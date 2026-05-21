import { readFile, unlink } from "node:fs/promises";

import { InlineKeyboard, Bot, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

import type { TelePiConfig } from "./config.js";
import { formatError } from "./errors.js";
import { escapeHTML } from "./format.js";
import {
  isMessageNotModifiedError,
  renderFailedText,
  renderPrefixedError,
  renderSessionInfoHTML,
  renderSessionInfoPlain,
} from "./bot/message-rendering.js";
import {
  appendKeyboardItems,
  paginateKeyboard,
  type KeyboardItem,
  KEYBOARD_PAGE_SIZE,
  NOOP_PAGE_CALLBACK_DATA,
} from "./bot/keyboard.js";
import {
  buildChatScopedCommands,
  buildChatScopedCommandSignature,
  getTelepiNativeCommandMenu,
  normalizeSlashCommand,
  rewriteSlashCommandForTelegram,
  TELEPI_BOT_COMMANDS,
  TELEPI_LOCAL_COMMAND_NAMES,
  type TelepiNativeCommandMenu,
} from "./bot/slash-command.js";
import {
  downloadTelegramFile,
  getTelegramTarget,
  safeEditMessage,
  safeReply,
  sendChatAction,
  sendTextMessage,
} from "./bot/telegram-transport.js";
import { createExtensionDialogManager } from "./bot/extension-dialogs.js";
import { createBotChatState } from "./bot/chat-state.js";
import { createChatTaskRunner } from "./bot/chat-task-runner.js";
import {
  COMMAND_MENU_CALLBACK_PREFIX,
  isStaleCallbackQueryError,
  logCallbackQueryError,
} from "./bot/callback-query-logging.js";
import { createPromptHandler } from "./bot/prompt-handler.js";
import { startPromptInboxPolling } from "./bot/prompt-inbox.js";
import { createCommandPickerHandlers, type PendingCommandPicker } from "./bot/command-picker.js";
import { createBasicCommandHandlers } from "./bot/commands/basic.js";
import { createSessionCommandHandlers } from "./bot/commands/sessions.js";
import { createContextCommandHandlers } from "./bot/commands/context.js";
import { createModelCommandHandlers } from "./bot/commands/model.js";
import { createTreeCommandHandlers } from "./bot/commands/tree.js";
import { registerTreeCallbacks, type PendingTreeView } from "./bot/tree-callbacks.js";
import {
  type PiSessionContext,
  type PiSessionInfo,
  getPiSessionContextKey,
  type PiSessionModelOption,
  type PiSessionRegistry,
  type PiSessionService,
} from "./pi-session.js";
import { truncateText, type TreeFilterMode } from "./tree.js";
import { getVoiceBackendStatus, transcribeAudio } from "./voice.js";

const EDIT_DEBOUNCE_MS = 1500;
const TYPING_INTERVAL_MS = 4500;
const EXTENSION_UI_TIMEOUT_MS = 60_000;
const DEFAULT_IMAGE_PROMPT = "Please analyze this image.";

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

type TelegramChatId = number | string;
type ContextKey = string;

function selectPhotoFileId(
  photos: Array<{ file_id: string; file_size?: number }> | undefined,
): string | undefined {
  if (!photos || photos.length === 0) {
    return undefined;
  }

  let selected = photos[photos.length - 1];
  for (const candidate of photos) {
    if (candidate.file_size !== undefined && (selected.file_size === undefined || candidate.file_size > selected.file_size)) {
      selected = candidate;
    }
  }

  return selected?.file_id;
}

function resolveImageMimeType(filePath: string, explicitMimeType?: string): string {
  const normalizedMimeType = explicitMimeType?.trim().toLowerCase();
  if (normalizedMimeType?.startsWith("image/")) {
    return normalizedMimeType;
  }

  const extensionIndex = filePath.lastIndexOf(".");
  const extension = extensionIndex >= 0 ? filePath.slice(extensionIndex).toLowerCase() : "";
  return IMAGE_MIME_BY_EXTENSION[extension] ?? "image/jpeg";
}

export function createBot(config: TelePiConfig, sessionRegistry: PiSessionRegistry): Bot<Context> {
  const bot = new Bot<Context>(config.telegramBotToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

  const chatState = createBotChatState();

  const pendingSessionPicks = new Map<ContextKey, Array<{ path: string; cwd: string }>>();
  const pendingSessionButtons = new Map<ContextKey, KeyboardItem[]>();
  const pendingWorkspacePicks = new Map<ContextKey, string[]>();
  const pendingWorkspaceButtons = new Map<ContextKey, KeyboardItem[]>();
  const pendingModelPicks = new Map<ContextKey, PiSessionModelOption[]>();
  const pendingModelButtons = new Map<ContextKey, KeyboardItem[]>();
  const pendingModelExtraButtons = new Map<ContextKey, KeyboardItem[]>();
  const pendingTreeNavs = new Map<ContextKey, string>();
  const pendingTreeViews = new Map<ContextKey, PendingTreeView>();
  const pendingBranchButtons = new Map<ContextKey, KeyboardItem[]>();
  const pendingCommandPickers = new Map<ContextKey, PendingCommandPicker>();
  const pendingCommandMenus = new Map<ContextKey, Map<string, { commandText: string }>>();
  const surfacedStartupErrorSignatures = new Map<ContextKey, string>();
  const chatScopedCommandSignatures = new Map<TelegramChatId, string>();
  let nextCommandMenuToken = 0;

  const getContextKey = (target: PiSessionContext): ContextKey => getPiSessionContextKey(target);
  const getExistingSession = (target: PiSessionContext): PiSessionService | undefined => sessionRegistry.get(target);
  const getOrCreateSession = async (target: PiSessionContext): Promise<PiSessionService> =>
    sessionRegistry.getOrCreate(target);

  const extensionDialogs = createExtensionDialogManager({
    getContextKey,
    sendTextMessage: (target, text, options) => sendTextMessage(bot.api, target, text, options),
    editMessage: (target, messageId, text, options) => safeEditMessage(bot, target, messageId, text, options),
    defaultTimeoutMs: EXTENSION_UI_TIMEOUT_MS,
  });

  const answerCallbackQuerySafely = async (
    ctx: Context,
    options?: Parameters<Context["answerCallbackQuery"]>[0],
    logOptions?: { source?: string },
  ): Promise<void> => {
    const responseText = typeof options === "object" && options !== null && "text" in options
      ? options.text
      : undefined;

    try {
      await ctx.answerCallbackQuery(options);
    } catch (error) {
      logCallbackQueryError(ctx, error, {
        phase: "answer",
        source: logOptions?.source,
        responseText,
      });
    }
  };

  const buildKeyboard = (
    items: KeyboardItem[],
    page: number,
    prefix: string,
    extraItems: KeyboardItem[] = [],
  ): InlineKeyboard => {
    const { keyboard } = paginateKeyboard(items, page, prefix);
    return appendKeyboardItems(keyboard, extraItems);
  };

  const syncChatScopedCommands = async (
    target: PiSessionContext,
    slashCommands: SlashCommandInfo[],
  ): Promise<void> => {
    const commands = buildChatScopedCommands(slashCommands);
    const signature = buildChatScopedCommandSignature(commands);
    const previousSignature = chatScopedCommandSignatures.get(target.chatId);
    if (signature === previousSignature) {
      return;
    }

    // Telegram command scopes are chat-scoped, not topic-scoped, so messageThreadId
    // is intentionally ignored here. In forum chats, the most recently synced topic wins.
    await bot.api.setMyCommands(commands, {
      scope: {
        type: "chat",
        chat_id: target.chatId,
      },
    });
    chatScopedCommandSignatures.set(target.chatId, signature);
  };

  const refreshChatScopedCommands = async (
    target: PiSessionContext,
    piSession: PiSessionService,
  ): Promise<void> => {
    try {
      const slashCommands = await piSession.listSlashCommands();
      await syncChatScopedCommands(target, slashCommands);
    } catch (error) {
      console.error("Failed to sync chat-scoped Telegram commands", error);
    }
  };

  const setPendingTreeView = (contextKey: ContextKey, mode: TreeFilterMode): void => {
    pendingTreeViews.set(contextKey, { mode });
  };

  const clearPendingTreeView = (contextKey: ContextKey): void => {
    pendingTreeViews.delete(contextKey);
  };

  const buildTreeKeyboard = (items: KeyboardItem[]): InlineKeyboard => {
    const keyboard = new InlineKeyboard();
    const navButtons = items.filter((button) => button.callbackData.startsWith("tree_nav_"));
    const pageButtons = items.filter(
      (button) => button.callbackData === NOOP_PAGE_CALLBACK_DATA || button.callbackData.startsWith("tree_page_"),
    );
    const filterButtons = items.filter((button) => button.callbackData.startsWith("tree_mode_"));

    for (const button of navButtons) {
      keyboard.text(button.label, button.callbackData).row();
    }

    if (pageButtons.length > 0) {
      for (const button of pageButtons) {
        keyboard.text(button.label, button.callbackData);
      }
      keyboard.row();
    }

    if (filterButtons.length > 0) {
      for (const button of filterButtons) {
        keyboard.text(button.label, button.callbackData);
      }
      keyboard.row();
    }

    return keyboard;
  };

  const createCommandMenuToken = (): string => {
    nextCommandMenuToken += 1;
    return nextCommandMenuToken.toString(36);
  };

  const openNativeCommandMenu = async (
    ctx: Context,
    target: PiSessionContext,
    menu: TelepiNativeCommandMenu,
  ): Promise<void> => {
    const contextKey = getContextKey(target);
    const keyboard = new InlineKeyboard();
    const actions = new Map<string, { commandText: string }>();

    menu.entries.forEach((entry, index) => {
      const token = createCommandMenuToken();
      actions.set(token, {
        commandText: entry.commandText,
      });
      keyboard.text(entry.label, `${COMMAND_MENU_CALLBACK_PREFIX}${token}`);
      if (index % 2 === 1 && index < menu.entries.length - 1) {
        keyboard.row();
      }
    });

    pendingCommandMenus.set(contextKey, actions);

    await safeReply(
      ctx,
      `<b>${escapeHTML(menu.title)}</b>\nChoose a command to run:`,
      {
        fallbackText: `${menu.title}\nChoose a command to run:`,
        replyMarkup: keyboard,
      },
      target,
    );
  };

  const clearContextPickers = (contextKey: ContextKey): void => {
    pendingSessionPicks.delete(contextKey);
    pendingSessionButtons.delete(contextKey);
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);
    pendingModelPicks.delete(contextKey);
    pendingModelButtons.delete(contextKey);
    pendingModelExtraButtons.delete(contextKey);
    pendingTreeNavs.delete(contextKey);
    pendingTreeViews.delete(contextKey);
    pendingBranchButtons.delete(contextKey);
    pendingCommandPickers.delete(contextKey);
    pendingCommandMenus.delete(contextKey);
    surfacedStartupErrorSignatures.delete(contextKey);
  };

  const clearContextPromptMemory = (target: PiSessionContext): void => {
    chatState.clearPromptMemory(target);
  };

  const surfaceStartupErrorDiagnostics = async (
    ctx: Context,
    target: PiSessionContext,
    info: PiSessionInfo,
  ): Promise<void> => {
    const contextKey = getContextKey(target);
    const errors = info.diagnostics?.filter((diagnostic) => diagnostic.type === "error") ?? [];
    if (errors.length === 0) {
      surfacedStartupErrorSignatures.delete(contextKey);
      return;
    }

    const signature = `${info.sessionId}:${errors.map((diagnostic) => diagnostic.message).join("\n")}`;
    if (surfacedStartupErrorSignatures.get(contextKey) === signature) {
      return;
    }

    surfacedStartupErrorSignatures.set(contextKey, signature);
    const plainText = ["Session startup issues:", ...errors.map((diagnostic) => `- ${diagnostic.message}`)].join("\n");
    const html = ["<b>Session startup issues:</b>", ...errors.map((diagnostic) => `• ${escapeHTML(diagnostic.message)}`)].join("\n");
    await safeReply(ctx, html, { fallbackText: plainText }, target);
  };

  const isBusy = (target: PiSessionContext): boolean => {
    const piSession = getExistingSession(target);
    return chatState.isLocallyBusy(target) || piSession?.isStreaming() === true;
  };

  const sendBusyReply = async (ctx: Context): Promise<void> => {
    const target = getTelegramTarget(ctx);
    const pendingDialogKind = target ? extensionDialogs.getPendingKind(target) : undefined;
    const message = pendingDialogKind === "input"
      ? "Please answer the pending prompt above or use /abort."
      : pendingDialogKind
        ? "Please answer the pending dialog above."
        : "Still working on previous message...";
    await safeReply(ctx, escapeHTML(message), {
      fallbackText: message,
    }, target);
  };

  const ensureActiveSession = async (ctx: Context, target: PiSessionContext): Promise<PiSessionService | undefined> => {
    const existing = getExistingSession(target);
    const hadActiveSession = existing?.hasActiveSession() === true;
    if (hadActiveSession) {
      return existing;
    }

    try {
      const piSession = existing ?? (await getOrCreateSession(target));
      if (!piSession.hasActiveSession()) {
        await piSession.newSession();
      }
      await surfaceStartupErrorDiagnostics(ctx, target, piSession.getInfo());
      return piSession;
    } catch (error) {
      const failure = renderPrefixedError("Failed to create session", error);
      await safeReply(ctx, failure.text, {
        fallbackText: failure.fallbackText,
        parseMode: failure.parseMode,
      }, target);
      return undefined;
    }
  };

  const handlePageCallback = (
    pattern: RegExp,
    prefix: string,
    buttonsMap: Map<ContextKey, KeyboardItem[]>,
    expiredMessage: string,
    extraButtonsMap?: Map<ContextKey, KeyboardItem[]>,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      const target = getTelegramTarget(ctx);
      const messageId = ctx.callbackQuery.message?.message_id;
      const page = Number.parseInt(ctx.match?.[1] ?? "", 10);

      if (!target || !messageId || Number.isNaN(page)) {
        return;
      }

      const contextKey = getContextKey(target);
      const buttons = buttonsMap.get(contextKey);
      if (!buttons) {
        await ctx.answerCallbackQuery({ text: expiredMessage });
        return;
      }

      await ctx.answerCallbackQuery();

      try {
        const keyboard = buildKeyboard(buttons, page, prefix, extraButtonsMap?.get(contextKey) ?? []);
        await bot.api.editMessageReplyMarkup(target.chatId, messageId, { reply_markup: keyboard });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error(`Failed to update ${prefix} keyboard page`, error);
        }
      }
    });
  };

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId || !config.telegramAllowedUserIdSet.has(fromId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Unauthorized" }).catch(() => {});
      } else if (ctx.chat) {
        await safeReply(ctx, escapeHTML("Unauthorized"), { fallbackText: "Unauthorized" });
      }
      return;
    }

    await next();
  });

  const chatTaskRunner = createChatTaskRunner({
    beginProcessing: (target, promptText) => chatState.beginProcessing(target, promptText),
    endProcessing: (target) => chatState.endProcessing(target),
    onTaskError: (error, target, promptText) => {
      console.error(
        "Detached prompt task failed",
        JSON.stringify({
          contextKey: getPiSessionContextKey(target),
          promptText,
          error: formatError(error),
        }),
      );
    },
  });

  const handleUserPrompt = createPromptHandler({
    bot,
    toolVerbosity: config.toolVerbosity,
    editDebounceMs: EDIT_DEBOUNCE_MS,
    typingIntervalMs: TYPING_INTERVAL_MS,
    isBusy,
    taskRunner: chatTaskRunner,
    ensureActiveSession,
    syncChatScopedCommands,
    refreshChatScopedCommands,
    extensionDialogs,
    sendBusyReply,
  });

  if (config.promptInboxDir) {
    const target: PiSessionContext = { chatId: config.telegramAllowedUserIds[0] };
    const stopPromptInboxPolling = startPromptInboxPolling({
      inboxDir: config.promptInboxDir,
      intervalMs: config.promptInboxIntervalMs,
      target,
      isBusy,
      handlePrompt: async (promptTarget, prompt) =>
        await handleUserPrompt({ api: bot.api } as Context, promptTarget, prompt),
      onError: (error) => {
        console.error("Prompt inbox polling failed", error);
      },
    });
    const stopBot = bot.stop.bind(bot);
    bot.stop = (...args: Parameters<typeof bot.stop>): ReturnType<typeof bot.stop> => {
      stopPromptInboxPolling();
      return stopBot(...args);
    };
  }

  const commandPickerHandlers = createCommandPickerHandlers({
    bot,
    pendingCommandPickers,
    getTelegramTarget,
    getContextKey,
    getOrCreateSession,
    syncChatScopedCommands,
    isBusy,
    handleUserPrompt,
    runTelePiPickerCommand,
    safeReply,
    safeEditMessage: (target, messageId, text, options) => safeEditMessage(bot, target, messageId, text, options),
    sendTextMessage: (ctx, target, text, options) => sendTextMessage(ctx.api, target, text, options),
  });
  const { openCommandPicker } = commandPickerHandlers;

  const basicCommandHandlers = createBasicCommandHandlers({
    sessionRegistry,
    getExistingSession,
    getOrCreateSession,
    refreshChatScopedCommands,
    openCommandPicker,
    handleUserPrompt,
    getLastPrompt: (target) => chatState.getLastPrompt(target),
    extensionDialogs,
    getVoiceBackendStatus,
    safeReply,
  });
  const {
    handleStartCommand,
    handleHelpCommand,
    handleCommandsCommand,
    handleAbortCommand,
    handleSessionCommand,
    handleRetryCommand,
  } = basicCommandHandlers;

  const contextCommandHandlers = createContextCommandHandlers({
    getExistingSession,
    safeReply,
  });
  const { handleContextCommand } = contextCommandHandlers;

  const sessionCommandHandlers = createSessionCommandHandlers({
    getContextKey,
    getOrCreateSession,
    getExistingSession,
    isBusy,
    beginSwitching: (target) => chatState.beginSwitching(target),
    endSwitching: (target) => chatState.endSwitching(target),
    buildKeyboard,
    clearContextPickers,
    clearContextPromptMemory,
    refreshChatScopedCommands,
    syncChatScopedCommands,
    setChatCommandSignature: (chatId, signature) => {
      if (signature === undefined) {
        chatScopedCommandSignatures.delete(chatId);
      } else {
        chatScopedCommandSignatures.set(chatId, signature);
      }
    },
    removeSession: (target) => sessionRegistry.remove(target),
    pendingSessionPicks,
    pendingSessionButtons,
    pendingWorkspacePicks,
    pendingWorkspaceButtons,
    safeReply,
    surfaceStartupErrorDiagnostics,
  });
  const { handleSessionsCommand, handleNewCommand, handleHandbackCommand } = sessionCommandHandlers;

  const modelCommandHandlers = createModelCommandHandlers({
    getContextKey,
    getExistingSession,
    getOrCreateSession,
    isBusy,
    refreshChatScopedCommands,
    pendingModelPicks,
    pendingModelButtons,
    pendingModelExtraButtons,
    buildKeyboard,
    safeReply,
    safeEditMessage: (target, messageId, text, options) => safeEditMessage(bot, target, messageId, text, options),
    surfaceStartupErrorDiagnostics,
  });
  const { renderModelPicker, handleModelCommand } = modelCommandHandlers;

  const treeCommandHandlers = createTreeCommandHandlers({
    getContextKey,
    getExistingSession,
    isBusy,
    pendingTreeNavs,
    pendingBranchButtons,
    clearPendingTreeView,
    setPendingTreeView,
    buildTreeKeyboard,
    buildKeyboard,
    safeReply,
  });
  const { collectLabelsMap, handleTreeCommand, handleBranchCommand, handleLabelCommand } = treeCommandHandlers;

  async function runTelePiPickerCommand(
    ctx: Context,
    target: PiSessionContext,
    command: string,
  ): Promise<void> {
    switch (command) {
      case "start":
        await handleStartCommand(ctx, target);
        return;
      case "help":
        await handleHelpCommand(ctx, target);
        return;
      case "abort":
        await handleAbortCommand(ctx, target);
        return;
      case "session":
        await handleSessionCommand(ctx, target);
        return;
      case "sessions":
        await handleSessionsCommand(ctx, target, "/sessions");
        return;
      case "new":
        await handleNewCommand(ctx, target);
        return;
      case "handback":
        await handleHandbackCommand(ctx, target);
        return;
      case "context":
        await handleContextCommand(ctx, target);
        return;
      case "model":
        await handleModelCommand(ctx, target);
        return;
      case "tree":
        await handleTreeCommand(ctx, target, "/tree");
        return;
      case "branch":
        await safeReply(ctx, escapeHTML("Use /branch <entry-id> with an ID from /tree."), {
          fallbackText: "Use /branch <entry-id> with an ID from /tree.",
        }, target);
        return;
      case "label":
        await handleLabelCommand(ctx, target, "/label");
        return;
      case "retry":
        await handleRetryCommand(ctx, target);
        return;
      default:
        await safeReply(ctx, escapeHTML(`Command not available from picker: /${command}`), {
          fallbackText: `Command not available from picker: /${command}`,
        }, target);
        return;
    }
  }

  bot.command("start", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleStartCommand(ctx, target);
  });

  bot.command("help", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleHelpCommand(ctx, target);
  });

  bot.command("commands", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleCommandsCommand(ctx, target);
  });

  bot.command("abort", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleAbortCommand(ctx, target);
  });

  bot.command("session", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleSessionCommand(ctx, target);
  });

  bot.command(["sessions", "switch"], async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleSessionsCommand(ctx, target);
  });

  bot.command("new", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleNewCommand(ctx, target);
  });

  bot.command("handback", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleHandbackCommand(ctx, target);
  });

  bot.command("context", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleContextCommand(ctx, target);
  });

  bot.command("model", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleModelCommand(ctx, target);
  });

  bot.command("tree", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleTreeCommand(ctx, target);
  });

  bot.command("branch", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleBranchCommand(ctx, target);
  });

  bot.command("label", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleLabelCommand(ctx, target);
  });

  bot.command("retry", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleRetryCommand(ctx, target);
  });

  bot.callbackQuery("pi_abort", async (ctx) => {
    const target = getTelegramTarget(ctx);
    await ctx.answerCallbackQuery({ text: "Aborting..." });
    if (!target) {
      return;
    }

    await getExistingSession(target)?.abort();
  });

  bot.callbackQuery(NOOP_PAGE_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^ui_sel_([a-z0-9]+)_(\d+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const dialogId = ctx.match?.[1];
    const optionIndex = Number.parseInt(ctx.match?.[2] ?? "", 10);
    if (!target || !dialogId || Number.isNaN(optionIndex)) {
      return;
    }

    const result = await extensionDialogs.resolveSelect(
      target,
      dialogId,
      ctx.callbackQuery.message?.message_id,
      optionIndex,
    );
    await answerCallbackQuerySafely(ctx, { text: result.callbackText }, { source: "extension.select" });
    await result.afterAnswer?.();
  });

  bot.callbackQuery(/^ui_cfm_([a-z0-9]+)_(yes|no)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const dialogId = ctx.match?.[1];
    const answer = ctx.match?.[2];
    if (!target || !dialogId || !answer) {
      return;
    }

    const result = await extensionDialogs.resolveConfirm(
      target,
      dialogId,
      ctx.callbackQuery.message?.message_id,
      answer === "yes",
    );
    await answerCallbackQuerySafely(ctx, { text: result.callbackText }, { source: "extension.confirm" });
    await result.afterAnswer?.();
  });

  bot.callbackQuery(/^ui_x_([a-z0-9]+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const dialogId = ctx.match?.[1];
    if (!target || !dialogId) {
      return;
    }

    const result = await extensionDialogs.resolveCancel(
      target,
      dialogId,
      ctx.callbackQuery.message?.message_id,
    );
    await answerCallbackQuerySafely(ctx, { text: result.callbackText }, { source: "extension.cancel" });
    await result.afterAnswer?.();
  });

  bot.callbackQuery(/^cmdm_([a-z0-9]+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const token = ctx.match?.[1];
    const logOptions = { source: "native.command-menu" };
    if (!token) {
      await answerCallbackQuerySafely(ctx, undefined, logOptions);
      return;
    }

    if (!target) {
      await answerCallbackQuerySafely(ctx, undefined, logOptions);
      return;
    }

    const contextKey = getContextKey(target);
    const action = pendingCommandMenus.get(contextKey)?.get(token);
    if (!action) {
      await answerCallbackQuerySafely(ctx, { text: "Expired, run the slash command again" }, logOptions);
      return;
    }

    if (isBusy(target)) {
      await answerCallbackQuerySafely(ctx, { text: "Wait for the current prompt to finish" }, logOptions);
      return;
    }

    await answerCallbackQuerySafely(ctx, { text: `Running ${action.commandText}` }, logOptions);
    await handleUserPrompt(ctx, target, action.commandText);
  });

  handlePageCallback(/^switch_page_(\d+)$/, "switch", pendingSessionButtons, "Expired, run /sessions again");
  handlePageCallback(/^newws_page_(\d+)$/, "newws", pendingWorkspaceButtons, "Expired, run /new again");
  handlePageCallback(/^model_page_(\d+)$/, "model", pendingModelButtons, "Expired, run /model again", pendingModelExtraButtons);
  handlePageCallback(/^branch_page_(\d+)$/, "branch", pendingBranchButtons, "Expired, run /branch again");

  registerTreeCallbacks({
    bot,
    getTelegramTarget,
    getContextKey,
    getExistingSession,
    isBusy,
    beginSwitching: (target) => chatState.beginSwitching(target),
    endSwitching: (target) => chatState.endSwitching(target),
    pendingTreeViews,
    pendingTreeNavs,
    pendingBranchButtons,
    setPendingTreeView,
    clearPendingTreeView,
    buildTreeKeyboard,
    buildKeyboard,
    collectLabelsMap,
    safeReply,
    safeEditMessage: (target, messageId, text, options) => safeEditMessage(bot, target, messageId, text, options),
  });

  bot.callbackQuery(/^switch_(\d+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!target || Number.isNaN(index)) {
      return;
    }

    const contextKey = getContextKey(target);
    const sessions = pendingSessionPicks.get(contextKey);
    if (!sessions || !sessions[index]) {
      await ctx.answerCallbackQuery({ text: "Session expired, run /sessions again" });
      return;
    }

    if (isBusy(target)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const piSession = await getOrCreateSession(target);
    await ctx.answerCallbackQuery({ text: "Switching..." });
    pendingSessionPicks.delete(contextKey);
    pendingSessionButtons.delete(contextKey);

    chatState.beginSwitching(target);
    try {
      const resolvedSession = await piSession.resolveSessionReference(sessions[index].path);
      const info = await piSession.switchSession(resolvedSession.path, resolvedSession.cwd);
      if (info.cancelled) {
        const cancelledText = "Session switch was cancelled.";
        if (messageId) {
          await safeEditMessage(bot, target, messageId, escapeHTML(cancelledText), {
            fallbackText: cancelledText,
          });
          return;
        }

        await safeReply(ctx, escapeHTML(cancelledText), { fallbackText: cancelledText }, target);
        return;
      }

      await refreshChatScopedCommands(target, piSession);
      clearPendingTreeView(contextKey);
      clearContextPromptMemory(target);
      const workspaceNotePlain = resolvedSession.workspaceWarning
        ? `\n\nWorkspace note: ${resolvedSession.workspaceWarning}`
        : "";
      const workspaceNoteHTML = resolvedSession.workspaceWarning
        ? `\n\n<b>Workspace note:</b> ${escapeHTML(resolvedSession.workspaceWarning)}`
        : "";
      const plainText = `Switched!${workspaceNotePlain}\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>Switched!</b>${workspaceNoteHTML}\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, target, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText }, target);
      }

      await surfaceStartupErrorDiagnostics(ctx, target, info);
    } catch (error) {
      const failure = renderFailedText(error);
      if (messageId) {
        await safeEditMessage(bot, target, messageId, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        });
      } else {
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
      }
    } finally {
      chatState.endSwitching(target);
    }
  });

  bot.callbackQuery(/^newws_(\d+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!target || Number.isNaN(index)) {
      return;
    }

    const contextKey = getContextKey(target);
    const workspaces = pendingWorkspacePicks.get(contextKey);
    if (!workspaces || !workspaces[index]) {
      await ctx.answerCallbackQuery({ text: "Expired, run /new again" });
      return;
    }

    if (isBusy(target)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const piSession = await getOrCreateSession(target);
    await ctx.answerCallbackQuery({ text: "Creating session..." });
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);

    chatState.beginSwitching(target);
    try {
      const { info, created } = await piSession.newSession(workspaces[index]);
      if (!created) {
        const html = escapeHTML("New session was cancelled.");
        if (messageId) {
          await safeEditMessage(bot, target, messageId, html, { fallbackText: "New session was cancelled." });
        }
        return;
      }

      await refreshChatScopedCommands(target, piSession);
      clearPendingTreeView(contextKey);
      clearContextPromptMemory(target);
      const plainText = `New session created.\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>New session created.</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, target, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText }, target);
      }

      await surfaceStartupErrorDiagnostics(ctx, target, info);
    } catch (error) {
      const failure = renderFailedText(error);
      if (messageId) {
        await safeEditMessage(bot, target, messageId, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        });
      } else {
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
      }
    } finally {
      chatState.endSwitching(target);
    }
  });

  bot.callbackQuery("model_show_all", async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;

    if (!target || !messageId) {
      return;
    }

    const contextKey = getContextKey(target);
    const piSession = getExistingSession(target);
    const models = pendingModelPicks.get(contextKey);
    if (!models || models.length === 0 || !piSession) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy(target)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Loading all models..." });
    await renderModelPicker(ctx, target, piSession, { showAll: true, messageId });
  });

  bot.callbackQuery(/^model_(\d+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!target || Number.isNaN(index)) {
      return;
    }

    const contextKey = getContextKey(target);
    const piSession = getExistingSession(target);
    const models = pendingModelPicks.get(contextKey);
    if (!models || !models[index] || !piSession) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy(target)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching model..." });
    pendingModelPicks.delete(contextKey);
    pendingModelButtons.delete(contextKey);
    pendingModelExtraButtons.delete(contextKey);

    chatState.beginSwitching(target);
    try {
      const modelName = await piSession.setModel(models[index].provider, models[index].id, models[index].thinkingLevel);
      const html = `<b>Model switched to:</b> <code>${escapeHTML(modelName)}</code>`;
      const plainText = `Model switched to: ${modelName}`;

      if (messageId) {
        await safeEditMessage(bot, target, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText }, target);
      }
    } catch (error) {
      const failure = renderFailedText(error);
      if (messageId) {
        await safeEditMessage(bot, target, messageId, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        });
        return;
      }

      await safeReply(ctx, failure.text, {
        fallbackText: failure.fallbackText,
        parseMode: failure.parseMode,
      }, target);
    } finally {
      chatState.endSwitching(target);
    }
  });

  bot.on("message:text", async (ctx) => {
    const userText = ctx.message.text.trim();
    if (!userText) {
      return;
    }

    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    const contextKey = getContextKey(target);
    const normalizedSlashCommand = normalizeSlashCommand(userText, bot.botInfo?.username);
    if (normalizedSlashCommand && TELEPI_LOCAL_COMMAND_NAMES.has(normalizedSlashCommand.name)) {
      return;
    }
    if (!normalizedSlashCommand && userText.startsWith("/")) {
      return;
    }

    if (await extensionDialogs.consumeInput(target, userText)) {
      return;
    }

    if (extensionDialogs.hasPending(target)) {
      await safeReply(ctx, escapeHTML("Please answer the pending dialog above."), {
        fallbackText: "Please answer the pending dialog above.",
      }, target);
      return;
    }

    if (normalizedSlashCommand) {
      const piSession = await getOrCreateSession(target);
      const slashCommands = await piSession.listSlashCommands();
      void syncChatScopedCommands(target, slashCommands).catch((error) => {
        console.error("Failed to sync chat-scoped Telegram commands", error);
      });
      const knownSlashCommands = new Set(slashCommands.map((command) => command.name));
      if (!knownSlashCommands.has(normalizedSlashCommand.name)) {
        await safeReply(ctx, escapeHTML("Unknown command. Use /commands to see available Pi slash commands."), {
          fallbackText: "Unknown command. Use /commands to see available Pi slash commands.",
        }, target);
        return;
      }

      const nativeCommandMenu = getTelepiNativeCommandMenu(normalizedSlashCommand, slashCommands);
      if (nativeCommandMenu) {
        await openNativeCommandMenu(ctx, target, nativeCommandMenu);
        return;
      }

      const commandText = rewriteSlashCommandForTelegram(normalizedSlashCommand, slashCommands);
      await handleUserPrompt(ctx, target, commandText, slashCommands);
      return;
    }

    await handleUserPrompt(ctx, target, userText);
  });

  bot.on(["message:photo", "message:document"], async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    if (isBusy(target)) {
      await sendBusyReply(ctx);
      return;
    }

    const photoFileId = selectPhotoFileId(ctx.message.photo as Array<{ file_id: string; file_size?: number }> | undefined);
    const documentMimeType = ctx.message.document?.mime_type;
    const isImageDocument = documentMimeType?.toLowerCase().startsWith("image/") ?? false;
    const documentFileId = isImageDocument ? ctx.message.document?.file_id : undefined;
    const fileId = photoFileId ?? documentFileId;
    if (!fileId) {
      return;
    }

    chatState.beginTranscribing(target);
    let tempFilePath: string | undefined;
    let promptText: string | undefined;
    let images: ImageContent[] | undefined;

    try {
      await sendChatAction(ctx.api, target, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId, {
        fileKind: "image file",
        tempFilePrefix: "telepi-image",
      });

      const imageBytes = await readFile(tempFilePath);
      const imageMimeType = resolveImageMimeType(tempFilePath, documentMimeType);
      promptText = ctx.message.caption?.trim() || DEFAULT_IMAGE_PROMPT;
      const preview = truncateText(promptText.replace(/\s+/g, " "), 240);
      images = [{
        type: "image",
        data: imageBytes.toString("base64"),
        mimeType: imageMimeType,
      }];

      await safeReply(
        ctx,
        `🖼️ ${escapeHTML(preview)}`,
        { fallbackText: `🖼️ ${preview}` },
        target,
      );
    } catch (error) {
      const failure = renderPrefixedError("Image handling failed", error, true);
      await safeReply(ctx, failure.text, {
        fallbackText: failure.fallbackText,
        parseMode: failure.parseMode,
      }, target);
      return;
    } finally {
      chatState.endTranscribing(target);
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    if (!promptText || !images) {
      return;
    }

    await handleUserPrompt(ctx, target, promptText, undefined, images);
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    const contextKey = getContextKey(target);
    if (isBusy(target)) {
      await sendBusyReply(ctx);
      return;
    }

    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) {
      return;
    }

    chatState.beginTranscribing(target);
    let tempFilePath: string | undefined;
    let transcript: string | undefined;

    try {
      await sendChatAction(ctx.api, target, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId);

      const result = await transcribeAudio(tempFilePath);
      transcript = result.text.trim();
      if (!transcript) {
        await safeReply(ctx, escapeHTML("Transcription was empty. Please try again or send text instead."), {
          fallbackText: "Transcription was empty. Please try again or send text instead.",
        }, target);
        return;
      }

      const preview = truncateText(transcript.replace(/\s+/g, " "), 240);
      await safeReply(
        ctx,
        `🎤 ${escapeHTML(preview)} <i>(via ${escapeHTML(result.backend)})</i>`,
        { fallbackText: `🎤 ${preview} (via ${result.backend})` },
        target,
      );
    } catch (error) {
      const failure = renderPrefixedError("Transcription failed", error, true);
      await safeReply(ctx, failure.text, {
        fallbackText: failure.fallbackText,
        parseMode: failure.parseMode,
      }, target);
      return;
    } finally {
      chatState.endTranscribing(target);
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    if (!transcript) {
      return;
    }

    await handleUserPrompt(ctx, target, transcript);
  });

  bot.catch((error) => {
    if (error.ctx?.callbackQuery && isStaleCallbackQueryError(error.error)) {
      logCallbackQueryError(error.ctx, error.error, { phase: "handler" });
      return;
    }

    console.error("Telegram bot error:", formatError(error.error));
  });

  return bot;
}

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([...TELEPI_BOT_COMMANDS]);
}

import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { InlineKeyboard, Bot, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";

import type { TelePiConfig, ToolVerbosity } from "./config.js";
import { escapeHTML, formatTelegramHTML } from "./format.js";
import { type PiSessionInfo, type PiSessionModelOption, type PiSessionService } from "./pi-session.js";
import {
  renderBranchConfirmation,
  renderLabels,
  renderTree,
  truncateText,
  type TreeFilterMode,
} from "./tree.js";
import { getAvailableBackends, transcribeAudio } from "./voice.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const EDIT_DEBOUNCE_MS = 1500;
const TYPING_INTERVAL_MS = 4500;
const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const STREAMING_PREVIEW_LIMIT = 3800;
const FORMATTED_CHUNK_TARGET = 3000;
const KEYBOARD_PAGE_SIZE = 6;
const NOOP_PAGE_CALLBACK_DATA = "noop_page";

type TelegramChatId = number | string;
type TelegramParseMode = "HTML";
type KeyboardItem = { label: string; callbackData: string };

interface PaginatedKeyboard {
  keyboard: InlineKeyboard;
}

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
};

type RenderedText = {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
};

type RenderedChunk = RenderedText & {
  sourceText: string;
};

function paginateKeyboard(items: KeyboardItem[], page: number, prefix: string): PaginatedKeyboard {
  const totalPages = Math.max(1, Math.ceil(items.length / KEYBOARD_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * KEYBOARD_PAGE_SIZE;
  const pageItems = items.slice(start, start + KEYBOARD_PAGE_SIZE);

  const keyboard = new InlineKeyboard();
  for (const item of pageItems) {
    keyboard.text(item.label, item.callbackData).row();
  }

  if (totalPages > 1) {
    if (safePage > 0) {
      keyboard.text("◀️ Prev", `${prefix}_page_${safePage - 1}`);
    }
    keyboard.text(`${safePage + 1}/${totalPages}`, NOOP_PAGE_CALLBACK_DATA);
    if (safePage < totalPages - 1) {
      keyboard.text("Next ▶️", `${prefix}_page_${safePage + 1}`);
    }
    keyboard.row();
  }

  return {
    keyboard,
  };
}

function appendKeyboardItems(keyboard: InlineKeyboard, items: KeyboardItem[]): InlineKeyboard {
  for (const item of items) {
    keyboard.text(item.label, item.callbackData).row();
  }

  return keyboard;
}

function splitTreeKeyboardItems(buttons: KeyboardItem[]): {
  navButtons: KeyboardItem[];
  filterButtons: KeyboardItem[];
} {
  const navButtons = buttons.filter((button) => button.callbackData.startsWith("tree_nav_"));
  const filterButtons = buttons.filter((button) => !button.callbackData.startsWith("tree_nav_"));
  return { navButtons, filterButtons };
}

export function createBot(config: TelePiConfig, piSession: PiSessionService): Bot<Context> {
  const bot = new Bot<Context>(config.telegramBotToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

  let isProcessing = false;
  let isSwitching = false;
  let isTranscribing = false;
  const pendingSessionPicks = new Map<number, Array<{ path: string; cwd: string }>>();
  const pendingSessionButtons = new Map<number, KeyboardItem[]>();
  const pendingWorkspacePicks = new Map<number, string[]>();
  const pendingWorkspaceButtons = new Map<number, KeyboardItem[]>();
  const pendingModelPicks = new Map<number, PiSessionModelOption[]>();
  const pendingModelButtons = new Map<number, KeyboardItem[]>();
  const pendingModelExtraButtons = new Map<number, KeyboardItem[]>();
  const pendingTreeNavs = new Map<number, string>();
  const pendingTreeButtons = new Map<number, KeyboardItem[]>();
  const pendingTreeFilterButtons = new Map<number, KeyboardItem[]>();
  const pendingBranchButtons = new Map<number, KeyboardItem[]>();

  const buildKeyboard = (
    items: KeyboardItem[],
    page: number,
    prefix: string,
    extraItems: KeyboardItem[] = [],
  ): InlineKeyboard => {
    const { keyboard } = paginateKeyboard(items, page, prefix);
    return appendKeyboardItems(keyboard, extraItems);
  };

  const setPendingTreeKeyboard = (chatId: number, buttons: KeyboardItem[]): InlineKeyboard => {
    const { navButtons, filterButtons } = splitTreeKeyboardItems(buttons);
    pendingTreeButtons.set(chatId, navButtons);
    pendingTreeFilterButtons.set(chatId, filterButtons);
    return buildKeyboard(navButtons, 0, "tree", filterButtons);
  };

  const clearPendingTreeKeyboard = (chatId: number): void => {
    pendingTreeButtons.delete(chatId);
    pendingTreeFilterButtons.delete(chatId);
  };

  const handlePageCallback = (
    pattern: RegExp,
    prefix: string,
    buttonsMap: Map<number, KeyboardItem[]>,
    expiredMessage: string,
    extraButtonsMap?: Map<number, KeyboardItem[]>,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      const chatId = ctx.chat?.id;
      const messageId = ctx.callbackQuery.message?.message_id;
      const page = Number.parseInt(ctx.match?.[1] ?? "", 10);

      if (!chatId || !messageId || Number.isNaN(page)) {
        return;
      }

      const buttons = buttonsMap.get(chatId);
      if (!buttons) {
        await ctx.answerCallbackQuery({ text: expiredMessage });
        return;
      }

      await ctx.answerCallbackQuery();

      try {
        const keyboard = buildKeyboard(buttons, page, prefix, extraButtonsMap?.get(chatId) ?? []);
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: keyboard });
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

  const collectLabelsMap = (): Map<string, string> => {
    const labels = new Map<string, string>();
    const walk = (node: { entry: { id: string }; children: any[]; label?: string }): void => {
      if (node.label) {
        labels.set(node.entry.id, node.label);
      }
      for (const child of node.children) {
        walk(child);
      }
    };

    for (const root of piSession.getTree()) {
      walk(root);
    }

    return labels;
  };

  const isBusy = (): boolean => isProcessing || isSwitching || isTranscribing || piSession.isStreaming();

  const sendBusyReply = async (ctx: Context): Promise<void> => {
    await safeReply(ctx, escapeHTML("Still working on previous message..."), {
      fallbackText: "Still working on previous message...",
    });
  };

  const ensureActiveSession = async (ctx: Context): Promise<boolean> => {
    if (piSession.hasActiveSession()) {
      return true;
    }

    try {
      await piSession.newSession();
      return true;
    } catch (error) {
      await safeReply(ctx, escapeHTML(`Failed to create session: ${formatError(error)}`), {
        fallbackText: `Failed to create session: ${formatError(error)}`,
      });
      return false;
    }
  };

  const handleUserPrompt = async (ctx: Context, chatId: number, userText: string): Promise<void> => {
    if (isBusy()) {
      await sendBusyReply(ctx);
      return;
    }

    isProcessing = true;

    try {
      if (!(await ensureActiveSession(ctx))) {
        return;
      }

      const abortKeyboard = new InlineKeyboard().text("⏹ Abort", "pi_abort");
      const toolVerbosity: ToolVerbosity = config.toolVerbosity;
      const toolStates = new Map<string, ToolState>();
      const toolCounts = new Map<string, number>();
      let accumulatedText = "";
      let responseMessageId: number | undefined;
      let responseMessagePromise: Promise<void> | undefined;
      let lastRenderedText = "";
      let lastEditAt = 0;
      let flushTimer: NodeJS.Timeout | undefined;
      let isFlushing = false;
      let flushPending = false;
      let finalized = false;

      const typingInterval = setInterval(() => {
        void bot.api.sendChatAction(chatId, "typing").catch(() => {});
      }, TYPING_INTERVAL_MS);
      void bot.api.sendChatAction(chatId, "typing").catch(() => {});

      const stopTyping = (): void => {
        clearInterval(typingInterval);
      };

      const clearFlushTimer = (): void => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
      };

      const renderPreview = (): RenderedChunk => {
        const previewText = buildStreamingPreview(accumulatedText);
        return renderMarkdownChunkWithinLimit(previewText);
      };

      const buildFinalResponseText = (text: string): string => {
        if (toolVerbosity !== "summary") {
          return text.trim();
        }

        const summaryLine = formatToolSummaryLine(toolCounts);
        const trimmedText = text.trim();
        if (!summaryLine) {
          return trimmedText;
        }

        return trimmedText ? `${trimmedText}\n\n${summaryLine}` : summaryLine;
      };

      const ensureResponseMessage = async (): Promise<void> => {
        if (responseMessageId) {
          return;
        }
        if (responseMessagePromise) {
          await responseMessagePromise;
          return;
        }

        responseMessagePromise = (async () => {
          stopTyping();
          const preview = renderPreview();
          const message = await sendTextMessage(bot.api, chatId, preview.text, {
            parseMode: preview.parseMode,
            fallbackText: preview.fallbackText,
            replyMarkup: abortKeyboard,
          });
          responseMessageId = message.message_id;
          lastRenderedText = preview.text;
          lastEditAt = Date.now();
        })();

        try {
          await responseMessagePromise;
        } finally {
          responseMessagePromise = undefined;
        }
      };

      const flushResponse = async (force = false): Promise<void> => {
        if (!accumulatedText) {
          return;
        }
        if (!responseMessageId) {
          await ensureResponseMessage();
          return;
        }
        if (isFlushing) {
          flushPending = true;
          return;
        }

        const now = Date.now();
        if (!force && now - lastEditAt < EDIT_DEBOUNCE_MS) {
          return;
        }

        const nextText = renderPreview();
        if (nextText.text === lastRenderedText) {
          return;
        }

        isFlushing = true;
        try {
          await safeEditMessage(bot, chatId, responseMessageId, nextText.text, {
            parseMode: nextText.parseMode,
            fallbackText: nextText.fallbackText,
            replyMarkup: abortKeyboard,
          });
          lastRenderedText = nextText.text;
          lastEditAt = Date.now();
        } finally {
          isFlushing = false;
          if (flushPending) {
            flushPending = false;
            scheduleFlush();
          }
        }
      };

      const scheduleFlush = (): void => {
        if (flushTimer || finalized) {
          return;
        }

        const delay = Math.max(0, EDIT_DEBOUNCE_MS - (Date.now() - lastEditAt));
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          void flushResponse().catch((error) => {
            console.error("Failed to update Telegram response message", error);
          });
        }, delay);
      };

      const removeAbortKeyboard = async (): Promise<void> => {
        if (!responseMessageId) {
          return;
        }

        try {
          await bot.api.editMessageReplyMarkup(chatId, responseMessageId, {
            reply_markup: new InlineKeyboard(),
          });
        } catch (error) {
          if (!isMessageNotModifiedError(error)) {
            console.error("Failed to clear Abort button", error);
          }
        }
      };

      const deliverRenderedChunks = async (chunks: RenderedChunk[]): Promise<void> => {
        if (chunks.length === 0) {
          return;
        }

        const [firstChunk, ...remainingChunks] = chunks;
        if (responseMessageId) {
          await safeEditMessage(bot, chatId, responseMessageId, firstChunk.text, {
            parseMode: firstChunk.parseMode,
            fallbackText: firstChunk.fallbackText,
          });
          await removeAbortKeyboard();
        } else {
          const message = await sendTextMessage(bot.api, chatId, firstChunk.text, {
            parseMode: firstChunk.parseMode,
            fallbackText: firstChunk.fallbackText,
          });
          responseMessageId = message.message_id;
        }

        for (const chunk of remainingChunks) {
          await sendTextMessage(bot.api, chatId, chunk.text, {
            parseMode: chunk.parseMode,
            fallbackText: chunk.fallbackText,
          });
        }
      };

      const finalizeResponse = async (): Promise<void> => {
        if (finalized) {
          return;
        }
        finalized = true;

        stopTyping();
        clearFlushTimer();
        if (responseMessagePromise) {
          try {
            await responseMessagePromise;
          } catch {
            // If the initial send failed, we will fall back to sending the final response below.
          }
        }

        const finalText = buildFinalResponseText(accumulatedText);
        if (!finalText) {
          const html = "<b>✅ Done</b>";
          const plainText = "✅ Done";

          if (responseMessageId) {
            await safeEditMessage(bot, chatId, responseMessageId, html, { fallbackText: plainText });
            await removeAbortKeyboard();
          } else {
            await safeReply(ctx, html, { fallbackText: plainText });
          }
          return;
        }

        await deliverRenderedChunks(splitMarkdownForTelegram(finalText));
      };

      const unsubscribe = piSession.subscribe({
        onTextDelta: (delta) => {
          accumulatedText += delta;
          if (!responseMessageId) {
            void ensureResponseMessage()
              .then(() => {
                scheduleFlush();
              })
              .catch((error) => {
                console.error("Failed to send initial Telegram response message", error);
              });
            return;
          }

          scheduleFlush();
        },
        onToolStart: (toolName, toolCallId) => {
          if (toolVerbosity === "summary") {
            toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
            return;
          }

          if (toolVerbosity === "none") {
            return;
          }

          toolStates.set(toolCallId, { toolName, partialResult: "" });
          if (toolVerbosity !== "all") {
            return;
          }

          const messageText = renderToolStartMessage(toolName);

          void (async () => {
            const message = await sendTextMessage(bot.api, chatId, messageText.text, {
              parseMode: messageText.parseMode,
              fallbackText: messageText.fallbackText,
            });
            const state = toolStates.get(toolCallId);
            if (!state) {
              return;
            }

            state.messageId = message.message_id;
            if (state.finalStatus) {
              await safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
                parseMode: state.finalStatus.parseMode,
                fallbackText: state.finalStatus.fallbackText,
              });
            }
          })().catch((error) => {
            console.error(`Failed to send tool start message for ${toolName}`, error);
          });
        },
        onToolUpdate: (toolCallId, partialResult) => {
          if (toolVerbosity === "none" || toolVerbosity === "summary") {
            return;
          }

          const state = toolStates.get(toolCallId);
          if (!state || !partialResult) {
            return;
          }

          state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
        },
        onToolEnd: (toolCallId, isError) => {
          if (toolVerbosity === "none" || toolVerbosity === "summary") {
            return;
          }

          const state = toolStates.get(toolCallId);
          if (!state) {
            return;
          }

          state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);
          if (toolVerbosity === "errors-only") {
            if (!isError) {
              return;
            }

            // errors-only: no start message was sent, so always send a new message (not edit)
            void sendTextMessage(bot.api, chatId, state.finalStatus.text, {
              parseMode: state.finalStatus.parseMode,
              fallbackText: state.finalStatus.fallbackText,
            }).catch((error) => {
              console.error(`Failed to send tool error message for ${state.toolName}`, error);
            });
            return;
          }

          if (!state.messageId) {
            return;
          }

          void safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
            parseMode: state.finalStatus.parseMode,
            fallbackText: state.finalStatus.fallbackText,
          }).catch((error) => {
            console.error(`Failed to update tool message for ${state.toolName}`, error);
          });
        },
        onAgentEnd: () => {
          void finalizeResponse().catch((error) => {
            console.error("Failed to finalize Telegram response message", error);
          });
        },
      });

      try {
        await piSession.prompt(userText);
        await finalizeResponse();
      } catch (error) {
        stopTyping();
        clearFlushTimer();
        if (responseMessagePromise) {
          try {
            await responseMessagePromise;
          } catch {
            // Ignore; we will send an error message below.
          }
        }

        if (finalized) {
          console.error("Pi prompt error after finalization:", formatError(error));
        } else {
          finalized = true;

          const combinedText = buildFinalResponseText(renderPromptFailure(accumulatedText, error));
          const chunks = splitMarkdownForTelegram(combinedText);
          try {
            await deliverRenderedChunks(chunks);
          } catch (telegramError) {
            console.error("Failed to send error message to Telegram:", telegramError);
          }
        }
      } finally {
        stopTyping();
        clearFlushTimer();
        unsubscribe();
      }
    } finally {
      isProcessing = false;
    }
  };

  bot.command("start", async (ctx) => {
    const info = piSession.getInfo();
    const voiceBackends = await getAvailableBackends().catch(() => []);
    const voiceInfoPlain = renderVoiceSupportPlain(voiceBackends);
    const voiceInfoHTML = renderVoiceSupportHTML(voiceBackends);
    const plainText = [
      "TelePi is ready.",
      "",
      "Send any text message to continue the current Pi session from Telegram.",
      "Send a voice message or audio file to transcribe it into a Pi prompt.",
      voiceInfoPlain,
      "",
      renderSessionInfoPlain(info),
    ].join("\n");
    const html = [
      "<b>TelePi is ready.</b>",
      "",
      "Send any text message to continue the current Pi session from Telegram.",
      "Send a voice message or audio file to transcribe it into a Pi prompt.",
      voiceInfoHTML,
      "",
      renderSessionInfoHTML(info),
    ].join("\n");

    await safeReply(ctx, html, { fallbackText: plainText });
  });

  bot.command("abort", async (ctx) => {
    try {
      await piSession.abort();
      await safeReply(ctx, escapeHTML("Aborted current operation"), {
        fallbackText: "Aborted current operation",
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(formatError(error))}`, {
        fallbackText: `Failed: ${formatError(error)}`,
      });
    }
  });

  bot.command("session", async (ctx) => {
    const info = piSession.getInfo();
    await safeReply(ctx, renderSessionInfoHTML(info), {
      fallbackText: renderSessionInfoPlain(info),
    });
  });

  bot.command(["sessions", "switch"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isBusy()) {
      await safeReply(ctx, escapeHTML("Cannot switch sessions while a prompt is running."), {
        fallbackText: "Cannot switch sessions while a prompt is running.",
      });
      return;
    }

    // If a path argument is provided, switch directly
    const rawText = ctx.message?.text ?? "";
    const sessionPath = rawText.replace(/^\/(?:sessions|switch)(?:@\w+)?\s*/, "").trim();
    if (sessionPath) {
      isSwitching = true;
      try {
        // Resolve the workspace from known sessions so tools are scoped correctly
        const resolvedWorkspace = await piSession.resolveWorkspaceForSession(sessionPath);
        const info = await piSession.switchSession(sessionPath, resolvedWorkspace);
        const plainText = `Switched session.\n\n${renderSessionInfoPlain(info)}`;
        const html = `<b>Switched session.</b>\n\n${renderSessionInfoHTML(info)}`;
        await safeReply(ctx, html, { fallbackText: plainText });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(formatError(error))}`, {
          fallbackText: `Failed: ${formatError(error)}`,
        });
      } finally {
        isSwitching = false;
      }
      return;
    }

    // No argument — show session picker
    const allSessions = await piSession.listAllSessions();
    if (allSessions.length === 0) {
      await safeReply(ctx, escapeHTML("No saved sessions found."), {
        fallbackText: "No saved sessions found.",
      });
      return;
    }

    const grouped = new Map<string, Array<(typeof allSessions)[number]>>();
    for (const session of allSessions) {
      const workspace = session.cwd || "Unknown";
      if (!grouped.has(workspace)) {
        grouped.set(workspace, []);
      }
      grouped.get(workspace)?.push(session);
    }

    const textLines: string[] = [];
    const orderedPicks: Array<{ path: string; cwd: string }> = [];
    const sessionButtons: KeyboardItem[] = [];

    for (const [workspace, sessions] of grouped) {
      const shortWorkspace = getWorkspaceShortName(workspace);
      if (textLines.length > 0) {
        textLines.push("");
      }
      textLines.push(`📁 ${shortWorkspace}`);

      for (const session of sessions) {
        const idx = orderedPicks.length;
        const label = trimLine(session.name || session.firstMessage, 35) || `Session ${idx + 1}`;
        sessionButtons.push({
          label: `📁 ${shortWorkspace.slice(0, 8)} · ${label.slice(0, 30)}`,
          callbackData: `switch_${idx}`,
        });
        textLines.push(`  ${idx + 1}. ${label} (${session.messageCount} msgs)`);
        orderedPicks.push({ path: session.path, cwd: session.cwd });
      }
    }

    pendingSessionPicks.set(chatId, orderedPicks);
    pendingSessionButtons.set(chatId, sessionButtons);

    const keyboard = buildKeyboard(sessionButtons, 0, "switch");
    const plainText = [
      `Available sessions (${allSessions.length} shown):`,
      "",
      ...textLines,
      "",
      "Tap a session to switch.",
    ].join("\n");
    const html = [
      `<b>Available sessions</b> <i>(${allSessions.length} shown)</i>`,
      "",
      ...textLines.map((line) => escapeHTML(line)),
      "",
      "Tap a session to switch.",
    ].join("\n");

    await safeReply(ctx, html, {
      fallbackText: plainText,
      replyMarkup: keyboard,
    });
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isBusy()) {
      await safeReply(ctx, escapeHTML("Cannot create new session while a prompt is running."), {
        fallbackText: "Cannot create new session while a prompt is running.",
      });
      return;
    }

    const workspaces = await piSession.listWorkspaces();

    if (workspaces.length <= 1) {
      try {
        const { info, created } = await piSession.newSession();
        if (!created) {
          await safeReply(ctx, escapeHTML("New session was cancelled."), {
            fallbackText: "New session was cancelled.",
          });
          return;
        }

        const plainText = `New session created.\n\n${renderSessionInfoPlain(info)}`;
        const html = `<b>New session created.</b>\n\n${renderSessionInfoHTML(info)}`;
        await safeReply(ctx, html, { fallbackText: plainText });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(formatError(error))}`, {
          fallbackText: `Failed: ${formatError(error)}`,
        });
      }
      return;
    }

    pendingWorkspacePicks.set(chatId, workspaces);
    const currentWorkspace = piSession.getCurrentWorkspace();
    const workspaceButtons = workspaces.map((workspace, index) => {
      const shortName = getWorkspaceShortName(workspace);
      const prefix = workspace === currentWorkspace ? "📂 " : "📁 ";
      return {
        label: `${prefix}${shortName}`,
        callbackData: `newws_${index}`,
      };
    });
    pendingWorkspaceButtons.set(chatId, workspaceButtons);

    await safeReply(ctx, "<b>Select workspace for new session:</b>", {
      fallbackText: "Select workspace for new session:",
      replyMarkup: buildKeyboard(workspaceButtons, 0, "newws"),
    });
  });

  bot.command("handback", async (ctx) => {
    if (isBusy()) {
      await safeReply(ctx, escapeHTML("Cannot hand back while a prompt is running. Use /abort first."), {
        fallbackText: "Cannot hand back while a prompt is running. Use /abort first.",
      });
      return;
    }

    if (!piSession.hasActiveSession()) {
      await safeReply(ctx, escapeHTML("No active session to hand back."), {
        fallbackText: "No active session to hand back.",
      });
      return;
    }

    try {
      const { sessionFile, workspace } = await piSession.handback();

      if (!sessionFile) {
        await safeReply(ctx, escapeHTML("Session was in-memory. No file to resume.\nUse /new to start a fresh session."), {
          fallbackText: "Session was in-memory. No file to resume.\nUse /new to start a fresh session.",
        });
        return;
      }

      // Use single-quote shell escaping for safe copy-paste
      const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
      const piCommand = `cd ${shellEscape(workspace)} && pi --session ${shellEscape(sessionFile)}`;
      const piContinueCommand = `cd ${shellEscape(workspace)} && pi -c`;

      let copiedToClipboard = false;
      if (process.platform === "darwin") {
        try {
          const { spawnSync } = await import("node:child_process");
          const result = spawnSync("pbcopy", [], {
            input: piCommand,
            timeout: 2000,
            stdio: ["pipe", "ignore", "ignore"],
          });
          copiedToClipboard = result.status === 0;
        } catch {
          // Ignore clipboard failures.
        }
      }

      const plainText = [
        "🔄 Session handed back to Pi CLI.",
        "",
        "Run this in your terminal:",
        piCommand,
        "",
        "Or simply:",
        piContinueCommand,
        "(to continue the most recent session)",
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 Command copied to clipboard!" : undefined,
        "",
        "Send any message here to start a new TelePi session.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      const html = [
        "<b>🔄 Session handed back to Pi CLI.</b>",
        "",
        "Run this in your terminal:",
        `<pre>${escapeHTML(piCommand)}</pre>`,
        "",
        "Or simply:",
        `<pre>${escapeHTML(piContinueCommand)}</pre>`,
        "<i>(to continue the most recent session)</i>",
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 <i>Command copied to clipboard!</i>" : undefined,
        "",
        "Send any message here to start a new TelePi session.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(formatError(error))}`, {
        fallbackText: `Failed: ${formatError(error)}`,
      });
    }
  });

  const renderModelPicker = async (
    chatId: number,
    options?: { showAll?: boolean; messageId?: number },
  ): Promise<void> => {
    const showAll = options?.showAll ?? false;
    const messageId = options?.messageId;
    const models = await piSession.listModels(showAll);
    if (models.length === 0) {
      const message = "No models available.";
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, escapeHTML(message), { fallbackText: message });
      } else {
        await bot.api.sendMessage(chatId, escapeHTML(message), { parse_mode: "HTML" });
      }
      return;
    }

    pendingModelPicks.set(chatId, models);

    const modelButtons = models.map((model, index) => {
      const prefix = model.current ? "✅ " : "";
      const modelRef = `${model.provider}/${model.id}`;
      const nameSuffix = model.name && model.name !== model.id ? ` · ${model.name}` : "";
      const thinkingSuffix = model.thinkingLevel ? ` : ${model.thinkingLevel}` : "";
      return {
        label: `${prefix}${modelRef}${nameSuffix}${thinkingSuffix}`,
        callbackData: `model_${index}`,
      };
    });
    pendingModelButtons.set(chatId, modelButtons);

    const allModels = showAll ? models : await piSession.listModels(true);
    const hasScopedSubset = !showAll && models.length > 0 && models.length < allModels.length;
    const extraButtons = hasScopedSubset
      ? [{ label: "Show all models", callbackData: "model_show_all" }]
      : [];
    pendingModelExtraButtons.set(chatId, extraButtons);
    const keyboard = buildKeyboard(modelButtons, 0, "model", extraButtons);

    const info = piSession.getInfo();
    const currentModelText = info.model ? `Current: ${info.model}` : "No model selected";
    const scopeHint = hasScopedSubset
      ? "Showing the current Pi model scope."
      : undefined;
    const html = [
      "<b>Select a model</b>",
      escapeHTML(currentModelText),
      scopeHint ? `<i>${escapeHTML(scopeHint)}</i>` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    const fallbackText = ["Select a model", currentModelText, scopeHint]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, html, {
        fallbackText,
        replyMarkup: keyboard,
      });
      return;
    }

    await bot.api.sendMessage(chatId, html, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  };

  const showModelPicker = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (!piSession.hasActiveSession()) {
      try {
        await piSession.newSession();
      } catch (error) {
        await safeReply(ctx, escapeHTML(`Failed to create session: ${formatError(error)}`), {
          fallbackText: `Failed to create session: ${formatError(error)}`,
        });
        return;
      }
    }

    await renderModelPicker(chatId);
  };

  bot.command("model", async (ctx) => {
    await showModelPicker(ctx);
  });

  bot.command("tree", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isBusy()) {
      await safeReply(ctx, escapeHTML("Cannot view tree while a prompt is running."), {
        fallbackText: "Cannot view tree while a prompt is running.",
      });
      return;
    }

    if (!piSession.hasActiveSession()) {
      await safeReply(ctx, escapeHTML("No active session. Send a message to start one."), {
        fallbackText: "No active session. Send a message to start one.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const arg = rawText.replace(/^\/tree(?:@\w+)?\s*/, "").trim().toLowerCase();
    let mode: TreeFilterMode = "default";
    if (arg === "all") {
      mode = "all-with-buttons";
    } else if (arg === "user") {
      mode = "user-only";
    }

    const tree = piSession.getTree();
    const leafId = piSession.getLeafId();
    const result = renderTree(tree, leafId, { mode });

    if (result.buttons.length === 0) {
      clearPendingTreeKeyboard(chatId);
      await safeReply(ctx, result.text, { fallbackText: stripHtml(result.text) });
      return;
    }

    const keyboard = setPendingTreeKeyboard(chatId, result.buttons);

    await safeReply(ctx, result.text, {
      fallbackText: stripHtml(result.text),
      replyMarkup: keyboard,
    });
  });

  bot.command("branch", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isBusy()) {
      await safeReply(ctx, escapeHTML("Cannot navigate while a prompt is running."), {
        fallbackText: "Cannot navigate while a prompt is running.",
      });
      return;
    }

    if (!piSession.hasActiveSession()) {
      await safeReply(ctx, escapeHTML("No active session."), { fallbackText: "No active session." });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const entryId = rawText.replace(/^\/branch(?:@\w+)?\s*/, "").trim();
    if (!entryId) {
      await safeReply(ctx, escapeHTML("Usage: /branch <entry-id>\nUse /tree to see entry IDs."), {
        fallbackText: "Usage: /branch <entry-id>\nUse /tree to see entry IDs.",
      });
      return;
    }

    const entry = piSession.getEntry(entryId);
    if (!entry) {
      await safeReply(ctx, escapeHTML(`Entry not found: ${entryId}`), {
        fallbackText: `Entry not found: ${entryId}`,
      });
      return;
    }

    const leafId = piSession.getLeafId();
    if (entry.id === leafId) {
      await safeReply(ctx, escapeHTML("You're already at this point."), {
        fallbackText: "You're already at this point.",
      });
      return;
    }

    const children = piSession.getChildren(entry.id);
    const confirmation = renderBranchConfirmation(entry, children, leafId, collectLabelsMap());

    pendingTreeNavs.set(chatId, entry.id);
    pendingBranchButtons.set(chatId, confirmation.buttons);

    await safeReply(ctx, confirmation.text, {
      fallbackText: stripHtml(confirmation.text),
      replyMarkup: buildKeyboard(confirmation.buttons, 0, "branch"),
    });
  });

  bot.command("label", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isBusy()) {
      await safeReply(ctx, escapeHTML("Cannot label entries while a prompt is running."), {
        fallbackText: "Cannot label entries while a prompt is running.",
      });
      return;
    }

    if (!piSession.hasActiveSession()) {
      await safeReply(ctx, escapeHTML("No active session."), { fallbackText: "No active session." });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const args = rawText.replace(/^\/label(?:@\w+)?\s*/, "").trim();

    if (!args) {
      const labelsText = renderLabels(piSession.getTree());
      await safeReply(ctx, labelsText, { fallbackText: stripHtml(labelsText) });
      return;
    }

    const clearMatch = args.match(/^clear\s+(\S+)/i);
    if (clearMatch) {
      const targetId = clearMatch[1];
      const entry = piSession.getEntry(targetId);
      if (!entry) {
        await safeReply(ctx, escapeHTML(`Entry not found: ${targetId}`), {
          fallbackText: `Entry not found: ${targetId}`,
        });
        return;
      }

      piSession.setLabel(targetId, "");
      await safeReply(ctx, `🏷️ Label cleared on <code>${escapeHTML(targetId)}</code>`, {
        fallbackText: `🏷️ Label cleared on ${targetId}`,
      });
      return;
    }

    const parts = args.split(/\s+/);
    if (parts.length >= 2) {
      const maybeId = parts[0];
      const entry = piSession.getEntry(maybeId);
      if (entry) {
        const labelName = parts.slice(1).join(" ");
        piSession.setLabel(maybeId, labelName);
        await safeReply(
          ctx,
          `🏷️ Label <b>${escapeHTML(labelName)}</b> set on <code>${escapeHTML(maybeId)}</code>`,
          {
            fallbackText: `🏷️ Label "${labelName}" set on ${maybeId}`,
          },
        );
        return;
      }
    }

    const leafId = piSession.getLeafId();
    if (!leafId) {
      await safeReply(ctx, escapeHTML("No current leaf to label. Send a message first."), {
        fallbackText: "No current leaf to label. Send a message first.",
      });
      return;
    }

    piSession.setLabel(leafId, args);
    await safeReply(
      ctx,
      `🏷️ Label <b>${escapeHTML(args)}</b> set on current leaf <code>${escapeHTML(leafId)}</code>`,
      {
        fallbackText: `🏷️ Label "${args}" set on current leaf ${leafId}`,
      },
    );
  });

  bot.callbackQuery("pi_abort", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Aborting..." });
    await piSession.abort();
  });

  bot.callbackQuery(NOOP_PAGE_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  handlePageCallback(/^switch_page_(\d+)$/, "switch", pendingSessionButtons, "Expired, run /sessions again");
  handlePageCallback(/^newws_page_(\d+)$/, "newws", pendingWorkspaceButtons, "Expired, run /new again");
  handlePageCallback(
    /^model_page_(\d+)$/,
    "model",
    pendingModelButtons,
    "Expired, run /model again",
    pendingModelExtraButtons,
  );
  handlePageCallback(
    /^tree_page_(\d+)$/,
    "tree",
    pendingTreeButtons,
    "Expired, run /tree again",
    pendingTreeFilterButtons,
  );
  handlePageCallback(/^branch_page_(\d+)$/, "branch", pendingBranchButtons, "Expired, run /branch again");

  bot.callbackQuery(/^switch_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const sessions = pendingSessionPicks.get(chatId);
    if (!sessions || !sessions[index]) {
      await ctx.answerCallbackQuery({ text: "Session expired, run /sessions again" });
      return;
    }

    if (isBusy()) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching..." });
    pendingSessionPicks.delete(chatId);
    pendingSessionButtons.delete(chatId);

    isSwitching = true;
    try {
      const info = await piSession.switchSession(sessions[index].path, sessions[index].cwd);
      const plainText = `Switched!\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>Switched!</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
        return;
      }

      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(formatError(error))}`;
      const errPlain = `Failed: ${formatError(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      isSwitching = false;
    }
  });

  bot.callbackQuery(/^newws_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const workspaces = pendingWorkspacePicks.get(chatId);
    if (!workspaces || !workspaces[index]) {
      await ctx.answerCallbackQuery({ text: "Expired, run /new again" });
      return;
    }

    if (isBusy()) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Creating session..." });
    pendingWorkspacePicks.delete(chatId);
    pendingWorkspaceButtons.delete(chatId);

    isSwitching = true;
    try {
      const { info, created } = await piSession.newSession(workspaces[index]);
      if (!created) {
        const html = escapeHTML("New session was cancelled.");
        if (messageId) {
          await safeEditMessage(bot, chatId, messageId, html, { fallbackText: "New session was cancelled." });
        }
        return;
      }

      const plainText = `New session created.\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>New session created.</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
        return;
      }

      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(formatError(error))}`;
      const errPlain = `Failed: ${formatError(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      isSwitching = false;
    }
  });

  bot.callbackQuery("model_show_all", async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;

    if (!chatId || !messageId) {
      return;
    }

    const models = pendingModelPicks.get(chatId);
    if (!models || models.length === 0) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy()) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Loading all models..." });
    await renderModelPicker(chatId, { showAll: true, messageId });
  });

  bot.callbackQuery(/^model_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const models = pendingModelPicks.get(chatId);
    if (!models || !models[index]) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy()) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching model..." });
    pendingModelPicks.delete(chatId);
    pendingModelButtons.delete(chatId);
    pendingModelExtraButtons.delete(chatId);

    isSwitching = true;
    try {
      const modelName = await piSession.setModel(
        models[index].provider,
        models[index].id,
        models[index].thinkingLevel,
      );
      const html = `<b>Model switched to:</b> <code>${escapeHTML(modelName)}</code>`;
      const plainText = `Model switched to: ${modelName}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, `<b>Failed:</b> ${escapeHTML(message)}`, {
          fallbackText: `Failed: ${message}`,
        });
        return;
      }

      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(message)}`, {
        fallbackText: `Failed: ${message}`,
      });
    } finally {
      isSwitching = false;
    }
  });

  bot.callbackQuery(/^tree_nav_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const entryId = ctx.match?.[1];
    if (!chatId || !entryId) {
      return;
    }

    if (isBusy()) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const entry = piSession.getEntry(entryId);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "Entry not found" });
      return;
    }

    const leafId = piSession.getLeafId();
    if (entry.id === leafId) {
      await ctx.answerCallbackQuery({ text: "Already at this point" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Loading..." });

    const confirmation = renderBranchConfirmation(
      entry,
      piSession.getChildren(entry.id),
      leafId,
      collectLabelsMap(),
    );
    pendingTreeNavs.set(chatId, entry.id);
    pendingBranchButtons.set(chatId, confirmation.buttons);

    const keyboard = buildKeyboard(confirmation.buttons, 0, "branch");

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, confirmation.text, {
        fallbackText: stripHtml(confirmation.text),
        replyMarkup: keyboard,
      });
    } else {
      await safeReply(ctx, confirmation.text, {
        fallbackText: stripHtml(confirmation.text),
        replyMarkup: keyboard,
      });
    }
  });

  bot.callbackQuery(/^tree_go_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const entryId = ctx.match?.[1];
    if (!chatId || !entryId) {
      return;
    }

    if (isBusy()) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const pendingId = pendingTreeNavs.get(chatId);
    if (pendingId !== entryId) {
      await ctx.answerCallbackQuery({ text: "Confirmation expired. Use /branch again." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Navigating..." });
    pendingTreeNavs.delete(chatId);
    pendingBranchButtons.delete(chatId);
    pendingTreeButtons.delete(chatId);
    pendingTreeFilterButtons.delete(chatId);

    isSwitching = true;
    try {
      const result = await piSession.navigateTree(entryId);
      if (result.cancelled) {
        const html = escapeHTML("Navigation cancelled.");
        if (messageId) {
          await safeEditMessage(bot, chatId, messageId, html, { fallbackText: "Navigation cancelled." });
        } else {
          await ctx.reply("Navigation cancelled.");
        }
        return;
      }

      let html = `<b>✅ Navigated to</b> <code>${escapeHTML(entryId.slice(0, 8))}</code>`;
      let plain = `✅ Navigated to ${entryId.slice(0, 8)}`;
      if (result.editorText) {
        html += `\n\nRe-submit: <i>${escapeHTML(truncateText(result.editorText, 200))}</i>`;
        plain += `\n\nRe-submit: ${truncateText(result.editorText, 200)}`;
      }
      html += "\n\nSend your next message to create a new branch from this point.";
      plain += "\n\nSend your next message to create a new branch from this point.";

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
      } else {
        await safeReply(ctx, html, { fallbackText: plain });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const errHtml = `<b>Failed:</b> ${escapeHTML(msg)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: `Failed: ${msg}` });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: `Failed: ${msg}` });
      }
    } finally {
      isSwitching = false;
    }
  });

  bot.callbackQuery(/^tree_sum_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const entryId = ctx.match?.[1];
    if (!chatId || !entryId) {
      return;
    }

    if (isBusy()) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const pendingId = pendingTreeNavs.get(chatId);
    if (pendingId !== entryId) {
      await ctx.answerCallbackQuery({ text: "Confirmation expired. Use /branch again." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Navigating with summary..." });
    pendingTreeNavs.delete(chatId);
    pendingBranchButtons.delete(chatId);
    pendingTreeButtons.delete(chatId);
    pendingTreeFilterButtons.delete(chatId);

    isSwitching = true;
    try {
      const result = await piSession.navigateTree(entryId, { summarize: true });
      if (result.cancelled) {
        const html = escapeHTML("Navigation cancelled.");
        if (messageId) {
          await safeEditMessage(bot, chatId, messageId, html, { fallbackText: "Navigation cancelled." });
        } else {
          await ctx.reply("Navigation cancelled.");
        }
        return;
      }

      let html = `<b>✅ Navigated to</b> <code>${escapeHTML(entryId.slice(0, 8))}</code>\n📝 Branch summary saved.`;
      let plain = `✅ Navigated to ${entryId.slice(0, 8)}\n📝 Branch summary saved.`;
      if (result.editorText) {
        html += `\n\nRe-submit: <i>${escapeHTML(truncateText(result.editorText, 200))}</i>`;
        plain += `\n\nRe-submit: ${truncateText(result.editorText, 200)}`;
      }
      html += "\n\nSend your next message to create a new branch from this point.";
      plain += "\n\nSend your next message to create a new branch from this point.";

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
      } else {
        await safeReply(ctx, html, { fallbackText: plain });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const errHtml = `<b>Failed:</b> ${escapeHTML(msg)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: `Failed: ${msg}` });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: `Failed: ${msg}` });
      }
    } finally {
      isSwitching = false;
    }
  });

  bot.callbackQuery("tree_cancel", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId) {
      pendingTreeNavs.delete(chatId);
      pendingBranchButtons.delete(chatId);
      pendingTreeButtons.delete(chatId);
      pendingTreeFilterButtons.delete(chatId);
    }
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId && messageId) {
      await safeEditMessage(bot, chatId, messageId, escapeHTML("Navigation cancelled."), {
        fallbackText: "Navigation cancelled.",
      });
    }
  });

  bot.callbackQuery(/^tree_mode_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const mode = ctx.match?.[1];
    if (!chatId || !messageId) {
      return;
    }

    if (isBusy()) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery();

    let filterMode: TreeFilterMode = "default";
    if (mode === "all") {
      filterMode = "all-with-buttons";
    } else if (mode === "user") {
      filterMode = "user-only";
    }

    const result = renderTree(piSession.getTree(), piSession.getLeafId(), { mode: filterMode });
    const keyboard = result.buttons.length > 0 ? setPendingTreeKeyboard(chatId, result.buttons) : undefined;

    if (!keyboard) {
      clearPendingTreeKeyboard(chatId);
    }

    await safeEditMessage(bot, chatId, messageId, result.text, {
      fallbackText: stripHtml(result.text),
      replyMarkup: keyboard,
    });
  });

  bot.on("message:text", async (ctx) => {
    const userText = ctx.message.text.trim();
    if (!userText || userText.startsWith("/")) {
      return;
    }

    await handleUserPrompt(ctx, ctx.chat.id, userText);
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const chatId = ctx.chat.id;
    if (isBusy()) {
      await sendBusyReply(ctx);
      return;
    }

    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) {
      return;
    }

    isTranscribing = true;
    let tempFilePath: string | undefined;
    let transcript: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId);

      const result = await transcribeAudio(tempFilePath);
      transcript = result.text.trim();
      if (!transcript) {
        await safeReply(ctx, escapeHTML("Transcription was empty. Please try again or send text instead."), {
          fallbackText: "Transcription was empty. Please try again or send text instead.",
        });
        return;
      }

      const preview = truncateText(transcript.replace(/\s+/g, " "), 240);
      await safeReply(
        ctx,
        `🎤 ${escapeHTML(preview)} <i>(via ${escapeHTML(result.backend)})</i>`,
        { fallbackText: `🎤 ${preview} (via ${result.backend})` },
      );
    } catch (error) {
      await safeReply(ctx, `<b>Transcription failed:</b>\n${escapeHTML(formatError(error))}`, {
        fallbackText: `Transcription failed:\n${formatError(error)}`,
      });
      return;
    } finally {
      isTranscribing = false;
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    if (!transcript) {
      return;
    }

    await handleUserPrompt(ctx, chatId, transcript);
  });

  bot.catch((error) => {
    const msg = error.error instanceof Error ? error.error.message : String(error.error);
    console.error("Telegram bot error:", msg);
  });

  return bot;
}

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Welcome and session info" },
    { command: "new", description: "Start a new session" },
    { command: "handback", description: "Hand session back to Pi CLI" },
    { command: "abort", description: "Cancel current operation" },
    { command: "session", description: "Current session details" },
    { command: "sessions", description: "List and switch sessions (or /sessions <path>)" },
    { command: "model", description: "Switch AI model" },
    { command: "tree", description: "View and navigate the session tree" },
    { command: "branch", description: "Navigate to a tree entry (/branch <id>)" },
    { command: "label", description: "Label an entry (/label [name] or /label <id> <name>)" },
  ]);
}

function renderSessionInfoPlain(info: PiSessionInfo): string {
  return [
    `Session ID: ${info.sessionId}`,
    `Session file: ${info.sessionFile ?? "(in-memory)"}`,
    `Workspace: ${info.workspace}`,
    info.sessionName ? `Session name: ${info.sessionName}` : undefined,
    info.model ? `Model: ${info.model}` : undefined,
    info.modelFallbackMessage ? `Model note: ${info.modelFallbackMessage}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderSessionInfoHTML(info: PiSessionInfo): string {
  return [
    `<b>Session ID:</b> <code>${escapeHTML(info.sessionId)}</code>`,
    `<b>Session file:</b> <code>${escapeHTML(info.sessionFile ?? "(in-memory)")}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
    info.sessionName ? `<b>Session name:</b> <code>${escapeHTML(info.sessionName)}</code>` : undefined,
    info.model ? `<b>Model:</b> <code>${escapeHTML(info.model)}</code>` : undefined,
    info.modelFallbackMessage
      ? `<b>Model note:</b> ${escapeHTML(info.modelFallbackMessage)}`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderVoiceSupportPlain(backends: string[]): string {
  if (backends.length === 0) {
    return "Voice transcription: unavailable (install parakeet-coreml + ffmpeg or set OPENAI_API_KEY).";
  }

  return `Voice transcription: ${backends.join(", ")}.`;
}

function renderVoiceSupportHTML(backends: string[]): string {
  if (backends.length === 0) {
    return "<i>Voice transcription unavailable.</i> Install <code>parakeet-node</code> or set <code>OPENAI_API_KEY</code>.";
  }

  return `<i>Voice transcription available via:</i> <code>${escapeHTML(backends.join(", "))}</code>`;
}

function renderToolStartMessage(toolName: string): RenderedText {
  return {
    text: `<b>🔧 Running:</b> <code>${escapeHTML(toolName)}</code>`,
    fallbackText: `🔧 Running: ${toolName}`,
    parseMode: "HTML",
  };
}

function renderToolEndMessage(toolName: string, partialResult: string, isError: boolean): RenderedText {
  const preview = summarizeToolOutput(partialResult);
  const icon = isError ? "❌" : "✅";
  const htmlLines = [`<b>${icon}</b> <code>${escapeHTML(toolName)}</code>`];
  const plainLines = [`${icon} ${toolName}`];

  if (preview) {
    htmlLines.push(`<pre>${escapeHTML(preview)}</pre>`);
    plainLines.push(preview);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

function formatToolSummaryLine(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) {
    return "";
  }

  const entries = [...toolCounts.entries()].sort((left, right) => {
    const countDelta = right[1] - left[1];
    return countDelta !== 0 ? countDelta : left[0].localeCompare(right[0]);
  });
  const totalCount = entries.reduce((sum, [, n]) => sum + n, 0);
  const label = totalCount === 1 ? "tool used" : "tools used";
  const tools = entries
    .map(([name, n]) => (n === 1 ? name : `${name} ×${n}`))
    .join(", ");
  return `🔧 ${totalCount} ${label}: ${tools}`;
}

async function safeReply(ctx: Context, text: string, options: TextOptions = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  // Default to HTML parse mode for all replies (unless explicitly overridden)
  const parseMode = options.parseMode !== undefined ? options.parseMode : ("HTML" as TelegramParseMode);

  const chunks = splitTelegramText(text);
  const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, chatId, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
    });
  }
}

async function sendTextMessage(
  api: Context["api"],
  chatId: TelegramChatId,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode")
    ? options.parseMode
    : "HTML";

  try {
    return await api.sendMessage(chatId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      return await api.sendMessage(chatId, options.fallbackText, {
        reply_markup: options.replyMarkup,
      });
    }
    throw error;
  }
}

async function safeEditMessage(
  bot: Bot<Context>,
  chatId: TelegramChatId,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode")
    ? options.parseMode
    : "HTML";

  try {
    await bot.api.editMessageText(chatId, messageId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      await bot.api.editMessageText(chatId, messageId, options.fallbackText, {
        reply_markup: options.replyMarkup,
      });
      return;
    }

    throw error;
  }
}

const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

async function downloadTelegramFile(api: Context["api"], token: string, fileId: string): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  if (file.file_size && file.file_size > MAX_AUDIO_FILE_SIZE) {
    throw new Error(`Audio file too large (${Math.round(file.file_size / 1024 / 1024)} MB, max 25 MB)`);
  }

  // URL contains the bot token — do not log this variable
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download voice file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(file.file_path) || ".ogg";
  const tempPath = path.join(tmpdir(), `telepi-voice-${randomUUID()}${extension}`);
  await writeFile(tempPath, buffer);
  return tempPath;
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

function splitMarkdownForTelegram(markdown: string): RenderedChunk[] {
  if (!markdown) {
    return [];
  }

  const chunks: RenderedChunk[] = [];
  let remaining = markdown;

  while (remaining) {
    const maxLength = Math.min(remaining.length, FORMATTED_CHUNK_TARGET);
    const initialCut = findPreferredSplitIndex(remaining, maxLength);
    const candidate = remaining.slice(0, initialCut) || remaining.slice(0, 1);
    const rendered = renderMarkdownChunkWithinLimit(candidate);

    chunks.push(rendered);
    remaining = remaining.slice(rendered.sourceText.length).trimStart();
  }

  return chunks;
}

function renderMarkdownChunkWithinLimit(markdown: string): RenderedChunk {
  if (!markdown) {
    return {
      text: "",
      fallbackText: "",
      parseMode: "HTML",
      sourceText: "",
    };
  }

  let sourceText = markdown;
  let rendered = formatMarkdownMessage(sourceText);

  while (rendered.text.length > TELEGRAM_MESSAGE_LIMIT && sourceText.length > 1) {
    const nextLength = Math.max(1, sourceText.length - Math.max(100, Math.ceil(sourceText.length * 0.1)));
    sourceText = sourceText.slice(0, nextLength).trimEnd() || sourceText.slice(0, nextLength);
    rendered = formatMarkdownMessage(sourceText);
  }

  return {
    ...rendered,
    sourceText,
  };
}

function formatMarkdownMessage(markdown: string): RenderedText {
  try {
    return {
      text: formatTelegramHTML(markdown),
      fallbackText: markdown,
      parseMode: "HTML",
    };
  } catch (error) {
    console.error("Failed to format Telegram HTML, falling back to plain text", error);
    return {
      text: markdown,
      fallbackText: markdown,
      parseMode: undefined,
    };
  }
}

function findPreferredSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return Math.max(1, text.length);
  }

  const newlineIndex = text.lastIndexOf("\n", maxLength);
  if (newlineIndex >= maxLength * 0.5) {
    return Math.max(1, newlineIndex);
  }

  const spaceIndex = text.lastIndexOf(" ", maxLength);
  if (spaceIndex >= maxLength * 0.5) {
    return Math.max(1, spaceIndex);
  }

  return Math.max(1, maxLength);
}

function buildStreamingPreview(text: string): string {
  if (text.length <= STREAMING_PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, STREAMING_PREVIEW_LIMIT)}\n\n… streaming (preview truncated)`;
}

function appendWithCap(base: string, addition: string, cap: number): string {
  const combined = `${base}${addition}`;
  return combined.length <= cap ? combined : combined.slice(-cap);
}

function summarizeToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= TOOL_OUTPUT_PREVIEW_LIMIT
    ? trimmed
    : `${trimmed.slice(-TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`;
}

function trimLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
}

function isTelegramParseError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes("unsupported start tag") ||
    message.includes("unexpected end tag") ||
    message.includes("entity name") ||
    message.includes("parse entities")
  );
}

function renderPromptFailure(accumulatedText: string, error: unknown): string {
  const message = formatError(error);
  const statusLine = isAbortError(message) ? "⏹ Aborted" : `⚠️ ${message}`;
  return accumulatedText.trim() ? `${accumulatedText.trim()}\n\n${statusLine}` : statusLine;
}

function isAbortError(message: string): boolean {
  return message.toLowerCase().includes("abort");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

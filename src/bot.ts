import { InlineKeyboard, Bot, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";

import type { TelePiConfig, ToolVerbosity } from "./config.js";
import { escapeHTML, formatTelegramHTML } from "./format.js";
import { type PiSessionInfo, type PiSessionService } from "./pi-session.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const EDIT_DEBOUNCE_MS = 1500;
const TYPING_INTERVAL_MS = 4500;
const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const STREAMING_PREVIEW_LIMIT = 3800;
const FORMATTED_CHUNK_TARGET = 3000;

type TelegramChatId = number | string;
type TelegramParseMode = "HTML";

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

export function createBot(config: TelePiConfig, piSession: PiSessionService): Bot<Context> {
  const bot = new Bot<Context>(config.telegramBotToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

  let isProcessing = false;
  const pendingSessionPicks = new Map<number, Array<{ path: string; cwd: string }>>();
  const pendingWorkspacePicks = new Map<number, string[]>();
  const pendingModelPicks = new Map<number, Array<{ provider: string; id: string }>>();

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId || !config.telegramAllowedUserIdSet.has(fromId)) {
      if (ctx.chat) {
        await safeReply(ctx, escapeHTML("Unauthorized"), { fallbackText: "Unauthorized" });
      }
      return;
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const info = piSession.getInfo();
    const plainText = [
      "TelePi is ready.",
      "",
      "Send any text message to continue the current Pi session from Telegram.",
      "",
      renderSessionInfoPlain(info),
    ].join("\n");
    const html = [
      "<b>TelePi is ready.</b>",
      "",
      "Send any text message to continue the current Pi session from Telegram.",
      "",
      renderSessionInfoHTML(info),
    ].join("\n");

    await safeReply(ctx, html, { fallbackText: plainText });
  });

  bot.command("abort", async (ctx) => {
    await piSession.abort();
    await safeReply(ctx, escapeHTML("Aborted current operation"), {
      fallbackText: "Aborted current operation",
    });
  });

  bot.command("session", async (ctx) => {
    const info = piSession.getInfo();
    await safeReply(ctx, renderSessionInfoHTML(info), {
      fallbackText: renderSessionInfoPlain(info),
    });
  });

  bot.command("sessions", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const allSessions = (await piSession.listAllSessions()).slice(0, 15);
    if (allSessions.length === 0) {
      await safeReply(ctx, escapeHTML("No saved sessions found."), {
        fallbackText: "No saved sessions found.",
      });
      return;
    }

    pendingSessionPicks.set(
      chatId,
      allSessions.map((session) => ({ path: session.path, cwd: session.cwd })),
    );

    const grouped = new Map<string, Array<(typeof allSessions)[number]>>();
    for (const session of allSessions) {
      const workspace = session.cwd || "Unknown";
      if (!grouped.has(workspace)) {
        grouped.set(workspace, []);
      }
      grouped.get(workspace)?.push(session);
    }

    const keyboard = new InlineKeyboard();
    const textLines: string[] = [];
    let globalIndex = 0;

    for (const [workspace, sessions] of grouped) {
      const shortWorkspace = getWorkspaceShortName(workspace);
      if (textLines.length > 0) {
        textLines.push("");
      }
      textLines.push(`📁 ${shortWorkspace}`);

      for (const session of sessions) {
        const label = trimLine(session.name || session.firstMessage, 35) || `Session ${globalIndex + 1}`;
        const buttonLabel = `📁 ${shortWorkspace.slice(0, 8)} · ${label.slice(0, 30)}`;
        keyboard.text(buttonLabel, `switch_${globalIndex}`).row();
        textLines.push(`  ${globalIndex + 1}. ${label} (${session.messageCount} msgs)`);
        globalIndex += 1;
      }
    }

    const plainText = [
      `Available sessions (${allSessions.length} shown):`,
      "",
      ...textLines,
      "",
      "Tap a button below to switch.",
    ].join("\n");
    const html = [
      `<b>Available sessions</b> <i>(${allSessions.length} shown)</i>`,
      "",
      ...textLines.map((line) => escapeHTML(line)),
      "",
      "Tap a button below to switch.",
    ].join("\n");

    await safeReply(ctx, html, {
      fallbackText: plainText,
      replyMarkup: keyboard,
    });
  });

  bot.command("switch", async (ctx) => {
    if (isProcessing || piSession.isStreaming()) {
      await safeReply(ctx, escapeHTML("Cannot switch sessions while a prompt is running."), {
        fallbackText: "Cannot switch sessions while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const sessionPath = rawText.replace(/^\/switch(?:@\w+)?\s*/, "").trim();
    if (!sessionPath) {
      await safeReply(
        ctx,
        escapeHTML("Usage: /switch <absolute-or-relative-session-path>\nOr run /sessions to pick from a list."),
        {
          fallbackText: "Usage: /switch <absolute-or-relative-session-path>\nOr run /sessions to pick from a list.",
        },
      );
      return;
    }

    const info = await piSession.switchSession(sessionPath);
    const plainText = `Switched session.\n\n${renderSessionInfoPlain(info)}`;
    const html = `<b>Switched session.</b>\n\n${renderSessionInfoHTML(info)}`;
    await safeReply(ctx, html, { fallbackText: plainText });
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isProcessing || piSession.isStreaming()) {
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
    const keyboard = new InlineKeyboard();
    const currentWorkspace = piSession.getCurrentWorkspace();

    for (const [index, workspace] of workspaces.entries()) {
      const shortName = getWorkspaceShortName(workspace);
      const prefix = workspace === currentWorkspace ? "📂 " : "📁 ";
      keyboard.text(`${prefix}${shortName}`, `newws_${index}`).row();
    }

    await safeReply(ctx, "<b>Select workspace for new session:</b>", {
      fallbackText: "Select workspace for new session:",
      replyMarkup: keyboard,
    });
  });

  bot.command("handback", async (ctx) => {
    if (isProcessing || piSession.isStreaming()) {
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
  });

  bot.command("model", async (ctx) => {
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

    const models = (await piSession.listModels()).slice(0, 20);
    if (models.length === 0) {
      await safeReply(ctx, escapeHTML("No models available."), {
        fallbackText: "No models available.",
      });
      return;
    }

    pendingModelPicks.set(
      chatId,
      models.map((model) => ({ provider: model.provider, id: model.id })),
    );

    const keyboard = new InlineKeyboard();
    for (const [index, model] of models.entries()) {
      const prefix = model.current ? "✅ " : "";
      const label = `${prefix}${model.name}`;
      keyboard.text(label, `model_${index}`).row();
    }

    const info = piSession.getInfo();
    const currentModelText = info.model ? `Current: ${info.model}` : "No model selected";

    await safeReply(ctx, `<b>Select a model</b>\n${escapeHTML(currentModelText)}`, {
      fallbackText: `Select a model\n${currentModelText}`,
      replyMarkup: keyboard,
    });
  });

  bot.callbackQuery("pi_abort", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Aborting..." });
    await piSession.abort();
  });

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

    if (isProcessing || piSession.isStreaming()) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching..." });
    pendingSessionPicks.delete(chatId);

    const info = await piSession.switchSession(sessions[index].path, sessions[index].cwd);
    const plainText = `Switched!\n\n${renderSessionInfoPlain(info)}`;
    const html = `<b>Switched!</b>\n\n${renderSessionInfoHTML(info)}`;

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      return;
    }

    await safeReply(ctx, html, { fallbackText: plainText });
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

    if (isProcessing || piSession.isStreaming()) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Creating session..." });
    pendingWorkspacePicks.delete(chatId);

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
    }
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

    if (isProcessing || piSession.isStreaming()) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching model..." });
    pendingModelPicks.delete(chatId);

    try {
      const modelName = await piSession.setModel(models[index].provider, models[index].id);
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
    }
  });

  bot.on("message:text", async (ctx) => {
    const userText = ctx.message.text.trim();
    if (!userText || userText.startsWith("/")) {
      return;
    }

    if (isProcessing || piSession.isStreaming()) {
      await safeReply(ctx, escapeHTML("Still working on previous message..."), {
        fallbackText: "Still working on previous message...",
      });
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

    isProcessing = true;

    const chatId = ctx.chat.id;
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
      isProcessing = false;
    }
  });

  bot.catch((error) => {
    console.error("Telegram bot error", error.error);
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
    { command: "sessions", description: "List available sessions" },
    { command: "switch", description: "Switch to another session" },
    { command: "model", description: "Switch AI model" },
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

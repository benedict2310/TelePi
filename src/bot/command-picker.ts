import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import { escapeHTML } from "../format.js";
import type { PiSessionContext, PiSessionService } from "../pi-session.js";
import { renderPrefixedError, trimLine, type RenderedText } from "./message-rendering.js";
import { KEYBOARD_PAGE_SIZE, NOOP_PAGE_CALLBACK_DATA } from "./keyboard.js";
import {
  buildCommandPickerEntries,
  filterCommandPickerEntries,
  getCommandPickerCounts,
  getCommandPickerFilterName,
  type CommandPickerEntry,
  type CommandPickerFilter,
} from "./slash-command.js";
import type { TextOptions } from "./telegram-transport.js";

export type PendingCommandPicker = {
  messageId: number;
  entries: CommandPickerEntry[];
  filter: CommandPickerFilter;
  page: number;
};

export function renderCommandPickerState(picker: PendingCommandPicker): RenderedText & {
  replyMarkup: InlineKeyboard;
  page: number;
  filteredEntries: CommandPickerEntry[];
} {
  const filteredEntries = filterCommandPickerEntries(picker.entries, picker.filter);
  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / KEYBOARD_PAGE_SIZE));
  const page = Math.max(0, Math.min(picker.page, totalPages - 1));
  const pageEntries = filteredEntries.slice(page * KEYBOARD_PAGE_SIZE, (page + 1) * KEYBOARD_PAGE_SIZE);
  const counts = getCommandPickerCounts(picker.entries);

  const keyboard = new InlineKeyboard();
  for (const entry of pageEntries) {
    keyboard.text(trimLine(entry.label, 48), `cmd_pick_${entry.id}`).row();
  }

  if (totalPages > 1) {
    if (page > 0) {
      keyboard.text("◀️ Prev", `cmd_page_${page - 1}`);
    }
    keyboard.text(`${page + 1}/${totalPages}`, NOOP_PAGE_CALLBACK_DATA);
    if (page < totalPages - 1) {
      keyboard.text("Next ▶️", `cmd_page_${page + 1}`);
    }
    keyboard.row();
  }

  const filterButtons: Array<{ filter: CommandPickerFilter; icon: string }> = [
    { filter: "all", icon: "🧭" },
    { filter: "telepi", icon: "📱" },
    { filter: "pi", icon: "⚡" },
  ];
  for (const button of filterButtons) {
    const active = picker.filter === button.filter;
    const label = `${active ? "✅ " : ""}${button.icon} ${getCommandPickerFilterName(button.filter)} ${counts[button.filter]}`;
    keyboard.text(label, `cmd_filter_${button.filter}`);
  }
  keyboard.row();

  const summary = filteredEntries.length === 0
    ? `No ${getCommandPickerFilterName(picker.filter)} commands available.`
    : `Showing ${page * KEYBOARD_PAGE_SIZE + 1}-${page * KEYBOARD_PAGE_SIZE + pageEntries.length} of ${filteredEntries.length} ${getCommandPickerFilterName(picker.filter)} commands.`;

  const plainLines = [
    "Command picker",
    `Filter: ${getCommandPickerFilterName(picker.filter)}`,
    `Page: ${page + 1}/${totalPages}`,
    summary,
    "",
    ...(pageEntries.length > 0
      ? pageEntries.map((entry) => {
        const detail = entry.kind === "pi" ? `${entry.description} [${entry.source}]` : entry.description;
        return `${entry.label.replace(/^[^/]+\s*/, "")} — ${detail}`;
      })
      : [picker.filter === "pi" ? "No Pi commands found in this session." : "No commands found for this filter."]),
    "",
    "Tap a button below to run a command.",
  ];

  const htmlLines = [
    "<b>Command picker</b>",
    `<i>Filter:</i> <b>${escapeHTML(getCommandPickerFilterName(picker.filter))}</b>`,
    `<i>Page:</i> ${page + 1}/${totalPages}`,
    `<i>${escapeHTML(summary)}</i>`,
    "",
    ...(pageEntries.length > 0
      ? pageEntries.map((entry) => entry.kind === "pi"
        ? `${escapeHTML(entry.label)} — ${escapeHTML(entry.description)} <i>(${escapeHTML(entry.source)})</i>`
        : `${escapeHTML(entry.label)} — ${escapeHTML(entry.description)}`)
      : [picker.filter === "pi" ? "<i>No Pi commands found in this session.</i>" : "<i>No commands found for this filter.</i>"]),
    "",
    "Tap a button below to run a command.",
  ];

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
    replyMarkup: keyboard,
    page,
    filteredEntries,
  };
}

export function createCommandPickerHandlers(deps: {
  bot: Bot<Context>;
  pendingCommandPickers: Map<string, PendingCommandPicker>;
  getTelegramTarget: (ctx: Context) => PiSessionContext | undefined;
  getContextKey: (target: PiSessionContext) => string;
  getOrCreateSession: (target: PiSessionContext) => Promise<PiSessionService>;
  syncChatScopedCommands: (target: PiSessionContext, slashCommands: SlashCommandInfo[]) => Promise<void>;
  isBusy: (target: PiSessionContext) => boolean;
  handleUserPrompt: (
    ctx: Context,
    target: PiSessionContext,
    userText: string,
    preloadedSlashCommands?: SlashCommandInfo[],
  ) => Promise<boolean>;
  runTelePiPickerCommand: (ctx: Context, target: PiSessionContext, command: string) => Promise<void>;
  safeReply: (ctx: Context, text: string, options?: TextOptions, target?: PiSessionContext) => Promise<void>;
  safeEditMessage: (target: PiSessionContext, messageId: number, text: string, options?: TextOptions) => Promise<void>;
  sendTextMessage: (ctx: Context, target: PiSessionContext, text: string, options?: TextOptions) => Promise<{ message_id: number }>;
}) {
  const {
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
    safeEditMessage,
    sendTextMessage,
  } = deps;

  const getPendingCommandPicker = (
    target: PiSessionContext,
    messageId?: number,
  ): { contextKey: string; picker: PendingCommandPicker } | undefined => {
    if (!messageId) {
      return undefined;
    }

    const contextKey = getContextKey(target);
    const picker = pendingCommandPickers.get(contextKey);
    if (!picker || picker.messageId !== messageId) {
      return undefined;
    }

    return { contextKey, picker };
  };

  const openCommandPicker = async (
    ctx: Context,
    target: PiSessionContext,
    options?: { messageId?: number; filter?: CommandPickerFilter; page?: number },
  ): Promise<void> => {
    const contextKey = getContextKey(target);
    const piSession = await getOrCreateSession(target);

    let slashCommands: SlashCommandInfo[];
    try {
      slashCommands = await piSession.listSlashCommands();
    } catch (error) {
      const failure = renderPrefixedError("Failed to load commands", error);
      if (options?.messageId) {
        await safeEditMessage(target, options.messageId, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        });
      } else {
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
      }
      return;
    }

    try {
      await syncChatScopedCommands(target, slashCommands);
    } catch (error) {
      console.error("Failed to sync chat-scoped Telegram commands", error);
    }

    const picker: PendingCommandPicker = {
      messageId: options?.messageId ?? 0,
      entries: buildCommandPickerEntries(slashCommands),
      filter: options?.filter ?? "all",
      page: options?.page ?? 0,
    };
    const rendered = renderCommandPickerState(picker);
    picker.page = rendered.page;

    if (options?.messageId) {
      await safeEditMessage(target, options.messageId, rendered.text, {
        fallbackText: rendered.fallbackText,
        parseMode: rendered.parseMode,
        replyMarkup: rendered.replyMarkup,
      });
      picker.messageId = options.messageId;
      pendingCommandPickers.set(contextKey, picker);
      return;
    }

    const message = await sendTextMessage(ctx, target, rendered.text, {
      fallbackText: rendered.fallbackText,
      parseMode: rendered.parseMode,
      replyMarkup: rendered.replyMarkup,
    });
    picker.messageId = message.message_id;
    pendingCommandPickers.set(contextKey, picker);
  };

  bot.callbackQuery(/^cmd_page_(\d+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const page = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!target || !messageId || Number.isNaN(page)) {
      return;
    }

    const activePicker = getPendingCommandPicker(target, messageId);
    if (!activePicker) {
      await ctx.answerCallbackQuery({ text: "Expired, run /commands again" });
      return;
    }

    activePicker.picker.page = page;
    const rendered = renderCommandPickerState(activePicker.picker);
    activePicker.picker.page = rendered.page;
    pendingCommandPickers.set(activePicker.contextKey, activePicker.picker);

    await ctx.answerCallbackQuery();
    await safeEditMessage(target, messageId, rendered.text, {
      fallbackText: rendered.fallbackText,
      parseMode: rendered.parseMode,
      replyMarkup: rendered.replyMarkup,
    });
  });

  bot.callbackQuery(/^cmd_filter_(all|telepi|pi)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const filter = ctx.match?.[1] as CommandPickerFilter | undefined;

    if (!target || !messageId || !filter) {
      return;
    }

    const activePicker = getPendingCommandPicker(target, messageId);
    if (!activePicker) {
      await ctx.answerCallbackQuery({ text: "Expired, run /commands again" });
      return;
    }

    activePicker.picker.filter = filter;
    activePicker.picker.page = 0;
    const rendered = renderCommandPickerState(activePicker.picker);
    activePicker.picker.page = rendered.page;
    pendingCommandPickers.set(activePicker.contextKey, activePicker.picker);

    await ctx.answerCallbackQuery({ text: `Showing ${getCommandPickerFilterName(filter)} commands` });
    await safeEditMessage(target, messageId, rendered.text, {
      fallbackText: rendered.fallbackText,
      parseMode: rendered.parseMode,
      replyMarkup: rendered.replyMarkup,
    });
  });

  bot.callbackQuery(/^cmd_pick_(\d+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!target || !messageId || Number.isNaN(index)) {
      return;
    }

    const activePicker = getPendingCommandPicker(target, messageId);
    if (!activePicker) {
      await ctx.answerCallbackQuery({ text: "Expired, run /commands again" });
      return;
    }

    const entry = activePicker.picker.entries.find((item) => item.id === index);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "Expired, run /commands again" });
      return;
    }

    if (entry.kind === "pi") {
      if (isBusy(target)) {
        await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
        return;
      }

      pendingCommandPickers.delete(activePicker.contextKey);
      await ctx.answerCallbackQuery({ text: `Running ${trimLine(entry.commandText, 32)}` });
      await handleUserPrompt(ctx, target, entry.commandText);
      return;
    }

    pendingCommandPickers.delete(activePicker.contextKey);
    await ctx.answerCallbackQuery({ text: `Opening ${trimLine(entry.commandText, 32)}` });
    await runTelePiPickerCommand(ctx, target, entry.command);
  });

  return {
    openCommandPicker,
  };
}

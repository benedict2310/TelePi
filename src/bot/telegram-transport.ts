import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type InlineKeyboard, Bot, type Context } from "grammy";

import {
  isMessageNotModifiedError,
  isTelegramParseError,
  splitTelegramText,
  type TelegramParseMode,
} from "./message-rendering.js";
import type { PiSessionContext } from "../pi-session.js";

export type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  rich?: boolean;
};

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

export function getTelegramTarget(ctx: Context): PiSessionContext | undefined {
  const chatId = ctx.chat?.id;
  if (chatId === undefined || chatId === null) {
    return undefined;
  }

  const messageThreadId =
    ctx.message?.message_thread_id ??
    (ctx.callbackQuery?.message && "message_thread_id" in ctx.callbackQuery.message
      ? ctx.callbackQuery.message.message_thread_id
      : undefined);

  return messageThreadId !== undefined ? { chatId, messageThreadId } : { chatId };
}

export async function safeReply(
  ctx: Context,
  text: string,
  options: TextOptions = {},
  target = getTelegramTarget(ctx),
): Promise<void> {
  if (!target) {
    return;
  }

  const parseMode = options.parseMode !== undefined ? options.parseMode : ("HTML" as TelegramParseMode);

  const chunks = splitTelegramText(text);
  const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, target, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
    });
  }
}

export async function sendTextMessage(
  api: Context["api"],
  target: PiSessionContext,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  if (options.rich) {
    return await api.sendRichMessage(target.chatId, { markdown: text }, {
      ...(target.messageThreadId !== undefined ? { message_thread_id: target.messageThreadId } : {}),
      reply_markup: options.replyMarkup,
    });
  }

  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode")
    ? options.parseMode
    : "HTML";

  try {
    return await api.sendMessage(target.chatId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(target.messageThreadId !== undefined ? { message_thread_id: target.messageThreadId } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      return await api.sendMessage(target.chatId, options.fallbackText, {
        ...(target.messageThreadId !== undefined ? { message_thread_id: target.messageThreadId } : {}),
        reply_markup: options.replyMarkup,
      });
    }
    throw error;
  }
}

export async function safeEditMessage(
  bot: Bot<Context>,
  target: PiSessionContext,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  if (options.rich) {
    // if in rich mode, we do not send parse_mode, and we send InputRichMessage into the text arg
    await bot.api.editMessageText(target.chatId, messageId, { markdown: text }, {
      reply_markup: options.replyMarkup,
    });
    return;
  }

  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode")
    ? options.parseMode
    : "HTML";

  try {
    await bot.api.editMessageText(target.chatId, messageId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      await bot.api.editMessageText(target.chatId, messageId, options.fallbackText, {
        reply_markup: options.replyMarkup,
      });
      return;
    }

    throw error;
  }
}

export async function sendChatAction(
  api: Context["api"],
  target: PiSessionContext,
  action: "typing",
): Promise<void> {
  await api.sendChatAction(target.chatId, action, {
    ...(target.messageThreadId !== undefined ? { message_thread_id: target.messageThreadId } : {}),
  });
}

export async function downloadTelegramFile(
  api: Context["api"],
  token: string,
  fileId: string,
  options: {
    maxFileSizeBytes?: number;
    fileKind?: string;
    tempFilePrefix?: string;
  } = {},
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  const maxFileSizeBytes = options.maxFileSizeBytes ?? MAX_FILE_SIZE;
  if (file.file_size && file.file_size > maxFileSizeBytes) {
    const label = options.fileKind ?? "File";
    throw new Error(`${label} too large (${Math.round(file.file_size / 1024 / 1024)} MB, max ${Math.round(maxFileSizeBytes / 1024 / 1024)} MB)`);
  }

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${options.fileKind ?? "voice file"}: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(file.file_path) || ".ogg";
  const tempPrefix = options.tempFilePrefix ?? "telepi-voice";
  const tempPath = path.join(tmpdir(), `${tempPrefix}-${randomUUID()}${extension}`);
  await writeFile(tempPath, buffer);
  return tempPath;
}

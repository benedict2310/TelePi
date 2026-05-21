import type { Context } from "grammy";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import { escapeHTML } from "../../format.js";
import type { PiSessionContext, PiSessionInfo, PiSessionService } from "../../pi-session.js";
import type { KeyboardItem } from "../keyboard.js";
import { getWorkspaceShortName, renderFailedText, renderPrefixedError, renderSessionInfoHTML, renderSessionInfoPlain, trimLine } from "../message-rendering.js";
import type { TextOptions } from "../telegram-transport.js";

export function createSessionCommandHandlers(deps: {
  getContextKey: (target: PiSessionContext) => string;
  getOrCreateSession: (target: PiSessionContext) => Promise<PiSessionService>;
  getExistingSession: (target: PiSessionContext) => PiSessionService | undefined;
  isBusy: (target: PiSessionContext) => boolean;
  beginSwitching: (target: PiSessionContext) => void;
  endSwitching: (target: PiSessionContext) => void;
  buildKeyboard: (items: KeyboardItem[], page: number, prefix: string, extraItems?: KeyboardItem[]) => any;
  clearContextPickers: (contextKey: string) => void;
  clearContextPromptMemory: (target: PiSessionContext) => void;
  refreshChatScopedCommands: (target: PiSessionContext, piSession: PiSessionService) => Promise<void>;
  syncChatScopedCommands: (target: PiSessionContext, slashCommands: SlashCommandInfo[]) => Promise<void>;
  setChatCommandSignature: (chatId: number | string, signature?: string) => void;
  removeSession: (target: PiSessionContext) => void;
  pendingSessionPicks: Map<string, Array<{ path: string; cwd: string }>>;
  pendingSessionButtons: Map<string, KeyboardItem[]>;
  pendingWorkspacePicks: Map<string, string[]>;
  pendingWorkspaceButtons: Map<string, KeyboardItem[]>;
  safeReply: (ctx: Context, text: string, options?: TextOptions, target?: PiSessionContext) => Promise<void>;
  surfaceStartupErrorDiagnostics: (ctx: Context, target: PiSessionContext, info: PiSessionInfo) => Promise<void>;
}) {
  const {
    getContextKey,
    getOrCreateSession,
    getExistingSession,
    isBusy,
    beginSwitching,
    endSwitching,
    buildKeyboard,
    clearContextPickers,
    clearContextPromptMemory,
    refreshChatScopedCommands,
    syncChatScopedCommands,
    setChatCommandSignature,
    removeSession,
    pendingSessionPicks,
    pendingSessionButtons,
    pendingWorkspacePicks,
    pendingWorkspaceButtons,
    safeReply,
    surfaceStartupErrorDiagnostics,
  } = deps;

  const handleSessionsCommand = async (
    ctx: Context,
    target: PiSessionContext,
    commandText?: string,
  ): Promise<void> => {
    const contextKey = getContextKey(target);

    if (isBusy(target)) {
      await safeReply(ctx, escapeHTML("Cannot switch sessions while a prompt is running."), {
        fallbackText: "Cannot switch sessions while a prompt is running.",
      }, target);
      return;
    }

    const piSession = await getOrCreateSession(target);
    const rawText = commandText ?? ctx.message?.text ?? "";
    const sessionReference = rawText.replace(/^\/(?:sessions|switch)(?:@\w+)?\s*/, "").trim();
    if (sessionReference) {
      beginSwitching(target);
      try {
        const resolvedSession = await piSession.resolveSessionReference(sessionReference);
        const info = await piSession.switchSession(resolvedSession.path, resolvedSession.cwd);
        if (info.cancelled) {
          await safeReply(ctx, escapeHTML("Session switch was cancelled."), {
            fallbackText: "Session switch was cancelled.",
          }, target);
          return;
        }

        await refreshChatScopedCommands(target, piSession);
        clearContextPickers(contextKey);
        clearContextPromptMemory(target);
        const workspaceNotePlain = resolvedSession.workspaceWarning
          ? `\n\nWorkspace note: ${resolvedSession.workspaceWarning}`
          : "";
        const workspaceNoteHTML = resolvedSession.workspaceWarning
          ? `\n\n<b>Workspace note:</b> ${escapeHTML(resolvedSession.workspaceWarning)}`
          : "";
        const plainText = `Switched session.${workspaceNotePlain}\n\n${renderSessionInfoPlain(info)}`;
        const html = `<b>Switched session.</b>${workspaceNoteHTML}\n\n${renderSessionInfoHTML(info)}`;
        await safeReply(ctx, html, { fallbackText: plainText }, target);
        await surfaceStartupErrorDiagnostics(ctx, target, info);
      } catch (error) {
        const failure = renderFailedText(error);
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
      } finally {
        endSwitching(target);
      }
      return;
    }

    const allSessions = await piSession.listAllSessions();
    if (allSessions.length === 0) {
      await safeReply(ctx, escapeHTML("No saved sessions found."), {
        fallbackText: "No saved sessions found.",
      }, target);
      return;
    }

    const orderedPicks: Array<{ path: string; cwd: string }> = [];
    const sessionButtons: KeyboardItem[] = allSessions.map((session, idx) => {
      const shortWorkspace = getWorkspaceShortName(session.cwd || "Unknown");
      const label = trimLine(session.name || session.firstMessage, 35) || `Session ${idx + 1}`;
      orderedPicks.push({ path: session.path, cwd: session.cwd });
      return {
        label: `📁 ${shortWorkspace.slice(0, 8)} · ${label.slice(0, 30)}`,
        callbackData: `switch_${idx}`,
      };
    });

    pendingSessionPicks.set(contextKey, orderedPicks);
    pendingSessionButtons.set(contextKey, sessionButtons);

    const keyboard = buildKeyboard(sessionButtons, 0, "switch");
    const plainText = `Select a session to switch (${allSessions.length} found).`;
    const html = `<b>Select a session to switch</b> <i>(${allSessions.length} found)</i>`;

    await safeReply(ctx, html, {
      fallbackText: plainText,
      replyMarkup: keyboard,
    }, target);
  };

  const handleNewCommand = async (ctx: Context, target: PiSessionContext): Promise<void> => {
    const contextKey = getContextKey(target);

    if (isBusy(target)) {
      await safeReply(ctx, escapeHTML("Cannot create new session while a prompt is running."), {
        fallbackText: "Cannot create new session while a prompt is running.",
      }, target);
      return;
    }

    const piSession = await getOrCreateSession(target);
    const workspaces = await piSession.listWorkspaces();

    if (workspaces.length <= 1) {
      try {
        const { info, created } = await piSession.newSession();
        if (!created) {
          await safeReply(ctx, escapeHTML("New session was cancelled."), {
            fallbackText: "New session was cancelled.",
          }, target);
          return;
        }

        await refreshChatScopedCommands(target, piSession);
        clearContextPickers(contextKey);
        clearContextPromptMemory(target);
        const plainText = `New session created.\n\n${renderSessionInfoPlain(info)}`;
        const html = `<b>New session created.</b>\n\n${renderSessionInfoHTML(info)}`;
        await safeReply(ctx, html, { fallbackText: plainText }, target);
        await surfaceStartupErrorDiagnostics(ctx, target, info);
      } catch (error) {
        const failure = renderFailedText(error);
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
      }
      return;
    }

    pendingWorkspacePicks.set(contextKey, workspaces);
    const currentWorkspace = piSession.getCurrentWorkspace();
    const workspaceButtons = workspaces.map((workspace, index) => {
      const shortName = getWorkspaceShortName(workspace);
      const prefix = workspace === currentWorkspace ? "📂 " : "📁 ";
      return {
        label: `${prefix}${shortName}`,
        callbackData: `newws_${index}`,
      };
    });
    pendingWorkspaceButtons.set(contextKey, workspaceButtons);

    await safeReply(ctx, "<b>Select workspace for new session:</b>", {
      fallbackText: "Select workspace for new session:",
      replyMarkup: buildKeyboard(workspaceButtons, 0, "newws"),
    }, target);
  };

  const handleHandbackCommand = async (ctx: Context, target: PiSessionContext): Promise<void> => {
    const contextKey = getContextKey(target);
    const piSession = getExistingSession(target);

    if (isBusy(target)) {
      await safeReply(ctx, escapeHTML("Cannot hand back while a prompt is running. Use /abort first."), {
        fallbackText: "Cannot hand back while a prompt is running. Use /abort first.",
      }, target);
      return;
    }

    if (!piSession?.hasActiveSession()) {
      await safeReply(ctx, escapeHTML("No active session to hand back."), {
        fallbackText: "No active session to hand back.",
      }, target);
      return;
    }

    try {
      const { sessionFile, workspace } = await piSession.handback();
      clearContextPickers(contextKey);
      clearContextPromptMemory(target);
      removeSession(target);
      setChatCommandSignature(target.chatId, undefined);
      try {
        await syncChatScopedCommands(target, []);
      } catch (error) {
        console.error("Failed to reset chat-scoped Telegram commands", error);
      }

      if (!sessionFile) {
        await safeReply(ctx, escapeHTML("Session was in-memory. No file to resume.\nUse /new to start a fresh session."), {
          fallbackText: "Session was in-memory. No file to resume.\nUse /new to start a fresh session.",
        }, target);
        return;
      }

      const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
      const piCommand = `cd ${shellEscape(workspace)} && pi --session ${shellEscape(sessionFile)}`;
      const piContinueCommand = `cd ${shellEscape(workspace)} && pi -c`;

      let copiedToClipboard = false;
      try {
        const { copyToClipboard: copyToClipboardUtil } = await import("../../install/clipboard.js");
        copiedToClipboard = await copyToClipboardUtil(piCommand);
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

      await safeReply(ctx, html, { fallbackText: plainText }, target);
    } catch (error) {
      const failure = renderFailedText(error);
      await safeReply(ctx, failure.text, {
        fallbackText: failure.fallbackText,
        parseMode: failure.parseMode,
      }, target);
    }
  };

  return {
    handleSessionsCommand,
    handleNewCommand,
    handleHandbackCommand,
  };
}

import { toFriendlyError } from "../errors.js";
import { escapeHTML, formatTelegramHTML } from "../format.js";
import type { PiSessionDiagnostic, PiSessionInfo } from "../pi-session.js";

export type TelegramParseMode = "HTML";

export type RenderedText = {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
};

export type RenderedChunk = RenderedText & {
  sourceText: string;
};

export const TELEGRAM_MESSAGE_LIMIT = 4000;
export const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const STREAMING_PREVIEW_LIMIT = 3800;
const FORMATTED_CHUNK_TARGET = 3000;

export function renderHelpPlain(info: PiSessionInfo): string {
  return [
    "TelePi commands:",
    "/start — welcome message and session info",
    "/help — show this help",
    "/commands — browse TelePi and Pi commands",
    "/new — start a new session",
    "/retry — resend the last prompt in this chat/topic",
    "/handback — hand the current session back to Pi CLI",
    "/abort — cancel the current Pi operation",
    "/session — show current session details",
    "/sessions — list and switch saved sessions",
    "/sessions <path|id> — switch directly to a session file or session ID",
    "/context — show context usage and session stats",
    "/model — switch AI model",
    "/thinking — set thinking level",
    "/tree — view the session tree",
    "/branch <id> — navigate to a tree entry",
    "/label [args] — add, clear, or list labels",
    "",
    "Notes:",
    "- Each Telegram chat/topic has its own Pi session and retry history.",
    "- Voice messages are transcribed and then sent as prompts.",
    "",
    renderSessionInfoPlain(info),
  ].join("\n");
}

export function renderHelpHTML(info: PiSessionInfo): string {
  return [
    "<b>TelePi commands</b>",
    "<code>/start</code> — welcome message and session info",
    "<code>/help</code> — show this help",
    "<code>/commands</code> — browse TelePi and Pi commands",
    "<code>/new</code> — start a new session",
    "<code>/retry</code> — resend the last prompt in this chat/topic",
    "<code>/handback</code> — hand the current session back to Pi CLI",
    "<code>/abort</code> — cancel the current Pi operation",
    "<code>/session</code> — show current session details",
    "<code>/sessions</code> — list and switch saved sessions",
    "<code>/sessions &lt;path|id&gt;</code> — switch directly to a session file or session ID",
    "<code>/context</code> — show context usage and session stats",
    "<code>/model</code> — switch AI model",
    "<code>/thinking</code> — set thinking level",
    "<code>/tree</code> — view the session tree",
    "<code>/branch &lt;id&gt;</code> — navigate to a tree entry",
    "<code>/label [args]</code> — add, clear, or list labels",
    "",
    "<b>Notes</b>",
    "- Each Telegram chat/topic has its own Pi session and retry history.",
    "- Voice messages are transcribed and then sent as prompts.",
    "",
    renderSessionInfoHTML(info),
  ].join("\n");
}

export function renderSessionInfoPlain(info: PiSessionInfo): string {
  const diagnostics = renderSessionDiagnosticsPlain(info.diagnostics);

  return [
    `Session ID: ${info.sessionId}`,
    `Session file: ${info.sessionFile ?? "(in-memory)"}`,
    `Workspace: ${info.workspace}`,
    info.sessionName ? `Session name: ${info.sessionName}` : undefined,
    info.model ? `Model: ${info.model}` : undefined,
    info.thinkingLevel ? `Thinking level: ${info.thinkingLevel}` : undefined,
    info.modelFallbackMessage ? `Model note: ${info.modelFallbackMessage}` : undefined,
    diagnostics ? "" : undefined,
    diagnostics,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function renderSessionInfoHTML(info: PiSessionInfo): string {
  const diagnostics = renderSessionDiagnosticsHTML(info.diagnostics);

  return [
    `<b>Session ID:</b> <code>${escapeHTML(info.sessionId)}</code>`,
    `<b>Session file:</b> <code>${escapeHTML(info.sessionFile ?? "(in-memory)")}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
    info.sessionName ? `<b>Session name:</b> <code>${escapeHTML(info.sessionName)}</code>` : undefined,
    info.model ? `<b>Model:</b> <code>${escapeHTML(info.model)}</code>` : undefined,
    info.thinkingLevel
      ? `<b>Thinking level:</b> <code>${escapeHTML(info.thinkingLevel)}</code>`
      : undefined,
    info.modelFallbackMessage
      ? `<b>Model note:</b> ${escapeHTML(info.modelFallbackMessage)}`
      : undefined,
    diagnostics ? "" : undefined,
    diagnostics,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderSessionDiagnosticsPlain(diagnostics: PiSessionDiagnostic[] | undefined): string | undefined {
  return renderSessionDiagnostics(diagnostics, {
    errorLabel: "Errors:",
    warningLabel: "Warnings:",
    infoLabel: "Notes:",
    renderItem: (message) => `- ${message}`,
  });
}

function renderSessionDiagnosticsHTML(diagnostics: PiSessionDiagnostic[] | undefined): string | undefined {
  return renderSessionDiagnostics(diagnostics, {
    errorLabel: "<b>Errors:</b>",
    warningLabel: "<b>Warnings:</b>",
    infoLabel: "<b>Notes:</b>",
    renderItem: (message) => `• ${escapeHTML(message)}`,
  });
}

function renderSessionDiagnostics(
  diagnostics: PiSessionDiagnostic[] | undefined,
  options: {
    errorLabel: string;
    warningLabel: string;
    infoLabel: string;
    renderItem: (message: string) => string;
  },
): string | undefined {
  if (!diagnostics || diagnostics.length === 0) {
    return undefined;
  }

  const groups: Array<{ type: PiSessionDiagnostic["type"]; label: string }> = [
    { type: "error", label: options.errorLabel },
    { type: "warning", label: options.warningLabel },
    { type: "info", label: options.infoLabel },
  ];
  const lines: string[] = [];

  for (const group of groups) {
    const matching = diagnostics.filter((diagnostic) => diagnostic.type === group.type);
    if (matching.length === 0) {
      continue;
    }

    if (lines.length > 0) {
      lines.push("");
    }

    lines.push(group.label);
    lines.push(...matching.map((diagnostic) => options.renderItem(diagnostic.message)));
  }

  return lines.join("\n");
}

export interface ContextUsageInfo {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface SessionStatsInfo {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsageInfo;
  sessionFile: string | undefined;
  sessionId: string;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function renderContextUsagePlain(usage: ContextUsageInfo): string {
  const tokenLine = usage.tokens !== null
    ? `Tokens in context: ${formatNumber(usage.tokens)}`
    : "Tokens in context: unknown (not yet estimated)";
  const windowLine = `Context window: ${formatNumber(usage.contextWindow)}`;
  const percentLine = usage.percent !== null
    ? `Usage: ${usage.percent.toFixed(2)}%`
    : "Usage: unknown";
  return [tokenLine, windowLine, percentLine].join("\n");
}

export function renderContextUsageHTML(usage: ContextUsageInfo): string {
  const tokenLine = usage.tokens !== null
    ? `<b>Tokens in context:</b> <code>${formatNumber(usage.tokens)}</code>`
    : `<b>Tokens in context:</b> <i>unknown (not yet estimated)</i>`;
  const windowLine = `<b>Context window:</b> <code>${formatNumber(usage.contextWindow)}</code>`;
  const percentLine = usage.percent !== null
    ? `<b>Usage:</b> <code>${usage.percent.toFixed(2)}%</code>`
    : `<b>Usage:</b> <i>unknown</i>`;
  return [tokenLine, windowLine, percentLine].join("\n");
}

export function renderSessionStatsPlain(stats: SessionStatsInfo): string {
  return [
    `Messages: ${stats.userMessages} user, ${stats.assistantMessages} assistant (${stats.totalMessages} total)`,
    `Tool calls: ${stats.toolCalls}`,
    `Tokens: ${formatNumber(stats.tokens.input)} input, ${formatNumber(stats.tokens.output)} output (${formatNumber(stats.tokens.total)} total)`,
    stats.tokens.cacheRead > 0 || stats.tokens.cacheWrite > 0
      ? `Cache: ${formatNumber(stats.tokens.cacheRead)} read, ${formatNumber(stats.tokens.cacheWrite)} write`
      : undefined,
    stats.cost > 0 ? `Estimated cost: $${stats.cost.toFixed(4)}` : undefined,
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function renderSessionStatsHTML(stats: SessionStatsInfo): string {
  const cacheLine = stats.tokens.cacheRead > 0 || stats.tokens.cacheWrite > 0
    ? `<b>Cache:</b> <code>${formatNumber(stats.tokens.cacheRead)}</code> read, <code>${formatNumber(stats.tokens.cacheWrite)}</code> write`
    : undefined;
  const costLine = stats.cost > 0
    ? `<b>Estimated cost:</b> <code>$${stats.cost.toFixed(4)}</code>`
    : undefined;
  return [
    `<b>Messages:</b> <code>${stats.userMessages}</code> user, <code>${stats.assistantMessages}</code> assistant (<code>${stats.totalMessages}</code> total)`,
    `<b>Tool calls:</b> <code>${stats.toolCalls}</code>`,
    `<b>Tokens:</b> <code>${formatNumber(stats.tokens.input)}</code> input, <code>${formatNumber(stats.tokens.output)}</code> output (<code>${formatNumber(stats.tokens.total)}</code> total)`,
    cacheLine,
    costLine,
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function renderVoiceSupportPlain(backends: string[], warning?: string): string {
  const status = backends.length === 0
    ? "Voice transcription: unavailable (install parakeet-coreml + ffmpeg, or on Intel Macs install sherpa-onnx-node + SHERPA_ONNX_MODEL_DIR, or set OPENAI_API_KEY)."
    : `Voice transcription: ${backends.join(", ")}.`;

  return warning ? `${status}\nWarning: ${warning}` : status;
}

export function renderVoiceSupportHTML(backends: string[], warning?: string): string {
  const status = backends.length === 0
    ? "<i>Voice transcription unavailable.</i> Install <code>parakeet-coreml</code>, or on Intel Macs install <code>sherpa-onnx-node</code> with <code>SHERPA_ONNX_MODEL_DIR</code>, or set <code>OPENAI_API_KEY</code>."
    : `<i>Voice transcription available via:</i> <code>${escapeHTML(backends.join(", "))}</code>`;

  return warning ? `${status}\n⚠️ ${escapeHTML(warning)}` : status;
}

const DIALOG_PANEL_MIN_WIDTH = 22;
const DIALOG_PANEL_MAX_WIDTH = 36;

export function renderDialogPanel(title: string, bodyLines: string[], titleIcon?: string): RenderedText {
  const panelText = buildDialogPanelText(titleIcon ? `${titleIcon} ${title}` : title, bodyLines);
  return {
    text: `<pre>${escapeHTML(panelText)}</pre>`,
    fallbackText: panelText,
    parseMode: "HTML",
  };
}

export function renderToolStartMessage(toolName: string): RenderedText {
  return {
    text: `<b>🔧 Running:</b> <code>${escapeHTML(toolName)}</code>`,
    fallbackText: `🔧 Running: ${toolName}`,
    parseMode: "HTML",
  };
}

export function renderToolEndMessage(toolName: string, partialResult: string, isError: boolean): RenderedText {
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

export function formatToolSummaryLine(toolCounts: Map<string, number>): string {
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

export function splitTelegramText(text: string): string[] {
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

export function splitMarkdownForTelegram(markdown: string): RenderedChunk[] {
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

export function renderMarkdownChunkWithinLimit(markdown: string): RenderedChunk {
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

export function formatMarkdownMessage(markdown: string): RenderedText {
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

export function findPreferredSplitIndex(text: string, maxLength: number): number {
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

export function buildStreamingPreview(text: string): string {
  if (text.length <= STREAMING_PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, STREAMING_PREVIEW_LIMIT)}\n\n… streaming (preview truncated)`;
}

export function appendWithCap(base: string, addition: string, cap: number): string {
  const combined = `${base}${addition}`;
  return combined.length <= cap ? combined : combined.slice(-cap);
}

export function summarizeToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= TOOL_OUTPUT_PREVIEW_LIMIT
    ? trimmed
    : `${trimmed.slice(-TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`;
}

export function trimLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 1)}…`;
}

export function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

export function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

export function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
}

export function isTelegramParseError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes("unsupported start tag") ||
    message.includes("unexpected end tag") ||
    message.includes("entity name") ||
    message.includes("parse entities")
  );
}

export function renderPromptFailure(accumulatedText: string, error: unknown): string {
  const message = toFriendlyError(error);
  const statusLine = isAbortError(message) ? "⏹ Aborted" : `⚠️ ${message}`;
  return accumulatedText.trim() ? `${accumulatedText.trim()}\n\n${statusLine}` : statusLine;
}

export function renderFailedText(error: unknown): RenderedText {
  return renderPrefixedError("Failed", error);
}

export function renderExtensionNotice(
  message: string,
  type: "info" | "warning" | "error" = "info",
): RenderedText {
  const prefix = type === "error" ? "❌" : type === "warning" ? "⚠️" : "ℹ️";
  return {
    text: `<b>${prefix}</b> ${escapeHTML(message)}`,
    fallbackText: `${prefix} ${message}`,
    parseMode: "HTML",
  };
}

export function renderExtensionError(extensionPath: string, event: string, error: string): RenderedText {
  if (event === "command" && extensionPath.startsWith("command:")) {
    const commandName = extensionPath.slice("command:".length);
    return {
      text: `<b>❌ /${escapeHTML(commandName)} failed:</b> ${escapeHTML(error)}`,
      fallbackText: `❌ /${commandName} failed: ${error}`,
      parseMode: "HTML",
    };
  }

  return {
    text: `<b>❌ Extension error:</b> ${escapeHTML(error)}`,
    fallbackText: `❌ Extension error: ${error}`,
    parseMode: "HTML",
  };
}

export function renderPrefixedError(prefix: string, error: unknown, multiline = false): RenderedText {
  const message = toFriendlyError(error);
  return {
    text: multiline
      ? `<b>${escapeHTML(prefix)}:</b>\n${escapeHTML(message)}`
      : `<b>${escapeHTML(prefix)}:</b> ${escapeHTML(message)}`,
    fallbackText: multiline ? `${prefix}:\n${message}` : `${prefix}: ${message}`,
    parseMode: "HTML",
  };
}

function buildDialogPanelText(title: string, bodyLines: string[]): string {
  const titleLines = wrapDialogPanelLine(title, DIALOG_PANEL_MAX_WIDTH);
  const wrappedBodyLines = bodyLines.flatMap((line) => {
    if (!line.trim()) {
      return [""];
    }
    return wrapDialogPanelLine(line, DIALOG_PANEL_MAX_WIDTH);
  });
  const contentWidth = Math.max(
    DIALOG_PANEL_MIN_WIDTH,
    ...titleLines.map((line) => line.length),
    ...wrappedBodyLines.map((line) => line.length),
  );
  const horizontal = "─".repeat(contentWidth + 2);
  const lines = [
    `┌${horizontal}┐`,
    ...titleLines.map((line) => frameDialogPanelLine(line, contentWidth)),
  ];

  if (wrappedBodyLines.length > 0) {
    lines.push(`├${horizontal}┤`, ...wrappedBodyLines.map((line) => frameDialogPanelLine(line, contentWidth)));
  }

  lines.push(`└${horizontal}┘`);
  return lines.join("\n");
}

function frameDialogPanelLine(text: string, width: number): string {
  return `│ ${text.padEnd(width, " ")} │`;
}

function wrapDialogPanelLine(text: string, maxWidth: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [""];
  }

  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    let remaining = word;
    while (remaining.length > maxWidth) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(remaining.slice(0, maxWidth));
      remaining = remaining.slice(maxWidth);
    }

    if (!remaining) {
      continue;
    }

    if (!current) {
      current = remaining;
      continue;
    }

    if (current.length + 1 + remaining.length <= maxWidth) {
      current += ` ${remaining}`;
      continue;
    }

    lines.push(current);
    current = remaining;
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

function isAbortError(message: string): boolean {
  return message.toLowerCase().includes("abort");
}

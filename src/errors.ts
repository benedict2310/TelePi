export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toFriendlyError(error: unknown): string {
  const rawMessage = formatError(error).trim();
  const message = rawMessage.replace(/^Pi session prompt failed:\s*/i, "").trim();
  const lower = message.toLowerCase();

  if (!message) {
    return "Something went wrong.";
  }

  if (
    lower === "aborted" ||
    lower === "request aborted" ||
    lower === "request aborted." ||
    lower.includes("abort requested")
  ) {
    return "Request aborted.";
  }

  if (lower.includes("pi session is not initialized")) {
    return "No active session. Send a message to start one.";
  }

  if (lower.startsWith("model not found:")) {
    return "That model is no longer available. Run /model again.";
  }

  if (lower.includes("telegram did not return a file path")) {
    return "Telegram did not provide the audio file. Please try again.";
  }

  const voiceDownloadStatus = message.match(/^Failed to download voice file:\s*(\d+)/i);
  if (voiceDownloadStatus) {
    return `Telegram audio download failed (${voiceDownloadStatus[1]}). Please try again.`;
  }

  if (/(network|econnreset|etimedout|enotfound|eai_again)/i.test(message)) {
    return "Network error. Please try again.";
  }

  return message;
}

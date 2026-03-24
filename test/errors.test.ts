import { formatError, toFriendlyError } from "../src/errors.js";

describe("errors", () => {
  it("formats Error instances and plain values", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
    expect(formatError("nope")).toBe("nope");
  });

  it("falls back to a generic message for empty errors", () => {
    expect(toFriendlyError("")).toBe("Something went wrong.");
  });

  it("normalizes aborted requests", () => {
    expect(toFriendlyError(new Error("Pi session prompt failed: aborted"))).toBe("Request aborted.");
    expect(toFriendlyError("Abort requested by user")).toBe("Request aborted.");
  });

  it("translates inactive-session and model lookup failures", () => {
    expect(toFriendlyError(new Error("Pi session is not initialized"))).toBe(
      "No active session. Send a message to start one.",
    );
    expect(toFriendlyError(new Error("Model not found: anthropic/fake"))).toBe(
      "That model is no longer available. Run /model again.",
    );
  });

  it("translates Telegram voice download failures", () => {
    expect(toFriendlyError(new Error("Telegram did not return a file path"))).toBe(
      "Telegram did not provide the audio file. Please try again.",
    );
    expect(toFriendlyError(new Error("Failed to download voice file: 502"))).toBe(
      "Telegram audio download failed (502). Please try again.",
    );
  });

  it("translates common network failures", () => {
    expect(toFriendlyError(new Error("fetch failed: ECONNRESET"))).toBe("Network error. Please try again.");
    expect(toFriendlyError(new Error("request ETIMEDOUT while contacting server"))).toBe(
      "Network error. Please try again.",
    );
  });

  it("preserves unknown messages after stripping wrapper prefixes", () => {
    expect(toFriendlyError(new Error("Pi session prompt failed: custom failure"))).toBe("custom failure");
  });
});

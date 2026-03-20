import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-config-"));
    process.chdir(tempDir);
    process.env = { ...originalEnv };
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    delete process.env.PI_MODEL;
    delete process.env.PI_SESSION_PATH;
    delete process.env.TOOL_VERBOSITY;
    delete process.env.container;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("loads a valid config with all required fields", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,456";
    process.env.PI_MODEL = "anthropic/claude-sonnet-4-5";
    process.env.PI_SESSION_PATH = " /tmp/session.jsonl ";
    process.env.TOOL_VERBOSITY = "all";

    const config = loadConfig();

    expect(config).toEqual({
      telegramBotToken: "bot-token",
      telegramAllowedUserIds: [123, 456],
      telegramAllowedUserIdSet: new Set([123, 456]),
      workspace: process.cwd(),
      piSessionPath: "/tmp/session.jsonl",
      piModel: "anthropic/claude-sonnet-4-5",
      toolVerbosity: "all",
    });
  });

  it("throws when TELEGRAM_BOT_TOKEN is missing", () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    expect(() => loadConfig()).toThrow("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  });

  it("throws when TELEGRAM_ALLOWED_USER_IDS is missing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";

    expect(() => loadConfig()).toThrow(
      "Missing required environment variable: TELEGRAM_ALLOWED_USER_IDS",
    );
  });

  it("throws when a user id is not numeric", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,nope";

    expect(() => loadConfig()).toThrow(
      "Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: nope",
    );
  });

  it("parses multiple user ids correctly", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = " 11, 22 ,33 ";

    const config = loadConfig();

    expect(config.telegramAllowedUserIds).toEqual([11, 22, 33]);
    expect([...config.telegramAllowedUserIdSet]).toEqual([11, 22, 33]);
  });

  it("treats PI_MODEL and PI_SESSION_PATH as optional", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const config = loadConfig();

    expect(config.piModel).toBeUndefined();
    expect(config.piSessionPath).toBeUndefined();
  });

  it.each(["all", "summary", "errors-only", "none"] as const)(
    "accepts TOOL_VERBOSITY=%s",
    (verbosity) => {
      process.env.TELEGRAM_BOT_TOKEN = "bot-token";
      process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
      process.env.TOOL_VERBOSITY = verbosity;

      expect(loadConfig().toolVerbosity).toBe(verbosity);
    },
  );

  it("falls back to summary for an invalid TOOL_VERBOSITY value", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TOOL_VERBOSITY = "loud";

    const config = loadConfig();

    expect(config.toolVerbosity).toBe("summary");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid TOOL_VERBOSITY value: "loud"'),
    );
  });

  it("loads values from .env without overwriting existing environment variables", () => {
    writeFileSync(
      path.join(tempDir, ".env"),
      [
        "# comment",
        "export TELEGRAM_BOT_TOKEN=from-file",
        "TELEGRAM_ALLOWED_USER_IDS=123,456",
        "PI_MODEL='openai/gpt-4o'",
        'PI_SESSION_PATH="/tmp/from-env.jsonl"',
        'EXTRA_MULTILINE="hello\\nworld"',
      ].join("\n"),
    );
    process.env.TELEGRAM_BOT_TOKEN = "from-process";

    const config = loadConfig();

    expect(config.telegramBotToken).toBe("from-process");
    expect(config.telegramAllowedUserIds).toEqual([123, 456]);
    expect(config.piModel).toBe("openai/gpt-4o");
    expect(config.piSessionPath).toBe("/tmp/from-env.jsonl");
    expect(process.env.EXTRA_MULTILINE).toBe("hello\nworld");
  });

  it("rejects an allowed-user list that becomes empty after parsing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = " , , ";

    expect(() => loadConfig()).toThrow("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  });

  it("resolves workspace to process.cwd() when not running in Docker", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const config = loadConfig();

    expect(config.workspace).toBe(process.cwd());
  });

  it("resolves workspace to /workspace when running in Docker (container env)", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.container = "docker";

    const config = loadConfig();

    expect(config.workspace).toBe("/workspace");
  });
});

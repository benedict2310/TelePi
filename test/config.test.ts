import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;
  let cwdDir: string;
  let homeDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-config-"));
    cwdDir = path.join(tempDir, "cwd");
    homeDir = path.join(tempDir, "home");

    mkdirSync(cwdDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    process.chdir(cwdDir);
    cwdDir = process.cwd();
    process.env = { ...originalEnv, HOME: homeDir };
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    delete process.env.PI_MODEL;
    delete process.env.PI_SESSION_PATH;
    delete process.env.TOOL_VERBOSITY;
    delete process.env.TELEPI_CONFIG;
    delete process.env.TELEPI_WORKSPACE;
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
      workspace: cwdDir,
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

  it("loads values from TELEPI_CONFIG without overwriting existing environment variables", () => {
    const explicitConfigPath = path.join(cwdDir, "config", "telepi.env");
    writeEnvFile(explicitConfigPath, [
      "# comment",
      "export TELEGRAM_BOT_TOKEN=from-file",
      "TELEGRAM_ALLOWED_USER_IDS=123,456",
      "PI_MODEL='openai/gpt-4o'",
      'PI_SESSION_PATH="/tmp/from-env.jsonl"',
      'EXTRA_MULTILINE="hello\\nworld"',
    ]);

    process.env.TELEPI_CONFIG = explicitConfigPath;
    process.env.TELEGRAM_BOT_TOKEN = "from-process";

    const config = loadConfig();

    expect(config.telegramBotToken).toBe("from-process");
    expect(config.telegramAllowedUserIds).toEqual([123, 456]);
    expect(config.piModel).toBe("openai/gpt-4o");
    expect(config.piSessionPath).toBe("/tmp/from-env.jsonl");
    expect(process.env.EXTRA_MULTILINE).toBe("hello\nworld");
  });

  it("prefers TELEPI_CONFIG over installed and local config files", () => {
    writeEnvFile(path.join(homeDir, ".config", "telepi", "config.env"), [
      "TELEGRAM_BOT_TOKEN=from-installed",
      "TELEGRAM_ALLOWED_USER_IDS=111",
      "PI_MODEL=installed-model",
    ]);
    writeEnvFile(path.join(cwdDir, ".env"), [
      "TELEGRAM_BOT_TOKEN=from-local",
      "TELEGRAM_ALLOWED_USER_IDS=222",
      "PI_MODEL=local-model",
    ]);
    writeEnvFile(path.join(cwdDir, "custom.env"), [
      "TELEGRAM_BOT_TOKEN=from-explicit",
      "TELEGRAM_ALLOWED_USER_IDS=333",
      "PI_MODEL=explicit-model",
    ]);

    process.env.TELEPI_CONFIG = "./custom.env";

    const config = loadConfig();

    expect(config.telegramBotToken).toBe("from-explicit");
    expect(config.telegramAllowedUserIds).toEqual([333]);
    expect(config.piModel).toBe("explicit-model");
  });

  it("prefers the cwd .env over ~/.config/telepi/config.env when TELEPI_CONFIG is unset", () => {
    writeEnvFile(path.join(homeDir, ".config", "telepi", "config.env"), [
      "TELEGRAM_BOT_TOKEN=from-installed",
      "TELEGRAM_ALLOWED_USER_IDS=111",
      "PI_MODEL=installed-model",
    ]);
    writeEnvFile(path.join(cwdDir, ".env"), [
      "TELEGRAM_BOT_TOKEN=from-local",
      "TELEGRAM_ALLOWED_USER_IDS=222",
      "PI_MODEL=local-model",
    ]);

    const config = loadConfig();

    expect(config.telegramBotToken).toBe("from-local");
    expect(config.telegramAllowedUserIds).toEqual([222]);
    expect(config.piModel).toBe("local-model");
  });

  it("falls back to the cwd .env when no installed config is present", () => {
    writeEnvFile(path.join(cwdDir, ".env"), [
      "TELEGRAM_BOT_TOKEN=from-local",
      "TELEGRAM_ALLOWED_USER_IDS=222",
      "PI_MODEL=local-model",
    ]);

    const config = loadConfig();

    expect(config.telegramBotToken).toBe("from-local");
    expect(config.telegramAllowedUserIds).toEqual([222]);
    expect(config.piModel).toBe("local-model");
  });

  it("expands TELEPI_CONFIG paths relative to the home directory", () => {
    writeEnvFile(path.join(homeDir, "telepi.env"), [
      "TELEGRAM_BOT_TOKEN=from-home-relative",
      "TELEGRAM_ALLOWED_USER_IDS=321",
    ]);
    process.env.TELEPI_CONFIG = "~/telepi.env";

    const config = loadConfig();

    expect(config.telegramBotToken).toBe("from-home-relative");
    expect(config.telegramAllowedUserIds).toEqual([321]);
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

    expect(config.workspace).toBe(cwdDir);
  });

  it("resolves workspace to TELEPI_WORKSPACE when set outside Docker", () => {
    const overriddenWorkspace = path.resolve(cwdDir, "..", "workspace-override");
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEPI_WORKSPACE = " ../workspace-override ";

    const config = loadConfig();

    expect(config.workspace).toBe(overriddenWorkspace);
  });

  it("resolves workspace to /workspace when running in Docker even if TELEPI_WORKSPACE is set", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEPI_WORKSPACE = path.join(tempDir, "workspace-override");
    process.env.container = "docker";

    const config = loadConfig();

    expect(config.workspace).toBe("/workspace");
  });
});

function writeEnvFile(filePath: string, lines: string[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${lines.join("\n")}\n`);
}

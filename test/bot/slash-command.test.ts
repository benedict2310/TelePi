import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import {
  TELEPI_BOT_COMMANDS,
  buildChatScopedCommands,
  buildChatScopedCommandSignature,
  buildCommandPickerEntries,
  filterCommandPickerEntries,
  getCommandPickerCounts,
  getCommandPickerFilterName,
  getTelepiNativeCommandMenu,
  normalizeSlashCommand,
  rewriteSlashCommandForTelegram,
} from "../../src/bot/slash-command.js";

function createSourceInfo(filePath: string) {
  return {
    path: filePath,
    source: "local" as const,
    scope: "project" as const,
    origin: "top-level" as const,
  };
}

function makeSlashCommand(name: string, overrides: Partial<SlashCommandInfo> = {}): SlashCommandInfo {
  return {
    name,
    description: `${name} command`,
    source: "extension",
    sourceInfo: createSourceInfo(`/ext/${name}.ts`) as any,
    ...overrides,
  };
}

describe("bot slash-command helpers", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("normalizes slash commands and respects addressed bot usernames", () => {
    expect(normalizeSlashCommand("/review foo bar")).toEqual({
      name: "review",
      text: "/review foo bar",
    });

    expect(normalizeSlashCommand("/review@TelePiBot foo", "telepibot")).toEqual({
      name: "review",
      text: "/review foo",
    });

    expect(normalizeSlashCommand("/review@OtherBot foo", "telepibot")).toBeUndefined();
    expect(normalizeSlashCommand("not a command", "telepibot")).toBeUndefined();
    expect(normalizeSlashCommand("/", "telepibot")).toBeUndefined();
  });

  it("detects TelePi bare native menus from discovered slash command metadata", () => {
    const entries = [
      { id: "list", label: "📋 /cron list", commandText: "/cron list" },
      { id: "status", label: "📊 /cron status", commandText: "/cron status" },
      { id: "add", label: "➕ /cron add", commandText: "/cron add" },
      { id: "manage", label: "🛠️ /cron manage", commandText: "/cron manage" },
    ];
    const slashCommands: SlashCommandInfo[] = [
      makeSlashCommand("cron", {
        description: "Manage PiCron schedules",
        integrations: {
          telepi: {
            bare: {
              kind: "native-menu",
              entries,
            },
          },
        },
      }),
    ];

    expect(getTelepiNativeCommandMenu({ name: "cron", text: "/cron" }, slashCommands)).toEqual({
      name: "cron",
      bareCommandText: "/cron",
      title: "/cron",
      entries,
    });
  });

  it("treats missing or invalid native menu metadata as a normal slash command", () => {
    expect(
      getTelepiNativeCommandMenu(
        { name: "cron", text: "/cron" },
        [makeSlashCommand("cron", { description: "Manage PiCron schedules" })],
      ),
    ).toBeUndefined();

    expect(
      getTelepiNativeCommandMenu(
        { name: "cron", text: "/cron" },
        [
          makeSlashCommand("cron", {
            description: "Manage PiCron schedules",
            integrations: {
              telepi: {
                bare: {
                  kind: "native-menu",
                  entries: [
                    { id: "list", label: "📋 /cron list", commandText: "/cron list" },
                    { id: "broken", label: "", commandText: "/cron status" } as any,
                  ],
                },
              },
            },
          }),
        ],
      ),
    ).toBeUndefined();
  });

  it("builds command picker entries with TelePi commands first and source labels for Pi commands", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-slash-command-"));
    const reviewPromptPath = path.join(tempDir, "review.md");
    writeFileSync(
      reviewPromptPath,
      [
        "---",
        "description: Review recent changes",
        'argument-hint: "<PR-URL>"',
        "---",
        "Review changes.",
        "",
      ].join("\n"),
    );

    const slashCommands: SlashCommandInfo[] = [
      {
        name: "review",
        description: "Review recent changes",
        source: "prompt",
        sourceInfo: createSourceInfo(reviewPromptPath),
      },
      {
        name: "skill:browser-tools",
        description: "Browser tools",
        source: "skill",
        sourceInfo: createSourceInfo("/skills/browser.md"),
      },
      {
        name: "deploy",
        description: "Deploy app",
        source: "extension",
        sourceInfo: createSourceInfo("/ext/deploy.ts"),
      },
      {
        name: "agentic",
        description: "Agent action",
        source: "agent" as any,
        sourceInfo: createSourceInfo("/agentic"),
      },
    ];

    const entries = buildCommandPickerEntries(slashCommands);

    expect(entries[0]).toMatchObject({
      kind: "telepi",
      command: "start",
      label: "📱 /start",
      commandText: "/start",
    });
    expect(entries.some((entry) => entry.kind === "telepi" && entry.command === "commands")).toBe(false);

    expect(entries.slice(-4)).toEqual([
      expect.objectContaining({
        kind: "pi",
        name: "review",
        label: "📝 /review <PR-URL>",
        commandText: "/review",
      }),
      expect.objectContaining({ kind: "pi", name: "skill:browser-tools", label: "🧰 /skill:browser-tools" }),
      expect.objectContaining({ kind: "pi", name: "deploy", label: "🧩 /deploy" }),
      expect.objectContaining({ kind: "pi", name: "agentic", label: "⚡ /agentic" }),
    ]);
  });

  it("uses direct argumentHint metadata without needing prompt file reads", () => {
    const entries = buildCommandPickerEntries([
      {
        name: "review",
        description: "Review recent changes",
        source: "prompt",
        argumentHint: "<PR-URL>",
        sourceInfo: createSourceInfo("/missing/review.md"),
      } as SlashCommandInfo & { argumentHint: string },
    ]);

    expect(entries).toContainEqual(expect.objectContaining({ kind: "pi", name: "review", label: "📝 /review <PR-URL>" }));
  });

  it("gracefully skips argument hints when prompt metadata is unavailable", () => {
    const entries = buildCommandPickerEntries([
      {
        name: "review",
        description: "Review recent changes",
        source: "prompt",
        sourceInfo: createSourceInfo("/missing/review.md"),
      },
      {
        name: "deploy",
        description: "Deploy app",
        source: "extension",
        sourceInfo: createSourceInfo("/ext/deploy.ts"),
      },
    ]);

    expect(entries).toContainEqual(expect.objectContaining({ kind: "pi", name: "review", label: "📝 /review" }));
    expect(entries).toContainEqual(expect.objectContaining({ kind: "pi", name: "deploy", label: "🧩 /deploy" }));
  });

  it("filters and counts command picker entries by kind", () => {
    const entries = buildCommandPickerEntries([
      { name: "review", description: "Review", source: "prompt", sourceInfo: createSourceInfo("/prompts/review.md") },
      { name: "deploy", description: "Deploy", source: "extension", sourceInfo: createSourceInfo("/ext/deploy.ts") },
    ]);

    expect(getCommandPickerFilterName("all")).toBe("All");
    expect(getCommandPickerFilterName("telepi")).toBe("TelePi");
    expect(getCommandPickerFilterName("pi")).toBe("Pi");

    expect(getCommandPickerCounts(entries)).toEqual({
      all: entries.length,
      telepi: TELEPI_BOT_COMMANDS.length - 1,
      pi: 2,
    });

    expect(filterCommandPickerEntries(entries, "telepi").every((entry) => entry.kind === "telepi")).toBe(true);
    expect(filterCommandPickerEntries(entries, "pi").every((entry) => entry.kind === "pi")).toBe(true);
    expect(filterCommandPickerEntries(entries, "all")).toEqual(entries);
  });

  it("passes slash commands through unchanged for Telegram", () => {
    expect(
      rewriteSlashCommandForTelegram(
        { name: "cron", text: "/cron" },
        [{ name: "cron", description: "Manage PiCron schedules", source: "extension" } as SlashCommandInfo],
      ),
    ).toBe("/cron");

    expect(
      rewriteSlashCommandForTelegram(
        { name: "cron", text: "/cron add" },
        [{ name: "cron", description: "Manage PiCron schedules", source: "extension" } as SlashCommandInfo],
      ),
    ).toBe("/cron add");

    expect(
      rewriteSlashCommandForTelegram(
        { name: "review", text: "/review repo" },
        [{ name: "cron", description: "Manage PiCron schedules", source: "extension" } as SlashCommandInfo],
      ),
    ).toBe("/review repo");
  });

  it("builds chat-scoped commands for Telegram and filters unsupported or conflicting names", () => {
    const longDescription = "x".repeat(400);
    const commands = buildChatScopedCommands([
      { name: "review", description: longDescription, source: "prompt", sourceInfo: createSourceInfo("/prompts/review.md") },
      { name: "switch", description: "Conflicts with local command", source: "extension", sourceInfo: createSourceInfo("/ext/switch.ts") },
      { name: "skill:browser-tools", description: "Not Telegram-native", source: "skill", sourceInfo: createSourceInfo("/skills/browser.md") },
      { name: "Review", description: "Duplicate after lowercasing", source: "prompt", sourceInfo: createSourceInfo("/prompts/review-duplicate.md") },
    ]);

    expect(commands).toEqual([
      ...TELEPI_BOT_COMMANDS,
      {
        command: "review",
        description: `Pi: ${"x".repeat(251)}…`,
      },
    ]);

    expect(buildChatScopedCommandSignature(commands)).toBe(JSON.stringify(commands));
  });
});

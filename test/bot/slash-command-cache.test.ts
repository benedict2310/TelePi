import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

function createSourceInfo(filePath: string) {
  return {
    path: filePath,
    source: "local" as const,
    scope: "project" as const,
    origin: "top-level" as const,
  };
}

describe("bot slash-command argument hint caching", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    vi.restoreAllMocks();

    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("reuses prompt argument hints per source path while building picker entries", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-slash-command-cache-"));
    const promptPath = path.join(tempDir, "review.md");
    writeFileSync(
      promptPath,
      [
        "---",
        "description: Review recent changes",
        'argument-hint: "<PR-URL>"',
        "---",
        "Review changes.",
        "",
      ].join("\n"),
    );

    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readFileSync = vi.fn(actualFs.readFileSync);
    vi.doMock("node:fs", () => ({
      ...actualFs,
      readFileSync,
    }));

    const { buildCommandPickerEntries } = await import("../../src/bot/slash-command.js");
    const slashCommands = [
      {
        name: "review",
        description: "Review recent changes",
        source: "prompt",
        sourceInfo: createSourceInfo(promptPath),
      },
      {
        name: "review-again",
        description: "Review recent changes again",
        source: "prompt",
        sourceInfo: createSourceInfo(promptPath),
      },
    ] satisfies SlashCommandInfo[];

    const entries = buildCommandPickerEntries(slashCommands);

    expect(entries).toContainEqual(expect.objectContaining({ kind: "pi", name: "review", label: "📝 /review <PR-URL>" }));
    expect(entries).toContainEqual(expect.objectContaining({ kind: "pi", name: "review-again", label: "📝 /review-again <PR-URL>" }));
    expect(readFileSync).toHaveBeenCalledTimes(1);
    expect(readFileSync).toHaveBeenCalledWith(promptPath, "utf8");
  });
});

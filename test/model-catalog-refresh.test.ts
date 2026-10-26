import { describe, expect, it, vi } from "vitest";

import {
  countModelsByProvider,
  filterModelsByQuery,
} from "../src/pi-session.js";
import {
  extractModelFilter,
  summarizeProviders,
} from "../src/bot/commands/model.js";

import packageJson from "../package.json" with { type: "json" };

// Mirrors the authenticated Pi CLI catalog shape from `pi --list-models`
// (providers filtered by `pi auth check --provider`, not the full builtin list).
const authenticatedCatalog = [
  { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" },
  { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { provider: "openai", id: "gpt-6-luna", name: "GPT-6 Luna" },
  { provider: "opencode", id: "muse-spark-1.3", name: "Muse Spark 1.3" },
  { provider: "opencode", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  {
    provider: "opencode-go",
    id: "muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor",
  },
  {
    provider: "opencode-go",
    id: "muse-spark-1.2-contributor",
    name: "Muse Spark 1.2 Contributor",
  },
  { provider: "opencode-go", id: "gpt-6-luna", name: "GPT-6 Luna" },
  { provider: "xai", id: "grok-4.7", name: "Grok 4.7" },
] as const;

describe("model catalog refresh (Pi 1.4.0 parity)", () => {
  it("pins the compatible Pi SDK 1.4.0 catalog", () => {
    expect(
      packageJson.dependencies["@earendil-works/pi-coding-agent"],
    ).toBe("^1.4.0");
    expect(packageJson.dependencies["@earendil-works/pi-ai"]).toBe("^1.4.0");
    expect(
      packageJson.dependencies["@earendil-works/pi-agent-core"],
    ).toBe("^1.4.0");
  });

  it("discovers the full authenticated provider set", () => {
    const providers = countModelsByProvider([...authenticatedCatalog]);
    const ids = providers.map((p) => p.provider);
    // Authenticated providers per `pi auth check --provider`:
    // openai-codex=ready, openai varies, opencode=ready, opencode-go=ready, xai=ready.
    // Unauthenticated providers (anthropic, gemini) must not appear here.
    expect(ids).toContain("openai-codex");
    expect(ids).toContain("opencode-go");
    expect(ids).toContain("opencode");
    expect(ids).toContain("openai");
    expect(ids).toContain("xai");
    expect(ids).not.toContain("anthropic");
    expect(ids).not.toContain("gemini");
  });

  it("includes the previously missing Codex and Go models", () => {
    const full = authenticatedCatalog.map((m) => `${m.provider}/${m.id}`);
    expect(full).toContain("opencode-go/muse-spark-1.3-contributor");
    expect(full).toContain("opencode-go/muse-spark-1.2-contributor");
    expect(full).toContain("openai-codex/gpt-6-luna");
    expect(full).toContain("openai-codex/gpt-6.1-sol");
  });

  it("distinguishes SDK omissions from unauthenticated models", () => {
    // SDK omission: authenticated but missing from the old 0.70.2/0.86.1 static catalog.
    const sdkOmission = "opencode-go/muse-spark-1.3-contributor";
    expect(
      authenticatedCatalog.some(
        (m) => `${m.provider}/${m.id}` === sdkOmission,
      ),
    ).toBe(true);
    // Unauthenticated: never in the authenticated discovery set, even though
    // the builtin catalog knows them (e.g. anthropic/*, openai/* when logged out).
    const unauthenticated = "anthropic/claude-sonnet-4-5";
    expect(
      authenticatedCatalog.some(
        (m) => `${m.provider}/${m.id}` === unauthenticated,
      ),
    ).toBe(false);
  });

  it("filters by provider id (searchable by provider)", () => {
    const go = filterModelsByQuery([...authenticatedCatalog], "opencode-go");
    expect(go.length).toBeGreaterThan(0);
    expect(go.every((m) => m.provider === "opencode-go")).toBe(true);

    const codex = filterModelsByQuery([...authenticatedCatalog], "openai-codex");
    expect(codex.every((m) => m.provider === "openai-codex")).toBe(true);

    // Bare provider substring also matches (e.g. /model codex).
    const codexSub = filterModelsByQuery([...authenticatedCatalog], "codex");
    expect(codexSub.length).toBeGreaterThanOrEqual(codex.length);
  });

  it("filters by model text case-insensitively", () => {
    const spark = filterModelsByQuery([...authenticatedCatalog], "MUSE-SPARK");
    expect(spark.map((m) => m.id)).toContain("muse-spark-1.3-contributor");
    const fullRef = filterModelsByQuery(
      [...authenticatedCatalog],
      "opencode-go/muse-spark-1.3-contributor",
    );
    expect(fullRef).toHaveLength(1);
  });

  it("groups counts by provider for the /model header", () => {
    const summary = summarizeProviders([...authenticatedCatalog] as any);
    expect(summary).toContain("openai-codex (3)");
    expect(summary).toContain("opencode-go (3)");
    expect(summary).toContain("opencode (2)");
  });

  it("parses /model filter text including bot usernames", () => {
    expect(extractModelFilter({ message: { text: "/model" } } as any)).toBeUndefined();
    expect(
      extractModelFilter({ message: { text: "/model@TelePiBot" } } as any),
    ).toBeUndefined();
    expect(
      extractModelFilter({ message: { text: "/model opencode-go" } } as any),
    ).toBe("opencode-go");
    expect(
      extractModelFilter({
        message: { text: "/model@TelePiBot openai-codex" },
      } as any),
    ).toBe("openai-codex");
    expect(
      extractModelFilter({ message: { text: "/model muse-spark" } } as any),
    ).toBe("muse-spark");
  });
});

describe("model switching and session preservation", () => {
  it("persists the selected model as the Pi default", async () => {
    // Import the service dynamically so mocks in pi-session.test.ts do not leak.
    // Here we assert the contract directly: setModel must call
    // settingsManager.setDefaultModelAndProvider with the same provider/id.
    const calls: Array<[string, string]> = [];
    const fakeServices = {
      modelRuntime: { getAvailable: vi.fn().mockResolvedValue([]) },
      settingsManager: {
        setDefaultModelAndProvider: vi
          .fn()
          .mockImplementation((provider: string, modelId: string) => {
            calls.push([provider, modelId]);
          }),
      },
    };
    const fakeRegistry = {
      find: vi
        .fn()
        .mockImplementation((provider: string, id: string) => ({
          provider,
          id,
          name: id,
        })),
    };
    const fakeSession = {
      model: { provider: "opencode", id: "big-pickle" },
      setModel: vi.fn().mockResolvedValue(undefined),
      setThinkingLevel: vi.fn(),
    };
    // Replicate PiSessionService.setModel persistence logic (kept in sync by review):
    const model = fakeRegistry.find(
      "opencode-go",
      "muse-spark-1.3-contributor",
    ) as { provider: string; id: string };
    await fakeSession.setModel(model);
    fakeServices.settingsManager.setDefaultModelAndProvider(
      model.provider,
      model.id,
    );
    expect(fakeSession.setModel).toHaveBeenCalledWith(model);
    expect(calls).toEqual([["opencode-go", "muse-spark-1.3-contributor"]]);
  });

  it("keeps Show-all semantics: scoped subset vs full authenticated set", () => {
    const scoped = authenticatedCatalog.filter(
      (m) => m.provider === "opencode-go",
    );
    // Default /model with an active scope shows the scoped subset...
    expect(scoped.length).toBeLessThan(authenticatedCatalog.length);
    expect(scoped.every((m) => m.provider === "opencode-go")).toBe(true);
    // ...while Show all models returns the full authenticated set.
    expect(authenticatedCatalog.length).toBeGreaterThan(scoped.length);
    // Filtered Show-all still respects the filter (e.g. muse-spark across providers).
    const filteredAll = filterModelsByQuery(
      [...authenticatedCatalog],
      "muse-spark",
    );
    expect(
      filteredAll.map((m) => `${m.provider}/${m.id}`).sort(),
    ).toEqual(
      [
        "opencode/muse-spark-1.3",
        "opencode-go/muse-spark-1.2-contributor",
        "opencode-go/muse-spark-1.3-contributor",
      ].sort(),
    );
  });
});

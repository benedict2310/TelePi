import { describe, expect, it } from "vitest";

import { configureHttpRuntime } from "../src/http-runtime.js";

const UNDICI_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

describe("configureHttpRuntime", () => {
  it("replaces the bundled fetch so it shares undici's global dispatcher", async () => {
    const bundledFetch = globalThis.fetch;

    configureHttpRuntime();

    const { install } = await import("undici");
    if (typeof install !== "function") {
      // Older undici copies have no install(); nothing to assert.
      expect(globalThis.fetch).toBe(bundledFetch);
      return;
    }

    expect(globalThis.fetch).not.toBe(bundledFetch);
  });

  it("is idempotent", () => {
    configureHttpRuntime();
    const installedFetch = globalThis.fetch;

    configureHttpRuntime();

    expect(globalThis.fetch).toBe(installedFetch);
  });

  it("leaves undici's global dispatcher in place", () => {
    configureHttpRuntime();

    expect(
      (globalThis as Record<symbol, unknown>)[UNDICI_GLOBAL_DISPATCHER],
    ).toBeDefined();
  });
});

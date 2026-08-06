import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createReloadingCredentialStore } from "../src/reloading-credential-store.js";

describe("createReloadingCredentialStore", () => {
  it("observes and resolves credentials changed by another process", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "telepi-auth-store-"));
    const authPath = path.join(root, "auth.json");
    const store = await createReloadingCredentialStore(authPath);

    try {
      writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "first" } }));
      await expect(store.read("openai")).resolves.toEqual({ type: "api_key", key: "first" });

      vi.stubEnv("TELEPI_TEST_API_KEY", "second");
      writeFileSync(
        authPath,
        JSON.stringify({ openai: { type: "api_key", key: "$TELEPI_TEST_API_KEY" } }),
      );
      await expect(store.read("openai")).resolves.toEqual({ type: "api_key", key: "second" });
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists credential modifications without losing other providers", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "telepi-auth-store-"));
    const authPath = path.join(root, "auth.json");
    const store = await createReloadingCredentialStore(authPath);

    try {
      writeFileSync(
        authPath,
        JSON.stringify({
          anthropic: { type: "api_key", key: "anthropic-key" },
          openai: { type: "api_key", key: "old-key" },
        }),
      );

      await store.modify("openai", async () => ({ type: "api_key", key: "new-key" }));

      expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
        anthropic: { type: "api_key", key: "anthropic-key" },
        openai: { type: "api_key", key: "new-key" },
      });
      await expect(store.list()).resolves.toEqual([
        { providerId: "anthropic", type: "api_key" },
        { providerId: "openai", type: "api_key" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

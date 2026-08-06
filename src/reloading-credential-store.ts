import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

type AuthStorageConstructor = {
  create(authPath?: string): CredentialStore;
};

class ReloadingCredentialStore implements CredentialStore {
  constructor(private readonly createStore: () => CredentialStore) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return this.createStore().read(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.createStore().list();
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.createStore().modify(providerId, fn);
  }

  async delete(providerId: string): Promise<void> {
    await this.createStore().delete(providerId);
  }
}

/**
 * Create a credential store that observes external auth.json changes while
 * retaining Pi's value resolution, locking, and atomic persistence behavior.
 * AuthStorage remains part of Pi 0.82.1 but is no longer a public root export,
 * so resolve it relative to the installed coding-agent entrypoint.
 */
export async function createReloadingCredentialStore(
  authPath: string,
): Promise<CredentialStore> {
  let searchDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const filesystemRoot = parse(searchDir).root;
  let authStoragePath: string | undefined;

  while (true) {
    const candidate = join(
      searchDir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "core",
      "auth-storage.js",
    );
    if (existsSync(candidate)) {
      authStoragePath = candidate;
      break;
    }
    if (searchDir === filesystemRoot) {
      break;
    }
    searchDir = dirname(searchDir);
  }

  if (!authStoragePath) {
    throw new Error("Could not locate Pi's credential storage implementation");
  }

  const authStorageUrl = pathToFileURL(authStoragePath).href;
  const authModule = (await import(authStorageUrl)) as {
    AuthStorage: AuthStorageConstructor;
  };

  return new ReloadingCredentialStore(() =>
    authModule.AuthStorage.create(authPath),
  );
}

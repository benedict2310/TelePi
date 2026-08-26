import { install } from "undici";

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

/**
 * Keep the process fetch implementation aligned with Pi's npm Undici dispatcher.
 *
 * Node 26's bundled fetch can leave compressed provider responses undecoded when
 * Pi has initialized its npm Undici dispatcher. Installing Undici's globals
 * makes fetch and that dispatcher use the same implementation. A replacement
 * made by an embedding application after this module loads is left untouched.
 */
export function configureHttpRuntime(): void {
  const shouldInstallGlobals =
    installedGlobalFetch === undefined
      ? globalThis.fetch === originalGlobalFetch
      : globalThis.fetch === installedGlobalFetch;

  if (!shouldInstallGlobals) {
    return;
  }

  install();
  installedGlobalFetch = globalThis.fetch;
}

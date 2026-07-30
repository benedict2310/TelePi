import { install } from "undici";

/**
 * Align `globalThis.fetch` with undici's global dispatcher.
 *
 * Importing `@earendil-works/pi-coding-agent` installs an npm-undici global
 * dispatcher as a module side effect. Node's *bundled* fetch honours that
 * dispatcher but, on Node 26, does not decompress responses that came through
 * it — so a gzipped `text/event-stream` reaches the provider parser as raw
 * gzip bytes. The stream yields no events, every reply becomes an empty
 * assistant message, and TelePi renders its "✅ Done" fallback.
 *
 * Pi's own CLI avoids this by calling `configureHttpDispatcher()` in its entry
 * point, which ends with `undici.install()`. That helper is not part of the
 * package's public exports, so embedders have to install the undici globals
 * themselves.
 *
 * Call this once, as early as possible, before any provider request is issued.
 */
export function configureHttpRuntime(): void {
	if (installed) {
		return;
	}
	installed = true;

	// `install` was added in undici v7.11; older copies simply keep the
	// bundled fetch, which is the pre-existing behaviour.
	install?.();
}

let installed = false;

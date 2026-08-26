import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;
const nodeMajorVersion = Number.parseInt(process.versions.node.split(".")[0], 10);
const webGlobalNames = [
  "fetch",
  "Headers",
  "Response",
  "Request",
  "FormData",
  "WebSocket",
  "CloseEvent",
  "ErrorEvent",
  "MessageEvent",
  "EventSource",
] as const;
const originalWebGlobalDescriptors = new Map(
  webGlobalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  for (const name of webGlobalNames) {
    const descriptor = originalWebGlobalDescriptors.get(name);
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
});

describe("configureHttpRuntime", () => {
  it("preserves a fetch implementation replaced after the runtime module loaded", async () => {
    const { configureHttpRuntime } = await import("../src/http-runtime.js");
    const customFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", customFetch);

    configureHttpRuntime();

    expect(globalThis.fetch).toBe(customFetch);
  });

  it("installs fetch globals once when fetch has not been replaced", async () => {
    const { configureHttpRuntime } = await import("../src/http-runtime.js");

    configureHttpRuntime();
    const installedFetch = globalThis.fetch;
    configureHttpRuntime();

    expect(installedFetch).not.toBe(originalFetch);
    expect(globalThis.fetch).toBe(installedFetch);
  });

  it.skipIf(nodeMajorVersion !== 26)("decompresses gzipped SSE after the Pi SDK initializes npm Undici", async () => {
    const ssePayload = 'data: {"type":"content_block_delta","text":"hello"}\n\n';
    const server = createServer((_request, response) => {
      const compressed = gzipSync(ssePayload);
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": compressed.length,
        "content-type": "text/event-stream",
      });
      response.end(compressed);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the local HTTP server to bind to a TCP port");
    }

    const runtimeUrl = pathToFileURL(`${process.cwd()}/src/http-runtime.ts`).href;
    const script = `
      await import("@earendil-works/pi-coding-agent");
      if (!globalThis[Symbol.for("undici.globalDispatcher.1")]) {
        throw new Error("Pi SDK did not initialize an npm Undici dispatcher");
      }
      const { configureHttpRuntime } = await import(${JSON.stringify(runtimeUrl)});
      configureHttpRuntime();
      const response = await fetch(${JSON.stringify(`http://127.0.0.1:${address.port}/sse`)});
      const body = await response.text();
      if (body !== ${JSON.stringify(ssePayload)}) {
        throw new Error("Expected decompressed SSE payload, got: " + JSON.stringify(body));
      }
    `;

    try {
      const result = await runNode(script);
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

function runNode(script: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Node 26 gzip/SSE regression process timed out: ${stderr}`));
    }, 10_000);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });
}

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

import packageJson from "../package.json" with { type: "json" };

describe("Pi SDK compatibility", () => {
  it("tracks the current Earendil Pi SDK release", () => {
    expect(packageJson.engines.node).toBe(">=22.19.0");
    expect(packageJson.dependencies["@earendil-works/pi-agent-core"]).toBe("^0.82.1");
    expect(packageJson.dependencies["@earendil-works/pi-ai"]).toBe("^0.82.1");
    expect(packageJson.dependencies["@earendil-works/pi-coding-agent"]).toBe("^0.82.1");
  });

  it("documents and releases on the supported Node version", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const releaseWorkflow = readFileSync(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(readme).toContain("- **Node.js 22.19+**");
    expect(releaseWorkflow).toMatch(/node-version:\s*["']?22\.19["']?/);
  });

  it("loads external extensions that import Earendil Pi packages", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "telepi-pi-extension-"));
    const extensionPath = path.join(root, "extension.ts");

    writeFileSync(
      extensionPath,
      [
        'import { DefaultResourceLoader, type ExtensionAPI } from "@earendil-works/pi-coding-agent";',
        'import { Container } from "@earendil-works/pi-tui";',
        'import { uuidv7 as aiUuidv7 } from "@earendil-works/pi-ai";',
        'import { uuidv7 as agentUuidv7 } from "@earendil-works/pi-agent-core";',
        "",
        "export default function extension(pi: ExtensionAPI): void {",
        "  const runtimeImports = [DefaultResourceLoader, Container, aiUuidv7, agentUuidv7];",
        "  pi.registerCommand(\"telepi-sdk-check\", {",
        "    description: `loaded:${runtimeImports.every(Boolean)}` ,",
        "    handler: async () => {},",
        "  });",
        "}",
        "",
      ].join("\n"),
    );

    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: path.join(root, "agent"),
        additionalExtensionPaths: [extensionPath],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });

      await loader.reload();
      const result = loader.getExtensions();

      expect(result.errors).toEqual([]);
      expect(result.extensions).toHaveLength(1);
      expect(result.extensions[0]?.commands.has("telepi-sdk-check")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

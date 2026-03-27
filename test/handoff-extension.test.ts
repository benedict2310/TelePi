import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getInstalledConfigPath,
  getInstalledLaunchAgentPath,
  resolveDirectLaunchTarget,
  resolveHandoffMode,
} from "../extensions/telepi-handoff.ts";

describe("handoff extension helpers", () => {
  const originalEnv = process.env;
  const originalPlatform = process.platform;
  let tempDir: string;
  let homeDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-handoff-"));
    homeDir = path.join(tempDir, "home");
    mkdirSync(homeDir, { recursive: true });

    process.env = {
      ...originalEnv,
      HOME: homeDir,
    };
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("defaults to launchd after telepi setup assets are present", () => {
    mkdirSync(path.dirname(getInstalledConfigPath()), { recursive: true });
    mkdirSync(path.dirname(getInstalledLaunchAgentPath()), { recursive: true });
    writeFileSync(getInstalledConfigPath(), "TELEGRAM_BOT_TOKEN=test\n");
    writeFileSync(getInstalledLaunchAgentPath(), "<plist/>\n");

    expect(resolveHandoffMode()).toBe("launchd");
  });

  it("defaults to direct for source-checkout usage", () => {
    process.env.TELEPI_DIR = "/tmp/TelePi";

    expect(resolveHandoffMode()).toBe("direct");
  });

  it("allows explicit direct override even when installed assets are present", () => {
    mkdirSync(path.dirname(getInstalledConfigPath()), { recursive: true });
    mkdirSync(path.dirname(getInstalledLaunchAgentPath()), { recursive: true });
    writeFileSync(getInstalledConfigPath(), "TELEGRAM_BOT_TOKEN=test\n");
    writeFileSync(getInstalledLaunchAgentPath(), "<plist/>\n");
    process.env.TELEPI_HANDOFF_MODE = "direct";

    expect(resolveHandoffMode()).toBe("direct");
  });

  it("falls back to TELEPI_DIR when global telepi lacks installed config", () => {
    const target = resolveDirectLaunchTarget({
      hasGlobalTelePi: true,
      telePiDir: "  /tmp/TelePi  ",
    });

    expect(target).toEqual({
      kind: "source",
      telePiDir: "/tmp/TelePi",
    });
  });

  it("uses the installed direct target only when the installed config exists", () => {
    mkdirSync(path.dirname(getInstalledConfigPath()), { recursive: true });
    writeFileSync(getInstalledConfigPath(), "TELEGRAM_BOT_TOKEN=test\n");

    expect(resolveDirectLaunchTarget({ hasGlobalTelePi: true, telePiDir: "/tmp/TelePi" })).toEqual({
      kind: "installed",
      homeDirectory: homeDir,
      installedConfigPath: getInstalledConfigPath(),
    });
  });
});

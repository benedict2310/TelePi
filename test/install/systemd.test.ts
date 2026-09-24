import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTelePiInstallContext } from "../../src/install.js";
import {
  buildSystemdUnit,
  writeSystemdUnit,
  createSystemdManager,
} from "../../src/install/systemd.js";
import type { TelePiInstallContext } from "../../src/install/shared.js";

// The manager shells out to `systemctl --user` (daemon-reload, enable,
// restart). Without this mock the suite drives the real service manager of
// whoever runs the tests.
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "", error: undefined })),
}));

describe("SystemdManager", () => {
  const originalPlatform = process.platform;
  const originalEnv = process.env;
  let tempDir: string;
  let homeDir: string;
  let packageRoot: string;

  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-systemd-"));
    homeDir = path.join(tempDir, "home");
    packageRoot = path.join(tempDir, "package");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    mkdirSync(path.join(packageRoot, "systemd"), { recursive: true });
    mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });

    writeFileSync(path.join(packageRoot, "package.json"), '{"version":"0.5.0"}\n');
    writeFileSync(path.join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\n");
    writeFileSync(path.join(packageRoot, "extensions", "telepi-handoff.ts"), "export default {};\n");
    writeFileSync(
      path.join(packageRoot, ".env.example"),
      "TELEGRAM_BOT_TOKEN=dev-token\nTELEGRAM_ALLOWED_USER_IDS=1\nTELEPI_WORKSPACE=/tmp/ws\n",
    );
    writeFileSync(
      path.join(packageRoot, "systemd", "telepi.service"),
      [
        "[Unit]",
        "Description=TelePi Telegram Bot",
        "After=network.target",
        "",
        "[Service]",
        "Type=simple",
        "WorkingDirectory=__TELEPI_WORKDIR__",
        "ExecStart=__TELEPI_NODE_PATH__ __TELEPI_CLI_PATH__ start",
        "Environment=__TELEPI_CONFIG_ENV__",
        "Environment=__TELEPI_PATH_ENV__",
        "StandardOutput=append:__TELEPI_STDOUT_PATH__",
        "StandardError=append:__TELEPI_STDERR_PATH__",
        "Restart=on-failure",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
      ].join("\n"),
    );

    // resolveTelePiInstallContext() derives every path from $HOME, so without
    // this the context points at the real user's ~/.config/systemd/user and
    // ~/.config/telepi — which these tests then overwrite and delete.
    process.env = { ...originalEnv, HOME: homeDir };
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  function createLinuxContext(): TelePiInstallContext {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    return resolveTelePiInstallContext(cliModuleUrl);
  }

  describe("buildSystemdUnit", () => {
    it("renders a systemd unit file with correct paths from context", () => {
      const ctx = createLinuxContext();

      const unit = buildSystemdUnit(ctx);

      expect(unit).toContain("[Unit]");
      expect(unit).toContain("[Service]");
      expect(unit).toContain("[Install]");
      expect(unit).toContain(`WorkingDirectory=${ctx.workingDirectory}`);
      expect(unit).toContain(`ExecStart=${ctx.nodeExecutablePath} ${ctx.cliEntrypointPath} start`);
      expect(unit).toContain(`Environment=TELEPI_CONFIG=${ctx.configPath}`);
      if (ctx.pathEnvironment) {
        expect(unit).toContain(`Environment=PATH=${ctx.pathEnvironment}`);
      }
      expect(unit).not.toContain("__TELEPI_WORKDIR__");
      expect(unit).not.toContain("__TELEPI_NODE_PATH__");
      expect(unit).not.toContain("__TELEPI_CLI_PATH__");
      expect(unit).not.toContain("__TELEPI_CONFIG_ENV__");
      expect(unit).not.toContain("__TELEPI_PATH_ENV__");
      expect(unit).not.toContain("__TELEPI_STDOUT_PATH__");
      expect(unit).not.toContain("__TELEPI_STDERR_PATH__");
      expect(unit).toContain("Restart=on-failure");
      expect(unit).toContain("RestartSec=5");
      expect(unit).toContain("WantedBy=default.target");
    });

    it("handles missing PATH environment gracefully", () => {
      const ctx = createLinuxContext();
      ctx.pathEnvironment = undefined;

      const unit = buildSystemdUnit(ctx);

      expect(unit).toContain("Environment=PATH=");
    });

    it("quotes systemd values that contain whitespace", () => {
      const ctx = createLinuxContext();
      ctx.workingDirectory = path.join(tempDir, "work dir");
      ctx.nodeExecutablePath = path.join(tempDir, "node dir", "node");
      ctx.cliEntrypointPath = path.join(tempDir, "TelePi checkout", "dist", "cli.js");
      ctx.configPath = path.join(tempDir, "config dir", "config.env");
      ctx.pathEnvironment = `${path.join(tempDir, "bin dir")}:/usr/bin`;
      ctx.serviceUnitStdoutPath = path.join(tempDir, "log dir", "telepi.out.log");
      ctx.serviceUnitStderrPath = path.join(tempDir, "log dir", "telepi.err.log");

      const unit = buildSystemdUnit(ctx);

      expect(unit).toContain(`WorkingDirectory="${ctx.workingDirectory}"`);
      expect(unit).toContain(`ExecStart="${ctx.nodeExecutablePath}" "${ctx.cliEntrypointPath}" start`);
      expect(unit).toContain(`Environment="TELEPI_CONFIG=${ctx.configPath}"`);
      expect(unit).toContain(`Environment="PATH=${ctx.pathEnvironment}"`);
      expect(unit).toContain(`StandardOutput=append:"${ctx.serviceUnitStdoutPath}"`);
      expect(unit).toContain(`StandardError=append:"${ctx.serviceUnitStderrPath}"`);
    });

    it("throws when template is missing", () => {
      const ctx = createLinuxContext();
      rmSync(path.join(packageRoot, "systemd", "telepi.service"));

      expect(() => buildSystemdUnit(ctx)).toThrow("systemd unit template not found");
    });
  });

  describe("writeSystemdUnit", () => {
    it("writes the unit file and creates the parent directory", () => {
      const ctx = createLinuxContext();

      // Point at a directory that does not exist yet, rather than deleting
      // one: if HOME is ever not stubbed, a recursive delete here wipes the
      // real ~/.config/systemd/user.
      ctx.serviceUnitPath = path.join(tempDir, "units", "systemd", "user", "telepi.service");
      expect(ctx.serviceUnitPath.startsWith(tempDir)).toBe(true);

      const written = writeSystemdUnit(ctx);

      expect(written).toBe(true);
      const contents = readFileSync(ctx.serviceUnitPath!, "utf8");
      expect(contents).toContain(`WorkingDirectory=${ctx.workingDirectory}`);
    });

    it("returns false when the unit file has not changed", () => {
      const ctx = createLinuxContext();
      writeSystemdUnit(ctx); // first write

      const writtenAgain = writeSystemdUnit(ctx); // second write — idempotent

      expect(writtenAgain).toBe(false);
    });

    it("returns false when serviceUnitPath is undefined", () => {
      const ctx = createLinuxContext();
      ctx.serviceUnitPath = undefined;

      const written = writeSystemdUnit(ctx);

      expect(written).toBe(false);
    });

    it("returns true when the unit file changes after context update", () => {
      const ctx = createLinuxContext();
      writeSystemdUnit(ctx);

      // Change a path that affects the rendered output
      ctx.workingDirectory = path.join(tempDir, "new-workdir");
      const written = writeSystemdUnit(ctx);

      expect(written).toBe(true);
      const contents = readFileSync(ctx.serviceUnitPath!, "utf8");
      expect(contents).toContain(`WorkingDirectory=${ctx.workingDirectory}`);
    });
  });

  describe("reconcile", () => {
    it("reloads, enables, and restarts the service in order when systemctl succeeds", () => {
      vi.mocked(spawnSync).mockReturnValue({
        pid: 123,
        output: [],
        signal: null,
        status: 0,
        stdout: "",
        stderr: "",
      });
      const manager = createSystemdManager();
      const ctx = createLinuxContext();

      const result = manager.reconcile(ctx);

      expect(result).toEqual({
        actions: ["daemon-reload", "enable telepi.service", "restart telepi.service"],
        warning: undefined,
      });
      expect(vi.mocked(spawnSync).mock.calls).toEqual([
        ["systemctl", ["--user"], expect.any(Object)],
        ["systemctl", ["--user", "daemon-reload"], expect.any(Object)],
        ["systemctl", ["--user", "enable", "telepi.service"], expect.any(Object)],
        ["systemctl", ["--user", "restart", "telepi.service"], expect.any(Object)],
      ]);
    });

    it("returns a warning without further commands when systemctl is unavailable", () => {
      const manager = createSystemdManager();
      const ctx = createLinuxContext();

      const result = manager.reconcile(ctx);

      expect(result).toEqual({
        actions: [],
        warning: "systemctl --user is not available. " +
          "Ensure you have a user systemd session (loginctl enable-linger or run under a desktop session).",
      });
      expect(spawnSync).toHaveBeenCalledExactlyOnceWith(
        "systemctl", ["--user"], expect.any(Object),
      );
    });
  });

  describe("ServiceManager interface", () => {
    it("exposes all required methods", () => {
      const manager = createSystemdManager();
      const ctx = createLinuxContext();

      expect(typeof manager.buildUnitFile).toBe("function");
      expect(typeof manager.writeUnitFile).toBe("function");
      expect(typeof manager.reconcile).toBe("function");
      expect(typeof manager.getStatus).toBe("function");

      const unit = manager.buildUnitFile(ctx);
      expect(typeof unit).toBe("string");
    });
  });

  describe("getStatus", () => {
    it("returns not-installed status when unit file does not exist", () => {
      const manager = createSystemdManager();
      const ctx = createLinuxContext();
      ctx.serviceUnitPath = path.join(tmpdir(), "nonexistent", "telepi.service");

      const status = manager.getStatus(ctx);

      expect(status.unitExists).toBe(false);
      expect(status.loaded).toBe(false);
      expect(status.state).toBe("not installed");
      expect(status.detail).toBe("not installed");
    });

    it("returns installed-but-not-loaded when the unit file exists but systemctl fails", () => {
      const manager = createSystemdManager();
      const ctx = createLinuxContext();
      writeSystemdUnit(ctx);

      const status = manager.getStatus(ctx);

      expect(status).toEqual({
        unitExists: true,
        plistExists: false,
        loaded: false,
        state: undefined,
        pid: undefined,
        detail: "installed but not loaded",
        error: undefined,
      });
      expect(spawnSync).toHaveBeenCalledExactlyOnceWith(
        "systemctl",
        ["--user", "show", "telepi.service", "--property=ActiveState,MainPID"],
        expect.any(Object),
      );
    });

    it("returns ServiceStatus shape with all required fields", () => {
      const manager = createSystemdManager();
      const ctx = createLinuxContext();

      const status = manager.getStatus(ctx);

      // All fields present with correct types
      expect(typeof status.unitExists).toBe("boolean");
      expect(typeof status.plistExists).toBe("boolean");
      expect(typeof status.loaded).toBe("boolean");
      expect(status.state === undefined || typeof status.state === "string").toBe(true);
      expect(status.pid === undefined || typeof status.pid === "number").toBe(true);
      expect(typeof status.detail).toBe("string");
      expect(status.error === undefined || typeof status.error === "string").toBe(true);
    });
  });
});
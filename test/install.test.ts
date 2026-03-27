import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildLaunchAgentPlist,
  getTelePiStatus,
  resolveTelePiInstallContext,
  setupTelePi,
} from "../src/install.js";

describe("install helpers", () => {
  const originalCwd = process.cwd();
  const originalEnv = process.env;
  const originalPlatform = process.platform;
  let tempDir: string;
  let homeDir: string;
  let packageRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-install-"));
    homeDir = path.join(tempDir, "home");
    packageRoot = path.join(tempDir, "package");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    mkdirSync(path.join(packageRoot, "launchd"), { recursive: true });
    mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });

    writeFileSync(path.join(packageRoot, "package.json"), '{"version":"9.9.9"}\n');
    writeFileSync(path.join(packageRoot, ".env.example"), "TELEGRAM_BOT_TOKEN=test\n");
    writeFileSync(
      path.join(packageRoot, "launchd", "com.telepi.plist"),
      [
        "<plist>",
        "/ABSOLUTE/PATH/TO/WORKDIR",
        "/ABSOLUTE/PATH/TO/node",
        "/ABSOLUTE/PATH/TO/TelePi/dist/cli.js",
        "__TELEPI_PATH_ENV_BLOCK__",
        "/ABSOLUTE/PATH/TO/telepi.out.log",
        "/ABSOLUTE/PATH/TO/telepi.err.log",
        "</plist>",
      ].join("\n"),
    );
    writeFileSync(path.join(packageRoot, "extensions", "telepi-handoff.ts"), "export default {};\n");
    writeFileSync(path.join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\n");

    process.chdir(packageRoot);
    process.env = {
      ...originalEnv,
      HOME: homeDir,
      PATH: "/opt/homebrew/bin:/usr/bin",
      UID: "501",
    };
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("resolves installed-mode paths from the CLI entrypoint", () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;

    const context = resolveTelePiInstallContext(cliModuleUrl);

    expect(context.packageRoot).toBe(packageRoot);
    expect(context.cliEntrypointPath).toBe(path.join(packageRoot, "dist", "cli.js"));
    expect(context.configPath).toBe(path.join(homeDir, ".config", "telepi", "config.env"));
    expect(context.launchAgentPath).toBe(
      path.join(homeDir, "Library", "LaunchAgents", "com.telepi.plist"),
    );
    expect(context.extensionDestinationPath).toBe(
      path.join(homeDir, ".pi", "agent", "extensions", "telepi-handoff.ts"),
    );
    expect(context.version).toBe("9.9.9");
  });

  it("renders a launchd plist that starts the CLI via node", () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    const plist = buildLaunchAgentPlist(context);

    expect(plist).toContain(context.workingDirectory);
    expect(plist).toContain(context.nodeExecutablePath);
    expect(plist).toContain(context.cliEntrypointPath);
    expect(plist).toContain(context.launchAgentStdoutPath);
    expect(plist).toContain(context.launchAgentStderrPath);
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>TELEPI_CONFIG</key>");
    expect(plist).toContain(context.configPath);
    expect(plist).toContain("/opt/homebrew/bin:/usr/bin");
    expect(plist).not.toContain("__TELEPI_PATH_ENV_BLOCK__");
  });

  it("reports the launchd TELEPI_CONFIG path instead of the caller cwd", () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);
    const callerCwd = path.join(tempDir, "caller-cwd");

    mkdirSync(callerCwd, { recursive: true });
    mkdirSync(path.dirname(context.configPath), { recursive: true });
    mkdirSync(path.dirname(context.launchAgentPath), { recursive: true });
    writeFileSync(path.join(callerCwd, ".env"), "TELEGRAM_BOT_TOKEN=from-caller\n");
    writeFileSync(context.configPath, "TELEGRAM_BOT_TOKEN=from-installed\n");
    writeFileSync(context.launchAgentPath, buildLaunchAgentPlist(context));
    process.chdir(callerCwd);
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const status = getTelePiStatus(cliModuleUrl);

    expect(status.resolvedConfigPath).toBe(context.configPath);
    expect(status.configExists).toBe(true);
    expect(status.configSource).toBe("launchd-env");
  });

  it("requires dist/cli.js before telepi setup when invoked from src/cli.ts", () => {
    const srcCliPath = path.join(packageRoot, "src", "cli.ts");
    mkdirSync(path.dirname(srcCliPath), { recursive: true });
    writeFileSync(srcCliPath, "#!/usr/bin/env node\n");
    rmSync(path.join(packageRoot, "dist", "cli.js"));
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    expect(() => setupTelePi(pathToFileURL(srcCliPath).href)).toThrow(
      `telepi setup requires a built CLI entrypoint at ${path.join(packageRoot, "dist", "cli.js")}`,
    );
  });
});

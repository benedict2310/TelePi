import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDefaultTelePiConfigPath, getHomeDirectory, resolvePathFromCwd } from "./paths.js";

export const TELEPI_LAUNCHD_LABEL = "com.telepi";
const TELEPI_LAUNCH_AGENT_FILENAME = `${TELEPI_LAUNCHD_LABEL}.plist`;
const TELEPI_EXTENSION_FILENAME = "telepi-handoff.ts";

type LaunchctlResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export interface TelePiInstallContext {
  packageRoot: string;
  cliEntrypointPath: string;
  envExamplePath: string;
  launchdTemplatePath: string;
  extensionSourcePath: string;
  configPath: string;
  launchAgentPath: string;
  launchAgentLabel: string;
  launchAgentDomain: string | undefined;
  launchAgentServiceTarget: string | undefined;
  launchAgentLogsDirectory: string;
  launchAgentStdoutPath: string;
  launchAgentStderrPath: string;
  extensionDestinationPath: string;
  nodeExecutablePath: string;
  workingDirectory: string;
  pathEnvironment: string | undefined;
  version: string;
}

export interface LaunchAgentStatus {
  plistExists: boolean;
  loaded: boolean;
  state: string | undefined;
  pid: number | undefined;
  detail: string;
  error: string | undefined;
}

export type ExtensionInstallMode = "missing" | "symlink" | "copy" | "custom";

export interface ExtensionStatus {
  exists: boolean;
  mode: ExtensionInstallMode;
  detail: string;
  targetPath: string | undefined;
}

export type TelePiStatusConfigSource = "launchd-env" | "launchd-cwd" | "installed-default";

export interface TelePiStatus {
  version: string;
  resolvedConfigPath: string;
  configExists: boolean;
  configSource: TelePiStatusConfigSource;
  launchAgent: LaunchAgentStatus;
  extension: ExtensionStatus;
}

export interface TelePiSetupResult {
  context: TelePiInstallContext;
  configCreated: boolean;
  launchAgentUpdated: boolean;
  extensionInstalledAs: "symlink" | "copy";
  launchdActions: string[];
  launchdWarning: string | undefined;
}

export function resolveTelePiInstallContext(cliModuleUrl: string): TelePiInstallContext {
  const rawCliEntrypointPath = fileURLToPath(cliModuleUrl);
  const packageRoot = path.resolve(path.dirname(rawCliEntrypointPath), "..");
  const cliEntrypointPath = resolveInstalledCliEntrypointPath(packageRoot, rawCliEntrypointPath);
  const homeDirectory = getHomeDirectory();
  const launchAgentDomain = resolveLaunchAgentDomain();

  return {
    packageRoot,
    cliEntrypointPath,
    envExamplePath: path.join(packageRoot, ".env.example"),
    launchdTemplatePath: path.join(packageRoot, "launchd", TELEPI_LAUNCH_AGENT_FILENAME),
    extensionSourcePath: path.join(packageRoot, "extensions", TELEPI_EXTENSION_FILENAME),
    configPath: getDefaultTelePiConfigPath(homeDirectory),
    launchAgentPath: path.join(homeDirectory, "Library", "LaunchAgents", TELEPI_LAUNCH_AGENT_FILENAME),
    launchAgentLabel: TELEPI_LAUNCHD_LABEL,
    launchAgentDomain,
    launchAgentServiceTarget: launchAgentDomain
      ? `${launchAgentDomain}/${TELEPI_LAUNCHD_LABEL}`
      : undefined,
    launchAgentLogsDirectory: path.join(homeDirectory, "Library", "Logs", "TelePi"),
    launchAgentStdoutPath: path.join(homeDirectory, "Library", "Logs", "TelePi", "telepi.out.log"),
    launchAgentStderrPath: path.join(homeDirectory, "Library", "Logs", "TelePi", "telepi.err.log"),
    extensionDestinationPath: path.join(
      homeDirectory,
      ".pi",
      "agent",
      "extensions",
      TELEPI_EXTENSION_FILENAME,
    ),
    nodeExecutablePath: process.execPath,
    workingDirectory: homeDirectory,
    pathEnvironment: process.env.PATH,
    version: readPackageVersion(packageRoot),
  };
}

export function getTelePiStatus(cliModuleUrl: string): TelePiStatus {
  const context = resolveTelePiInstallContext(cliModuleUrl);
  const configInfo = getInstalledConfigStatus(context);

  return {
    version: context.version,
    resolvedConfigPath: configInfo.resolvedPath,
    configExists: existsSync(configInfo.resolvedPath),
    configSource: configInfo.source,
    launchAgent: getLaunchAgentStatus(context),
    extension: getExtensionStatus(context),
  };
}

export function setupTelePi(cliModuleUrl: string): TelePiSetupResult {
  if (process.platform !== "darwin") {
    throw new Error("telepi setup is currently only supported on macOS.");
  }

  const context = resolveTelePiInstallContext(cliModuleUrl);
  ensureInstallInputsExist(context);

  mkdirSync(path.dirname(context.configPath), { recursive: true });
  mkdirSync(path.dirname(context.launchAgentPath), { recursive: true });
  mkdirSync(context.launchAgentLogsDirectory, { recursive: true });
  mkdirSync(path.dirname(context.extensionDestinationPath), { recursive: true });

  const configCreated = ensureConfigEnv(context);
  const launchAgentUpdated = writeLaunchAgentPlist(context);
  const extensionInstalledAs = installExtension(context);
  const { actions: launchdActions, warning: launchdWarning } = reconcileLaunchAgent(context);

  return {
    context,
    configCreated,
    launchAgentUpdated,
    extensionInstalledAs,
    launchdActions,
    launchdWarning,
  };
}

export function buildLaunchAgentPlist(context: TelePiInstallContext): string {
  const template = readFileSync(context.launchdTemplatePath, "utf8");
  const replacements: Array<[string, string]> = [
    ["/ABSOLUTE/PATH/TO/WORKDIR", escapeXml(context.workingDirectory)],
    ["/ABSOLUTE/PATH/TO/node", escapeXml(context.nodeExecutablePath)],
    ["/ABSOLUTE/PATH/TO/TelePi/dist/cli.js", escapeXml(context.cliEntrypointPath)],
    ["/ABSOLUTE/PATH/TO/telepi.out.log", escapeXml(context.launchAgentStdoutPath)],
    ["/ABSOLUTE/PATH/TO/telepi.err.log", escapeXml(context.launchAgentStderrPath)],
    ["__TELEPI_PATH_ENV_BLOCK__", buildEnvironmentVariablesBlock(context)],
  ];

  return replacements.reduce(
    (content, [placeholder, value]) => content.replace(placeholder, value),
    template,
  );
}

function getInstalledConfigStatus(context: TelePiInstallContext): {
  resolvedPath: string;
  source: TelePiStatusConfigSource;
} {
  const plistContents = readLaunchAgentPlist(context);
  if (!plistContents) {
    return {
      resolvedPath: context.configPath,
      source: "installed-default",
    };
  }

  const workingDirectory = readLaunchAgentWorkingDirectory(plistContents) ?? context.workingDirectory;
  const envVars = readLaunchAgentEnvironmentVariables(plistContents);
  const explicitConfigPath = envVars.TELEPI_CONFIG
    ? resolvePathFromCwd(envVars.TELEPI_CONFIG, workingDirectory)
    : undefined;

  if (explicitConfigPath) {
    return {
      resolvedPath: explicitConfigPath,
      source: "launchd-env",
    };
  }

  const localConfigPath = path.join(workingDirectory, ".env");
  if (existsSync(localConfigPath)) {
    return {
      resolvedPath: localConfigPath,
      source: "launchd-cwd",
    };
  }

  return {
    resolvedPath: context.configPath,
    source: "installed-default",
  };
}

function ensureInstallInputsExist(context: TelePiInstallContext): void {
  if (path.extname(context.cliEntrypointPath) === ".ts") {
    throw new Error(
      `telepi setup requires a built CLI entrypoint at ${path.join(context.packageRoot, "dist", "cli.js")}. Run \`npm run build\` and rerun \`telepi setup\`.`,
    );
  }

  for (const filePath of [
    context.envExamplePath,
    context.launchdTemplatePath,
    context.extensionSourcePath,
    context.cliEntrypointPath,
  ]) {
    if (!existsSync(filePath)) {
      throw new Error(`Required install asset is missing: ${filePath}`);
    }
  }
}

function ensureConfigEnv(context: TelePiInstallContext): boolean {
  if (existsSync(context.configPath)) {
    return false;
  }

  copyFileSync(context.envExamplePath, context.configPath);
  return true;
}

function writeLaunchAgentPlist(context: TelePiInstallContext): boolean {
  const nextContents = buildLaunchAgentPlist(context);
  const previousContents = existsSync(context.launchAgentPath)
    ? readFileSync(context.launchAgentPath, "utf8")
    : undefined;

  if (previousContents === nextContents) {
    return false;
  }

  writeFileSync(context.launchAgentPath, nextContents, "utf8");
  return true;
}

function installExtension(context: TelePiInstallContext): "symlink" | "copy" {
  const destinationPath = context.extensionDestinationPath;
  const existingStatus = getExtensionStatus(context);

  if (existingStatus.mode === "symlink" && existingStatus.targetPath === context.extensionSourcePath) {
    return "symlink";
  }

  rmSync(destinationPath, { force: true, recursive: true });

  try {
    symlinkSync(context.extensionSourcePath, destinationPath);
    return "symlink";
  } catch {
    copyFileSync(context.extensionSourcePath, destinationPath);
    return "copy";
  }
}

function reconcileLaunchAgent(context: TelePiInstallContext): {
  actions: string[];
  warning: string | undefined;
} {
  const actions: string[] = [];

  if (process.platform !== "darwin") {
    return { actions, warning: "launchd is only available on macOS." };
  }

  if (!context.launchAgentDomain || !context.launchAgentServiceTarget) {
    return {
      actions,
      warning:
        "Could not determine the current user launchd domain. Load the agent manually with launchctl bootstrap.",
    };
  }

  const launchctlCheck = runCommand("launchctl", ["help"]);
  if (launchctlCheck.error) {
    return {
      actions,
      warning: `launchctl is unavailable: ${launchctlCheck.error.message}`,
    };
  }

  runCommand("launchctl", ["bootout", context.launchAgentDomain, context.launchAgentPath]);
  actions.push(`bootout ${context.launchAgentDomain} ${context.launchAgentPath}`);

  const bootstrap = runCommand("launchctl", [
    "bootstrap",
    context.launchAgentDomain,
    context.launchAgentPath,
  ]);
  if (bootstrap.status !== 0) {
    return {
      actions,
      warning: formatLaunchctlFailure("bootstrap", bootstrap),
    };
  }
  actions.push(`bootstrap ${context.launchAgentDomain} ${context.launchAgentPath}`);

  const enable = runCommand("launchctl", ["enable", context.launchAgentServiceTarget]);
  if (enable.status === 0) {
    actions.push(`enable ${context.launchAgentServiceTarget}`);
  }

  const kickstart = runCommand("launchctl", ["kickstart", "-k", context.launchAgentServiceTarget]);
  if (kickstart.status === 0) {
    actions.push(`kickstart -k ${context.launchAgentServiceTarget}`);
    return { actions, warning: undefined };
  }

  return {
    actions,
    warning: formatLaunchctlFailure("kickstart", kickstart),
  };
}

function getLaunchAgentStatus(context: TelePiInstallContext): LaunchAgentStatus {
  const plistExists = existsSync(context.launchAgentPath);

  if (process.platform !== "darwin") {
    return {
      plistExists,
      loaded: false,
      state: undefined,
      pid: undefined,
      detail: "launchd unavailable on this platform",
      error: undefined,
    };
  }

  if (!context.launchAgentServiceTarget) {
    return {
      plistExists,
      loaded: false,
      state: undefined,
      pid: undefined,
      detail: "launchd domain unavailable",
      error: "Could not determine the current user launchd domain.",
    };
  }

  const result = runCommand("launchctl", ["print", context.launchAgentServiceTarget]);
  if (result.error) {
    return {
      plistExists,
      loaded: false,
      state: undefined,
      pid: undefined,
      detail: "launchctl unavailable",
      error: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      plistExists,
      loaded: false,
      state: undefined,
      pid: undefined,
      detail: plistExists ? "installed but not loaded" : "not installed",
      error: cleanCommandOutput(result.stderr) || cleanCommandOutput(result.stdout) || undefined,
    };
  }

  const output = `${result.stdout}\n${result.stderr}`;
  return {
    plistExists,
    loaded: true,
    state: matchValue(output, /\bstate = ([^\n]+)/),
    pid: parseNumericValue(matchValue(output, /\bpid = (\d+)/)),
    detail: "loaded",
    error: undefined,
  };
}

function getExtensionStatus(context: TelePiInstallContext): ExtensionStatus {
  const destinationPath = context.extensionDestinationPath;
  const sourcePath = context.extensionSourcePath;

  if (!existsSync(destinationPath)) {
    return {
      exists: false,
      mode: "missing",
      detail: "missing",
      targetPath: undefined,
    };
  }

  const stats = lstatSync(destinationPath);
  if (stats.isSymbolicLink()) {
    const rawTarget = readlinkSync(destinationPath);
    const resolvedTarget = path.resolve(path.dirname(destinationPath), rawTarget);
    if (resolvedTarget === sourcePath) {
      return {
        exists: true,
        mode: "symlink",
        detail: "symlinked",
        targetPath: resolvedTarget,
      };
    }

    return {
      exists: true,
      mode: "custom",
      detail: "symlinked elsewhere",
      targetPath: resolvedTarget,
    };
  }

  if (filesMatch(destinationPath, sourcePath)) {
    return {
      exists: true,
      mode: "copy",
      detail: "copied",
      targetPath: undefined,
    };
  }

  return {
    exists: true,
    mode: "custom",
    detail: "custom file",
    targetPath: undefined,
  };
}

function filesMatch(leftPath: string, rightPath: string): boolean {
  if (!existsSync(leftPath) || !existsSync(rightPath)) {
    return false;
  }

  return readFileSync(leftPath, "utf8") === readFileSync(rightPath, "utf8");
}

function buildEnvironmentVariablesBlock(context: TelePiInstallContext): string {
  const entries: Array<[string, string]> = [["TELEPI_CONFIG", context.configPath]];
  if (context.pathEnvironment) {
    entries.push(["PATH", context.pathEnvironment]);
  }

  return [
    "",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...entries.flatMap(([key, value]) => [
      `    <key>${key}</key>`,
      `    <string>${escapeXml(value)}</string>`,
    ]),
    "  </dict>",
  ].join("\n");
}

function readLaunchAgentPlist(context: TelePiInstallContext): string | undefined {
  if (!existsSync(context.launchAgentPath)) {
    return undefined;
  }

  return readFileSync(context.launchAgentPath, "utf8");
}

function readLaunchAgentWorkingDirectory(plistContents: string): string | undefined {
  return readLaunchAgentStringValue(plistContents, "WorkingDirectory");
}

function readLaunchAgentEnvironmentVariables(plistContents: string): Record<string, string> {
  const environmentBlock = plistContents.match(
    /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/,
  )?.[1];
  if (!environmentBlock) {
    return {};
  }

  const values: Record<string, string> = {};
  const pattern = /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g;

  for (const match of environmentBlock.matchAll(pattern)) {
    const key = decodeXml(match[1] ?? "").trim();
    const value = decodeXml(match[2] ?? "").trim();
    if (key) {
      values[key] = value;
    }
  }

  return values;
}

function readLaunchAgentStringValue(plistContents: string, key: string): string | undefined {
  const pattern = new RegExp(
    `<key>${escapeRegExp(key)}<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>`,
  );
  const value = plistContents.match(pattern)?.[1];
  return value ? decodeXml(value).trim() : undefined;
}

function readPackageVersion(packageRoot: string): string {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
  return packageJson.version ?? "0.0.0";
}

function resolveInstalledCliEntrypointPath(packageRoot: string, rawCliEntrypointPath: string): string {
  if (path.extname(rawCliEntrypointPath) !== ".ts") {
    return rawCliEntrypointPath;
  }

  const builtCliEntrypointPath = path.join(packageRoot, "dist", "cli.js");
  return existsSync(builtCliEntrypointPath) ? builtCliEntrypointPath : rawCliEntrypointPath;
}

function resolveLaunchAgentDomain(): string | undefined {
  const uid = process.getuid?.();
  if (typeof uid === "number") {
    return `gui/${uid}`;
  }

  const rawUid = process.env.UID?.trim();
  if (!rawUid) {
    return undefined;
  }

  const parsedUid = Number(rawUid);
  return Number.isInteger(parsedUid) ? `gui/${parsedUid}` : undefined;
}

function runCommand(command: string, args: string[]): LaunchctlResult {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error,
    };
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function formatLaunchctlFailure(action: string, result: LaunchctlResult): string {
  const detail = cleanCommandOutput(result.stderr) || cleanCommandOutput(result.stdout);
  return detail ? `launchctl ${action} failed: ${detail}` : `launchctl ${action} failed.`;
}

function cleanCommandOutput(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function matchValue(input: string, pattern: RegExp): string | undefined {
  return input.match(pattern)?.[1]?.trim();
}

function parseNumericValue(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

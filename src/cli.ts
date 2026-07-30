#!/usr/bin/env node
import { isEntrypoint } from "./entrypoint.js";
import { configureHttpRuntime } from "./http-runtime.js";
import { getTelePiStatus, resolveTelePiInstallContext, setupTelePi } from "./install.js";
import { startBot } from "./index.js";

// Must run before any provider request is issued. See http-runtime.ts.
configureHttpRuntime();

const HELP_TEXT = `TelePi CLI

Usage:
  telepi                              Start the bot
  telepi start                        Start the bot
  telepi setup                        Interactive setup (TTY only)
  telepi setup <bot_token> <userids> <workspace>
                                      Fast setup without prompts
  telepi status                       Show installed-mode status
  telepi version                      Print the TelePi version
  telepi help                         Show this help
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "start":
      ensureNoArguments(command ?? "start", rest);
      await startBot();
      return;
    case "setup":
      await runSetupCommand(rest);
      return;
    case "status":
      ensureNoArguments(command, rest);
      runStatusCommand();
      return;
    case "version":
    case "--version":
    case "-v":
      ensureNoArguments("version", rest);
      console.log(resolveTelePiInstallContext(import.meta.url).version);
      return;
    case "help":
    case "--help":
    case "-h":
      ensureNoArguments("help", rest);
      console.log(HELP_TEXT);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

export function ensureNoArguments(command: string, args: string[]): void {
  if (args.length > 0) {
    throw new Error(`Unexpected arguments for ${command}: ${args.join(" ")}`);
  }
}

export async function runSetupCommand(args: string[]): Promise<void> {
  if (args.length !== 0 && args.length !== 3) {
    throw new Error("Usage: telepi setup [<bot_token> <userids> <workspace>]");
  }

  const [telegramBotToken, telegramAllowedUserIds, workspace] = args;
  const result = await setupTelePi(import.meta.url, {
    telegramBotToken,
    telegramAllowedUserIds,
    workspace,
  });
  const configState = result.configCreated
    ? "created"
    : result.configUpdated
      ? "updated"
      : "unchanged";

  const platform = result.context.platform;
  const serviceLabel = platform === "linux" ? "Service" : "LaunchAgent";

  console.log(`TelePi ${result.context.version}`);
  console.log(`Config: ${result.context.configPath} (${configState})`);

  if (platform === "linux" && result.context.serviceUnitPath) {
    console.log(
      `Service: ${result.context.serviceUnitPath} (${result.unitUpdated ? "updated" : "unchanged"})`,
    );
  } else if (platform === "darwin" && result.context.launchAgentPath) {
    console.log(
      `${serviceLabel}: ${result.context.launchAgentPath} (${result.unitUpdated ? "updated" : "unchanged"})`,
    );
  }

  console.log(
    `Extension: ${result.context.extensionDestinationPath} (${result.extensionInstalledAs})`,
  );

  if (result.serviceActions.length > 0) {
    const actionLabel = platform === "linux" ? "systemctl" : "launchd";
    console.log(`${actionLabel}: ${result.serviceActions.join(" -> ")}`);
  }
  if (result.serviceWarning) {
    const warningLabel = platform === "linux" ? "systemd" : "launchd";
    console.warn(`${warningLabel} warning: ${result.serviceWarning}`);
  }
}

export function runStatusCommand(): void {
  const status = getTelePiStatus(import.meta.url);
  const platform = resolveTelePiInstallContext(import.meta.url).platform;

  const configSourceLabels: Record<string, string> = {
    "service-env": platform === "linux" ? "systemd TELEPI_CONFIG" : "launchd TELEPI_CONFIG",
    "service-cwd": platform === "linux" ? "systemd working-directory .env" : "launchd working-directory .env",
    "launchd-env": "launchd TELEPI_CONFIG",
    "launchd-cwd": "launchd working-directory .env",
    "installed-default": "installed default",
  };

  const serviceSummary = status.service.loaded
    ? `loaded${status.service.state ? ` (${status.service.state})` : ""}${status.service.pid ? ` pid=${status.service.pid}` : ""}`
    : status.service.detail;

  const extensionSummary =
    status.extension.mode === "symlink" && status.extension.targetPath
      ? `${status.extension.detail} -> ${status.extension.targetPath}`
      : status.extension.detail;

  const serviceLabel = platform === "linux" ? "systemd" : "launchd";
  const unitLabel = platform === "linux" ? "unit" : "plist";
  const unitPresent = status.service.unitExists ? `${unitLabel} present` : `${unitLabel} missing`;

  console.log(`TelePi ${status.version}`);
  console.log(`Config path: ${status.resolvedConfigPath} [${configSourceLabels[status.configSource] ?? status.configSource}]`);
  console.log(`Config exists: ${status.configExists ? "yes" : "no"}`);
  console.log(`${serviceLabel}: ${serviceSummary} (${unitPresent})`);
  if (status.service.error) {
    console.log(`${serviceLabel} detail: ${status.service.error}`);
  }
  console.log(`Extension: ${extensionSummary}`);
}

async function runCli(): Promise<void> {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`telepi: ${message}`);
    if (message.startsWith("Unknown command:") || message.startsWith("Unexpected arguments") || message.startsWith("Usage: telepi setup")) {
      console.error("Run `telepi help` for usage.");
    }
    process.exit(1);
  }
}

if (isEntrypoint(import.meta.url)) {
  await runCli();
}
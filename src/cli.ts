#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getTelePiStatus, resolveTelePiInstallContext, setupTelePi } from "./install.js";
import { startBot } from "./index.js";

const HELP_TEXT = `TelePi CLI

Usage:
  telepi                              Start the bot
  telepi start                        Start the bot
  telepi setup                        Interactive macOS setup (TTY only)
  telepi setup <bot_token> <userids> <workspace>
                                      Fast macOS setup without prompts
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

  console.log(`TelePi ${result.context.version}`);
  console.log(`Config: ${result.context.configPath} (${configState})`);
  console.log(
    `LaunchAgent: ${result.context.launchAgentPath} (${result.launchAgentUpdated ? "updated" : "unchanged"})`,
  );
  console.log(
    `Extension: ${result.context.extensionDestinationPath} (${result.extensionInstalledAs})`,
  );

  if (result.launchdActions.length > 0) {
    console.log(`launchd: ${result.launchdActions.join(" -> ")}`);
  }
  if (result.launchdWarning) {
    console.warn(`launchd warning: ${result.launchdWarning}`);
  }
}

export function runStatusCommand(): void {
  const status = getTelePiStatus(import.meta.url);
  const configSourceLabels: Record<typeof status.configSource, string> = {
    "launchd-env": "launchd TELEPI_CONFIG",
    "launchd-cwd": "launchd working-directory .env",
    "installed-default": "installed default",
  };
  const launchdSummary = status.launchAgent.loaded
    ? `loaded${status.launchAgent.state ? ` (${status.launchAgent.state})` : ""}${status.launchAgent.pid ? ` pid=${status.launchAgent.pid}` : ""}`
    : status.launchAgent.detail;
  const extensionSummary =
    status.extension.mode === "symlink" && status.extension.targetPath
      ? `${status.extension.detail} -> ${status.extension.targetPath}`
      : status.extension.detail;

  console.log(`TelePi ${status.version}`);
  console.log(`Config path: ${status.resolvedConfigPath} [${configSourceLabels[status.configSource]}]`);
  console.log(`Config exists: ${status.configExists ? "yes" : "no"}`);
  console.log(
    `launchd: ${launchdSummary} (${status.launchAgent.plistExists ? "plist present" : "plist missing"})`,
  );
  if (status.launchAgent.error) {
    console.log(`launchd detail: ${status.launchAgent.error}`);
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

function isEntrypoint(moduleUrl: string): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) {
    return false;
  }

  try {
    return fileURLToPath(moduleUrl) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url)) {
  await runCli();
}

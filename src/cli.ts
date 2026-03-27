#!/usr/bin/env node
import { getTelePiStatus, resolveTelePiInstallContext, setupTelePi } from "./install.js";
import { startBot } from "./index.js";

const HELP_TEXT = `TelePi CLI

Usage:
  telepi                Start the bot
  telepi start          Start the bot
  telepi setup          Install/update the macOS launchd service and Pi extension
  telepi status         Show installed-mode status
  telepi version        Print the TelePi version
  telepi help           Show this help
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (rest.length > 0) {
    throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
  }

  switch (command) {
    case undefined:
    case "start":
      await startBot();
      return;
    case "setup":
      runSetupCommand();
      return;
    case "status":
      runStatusCommand();
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(resolveTelePiInstallContext(import.meta.url).version);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP_TEXT);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function runSetupCommand(): void {
  const result = setupTelePi(import.meta.url);

  console.log(`TelePi ${result.context.version}`);
  console.log(`Config: ${result.context.configPath} (${result.configCreated ? "created" : "present"})`);
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

function runStatusCommand(): void {
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

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`telepi: ${message}`);
  if (message.startsWith("Unknown command:") || message.startsWith("Unexpected arguments:")) {
    console.error("Run `telepi help` for usage.");
  }
  process.exit(1);
}

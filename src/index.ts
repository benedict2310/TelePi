import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBot, registerCommands } from "./bot.js";
import { loadConfig } from "./config.js";
import { PiSessionRegistry } from "./pi-session.js";

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 3000;

export async function startBot(): Promise<void> {
  let sessionRegistry: PiSessionRegistry | undefined;
  let bot: ReturnType<typeof createBot> | undefined;
  let shuttingDown = false;
  let restartAttempts = 0;

  try {
    const config = loadConfig();
    sessionRegistry = await PiSessionRegistry.create(config);
    bot = createBot(config, sessionRegistry);
    await registerCommands(bot);

    console.log("TelePi running");
    console.log(`Default workspace: ${config.workspace}`);
    if (config.piSessionPath) {
      console.log(`Bootstrap session: ${config.piSessionPath}`);
    }
  } catch (error) {
    sessionRegistry?.dispose();
    throw error;
  }

  const disposeSessions = () => {
    sessionRegistry?.dispose();
    sessionRegistry = undefined;
  };

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    console.log(`Received ${signal}, shutting down TelePi...`);
    bot?.stop();

    setTimeout(() => {
      disposeSessions();
      console.log("TelePi stopped.");
    }, 500);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  async function startPolling(): Promise<void> {
    try {
      await bot!.start({
        drop_pending_updates: true,
        onStart: () => {
          restartAttempts = 0;
        },
      });
    } catch (error) {
      if (shuttingDown) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const is409 = message.includes("409") || message.includes("Conflict");

      if (is409 && restartAttempts < MAX_RESTART_ATTEMPTS) {
        restartAttempts++;
        console.warn(`Polling error (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}): ${message}`);
        console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
        return startPolling();
      }

      disposeSessions();
      throw error;
    }
  }

  try {
    await startPolling();
  } finally {
    if (!shuttingDown) {
      disposeSessions();
    }
  }
}

async function runMain(): Promise<void> {
  try {
    await startBot();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start TelePi: ${message}`);
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
  await runMain();
}

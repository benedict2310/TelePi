import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type HandoffMode = "direct" | "launchd";

export type DirectLaunchTarget =
  | {
      kind: "installed";
      homeDirectory: string;
      installedConfigPath: string;
    }
  | {
      kind: "source";
      telePiDir: string;
    }
  | {
      kind: "unavailable";
      reason: "missing-installed-config" | "missing-telepi";
      installedConfigPath: string;
    };

const DEFAULT_LAUNCHD_LABEL = "com.telepi";
const DIRECT_LOG_PATH = "/tmp/telepi.log";

function shellQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function getLaunchdLabel(env: NodeJS.ProcessEnv = process.env): string {
  return env.TELEPI_LAUNCHD_LABEL?.trim() || DEFAULT_LAUNCHD_LABEL;
}

export function resolveHandoffMode(env: NodeJS.ProcessEnv = process.env): HandoffMode | undefined {
  const raw = env.TELEPI_HANDOFF_MODE?.trim().toLowerCase();
  if (!raw || raw === "auto") {
    return hasInstalledLaunchdFlow(env) ? "launchd" : "direct";
  }
  if (raw === "direct") {
    return "direct";
  }
  if (raw === "launchd") {
    return "launchd";
  }
  return undefined;
}

export function getHomeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || homedir();
}

export function getInstalledConfigPath(homeDirectory = getHomeDirectory()): string {
  return path.join(homeDirectory, ".config", "telepi", "config.env");
}

export function getInstalledLaunchAgentPath(
  homeDirectory = getHomeDirectory(),
  launchdLabel = getLaunchdLabel(),
): string {
  return path.join(homeDirectory, "Library", "LaunchAgents", `${launchdLabel}.plist`);
}

export function hasInstalledLaunchdFlow(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== "darwin") {
    return false;
  }

  const homeDirectory = getHomeDirectory(env);
  return (
    existsSync(getInstalledConfigPath(homeDirectory)) &&
    existsSync(getInstalledLaunchAgentPath(homeDirectory, getLaunchdLabel(env)))
  );
}

export function resolveDirectLaunchTarget(options: {
  hasGlobalTelePi: boolean;
  telePiDir: string | undefined;
  env?: NodeJS.ProcessEnv;
}): DirectLaunchTarget {
  const env = options.env ?? process.env;
  const homeDirectory = getHomeDirectory(env);
  const installedConfigPath = getInstalledConfigPath(homeDirectory);
  const telePiDir = options.telePiDir?.trim();

  if (options.hasGlobalTelePi && existsSync(installedConfigPath)) {
    return {
      kind: "installed",
      homeDirectory,
      installedConfigPath,
    };
  }

  if (telePiDir) {
    return {
      kind: "source",
      telePiDir,
    };
  }

  if (options.hasGlobalTelePi) {
    return {
      kind: "unavailable",
      reason: "missing-installed-config",
      installedConfigPath,
    };
  }

  return {
    kind: "unavailable",
    reason: "missing-telepi",
    installedConfigPath,
  };
}

async function hasGlobalTelePiCommand(pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec("bash", ["-lc", "command -v telepi >/dev/null 2>&1"], {
      timeout: 3000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Hand off this session to TelePi (Telegram)",
    handler: async (_args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();

      if (!sessionFile) {
        ctx.ui.notify("Cannot hand off an in-memory session. Save the session first.", "error");
        return;
      }

      const handoffMode = resolveHandoffMode();
      if (!handoffMode) {
        ctx.ui.notify(
          "Invalid TELEPI_HANDOFF_MODE. Expected one of: auto, direct, launchd",
          "error",
        );
        return;
      }

      const safeSessionFile = shellQuote(sessionFile);
      let launched = false;

      if (handoffMode === "launchd") {
        const launchdLabel = getLaunchdLabel();
        const safeLaunchdLabel = shellQuote(launchdLabel);

        ctx.ui.notify(
          `Handing off to TelePi via launchd...\nSession: ${sessionFile}\nJob: ${launchdLabel}`,
          "info",
        );

        try {
          const result = await pi.exec(
            "bash",
            [
              "-lc",
              `session_file='${safeSessionFile}'
label='${safeLaunchdLabel}'
launchctl setenv PI_SESSION_PATH "$session_file"
launchctl kickstart -k "gui/$UID/$label"`,
            ],
            { timeout: 5000 },
          );

          if (result.code === 0) {
            ctx.ui.notify(`TelePi restarted via launchd job ${launchdLabel}. Check Telegram!`, "success");
            launched = true;
          } else {
            ctx.ui.notify(
              "Could not restart TelePi via launchd. Verify the LaunchAgent is loaded and try manually:\n" +
                `launchctl setenv PI_SESSION_PATH '${safeSessionFile}'\n` +
                `launchctl kickstart -k gui/$UID/'${safeLaunchdLabel}'`,
              "warning",
            );
          }
        } catch {
          // pi.exec() only throws on OS-level failure (e.g. timeout); non-zero exit codes are
          // handled above via result.code. This catch is a last-resort safety net.
          ctx.ui.notify(
            "Could not restart TelePi via launchd. Verify the LaunchAgent is loaded and try manually:\n" +
              `launchctl setenv PI_SESSION_PATH '${safeSessionFile}'\n` +
              `launchctl kickstart -k gui/$UID/'${safeLaunchdLabel}'`,
            "warning",
          );
        }
      } else {
        const telePiDir = process.env.TELEPI_DIR?.trim();
        const hasGlobalTelePi = await hasGlobalTelePiCommand(pi);
        const directLaunchTarget = resolveDirectLaunchTarget({ hasGlobalTelePi, telePiDir });

        if (directLaunchTarget.kind === "unavailable") {
          if (directLaunchTarget.reason === "missing-installed-config") {
            ctx.ui.notify(
              "TelePi is installed globally, but its installed config is missing:\n" +
                `  ${directLaunchTarget.installedConfigPath}\n\n` +
                "Run `telepi setup` to create it, or point TELEPI_DIR at a source checkout.",
              "error",
            );
            return;
          }

          ctx.ui.notify(
            "TelePi is not available for direct hand-off. Either install it globally:\n" +
              "  npm install -g @benedict2310/telepi\n" +
              "  telepi setup\n\n" +
              "Or point TELEPI_DIR at a source checkout:\n" +
              "  export TELEPI_DIR=/path/to/TelePi\n\n" +
              "Or switch to launchd mode with:\n" +
              "  export TELEPI_HANDOFF_MODE=launchd",
            "error",
          );
          return;
        }

        ctx.ui.notify(`Handing off to TelePi...\nSession: ${sessionFile}`, "info");

        if (directLaunchTarget.kind === "source") {
          await pi.exec("bash", ["-lc", 'pkill -f "tsx.*TelePi" 2>/dev/null || true'], {
            timeout: 3000,
          }).catch(() => {});
        }

        try {
          const result =
            directLaunchTarget.kind === "installed"
              ? await pi.exec(
                  "bash",
                  [
                    "-lc",
                    `cd '${shellQuote(directLaunchTarget.homeDirectory)}'
telepi_command="$(command -v telepi)"
PI_SESSION_PATH='${safeSessionFile}' TELEPI_CONFIG='${shellQuote(directLaunchTarget.installedConfigPath)}' nohup "$telepi_command" start > '${DIRECT_LOG_PATH}' 2>&1 & echo $!`,
                  ],
                  { timeout: 5000 },
                )
              : await pi.exec(
                  "bash",
                  [
                    "-lc",
                    `cd '${shellQuote(directLaunchTarget.telePiDir)}'
PI_SESSION_PATH='${safeSessionFile}' nohup npx tsx src/index.ts > '${DIRECT_LOG_PATH}' 2>&1 & echo $!`,
                  ],
                  { timeout: 5000 },
                );
          const pid = result.stdout.trim();
          if (pid && result.code === 0) {
            ctx.ui.notify(
              directLaunchTarget.kind === "installed"
                ? `TelePi started via installed \`telepi\` (PID: ${pid}). Check Telegram!`
                : `TelePi started from source checkout (PID: ${pid}). Check Telegram!`,
              "success",
            );
            launched = true;
          } else {
            ctx.ui.notify(`TelePi may have failed to start. Check ${DIRECT_LOG_PATH}`, "warning");
          }
        } catch {
          ctx.ui.notify(
            directLaunchTarget.kind === "installed"
              ? "Could not auto-launch TelePi. Start it manually:\n" +
                  `TELEPI_CONFIG="${directLaunchTarget.installedConfigPath}" PI_SESSION_PATH="${sessionFile}" telepi start`
              : `Could not auto-launch TelePi. Start it manually:\n` +
                  `cd "${directLaunchTarget.telePiDir}" && PI_SESSION_PATH="${sessionFile}" npx tsx src/index.ts`,
            "warning",
          );
        }
      }

      if (launched) {
        ctx.shutdown();
      }
    },
  });
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type HandoffMode = "direct" | "launchd" | "systemd";

export type DirectLaunchTarget =
  | { kind: "installed"; homeDirectory: string; installedConfigPath: string }
  | { kind: "source"; telePiDir: string }
  | { kind: "unavailable"; reason: "missing-installed-config" | "missing-telepi"; installedConfigPath: string };

const DEFAULT_LAUNCHD_LABEL = "com.telepi";
const DEFAULT_SYSTEMD_SERVICE = "telepi.service";
const DIRECT_LOG_PATH = "/tmp/telepi.log";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function getLaunchdLabel(env: NodeJS.ProcessEnv = process.env): string {
  return env.TELEPI_LAUNCHD_LABEL?.trim() || DEFAULT_LAUNCHD_LABEL;
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

export function getInstalledSystemdServicePath(homeDirectory = getHomeDirectory()): string {
  return path.join(homeDirectory, ".config", "systemd", "user", DEFAULT_SYSTEMD_SERVICE);
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

export function resolveHandoffMode(env: NodeJS.ProcessEnv = process.env): HandoffMode | undefined {
  const raw = env.TELEPI_HANDOFF_MODE?.trim().toLowerCase();

  if (!raw || raw === "auto") {
    if (hasInstalledLaunchdFlow(env)) return "launchd";
    if (hasInstalledSystemdFlow(env)) return "systemd";
    return "direct";
  }

  if (raw === "direct") return "direct";
  if (raw === "launchd") return "launchd";
  if (raw === "systemd") return "systemd";

  return undefined;
}

export function hasInstalledLaunchdFlow(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== "darwin") return false;

  const homeDirectory = getHomeDirectory(env);
  return (
    existsSync(getInstalledConfigPath(homeDirectory)) &&
    existsSync(getInstalledLaunchAgentPath(homeDirectory, getLaunchdLabel(env)))
  );
}

export function hasInstalledSystemdFlow(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== "linux") return false;

  const homeDirectory = getHomeDirectory(env);
  return (
    existsSync(getInstalledConfigPath(homeDirectory)) &&
    existsSync(getInstalledSystemdServicePath(homeDirectory))
  );
}

// ---------------------------------------------------------------------------
// Direct launch target
// ---------------------------------------------------------------------------

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
    return { kind: "installed", homeDirectory, installedConfigPath };
  }
  if (telePiDir) return { kind: "source", telePiDir };
  if (options.hasGlobalTelePi) {
    return { kind: "unavailable", reason: "missing-installed-config", installedConfigPath };
  }
  return { kind: "unavailable", reason: "missing-telepi", installedConfigPath };
}

async function hasGlobalTelePiCommand(pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec("bash", ["-lc", "command -v telepi >/dev/null 2>&1"], { timeout: 3000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Handoff command handler
// ---------------------------------------------------------------------------

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
        ctx.ui.notify("Invalid TELEPI_HANDOFF_MODE. Expected one of: auto, direct, launchd, systemd", "error");
        return;
      }

      const safeSessionFile = shellQuote(sessionFile);
      let launched = false;

      // 1) launchd (macOS)
      if (handoffMode === "launchd") {
        launched = await handoffViaLaunchd(pi, ctx, sessionFile, safeSessionFile);
      }
      // 2) systemd (Linux)
      else if (handoffMode === "systemd") {
        launched = await handoffViaSystemd(pi, ctx, sessionFile, safeSessionFile);
      }
      // 3) direct
      else {
        launched = await handoffViaDirect(pi, ctx, sessionFile, safeSessionFile);
      }

      if (launched) ctx.shutdown();
    },
  });
}

// ---------------------------------------------------------------------------
// Handoff implementations
// ---------------------------------------------------------------------------

async function handoffViaLaunchd(
  pi: ExtensionAPI,
  ctx: { ui: { notify: (msg: string, severity: "info" | "warning" | "error") => void } },
  sessionFile: string,
  safeSessionFile: string,
): Promise<boolean> {
  const launchdLabel = getLaunchdLabel();
  const safeLaunchdLabel = shellQuote(launchdLabel);

  ctx.ui.notify(`Handing off to TelePi via launchd...\nSession: ${sessionFile}\nJob: ${launchdLabel}`, "info");

  try {
    const result = await pi.exec(
      "bash",
      ["-lc", [
        `session_file='${safeSessionFile}'`,
        `label='${safeLaunchdLabel}'`,
        `launchctl setenv PI_SESSION_PATH "$session_file"`,
        `launchctl kickstart -k "gui/$UID/$label"`,
      ].join("\n")],
      { timeout: 5000 },
    );

    if (result.code === 0) {
      ctx.ui.notify(`TelePi restarted via launchd job ${launchdLabel}. Check Telegram!`, "info");
      return true;
    }

    ctx.ui.notify(
      "Could not restart TelePi via launchd. Verify the LaunchAgent is loaded and try manually:\n" +
        `launchctl setenv PI_SESSION_PATH '${safeSessionFile}'\n` +
        `launchctl kickstart -k gui/$UID/'${safeLaunchdLabel}'`,
      "warning",
    );
    return false;
  } catch {
    ctx.ui.notify(
      "Could not restart TelePi via launchd. Verify the LaunchAgent is loaded and try manually:\n" +
        `launchctl setenv PI_SESSION_PATH '${safeSessionFile}'\n` +
        `launchctl kickstart -k gui/$UID/'${safeLaunchdLabel}'`,
      "warning",
    );
    return false;
  }
}

async function handoffViaSystemd(
  pi: ExtensionAPI,
  ctx: { ui: { notify: (msg: string, severity: "info" | "warning" | "error") => void } },
  sessionFile: string,
  safeSessionFile: string,
): Promise<boolean> {
  ctx.ui.notify(`Handing off to TelePi via systemd...\nSession: ${sessionFile}`, "info");

  try {
    const result = await pi.exec(
      "bash",
      ["-lc", [
        `session_file='${safeSessionFile}'`,
        `systemctl --user set-environment PI_SESSION_PATH="$session_file"`,
        `systemctl --user restart telepi.service`,
      ].join("\n")],
      { timeout: 5000 },
    );

    if (result.code === 0) {
      ctx.ui.notify("TelePi restarted via systemd. Check Telegram!", "info");
      return true;
    }

    ctx.ui.notify(
      "Could not restart TelePi via systemd. Try manually:\n" +
        `systemctl --user set-environment PI_SESSION_PATH='${safeSessionFile}'\n` +
        `systemctl --user restart telepi.service`,
      "warning",
    );
    return false;
  } catch {
    ctx.ui.notify(
      "Could not restart TelePi via systemd. Try manually:\n" +
        `systemctl --user set-environment PI_SESSION_PATH='${safeSessionFile}'\n` +
        `systemctl --user restart telepi.service`,
      "warning",
    );
    return false;
  }
}

async function handoffViaDirect(
  pi: ExtensionAPI,
  ctx: { ui: { notify: (msg: string, severity: "info" | "warning" | "error") => void } },
  sessionFile: string,
  safeSessionFile: string,
): Promise<boolean> {
  const telePiDir = process.env.TELEPI_DIR?.trim();
  const hasGlobalTelePi = await hasGlobalTelePiCommand(pi);
  const target = resolveDirectLaunchTarget({ hasGlobalTelePi, telePiDir });

  if (target.kind === "unavailable") {
    if (target.reason === "missing-installed-config") {
      ctx.ui.notify(
        "TelePi is installed globally, but its installed config is missing:\n" +
          `  ${target.installedConfigPath}\n\n` +
          "Run `telepi setup` to create it, or point TELEPI_DIR at a source checkout.",
        "error",
      );
    } else {
      ctx.ui.notify(
        "TelePi is not available for direct hand-off. Either install it globally:\n" +
          "  npm install -g @benedict2310/telepi\n" +
          "  telepi setup\n\n" +
          "Or point TELEPI_DIR at a source checkout:\n" +
          "  export TELEPI_DIR=/path/to/TelePi\n\n" +
          "Or use systemd mode (Linux) / launchd mode (macOS) with:\n" +
          "  export TELEPI_HANDOFF_MODE=systemd   # Linux\n" +
          "  export TELEPI_HANDOFF_MODE=launchd   # macOS",
        "error",
      );
    }
    return false;
  }

  ctx.ui.notify(`Handing off to TelePi...\nSession: ${sessionFile}`, "info");

  if (target.kind === "source") {
    await pi.exec("bash", ["-lc", 'pkill -f "tsx.*TelePi" 2>/dev/null || true'], { timeout: 3000 }).catch(() => {});
  }

  try {
    const result =
      target.kind === "installed"
        ? await pi.exec(
            "bash",
            ["-lc", [
              `cd '${shellQuote(target.homeDirectory)}'`,
              `telepi_command="$(command -v telepi)"`,
              `PI_SESSION_PATH='${safeSessionFile}' TELEPI_CONFIG='${shellQuote(target.installedConfigPath)}' nohup "$telepi_command" start > '${DIRECT_LOG_PATH}' 2>&1 &`,
              `echo $!`,
            ].join("\n")],
            { timeout: 5000 },
          )
        : await pi.exec(
            "bash",
            ["-lc", [
              `cd '${shellQuote(target.telePiDir)}'`,
              `PI_SESSION_PATH='${safeSessionFile}' nohup npx tsx src/index.ts > '${DIRECT_LOG_PATH}' 2>&1 &`,
              `echo $!`,
            ].join("\n")],
            { timeout: 5000 },
          );

    const pid = result.stdout.trim();
    if (pid && result.code === 0) {
      ctx.ui.notify(
        target.kind === "installed"
          ? `TelePi started via installed \`telepi\` (PID: ${pid}). Check Telegram!`
          : `TelePi started from source checkout (PID: ${pid}). Check Telegram!`,
        "info",
      );
      return true;
    }
    ctx.ui.notify(`TelePi may have failed to start. Check ${DIRECT_LOG_PATH}`, "warning");
    return false;
  } catch {
    ctx.ui.notify(
      target.kind === "installed"
        ? "Could not auto-launch TelePi. Start it manually:\n" +
          `TELEPI_CONFIG="${target.installedConfigPath}" PI_SESSION_PATH="${sessionFile}" telepi start`
        : `Could not auto-launch TelePi. Start it manually:\n` +
          `cd "${target.telePiDir}" && PI_SESSION_PATH="${sessionFile}" npx tsx src/index.ts`,
      "warning",
    );
    return false;
  }
}
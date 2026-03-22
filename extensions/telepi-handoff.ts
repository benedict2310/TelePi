import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type HandoffMode = "direct" | "launchd";

const DEFAULT_LAUNCHD_LABEL = "com.telepi";

function shellQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function resolveHandoffMode(): HandoffMode | undefined {
  const raw = process.env.TELEPI_HANDOFF_MODE?.trim().toLowerCase();
  if (!raw || raw === "direct") {
    return "direct";
  }
  if (raw === "launchd") {
    return "launchd";
  }
  return undefined;
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
          "Invalid TELEPI_HANDOFF_MODE. Expected one of: direct, launchd",
          "error",
        );
        return;
      }

      const safeSessionFile = shellQuote(sessionFile);
      let launched = false;

      if (handoffMode === "launchd") {
        const launchdLabel = process.env.TELEPI_LAUNCHD_LABEL?.trim() || DEFAULT_LAUNCHD_LABEL;
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
              `launchctl setenv PI_SESSION_PATH "${sessionFile}"\n` +
              `launchctl kickstart -k gui/$UID/${launchdLabel}`,
              "warning",
            );
          }
        } catch {
          ctx.ui.notify(
            "Could not restart TelePi via launchd. Verify the LaunchAgent is loaded and try manually:\n" +
            `launchctl setenv PI_SESSION_PATH "${sessionFile}"\n` +
            `launchctl kickstart -k gui/$UID/${launchdLabel}`,
            "warning",
          );
        }
      } else {
        const telePiDir = process.env.TELEPI_DIR;
        if (!telePiDir) {
          ctx.ui.notify(
            "TELEPI_DIR is not set. Add it to your shell profile:\n" +
            "  export TELEPI_DIR=/path/to/TelePi\n\n" +
            "Or switch to launchd mode with:\n" +
            "  export TELEPI_HANDOFF_MODE=launchd",
            "error",
          );
          return;
        }

        ctx.ui.notify(
          `Handing off to TelePi...\nSession: ${sessionFile}`,
          "info",
        );

        await pi.exec("bash", ["-lc", 'pkill -f "tsx.*TelePi" 2>/dev/null || true'], { timeout: 3000 }).catch(() => {});

        try {
          const result = await pi.exec(
            "bash",
            [
              "-lc",
              `cd '${shellQuote(telePiDir)}'
PI_SESSION_PATH='${safeSessionFile}' nohup npx tsx src/index.ts > /tmp/telepi.log 2>&1 & echo $!`,
            ],
            { timeout: 5000 },
          );
          const pid = result.stdout.trim();
          if (pid && result.code === 0) {
            ctx.ui.notify(`TelePi started (PID: ${pid}). Check Telegram!`, "success");
            launched = true;
          } else {
            ctx.ui.notify(`TelePi may have failed to start. Check /tmp/telepi.log`, "warning");
          }
        } catch {
          ctx.ui.notify(
            `Could not auto-launch TelePi. Start it manually:\n` +
            `cd "${telePiDir}" && PI_SESSION_PATH="${sessionFile}" npx tsx src/index.ts`,
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

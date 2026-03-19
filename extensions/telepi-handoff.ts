import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Hand off this session to TelePi (Telegram)",
    handler: async (_args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();

      if (!sessionFile) {
        ctx.ui.notify("Cannot hand off an in-memory session. Save the session first.", "error");
        return;
      }

      const telePiDir = process.env.TELEPI_DIR;
      if (!telePiDir) {
        ctx.ui.notify(
          "TELEPI_DIR is not set. Add it to your shell profile:\n" +
          "  export TELEPI_DIR=/path/to/TelePi",
          "error",
        );
        return;
      }

      ctx.ui.notify(
        `Handing off to TelePi...\nSession: ${sessionFile}`,
        "info",
      );

      // Kill any existing TelePi instance first (same bot token = conflict)
      await pi.exec("bash", ["-c", `pkill -f "tsx.*TelePi" 2>/dev/null || true`], { timeout: 3000 }).catch(() => {});

      // Use a safe quoting approach for the session path
      const safeSessionFile = sessionFile.replace(/'/g, "'\\''");

      let launched = false;
      try {
        const result = await pi.exec(
          "bash",
          ["-c", `cd '${telePiDir.replace(/'/g, "'\\''")}' && PI_SESSION_PATH='${safeSessionFile}' nohup npx tsx src/index.ts > /tmp/telepi.log 2>&1 & echo $!`],
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

      // Only shut down Pi CLI if TelePi launched successfully
      if (launched) {
        ctx.shutdown();
      }
    },
  });
}

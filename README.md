# TelePi

TelePi is a Telegram bridge for the [Pi coding agent](https://github.com/badlogic/pi-mono) SDK. It lets you continue Pi sessions from Telegram — hand off from the CLI, keep working on your phone, and hand back when you're at your desk.

## Features

- **Bi-directional hand-off**: Move sessions CLI → Telegram (`/handoff`) and back (`/handback`)
- **Cross-workspace sessions**: Browse and switch between sessions from any project
- **Model switching**: Change AI models on the fly via `/model`
- **Workspace-aware `/new`**: Create sessions in any known project workspace
- **Native Telegram UX**: Typing indicators, inline keyboards, HTML-formatted responses, auto-retry on rate limits
- **Security**: Telegram user allowlist, workspace-scoped tools, Docker support

## Prerequisites

- Node.js 20+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Pi installed locally with working credentials in `~/.pi/agent/auth.json`

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy the example environment file and fill it in:
   ```bash
   cp .env.example .env
   ```
   - `TELEGRAM_BOT_TOKEN` — your bot token from BotFather
   - `TELEGRAM_ALLOWED_USER_IDS` — your Telegram numeric user ID (comma-separated for multiple)
   - `PI_SESSION_PATH` *(optional)* — open a specific Pi session JSONL file for hand-off
   - `PI_MODEL` *(optional)* — force a specific model, e.g. `anthropic/claude-sonnet-4-5`

3. Start the bot:
   ```bash
   npm run dev
   ```

4. Optional: build TelePi for `launchd`:
   ```bash
   npm run build
   ```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and current session info |
| `/new` | Create a fresh session (shows workspace picker if multiple known) |
| `/handback` | Hand session back to Pi CLI (copies resume command to clipboard) |
| `/abort` | Cancel the current Pi operation |
| `/session` | Show current session details (ID, file, workspace, model) |
| `/sessions` | List all sessions across all workspaces with tap-to-switch buttons |
| `/sessions <path>` | Switch directly to a specific session file |
| `/model` | Pick a different AI model from an inline keyboard |

## Session Hand-off

TelePi supports seamless bi-directional session hand-off between Pi CLI and Telegram. Both directions preserve the **full conversation context** — the JSONL session file is the single source of truth, and whichever side opens it gets the complete history, including any messages added by the other side.

### CLI → Telegram (`/handoff`)

You're working in Pi CLI on your laptop and want to continue from your phone:

1. **In Pi CLI**, type `/handoff`
2. The extension opens your current session in TelePi and shuts down Pi CLI
3. **Open Telegram** — TelePi is already running with your full conversation context. Just keep typing.

**Extension installation** — symlink into Pi's global extensions directory:

```bash
cd /path/to/TelePi
ln -s "$(pwd)/extensions/telepi-handoff.ts" ~/.pi/agent/extensions/telepi-handoff.ts
```

Pi auto-discovers it after symlinking (or run `/reload` in Pi).

The extension supports two hand-off modes, controlled via shell environment variables:

- `TELEPI_HANDOFF_MODE=direct` *(default)* — old behavior: kill the current TelePi dev process and start a new one with `npx tsx src/index.ts`
- `TELEPI_HANDOFF_MODE=launchd` — set `PI_SESSION_PATH` in the `launchd` user environment and restart a LaunchAgent
- `TELEPI_LAUNCHD_LABEL` *(optional, default: `com.telepi`)* — LaunchAgent label to restart in `launchd` mode

#### Direct mode

Set `TELEPI_DIR` in your shell profile to point to your TelePi installation:

```bash
export TELEPI_HANDOFF_MODE=direct
export TELEPI_DIR="/path/to/TelePi"
```

#### launchd mode (recommended on macOS)

1. Build TelePi:
   ```bash
   npm run build
   ```
2. Copy `launchd/com.telepi.plist` to `~/Library/LaunchAgents/com.telepi.plist`
3. Replace the placeholder paths with your real TelePi path, Node path, and log file locations
4. Load it:
   ```bash
   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.telepi.plist
   launchctl kickstart -k gui/$UID/com.telepi
   ```
5. Export the hand-off settings in your shell profile:
   ```bash
   export TELEPI_HANDOFF_MODE=launchd
   export TELEPI_LAUNCHD_LABEL=com.telepi
   ```

In `launchd` mode, `/handoff` only does two things: set `PI_SESSION_PATH` in `launchd`, then restart the configured LaunchAgent. That keeps TelePi to a single bot process and avoids Telegram token conflicts.

### Telegram → CLI (`/handback`)

You're on your phone and want to get back to your terminal:

1. **In Telegram**, type `/handback`
2. TelePi disposes the session and sends you the exact command to resume, e.g.:
   ```
   cd '/Users/you/myproject' && pi --session '/Users/you/.pi/agent/sessions/.../session.jsonl'
   ```
3. On macOS, the command is **copied to your clipboard** automatically
4. **In your terminal**, paste and run — Pi CLI opens with the full conversation, including everything from Telegram
5. TelePi stays alive — send any message in Telegram to start a fresh session

You can also resume with the shorthand:

```bash
# Continue the most recent session in the project
cd /path/to/project && pi -c
```

### Manual hand-off

Without the extension, you can hand off manually:

1. Note the session file path from Pi CLI (shown on startup)
2. Set `PI_SESSION_PATH` in TelePi's `.env`
3. Start TelePi: `npm run dev`

### How it works

Both Pi CLI and TelePi use the same `SessionManager` from the Pi SDK to read/write session JSONL files stored under `~/.pi/agent/sessions/`. When either side opens a session file:

1. `SessionManager.open(path)` loads all entries from the JSONL file
2. `buildSessionContext()` walks the entry tree from the current leaf to the root
3. The full message history (including compaction summaries and branch context) is sent to the LLM

This means hand-off is lossless — no context is dropped regardless of how many times you switch between CLI and Telegram.

## Cross-Workspace Sessions

TelePi discovers sessions from **all** project workspaces stored under `~/.pi/agent/sessions/`. This means:

- **`/sessions`** shows sessions from every project (OpenClawd, homepage, TelePi, etc.), grouped by workspace
- **`/new`** shows a workspace picker when multiple workspaces are known, so you can start a new session in any project
- **Switching sessions** automatically updates the workspace — coding tools are re-scoped to the correct project directory

Sessions are stored under `~/.pi/agent/sessions/--<encoded-workspace-path>--/`.

## File Layout

```
TelePi/
├── extensions/
│   └── telepi-handoff.ts        ← Pi CLI extension (git-tracked)
├── launchd/
│   └── com.telepi.plist
├── src/
│   ├── index.ts                 ← entry point
│   ├── bot.ts                   ← Telegram bot (Grammy)
│   ├── pi-session.ts            ← Pi SDK session wrapper
│   ├── config.ts                ← environment config
│   └── format.ts                ← markdown → Telegram HTML
├── test/
│   ├── bot.test.ts              ← bot command/callback integration tests
│   ├── config.test.ts           ← config/env loading tests
│   ├── format.test.ts           ← formatter unit tests
│   └── pi-session.test.ts       ← session service integration tests
├── vitest.config.ts
├── .env.example
├── Dockerfile
└── docker-compose.yml

~/.pi/agent/extensions/
    └── telepi-handoff.ts        ← symlink → TelePi/extensions/ (Pi auto-discovers)
```

## Docker

For production use with Docker:

```bash
docker compose up --build
```

The compose file:
- Mounts `~/.pi/agent` read-only (for auth and settings)
- Mounts `~/.pi/agent/sessions` read-write (for session persistence)
- Mounts your workspace directory read-write
- Runs as non-root, drops capabilities, enables `no-new-privileges`

## Security Notes

- Only Telegram user IDs in `TELEGRAM_ALLOWED_USER_IDS` can interact with the bot
- Pi tools are scoped to the workspace via `createCodingTools(workspace)` and re-scoped on session switch
- The `/handoff` extension only shuts down Pi CLI if TelePi launches or restarts successfully
- URL sanitization blocks `javascript:` and other unsafe protocols in formatted output
- Shell commands in `/handback` use `spawnSync` (no shell interpretation) for clipboard copy

## Architecture

```
Telegram ←→ Grammy bot (auto-retry, HTML formatting, inline keyboards)
                |
                v
         PiSessionService (tracks current workspace)
                |
                ├── AgentSession (Pi SDK)  ──→ ~/.pi/agent/sessions/
                ├── ModelRegistry           ──→ ~/.pi/agent/auth.json
                └── Coding tools            ──→ current workspace directory
```

## Development

```bash
npm install
npm run build          # TypeScript compilation
npm run dev            # Run with tsx (auto-loads .env)
npm test               # Run tests
npm run test:coverage  # Run tests with coverage report
```

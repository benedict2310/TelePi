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

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and current session info |
| `/new` | Create a fresh session (shows workspace picker if multiple known) |
| `/handback` | Hand session back to Pi CLI (copies resume command to clipboard) |
| `/abort` | Cancel the current Pi operation |
| `/session` | Show current session details (ID, file, workspace, model) |
| `/sessions` | List all sessions across all workspaces with tap-to-switch buttons |
| `/switch <path>` | Switch to a specific session file |
| `/model` | Pick a different AI model from an inline keyboard |

## Session Hand-off

### CLI → Telegram (`/handoff`)

TelePi includes a Pi extension that hands off your current CLI session to Telegram.

**Installation** — symlink the extension into Pi's global extensions directory:

```bash
cd /path/to/TelePi
ln -s "$(pwd)/extensions/telepi-handoff.ts" ~/.pi/agent/extensions/telepi-handoff.ts
```

Pi auto-discovers it after symlinking (or run `/reload` in Pi).

**Usage** — in any Pi CLI session:

```
/handoff
```

This will:
1. Kill any existing TelePi instance (avoids bot token conflicts)
2. Launch TelePi in the background with `PI_SESSION_PATH` set to your current session
3. Shut down the Pi CLI, releasing the session file
4. You can now continue in Telegram

Set `TELEPI_DIR` in your shell profile to point to your TelePi installation:

```bash
export TELEPI_DIR="/path/to/TelePi"
```

### Telegram → CLI (`/handback`)

In Telegram, type `/handback` to release the session back to Pi CLI:

1. TelePi disposes the Pi session (releases the file)
2. Sends you the exact `pi --session <path>` command to run in your terminal
3. On macOS, copies the command to your clipboard automatically
4. The bot stays alive — send any message to start a new TelePi session

The handed-back session can be resumed in Pi CLI with:

```bash
# Exact session (shown in the /handback message)
pi --session /path/to/session.jsonl

# Or just continue the most recent session in the project
cd /path/to/project && pi -c
```

### Manual hand-off

Without extensions, you can hand off manually:

1. Note the session file path from Pi CLI (shown on startup)
2. Set `PI_SESSION_PATH` in TelePi's `.env`
3. Start TelePi: `npm run dev`

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
├── src/
│   ├── index.ts                 ← entry point
│   ├── bot.ts                   ← Telegram bot (Grammy)
│   ├── pi-session.ts            ← Pi SDK session wrapper
│   ├── config.ts                ← environment config
│   └── format.ts                ← markdown → Telegram HTML
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
- The `/handoff` extension only shuts down Pi CLI if TelePi launches successfully
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
npm run build    # TypeScript compilation
npm run dev      # Run with tsx (auto-loads .env)
```

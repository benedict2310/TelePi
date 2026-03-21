# TelePi

TelePi is a Telegram bridge for the [Pi coding agent](https://github.com/badlogic/pi-mono) SDK. It lets you continue Pi sessions from Telegram — hand off from the CLI, keep working on your phone, and hand back when you're at your desk. Send a voice message and TelePi will transcribe it and feed it straight into Pi.

## Features

- **Bi-directional hand-off**: Move sessions CLI → Telegram (`/handoff`) and back (`/handback`)
- **Voice messages**: Send a voice note or audio file and TelePi transcribes it into a Pi prompt
- **Local or cloud transcription**: [Parakeet CoreML](https://github.com/badlogic/parakeet-coreml) (free, private, on-device) or OpenAI Whisper (cloud)
- **Session tree navigation**: Browse, branch, and label your Pi session history with `/tree`, `/branch`, `/label`
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
   - `OPENAI_API_KEY` *(optional)* — enable cloud-based voice transcription via OpenAI Whisper
   - `TOOL_VERBOSITY` *(optional)* — `all` | `summary` | `errors-only` | `none` (default: `summary`)

3. Start the bot:
   ```bash
   npm run dev
   ```

4. If using launchd mode, build TelePi first:
   ```bash
   npm run build
   ```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message, session info, and voice backend status |
| `/new` | Create a fresh session (shows workspace picker if multiple known) |
| `/handback` | Hand session back to Pi CLI (copies resume command to clipboard) |
| `/abort` | Cancel the current Pi operation |
| `/session` | Show current session details (ID, file, workspace, model) |
| `/sessions` | List all sessions across all workspaces with tap-to-switch buttons |
| `/sessions <path>` | Switch directly to a specific session file |
| `/model` | Pick an AI model from the current Pi model scope, with an option to show all available models |
| `/tree` | View the session entry tree; navigate with inline buttons |
| `/branch <id>` | Navigate to a specific entry ID (with confirmation) |
| `/label [args]` | Add or clear labels on entries for easy reference |

## Voice Messages

Send any Telegram **voice message** or **audio file** and TelePi will transcribe it and feed the transcript straight into Pi as a text prompt.

```
[you send a voice message]
🎤 "How does the session hand-off work?" (via parakeet)

[Pi responds normally]
```

TelePi supports two transcription backends and picks the best one automatically:

| Backend | How to enable | Cost | Privacy |
|---------|---------------|------|---------|
| **Parakeet** (local, CoreML) | `npm install parakeet-coreml` + `brew install ffmpeg` | Free | On-device |
| **OpenAI Whisper** (cloud) | `OPENAI_API_KEY=sk-...` in `.env` | ~$0.006/min | Cloud |

Parakeet is tried first when installed. If it is not available, TelePi falls back to OpenAI Whisper. The `/start` command shows which backends are currently active.

### Installing Parakeet (local transcription)

Parakeet is an optional dependency (~1.5 GB download, macOS only with Apple Silicon):

```bash
npm install parakeet-coreml
brew install ffmpeg   # required for audio decoding
```

On first use the CoreML model is downloaded automatically. Subsequent calls use the cached model.

### Using OpenAI Whisper (cloud transcription)

Add your key to `.env`:

```
OPENAI_API_KEY=sk-...
```

No additional packages are required. Supports the same audio formats Telegram delivers (Ogg Opus, MP3, M4A, WAV, etc.).

## Session Tree Navigation

Every prompt and response in Pi is stored as a tree of entries. TelePi exposes this tree so you can review history and jump back to any point to create a new branch.

### `/tree`

Shows the session entry tree as a preformatted diagram with inline navigation buttons.

```
/tree        — default view (last 10 entries, branch points highlighted)
/tree all    — full tree with navigation buttons on every entry
/tree user   — user messages only
```

Inline buttons let you switch between filter modes without retyping the command.

### `/branch <id>`

Navigate to any entry by its short 4-character ID (shown in `/tree`). TelePi asks for confirmation and offers two options:

- **Navigate here** — moves the session leaf to the selected entry; your next message creates a new branch from that point
- **Navigate + Summarize** — same, but first generates a concise summary of the branch you are leaving

### `/label [args]`

Attach human-readable labels to entries so you can find them easily in `/tree`.

```
/label fix-auth          — label the current leaf "fix-auth"
/label <id> fix-auth     — label a specific entry
/label clear <id>        — remove a label
/label                   — list all labels in the session
```

Labeled entries are highlighted in `/tree` output and shown in `/branch` confirmations.

## Session Hand-off

TelePi supports seamless bi-directional session hand-off between Pi CLI and Telegram. Both directions preserve the **full conversation context** — the JSONL session file is the single source of truth, and whichever side opens it gets the complete history, including any messages added by the other side.

### CLI → Telegram (`/handoff`)

You're working in Pi CLI on your laptop and want to continue from your phone:

1. **In Pi CLI**, type `/handoff`
2. The extension hands off your current session to TelePi — in direct mode it launches TelePi, and in `launchd` mode it restarts the configured LaunchAgent — then shuts down Pi CLI
3. **Open Telegram** — TelePi is already running with your full conversation context. Just keep typing (or speak).

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

Set `TELEPI_DIR` in your shell profile to point to your TelePi installation (`TELEPI_HANDOFF_MODE=direct` is the default and does not need to be set explicitly):

```bash
export TELEPI_DIR="/path/to/TelePi"
```

#### launchd mode (recommended on macOS)

1. Build TelePi:
   ```bash
   npm run build
   ```
2. Copy `launchd/com.telepi.plist` to `~/Library/LaunchAgents/com.telepi.plist`
3. Replace the placeholder paths with your real TelePi path, Node path, and log file locations. Also ensure a `.env` file with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS` is present in the `WorkingDirectory` (TelePi loads it from `process.cwd()` at startup — see `.env.example`)
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

> **Note:** `launchctl setenv` does not persist across reboots. After a machine restart, `PI_SESSION_PATH` will be cleared and TelePi will start a fresh in-memory session until the next `/handoff`.

> **Note:** Because `KeepAlive` is set in the plist, launchd will automatically restart TelePi if it exits. To fully stop TelePi, unload the agent: `launchctl bootout gui/$UID/com.telepi`.

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
│   ├── format.ts                ← markdown → Telegram HTML
│   ├── tree.ts                  ← session tree rendering & navigation
│   └── voice.ts                 ← audio transcription (Parakeet / OpenAI)
├── test/
│   ├── bot.test.ts              ← bot command/callback integration tests
│   ├── config.test.ts           ← config/env loading tests
│   ├── format.test.ts           ← formatter unit tests
│   ├── pi-session.test.ts       ← session service integration tests
│   ├── tree.test.ts             ← tree rendering unit tests
│   ├── voice.test.ts            ← voice transcription unit tests
│   └── voice.decode.test.ts     ← ffmpeg audio decode tests
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
- Voice files are downloaded to a temporary directory and deleted immediately after transcription

## Architecture

```
Telegram ←→ Grammy bot (auto-retry, HTML formatting, inline keyboards)
                |
                ├── Voice handler ──→ voice.ts (Parakeet | OpenAI Whisper)
                |                         |
                |                    ffmpeg decode
                v
         PiSessionService (tracks current workspace)
                |
                ├── AgentSession (Pi SDK)  ──→ ~/.pi/agent/sessions/
                ├── ModelRegistry           ──→ ~/.pi/agent/auth.json
                ├── SessionTree             ──→ tree.ts (render/navigate)
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

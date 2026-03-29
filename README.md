# TelePi

TelePi is a Telegram bridge for the [Pi coding agent](https://github.com/badlogic/pi-mono) SDK. It lets you continue Pi sessions from Telegram — hand off from the CLI, keep working on your phone, and hand back when you're at your desk. Send a voice message and TelePi will transcribe it and feed it straight into Pi.

## Features

- **Bi-directional hand-off**: Move sessions CLI → Telegram (`/handoff`) and back (`/handback`)
- **Per-chat/topic sessions**: Every Telegram chat or forum topic gets its own Pi session, picker state, and retry history
- **Voice messages**: Send a voice note or audio file and TelePi transcribes it into a Pi prompt
- **Local or cloud transcription**: [Parakeet CoreML](https://github.com/badlogic/parakeet-coreml) on Apple Silicon, [Sherpa-ONNX Parakeet](https://k2-fsa.github.io/sherpa/onnx/) for Intel Macs (and as a CPU fallback), or OpenAI Whisper in the cloud
- **Session tree navigation**: Browse, branch, and label your Pi session history with `/tree`, `/branch`, `/label`
- **Cross-workspace sessions**: Browse and switch between sessions from any project
- **Model switching**: Change AI models on the fly via `/model`
- **Workspace-aware `/new`**: Create sessions in any known project workspace
- **Helpful recovery commands**: `/help` for quick usage guidance and `/retry` to resend the last prompt in the current chat/topic
- **Native Telegram UX**: Topic-safe inline keyboards, typing indicators, HTML-formatted responses, friendly user-facing errors, auto-retry on rate limits
- **Security**: Telegram user allowlist, workspace-scoped tools, Docker support

## Prerequisites

- Node.js 20+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Pi installed locally with working credentials in `~/.pi/agent/auth.json`

## Quickstart (npm global install, macOS)

This is the main install path for TelePi.

1. Install TelePi globally:
   ```bash
   npm install -g @futurelab-studio/telepi
   ```
2. Run the installer using either flow:
   ```bash
   telepi setup
   ```
   When run in a terminal, `telepi setup` prompts for the three setup values TelePi currently cares about:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_ALLOWED_USER_IDS`
   - `TELEPI_WORKSPACE`

   On a fresh config copied from `.env.example`, the example values are treated as placeholders, not saved defaults — pressing Enter still requires you to enter your real bot token, allowed user ID list, and workspace.

   Or use the fast positional form:
   ```bash
   telepi setup <bot_token> <userids> <workspace>
   ```
   where `<userids>` uses the same comma-separated format as the config file, for example `123456789,987654321`.

   `telepi setup` will:
   - create or update `~/.config/telepi/config.env`
   - preserve any existing optional config values already present in that file
   - install/update `~/Library/LaunchAgents/com.telepi.plist`
   - install the Pi `/handoff` extension at `~/.pi/agent/extensions/telepi-handoff.ts`

   If you run setup non-interactively, you must either pass all three positional values or already have them configured; TelePi now fails clearly instead of writing placeholder values.
3. Verify the installed config at `~/.config/telepi/config.env` with your real values:
   ```dotenv
   TELEGRAM_BOT_TOKEN=123456789:AAFf_real_token_from_botfather
   TELEGRAM_ALLOWED_USER_IDS=111111111,222222222
   TELEPI_WORKSPACE=/Users/you/your-main-project
   ```
   Notes:
   - `TELEPI_WORKSPACE` is strongly recommended in installed mode so fresh Telegram sessions start in the right project
   - `PI_SESSION_PATH` is usually injected automatically by `/handoff`
   - `OPENAI_API_KEY`, `SHERPA_ONNX_MODEL_DIR`, `PI_MODEL`, and `TOOL_VERBOSITY` are optional
4. Verify the install:
   ```bash
   telepi status
   ```
5. Open Telegram and send `/start` to your bot.

Rerunning `telepi setup` after upgrades is safe; it refreshes the LaunchAgent and extension while preserving your config. After setup, `/handoff` automatically reuses the installed `launchd` service by default.

## Development from Source

Use a source checkout when you want to hack on TelePi or run the latest unreleased code.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the example environment file and fill it in:
   ```bash
   cp .env.example .env
   ```
   Replace the example values from `.env.example` with your real settings. At minimum set:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_ALLOWED_USER_IDS`
   - `TELEPI_WORKSPACE` if you want fresh Telegram sessions rooted somewhere other than the repo directory
3. Start the bot in development mode:
   ```bash
   npm run dev
   ```
4. To test the installed-mode flow from a checkout, build first and use the built CLI entrypoint:
   ```bash
   npm run build
   node dist/cli.js setup
   # or: node dist/cli.js setup <bot_token> <userids> <workspace>
   node dist/cli.js status
   ```

If you are working from a built checkout or GitHub Release artifact instead of a global npm install, install runtime dependencies first — the `dist/` files are not self-contained:

```bash
npm install --omit=dev
# or: npm ci --omit=dev
node dist/cli.js setup
node dist/cli.js start
```


## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message, session info, and voice backend status |
| `/help` | Quick command reference and usage tips |
| `/new` | Create a fresh session (shows workspace picker if multiple known) |
| `/retry` | Re-send the last prompt in the current chat/topic |
| `/handback` | Hand session back to Pi CLI (copies resume command to clipboard) |
| `/abort` | Cancel the current Pi operation |
| `/session` | Show current session details (ID, file, workspace, model) |
| `/sessions` | List all sessions across all workspaces with tap-to-switch buttons |
| `/sessions <path\|id>` | Switch directly to a specific session file or session ID/prefix |
| `/model` | Pick a different AI model from an inline keyboard |
| `/tree` | View the session entry tree; navigate with inline buttons |
| `/branch <id>` | Navigate to a specific entry ID (with confirmation) |
| `/label [args]` | Add or clear labels on entries for easy reference |

Sessions, inline keyboards, and `/retry` state are isolated per Telegram chat/topic, so forum topics can be used independently without colliding with each other.

## Voice Messages

Send any Telegram **voice message** or **audio file** and TelePi will transcribe it and feed the transcript straight into Pi as a text prompt.

```
[you send a voice message]
🎤 "How does the session hand-off work?" (via parakeet)

[Pi responds normally]
```

TelePi supports three transcription backends and picks the best one automatically:

| Backend | How to enable | Cost | Privacy |
|---------|---------------|------|---------|
| **Parakeet CoreML** (local) | `npm install parakeet-coreml` + `brew install ffmpeg` | Free | On-device |
| **Sherpa-ONNX Parakeet** (local, Intel Mac path) | `npm install sherpa-onnx-node` + download model + set `SHERPA_ONNX_MODEL_DIR` | Free | On-device |
| **OpenAI Whisper** (cloud) | `OPENAI_API_KEY=sk-...` in your TelePi config file | ~$0.006/min | Cloud |

TelePi tries backends in this order:

1. **Parakeet CoreML** — best local path on Apple Silicon
2. **Sherpa-ONNX Parakeet** — the local/offline path for Intel Macs, where `parakeet-coreml` does not run (and a CPU fallback on Apple Silicon)
3. **OpenAI Whisper** — cloud fallback

The `/start` command shows which backends are currently active.

### Installing Parakeet CoreML (local transcription on Apple Silicon)

Parakeet CoreML is an optional dependency (~1.5 GB download, macOS only with Apple Silicon):

```bash
npm install parakeet-coreml
brew install ffmpeg   # required for audio decoding
```

On first use the CoreML model is downloaded automatically. Subsequent calls use the cached model.

### Installing Sherpa-ONNX Parakeet (local transcription for Intel Macs)

This is the recommended local transcription path on Intel Macs, since `parakeet-coreml` is Apple-Silicon-only. It can also be used on Apple Silicon, but TelePi will still prefer Parakeet CoreML there when available.

Install the optional Node binding:

```bash
npm install sherpa-onnx-node
brew install ffmpeg   # required for audio decoding
```

Download and extract the Parakeet model layout TelePi expects (`encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt`). The v3 multilingual model below is the intended Intel Mac setup:

```bash
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2
tar xvf sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2
```

Point TelePi at the extracted directory:

```bash
export SHERPA_ONNX_MODEL_DIR="$(pwd)/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
```

If `SHERPA_ONNX_MODEL_DIR` is set, TelePi treats missing model files or a missing `sherpa-onnx-node` package as configuration errors and will not silently fall through to OpenAI.

If the native module cannot find its shared libraries on macOS, start TelePi with:

```bash
export DYLD_LIBRARY_PATH="$(pwd)/node_modules/sherpa-onnx-darwin-$(uname -m | sed 's/x86_64/x64/;s/arm64/arm64/'):${DYLD_LIBRARY_PATH}"
```

For the exact family of Sherpa Parakeet models TelePi currently supports, plus platform notes, see:

- https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html

### Using OpenAI Whisper (cloud transcription)

Add your key to your TelePi config file (`~/.config/telepi/config.env` in installed mode, or `.env` in a source checkout):

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
2. The extension hands off your current session to TelePi — in direct mode it starts TelePi immediately, and in `launchd` mode it restarts the installed LaunchAgent with the handed-off session. The default `auto` behavior picks `launchd` after `telepi setup`, otherwise direct mode — then shuts down Pi CLI
3. **Open Telegram** — TelePi is already running with your full conversation context. Just keep typing (or speak).

**Extension installation**

- If you used `telepi setup`, the extension is already installed at `~/.pi/agent/extensions/telepi-handoff.ts`
- If you are developing from a source checkout without `telepi setup`, symlink it manually:

```bash
cd /path/to/TelePi
ln -s "$(pwd)/extensions/telepi-handoff.ts" ~/.pi/agent/extensions/telepi-handoff.ts
```

Pi auto-discovers it after symlinking (or run `/reload` in Pi).

The extension supports three hand-off mode settings, controlled via shell environment variables:

- `TELEPI_HANDOFF_MODE=auto` *(default)* — if `telepi setup` assets are present (`~/.config/telepi/config.env` plus the configured LaunchAgent plist), reuse `launchd`; otherwise use direct mode
- `TELEPI_HANDOFF_MODE=direct` — always start a fresh direct TelePi process; best for source-checkout development or when the LaunchAgent is unloaded
- `TELEPI_HANDOFF_MODE=launchd` — force `launchd` hand-off by setting `PI_SESSION_PATH` in the `launchd` user environment and restarting the configured LaunchAgent
- `TELEPI_LAUNCHD_LABEL` *(optional, default: `com.telepi`)* — LaunchAgent label/plist name to restart in `launchd` mode or auto-detect

#### Direct mode

Direct mode starts a separate TelePi process. That is the natural default for source-checkout development, where you typically export:

```bash
export TELEPI_DIR="/path/to/TelePi"
```

If a global `telepi` command is available and `~/.config/telepi/config.env` exists, direct mode can also launch the installed CLI explicitly. If the installed config is missing, `/handoff` now falls back to `TELEPI_DIR` when that source checkout path is available.

#### launchd mode (default after `telepi setup` on macOS)

If you installed TelePi with `telepi setup`, no extra shell exports are required: `/handoff` auto-detects the installed config + LaunchAgent plist and reuses the resident `launchd`-managed bot instead of starting a second direct polling process.

If you are testing the installed flow from a source checkout, run the installer from the built checkout first:

```bash
npm run build
node dist/cli.js setup
```

You can still force launchd mode explicitly (or point at a non-default label) with:

```bash
export TELEPI_HANDOFF_MODE=launchd
export TELEPI_LAUNCHD_LABEL=com.telepi
```

In `launchd` mode, `/handoff` only does two things: set `PI_SESSION_PATH` in `launchd`, then restart the configured LaunchAgent. That keeps TelePi to a single bot process and avoids Telegram token conflicts.

> **Note:** `launchctl setenv` does not persist across reboots. After a machine restart, `PI_SESSION_PATH` will be cleared and TelePi will start a fresh session until the next `/handoff`.

> **Note:** `telepi setup` installs the plist with `KeepAlive`, so launchd will restart TelePi if it exits. To fully stop TelePi, unload the agent: `launchctl bootout gui/$UID/com.telepi`.

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
2. Start TelePi with that session explicitly:

```bash
TELEPI_CONFIG="$HOME/.config/telepi/config.env" PI_SESSION_PATH="/path/to/session.jsonl" telepi start
```

From a source checkout, use the development entrypoint instead:

```bash
cd /path/to/TelePi
PI_SESSION_PATH="/path/to/session.jsonl" npm run dev
```

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

Installed mode (`telepi setup`) creates or manages these user-level files:

```text
~/.config/telepi/
└── config.env                     ← generated from .env.example and updated by telepi setup

~/Library/LaunchAgents/
└── com.telepi.plist              ← launchd service generated by telepi setup

~/Library/Logs/TelePi/
├── telepi.out.log
└── telepi.err.log

~/.pi/agent/extensions/
└── telepi-handoff.ts             ← installed Pi CLI extension
```

Source checkout layout:

```text
TelePi/
├── dist/
│   ├── cli.js                    ← built CLI entrypoint (`node dist/cli.js ...`)
│   └── index.js                  ← built bot entrypoint
├── extensions/
│   └── telepi-handoff.ts         ← Pi CLI extension source
├── launchd/
│   └── com.telepi.plist          ← launchd template used by telepi setup
├── scripts/
│   └── package-release.mjs       ← builds release tarballs + sha256 checksums
├── src/
│   ├── cli.ts                    ← CLI commands (`start`, `setup`, `status`)
│   ├── index.ts                  ← entry point
│   ├── bot.ts                    ← Telegram bot (Grammy)
│   ├── config.ts                 ← environment config
│   ├── errors.ts                 ← user-facing error helpers
│   ├── format.ts                 ← markdown → Telegram HTML
│   ├── install.ts                ← installed-mode setup/status helpers
│   ├── model-scope.ts            ← model filtering and grouping
│   ├── pi-session.ts             ← Pi SDK session wrapper
│   ├── tree.ts                   ← session tree rendering & navigation
│   └── voice.ts                  ← audio transcription (Parakeet CoreML / Sherpa-ONNX / OpenAI)
├── test/
│   ├── bot.test.ts               ← bot command/callback integration tests
│   ├── config.test.ts            ← config/env loading tests
│   ├── errors.test.ts            ← error helper unit tests
│   ├── format.test.ts            ← formatter unit tests
│   ├── install.test.ts           ← install/setup unit tests
│   ├── pi-session.test.ts        ← session service integration tests
│   ├── tree.test.ts              ← tree rendering unit tests
│   ├── voice.decode.test.ts      ← ffmpeg audio decode tests
│   └── voice.test.ts             ← voice transcription unit tests
├── vitest.config.ts
├── .env.example
├── Dockerfile
└── docker-compose.yml
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
Telegram ←→ Grammy bot (auto-retry, topic-aware routing, inline keyboards)
                |
                ├── Voice handler ──→ voice.ts (Parakeet CoreML | Sherpa-ONNX | OpenAI Whisper)
                |                         |
                |                    ffmpeg decode
                v
         PiSessionRegistry (one PiSessionService per chat/topic)
                |
                ├── PiSessionService       ──→ current workspace + session state
                ├── AgentSession (Pi SDK)  ──→ ~/.pi/agent/sessions/
                ├── ModelRegistry          ──→ ~/.pi/agent/auth.json
                ├── SessionTree            ──→ tree.ts (render/navigate)
                └── Coding tools           ──→ current workspace directory
```

## Development

```bash
npm install
npm run dev            # Run with tsx (auto-loads .env)
npm run build          # TypeScript compilation
npm run build:clean    # Clean dist/ and rebuild
npm test               # Run tests
npm run test:coverage  # Run tests with coverage report
npm run package:release  # Create artifacts/telepi-vX.Y.Z.tar.gz + checksum
npm run ci:release     # Test + clean build + package release artifact
```

## Release Automation

GitHub Actions publishes npm and creates the GitHub Release automatically on tag pushes matching `v*.*.*`.

Maintainer flow:

```bash
npm version patch   # or minor / major
git push origin main --follow-tags
```

The release workflow then:
- verifies the pushed tag matches `package.json`
- upgrades npm to a Trusted Publishing-compatible version
- runs `npm run ci:release`
- publishes `@futurelab-studio/telepi` to npm
- creates a GitHub Release with the packaged tarball and checksum

Notes:
- prerelease tags like `v0.2.0-beta.1` are published to npm with the `next` dist-tag and marked as GitHub prereleases
- npm publishing uses Trusted Publishing from GitHub Actions; no `NPM_TOKEN` secret is required
- the trusted publisher must be configured on npm for repo `benedict2310/TelePi` and workflow `.github/workflows/release.yml`
- reusable setup details for this pattern live in `docs/npm-trusted-publishing.md`

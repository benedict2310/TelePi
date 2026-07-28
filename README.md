# TelePi

**Run your Pi coding agent from Telegram: voice prompts, screenshots, session handoff, and terminal handback.**

TelePi is a Telegram bridge for the [Pi coding agent](https://github.com/badlogic/pi-mono). It runs locally on your machine, opens real Pi sessions in your repositories, lets you continue from your phone, and hands the exact same session back to the terminal when you return.

**Who this is for:** developers already using Pi who want a safe mobile control surface for coding-agent work: reply from the train, send a screenshot, dictate a prompt, watch progress, then resume in the CLI without losing context.

Early open-source release: **80+ stars, 13 forks, and hundreds of npm downloads**. Current npm release: `@futurelab-studio/telepi` **v0.4.2**, with macOS `launchd`, Linux `systemd --user`, image prompts, prompt inbox, local/cloud voice transcription, and Pi command bridging. Read the [Futurelab TelePi deep dive](https://futurelab.studio/blog/telepi-telegram-remote-control-for-pi/) for the longer story.

> **Demo placeholder:** GIF coming soon. The core loop is: Pi CLI `/handoff` → Telegram text/voice/image prompt → `/handback` → resume the same Pi session in your terminal.

## Try it in 5 minutes

You need:

- **Node.js 22.19+**
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your numeric Telegram user ID for the allowlist
- Pi installed and authenticated locally (`~/.pi/agent/auth.json` exists after a working Pi login)

Install the npm package and run the guided setup:

```bash
npm install -g @futurelab-studio/telepi
telepi setup
telepi status
```

`telepi setup` asks for your bot token, allowed Telegram user IDs, and default workspace. It installs the local service for your platform and the Pi `/handoff` extension.

**Success checkpoint:** open Telegram and send `/start` to your bot. You should see your workspace/session status and voice backend status. If not, jump to [Troubleshooting activation blockers](#troubleshooting-activation-blockers).

## Your first TelePi session

1. Start or open a Pi session in a repository.
2. Run `/handoff` from Pi.
3. Open Telegram and find your bot.
4. Send a text prompt, voice message, or screenshot/photo.
5. Use `/handback` to resume the same session in your terminal.

## Security model

TelePi gives Telegram access to a coding agent, so it is designed to stay private by default:

- **Telegram user allowlist:** only IDs in `TELEGRAM_ALLOWED_USER_IDS` can interact with the bot.
- **Workspace-scoped execution:** Pi tools are created for the active workspace and re-scoped when you switch sessions.
- **Local user service:** installed mode runs under your own macOS/Linux user account, not as a public server.
- **No public bot access when configured correctly:** anyone else who discovers the bot is rejected unless their Telegram user ID is allowlisted.
- **Docker support:** run TelePi in a non-root container with explicit read/write mounts if you want stronger filesystem isolation.

## Features

- **Bi-directional hand-off**: Move sessions CLI → Telegram (`/handoff`) and back (`/handback`)
- **Per-chat/topic sessions**: Every Telegram chat or forum topic gets its own Pi session, picker state, and retry history
- **Voice and image messages**: Send voice/audio for transcription, or photos/image documents as Pi image inputs
- **Local or cloud transcription**: [Parakeet CoreML](https://github.com/sebastian-software/parakeet-coreml) on Apple Silicon, [Sherpa-ONNX Parakeet](https://k2-fsa.github.io/sherpa/onnx/) for Intel Macs (and as a CPU fallback), or OpenAI Whisper in the cloud
- **Session tree navigation**: Browse, branch, and label your Pi session history with `/tree`, `/branch`, `/label`
- **Cross-workspace sessions**: Browse and switch between sessions from any project
- **Model switching**: Change AI models on the fly via `/model`
- **Workspace-aware `/new`**: Create sessions in any known project workspace
- **Pi slash-command bridge**: Run discovered Pi prompt templates, skills, and extension commands from Telegram, browse them with the paginated `/commands` picker, and surface Telegram-compatible ones in the native slash-command menu
- **External prompt inbox**: Let cron jobs, mail filters, webhooks, or log watchers drop `.txt` prompts into a watched directory
- **Helpful recovery commands**: `/help` for quick usage guidance and `/retry` to resend the last prompt in the current chat/topic
- **Extension dialog support**: Pi extension commands can ask for Telegram-native selects, confirms, and text input mid-command
- **Native Telegram UX**: Topic-safe inline keyboards, typing indicators, HTML-formatted responses, friendly user-facing errors, auto-retry on rate limits
- **Security**: Telegram user allowlist, workspace-scoped tools, Docker support

## Full setup details

The npm global install is the main path for TelePi on macOS (`launchd`) and Linux (`systemd --user`).

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
   - on macOS, install/update `~/Library/LaunchAgents/com.telepi.plist`
   - on Linux, install/update `~/.config/systemd/user/telepi.service` and run `systemctl --user daemon-reload && systemctl --user enable --now telepi.service`
   - install the Pi `/handoff` extension at `~/.pi/agent/extensions/telepi-handoff.ts`

   If you run setup non-interactively, you must either pass all three positional values or already have them configured; TelePi fails clearly instead of writing placeholder values.
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

Rerunning `telepi setup` after upgrades is safe; it refreshes the service unit and extension while preserving your config. After setup, `/handoff` automatically reuses the installed `launchd` service on macOS or `systemd --user` service on Linux by default.

## Troubleshooting activation blockers

### How do I get a Telegram bot token?

Open [@BotFather](https://t.me/BotFather), send `/newbot`, choose a name and username, then copy the token into `telepi setup` as `TELEGRAM_BOT_TOKEN`.

### How do I find my Telegram user ID?

Message a helper bot such as [@userinfobot](https://t.me/userinfobot) and copy the numeric ID into `TELEGRAM_ALLOWED_USER_IDS`. Use comma-separated IDs for multiple people, for example `123456789,987654321`.

### Bot does not respond

Run `telepi status` first. Then check that the token is correct, your numeric user ID is allowlisted, you messaged the right bot, and you do not have a second TelePi process polling the same token. On macOS, logs are in `~/Library/Logs/TelePi/`; on Linux, use `journalctl --user -u telepi.service -f`.

### Pi auth missing

Start Pi locally once and complete authentication before using TelePi. TelePi expects Pi credentials under `~/.pi/agent/auth.json` and sessions under `~/.pi/agent/sessions/`.

### Service not running

Run `telepi status`. On macOS, restart the LaunchAgent with `launchctl kickstart -k gui/$UID/com.telepi`. On Linux, run `systemctl --user status telepi.service` and `systemctl --user restart telepi.service`; on headless systems you may also need `loginctl enable-linger "$USER"`.

### Voice transcription not working

Send `/start` and check the voice backend status. Local transcription needs `ffmpeg` plus either `parakeet-coreml` on Apple Silicon or `sherpa-onnx-node` with `SHERPA_ONNX_MODEL_DIR` for Intel/CPU fallback. Cloud transcription needs `OPENAI_API_KEY` in `~/.config/telepi/config.env`. See [Voice and Image Messages](#voice-and-image-messages) for setup details.

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
| `/commands` | Open a paginated picker for TelePi commands plus discovered Pi prompt templates, skills, and extension commands |
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

`/commands` now opens a mobile-friendly inline picker with pagination plus `All`, `TelePi`, and `Pi` filters. Tapping a TelePi entry runs the built-in command immediately, and tapping a Pi entry forwards the slash command into the active Pi session. Telegram-compatible discovered Pi commands (for example `/review` or `/compact`) are also synced into Telegram's native slash-command interface for the current chat. Commands that Telegram cannot represent, such as `/skill:browser-tools`, stay available through the picker and by manual typing.

Any non-TelePi slash command that matches the active Pi session's discovered commands is forwarded into Pi unchanged. That means Telegram can now trigger file-based prompt templates (for example `/review`), skills (`/skill:browser-tools`), and compatible extension commands. Interactive extension commands can also open Telegram-native select/confirm/input dialogs while the command is running.

## External Prompt Inbox

For cron jobs, mail filters, webhooks, or log watchers, keep the external trigger outside TelePi and write a `.txt` file into a prompt inbox instead:

```env
TELEPI_PROMPT_INBOX_DIR=/absolute/path/to/prompt-inbox
TELEPI_PROMPT_INBOX_INTERVAL_MS=60000  # optional; default 60s, minimum 1s
```

When enabled, TelePi polls the directory, processes one `.txt` file at a time, sends its trimmed contents to the root chat for the first `TELEGRAM_ALLOWED_USER_IDS` entry, and deletes the file after accepting it. If that chat is already busy, files stay queued for the next poll. Empty `.txt` files are deleted to avoid loops; subdirectories and non-`.txt` files are ignored.

## Voice and Image Messages

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
| **Any OpenAI-compatible provider** (cloud) | `TELEPI_TRANSCRIPTION_URL` + `TELEPI_TRANSCRIPTION_MODEL` + `TELEPI_TRANSCRIPTION_API_KEY` | Provider's | Cloud |

TelePi tries backends in this order:

1. **Parakeet CoreML** — best local path on Apple Silicon
2. **Sherpa-ONNX Parakeet** — the local/offline path for Intel Macs, where `parakeet-coreml` does not run (and a CPU fallback on Apple Silicon)
3. **OpenAI Whisper** — cloud fallback

The `/start` command shows which backends are currently active.

Send a Telegram **photo** or **image document** to pass it to Pi as image input. Captions become the prompt; without a caption TelePi asks Pi to analyze the image.

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

#### Using another OpenAI-compatible provider

The cloud backend sends a plain multipart request to an OpenAI-shaped
`/audio/transcriptions` endpoint, so any provider implementing that shape works.
Every variable below is optional and falls back to the OpenAI default, so an
existing `OPENAI_API_KEY` setup needs no changes.

| Variable | Default | Purpose |
|----------|---------|---------|
| `TELEPI_TRANSCRIPTION_API_KEY` | `OPENAI_API_KEY` | Credential for the endpoint |
| `TELEPI_TRANSCRIPTION_URL` | `https://api.openai.com/v1/audio/transcriptions` | Full endpoint URL |
| `TELEPI_TRANSCRIPTION_MODEL` | `whisper-1` | Value sent in the `model` field |
| `TELEPI_TRANSCRIPTION_AUTH_HEADER` | unset | Header name for the key. Unset sends `Authorization: Bearer <key>`; set sends `<header>: <key>` raw |

Example, using SipPulse AI:

```
TELEPI_TRANSCRIPTION_API_KEY=...
TELEPI_TRANSCRIPTION_URL=https://api.sippulse.ai/openai/audio/transcriptions
TELEPI_TRANSCRIPTION_MODEL=pulse-precision-pro
```

`TELEPI_TRANSCRIPTION_AUTH_HEADER` exists for providers that do not accept the
Bearer form and expect their own header instead, such as `api-key`.

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

- `TELEPI_HANDOFF_MODE=auto` *(default)* — if `telepi setup` assets are present, reuse `launchd` on macOS or `systemd --user` on Linux; otherwise use direct mode
- `TELEPI_HANDOFF_MODE=direct` — always start a fresh direct TelePi process; best for source-checkout development or when the installed service is unloaded
- `TELEPI_HANDOFF_MODE=launchd` — force macOS `launchd` hand-off by setting `PI_SESSION_PATH` in the `launchd` user environment and restarting the configured LaunchAgent
- `TELEPI_HANDOFF_MODE=systemd` — force Linux `systemd --user` hand-off by setting `PI_SESSION_PATH` in the user service manager and restarting `telepi.service`
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

#### systemd mode (default after `telepi setup` on Linux)

On Linux, `telepi setup` installs a user service at `~/.config/systemd/user/telepi.service`, reloads the user daemon, enables the service, and starts/restarts it. `/handoff` auto-detects that service and runs:

```bash
systemctl --user set-environment PI_SESSION_PATH=/path/to/session.jsonl
systemctl --user restart telepi.service
```

If `systemctl --user` is unavailable, make sure your distro has user systemd sessions enabled. On headless servers you may need lingering:

```bash
loginctl enable-linger "$USER"
```

Useful commands:

```bash
systemctl --user status telepi.service
journalctl --user -u telepi.service -f
systemctl --user stop telepi.service
```

### Telegram → CLI (`/handback`)

You're on your phone and want to get back to your terminal:

1. **In Telegram**, type `/handback`
2. TelePi disposes the session and sends you the exact command to resume, e.g.:
   ```
   cd '/Users/you/myproject' && pi --session '/Users/you/.pi/agent/sessions/.../session.jsonl'
   ```
3. On macOS and Linux desktops with `wl-copy`, `xclip`, or `xsel`, the command is **copied to your clipboard** automatically
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

For a fuller module walkthrough after the bot/install refactors, see [`docs/architecture.md`](docs/architecture.md).

## File Layout

Installed mode (`telepi setup`) creates or manages these user-level files:

```text
~/.config/telepi/
└── config.env                     ← generated from .env.example and updated by telepi setup

~/Library/LaunchAgents/            (macOS)
└── com.telepi.plist              ← launchd service generated by telepi setup

~/.config/systemd/user/            (Linux)
└── telepi.service                 ← systemd user service generated by telepi setup

~/Library/Logs/TelePi/             (macOS)
├── telepi.out.log
└── telepi.err.log

~/.local/state/telepi/logs/        (Linux)
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
├── docs/
│   ├── architecture.md           ← module layout and runtime overview
│   └── npm-trusted-publishing.md ← npm release automation playbook
├── extensions/
│   └── telepi-handoff.ts         ← Pi CLI extension source
├── launchd/
│   └── com.telepi.plist          ← launchd template used by telepi setup
├── systemd/
│   └── telepi.service            ← systemd user-service template used by telepi setup
├── scripts/
│   └── package-release.mjs       ← builds release tarballs + sha256 checksums
├── src/
│   ├── cli.ts                    ← CLI commands (`start`, `setup`, `status`)
│   ├── index.ts                  ← entry point
│   ├── bot.ts                    ← Grammy wiring, callbacks, and shared picker state
│   ├── bot/
│   │   ├── commands/             ← grouped bot command handlers (`basic`, `sessions`, `model`, `tree`)
│   │   ├── chat-state.ts         ← per-chat/topic transient state and `/retry` memory
│   │   ├── extension-dialogs.ts  ← Telegram-backed extension select/confirm/input dialogs
│   │   ├── keyboard.ts           ← inline keyboard pagination helpers
│   │   ├── message-rendering.ts  ← Telegram HTML/plain rendering and chunking helpers
│   │   ├── prompt-handler.ts     ← prompt execution, streaming, and tool updates
│   │   ├── slash-command.ts      ← slash-command normalization and command catalog helpers
│   │   └── telegram-transport.ts ← safe reply/edit/send helpers and Telegram file downloads
│   ├── config.ts                 ← environment config
│   ├── errors.ts                 ← user-facing error helpers
│   ├── format.ts                 ← markdown → Telegram HTML
│   ├── install.ts                ← public installed-mode setup/status facade used by the CLI
│   ├── install/
│   │   ├── config.ts             ← config-file setup/update helpers
│   │   ├── extension.ts          ← extension install/status helpers
│   │   ├── launchd.ts            ← LaunchAgent plist and launchctl helpers
│   │   ├── platform.ts           ← platform detection and install context resolution
│   │   ├── service-manager.ts    ← shared launchd/systemd service manager interface
│   │   ├── systemd.ts            ← systemd unit and systemctl helpers
│   │   └── shared.ts             ← shared install types/constants
│   ├── model-scope.ts            ← model filtering and grouping
│   ├── pi-session.ts             ← Pi SDK session wrapper
│   ├── telegram-ui-context.ts    ← Pi extension UI adapter backed by Telegram dialogs
│   ├── tree.ts                   ← session tree rendering & navigation
│   └── voice.ts                  ← audio transcription (Parakeet CoreML / Sherpa-ONNX / OpenAI)
├── test/
│   ├── bot.test.ts               ← high-level bot integration tests
│   ├── bot/
│   │   ├── chat-state.test.ts
│   │   ├── extension-dialogs.test.ts
│   │   ├── keyboard.test.ts
│   │   ├── message-rendering.test.ts
│   │   ├── slash-command.test.ts
│   │   └── telegram-transport.test.ts
│   ├── config.test.ts            ← config/env loading tests
│   ├── errors.test.ts            ← error helper unit tests
│   ├── format.test.ts            ← formatter unit tests
│   ├── install.test.ts           ← install/setup integration tests
│   ├── pi-session.test.ts        ← session service integration tests
│   ├── telegram-ui-context.test.ts ← extension UI adapter unit tests
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

```text
Telegram
  ↓
Grammy bot (`src/bot.ts`)
  ├── transport helpers         → `src/bot/telegram-transport.ts`
  ├── rendering helpers         → `src/bot/message-rendering.ts`
  ├── prompt lifecycle          → `src/bot/prompt-handler.ts`
  ├── chat-local busy/retry     → `src/bot/chat-state.ts`
  ├── extension dialogs         → `src/bot/extension-dialogs.ts`
  ├── grouped command handlers  → `src/bot/commands/*`
  └── voice route               → `src/voice.ts`
                                     └── ffmpeg decode + local/cloud transcription backends
        ↓
PiSessionRegistry / PiSessionService (`src/pi-session.ts`)
  ├── AgentSession / SessionManager → `~/.pi/agent/sessions/`
  ├── workspace + saved-session switching
  ├── model scope / registry integration
  ├── tree navigation + labels
  └── handback/session lifecycle
        ↓
Pi SDK + workspace-scoped coding tools
```

The detailed module map, testing layout, and remaining large hotspots are documented in [`docs/architecture.md`](docs/architecture.md).

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
- installs dependencies and runs release CI via `npx --yes npm@11.10.0`
- publishes `@futurelab-studio/telepi` to npm
- creates a GitHub Release with the packaged tarball and checksum

Notes:
- prerelease tags like `v0.2.0-beta.1` are published to npm with the `next` dist-tag and marked as GitHub prereleases
- npm publishing uses Trusted Publishing from GitHub Actions; no `NPM_TOKEN` secret is required
- the trusted publisher must be configured on npm for repo `benedict2310/TelePi` and workflow `.github/workflows/release.yml`
- npm Trusted Publishing currently requires npm CLI `11.5.1+` and Node `22.14.0+`; TelePi keeps the runner's bundled npm unchanged and uses `npx --yes npm@11.10.0` for release steps because older npm versions can fail with misleading `E404 Not Found` publish errors even when OIDC is configured correctly
- the workflow has been verified end-to-end with release `v0.2.2`
- reusable setup details for this pattern live in `docs/npm-trusted-publishing.md`

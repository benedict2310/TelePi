# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the runtime code for the Telegram bridge, session management, config loading, voice transcription, and formatting. `test/` mirrors the source layout with Vitest files such as `test/config.test.ts` and `test/pi-session.test.ts`. Integration assets live beside the app: `extensions/telepi-handoff.ts` for Pi CLI hand-off, `launchd/com.telepi.plist` for macOS service setup, and `Dockerfile` plus `docker-compose.yml` for containerized runs.

## Build, Test, and Development Commands
Use `npm install` to install dependencies. `npm run dev` starts TelePi with `tsx` against `src/index.ts` for local development. `npm run build` compiles TypeScript into `dist/`. `npm start` runs the built app from `dist/index.js`. `npm test` runs the Vitest suite once, and `npm run test:coverage` enforces coverage thresholds. For Docker, use `docker compose up --build` after creating `.env`.

## Coding Style & Naming Conventions
This project uses strict TypeScript with ESM modules. Follow the existing style: 2-space indentation, double quotes, semicolons, and explicit `.js` import suffixes in TypeScript source. Prefer small, focused modules in `src/` and keep filenames lowercase with hyphens only when already established, for example `pi-session.ts` and `model-scope.ts`. Export named functions and types where practical; avoid default exports unless there is a clear single entrypoint.

## Testing Guidelines
Tests use Vitest with `globals: true` and the pattern `test/**/*.test.ts`. Add or update tests alongside behavior changes, especially for parsing, formatting, session flow, and voice fallback logic. Coverage thresholds are enforced at 80% for lines, functions, and statements, and 70% for branches; `src/index.ts` is excluded from coverage accounting.

## Commit & Pull Request Guidelines
Recent history favors short imperative subjects, usually Conventional Commit style: `fix: support switching TelePi sessions by id`, `feat(docker): allow user npm global installs`. Prefer `feat`, `fix`, and optional scopes when useful. PRs should explain the user-visible change, note any config or deployment impact (`.env`, Docker, `launchd`), link related issues, and include screenshots or chat transcripts when Telegram UX changes.

## Security & Configuration Tips
Keep secrets in `.env`; never commit bot tokens or Pi auth files. `TELEGRAM_ALLOWED_USER_IDS` is required and should stay narrowly scoped. In Docker, preserve the read-only mounts for `~/.pi/agent/auth.json` and `settings.json`, and treat `/workspace` as the only writable agent workspace.

## Release Automation
npm publishing is automated through `.github/workflows/release.yml` on tag pushes matching `v*.*.*`. TelePi uses npm Trusted Publishing from GitHub Actions, so no `NPM_TOKEN` secret is required. The npm package `@futurelab-studio/telepi` must trust repo `benedict2310/TelePi` and workflow `.github/workflows/release.yml`. Standard maintainer flow: `npm version patch|minor|major` followed by `git push origin main --follow-tags`.

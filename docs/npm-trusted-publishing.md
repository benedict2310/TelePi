# npm Trusted Publishing Playbook

This document captures the release automation pattern used by TelePi so it can be reused in sibling repos such as TeleCodex.

## Goal

Publish npm packages from GitHub Actions without storing a long-lived `NPM_TOKEN` secret.

The approach uses:
- **npm Trusted Publishing**
- a **tag-driven GitHub Actions workflow**
- optional **GitHub Release assets** alongside the npm publish

## Why this approach

Compared with a classic `NPM_TOKEN` secret, Trusted Publishing gives:
- no publish token stored in GitHub secrets
- no manual OTP step in CI
- better provenance support with `npm publish --provenance`
- less secret rotation overhead

## Reference implementation in TelePi

Files to copy/adapt:
- `.github/workflows/release.yml`
- `package.json`
- `README.md` release section
- `AGENTS.md` release section

TelePi-specific details to adapt in other repos:
- package name
- Node version
- build/test/package scripts
- whether GitHub Release assets should be uploaded

## Package prerequisites

Before wiring Trusted Publishing, make sure the package itself is publishable.

Typical `package.json` requirements:

```json
{
  "name": "@futurelab-studio/your-package",
  "version": "0.1.0",
  "license": "MIT",
  "publishConfig": {
    "access": "public"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "bin": {
    "your-cli": "dist/cli.js"
  }
}
```

Notes:
- keep the package name scoped if you want org ownership, e.g. `@futurelab-studio/...`
- `publishConfig.access = public` is required for public scoped packages
- ensure the published tarball contains all runtime files needed by end users

## GitHub Actions workflow pattern

TelePi uses a workflow that triggers on semver-ish tag pushes:

```yaml
on:
  push:
    tags:
      - "v*.*.*"
```

Key workflow requirements:

```yaml
permissions:
  contents: write
  id-token: write
```

Why:
- `contents: write` lets the workflow create/update the GitHub Release
- `id-token: write` is required for npm Trusted Publishing

Also note npm's current Trusted Publishing requirements:
- **npm CLI `11.5.1+`**
- **Node `22.14.0+`**

In practice, the workflow should explicitly upgrade npm after `actions/setup-node`, for example:

```yaml
- name: Update npm for trusted publishing
  run: npm install -g npm@^11.10.0

- name: Show Node and npm versions
  run: |
    node -v
    npm -v
```

### Core release steps

A typical workflow should:
1. check out the repo
2. set up Node and npm registry access
3. verify the pushed tag matches `package.json`
4. install dependencies with `npm ci`
5. run release CI (`test`, `build`, packaging if needed)
6. publish to npm with `--provenance`
7. optionally upload GitHub Release assets

TelePi uses this publish step:

```yaml
- name: Publish package to npm
  shell: bash
  run: |
    if [[ "${GITHUB_REF_NAME}" == *-* ]]; then
      npm publish --access public --tag next --provenance
    else
      npm publish --access public --provenance
    fi
```

This means:
- normal tags like `v0.1.0` publish to npm `latest`
- prerelease tags like `v0.2.0-beta.1` publish to npm `next`

## npm-side Trusted Publisher setup

This must be configured on npm once per package/repo pairing.

In npm package settings:
1. open the package (or create the package manually with the first publish if needed)
2. go to **Trusted publishers**
3. add a **GitHub Actions** trusted publisher
4. set:
   - owner/repo: `benedict2310/TelePi` (or the target repo)
   - workflow path: `.github/workflows/release.yml`
5. save

For another repo like TeleCodex, repeat with that repo name and workflow path.

## Maintainer release flow

Once the workflow and trusted publisher are configured, the normal release flow is:

```bash
npm version patch   # or minor / major
git push origin main --follow-tags
```

The workflow will then:
- validate the tag/version pairing
- run tests/build/package steps
- publish to npm
- publish the GitHub Release assets

## First-time checklist for another repo (example: TeleCodex)

For TeleCodex, follow this order:

1. **Make the package publishable**
   - choose package name (for example `@futurelab-studio/telecodex`)
   - add `publishConfig.access = public`
   - ensure `files`, `bin`, and runtime assets are correct
   - add release scripts if needed, e.g. `package:release` and `ci:release`

2. **Add a release workflow**
   - copy the TelePi workflow as a starting point
   - update Node version if needed
   - update any package-specific packaging steps

3. **Configure Trusted Publishing on npm**
   - repo: `benedict2310/TeleCodex`
   - workflow: `.github/workflows/release.yml`

4. **Do a manual first publish if desired**
   - optional but useful to verify the package contents before relying on CI

5. **Switch to tag-driven releases**
   - `npm version patch`
   - `git push origin main --follow-tags`

## Common pitfalls

- **Tag does not match `package.json`**
  - fix the version or tag; the workflow should fail fast

- **Trusted Publishing not enabled on npm**
  - CI publish fails even though the workflow is correct

- **Wrong workflow path in npm trusted publisher settings**
  - npm trusts an exact repo + workflow pairing

- **Published tarball missing runtime files**
  - verify with `npm pack --dry-run`

- **Package is scoped but missing `publishConfig.access = public`**
  - public publish can fail or behave unexpectedly

- **GitHub Release assets depend on scripts that do not exist in the repo**
  - either add `package:release` / `ci:release` or simplify the workflow

## Practical adaptation notes for TeleCodex

TeleCodex does not currently have the full TelePi release setup. To reuse this process there, likely changes include:
- making the package scoped/publishable
- adding a CLI/bin if it should be globally installed
- adding release packaging scripts if GitHub artifacts are desired
- adding `.github/workflows/release.yml`
- adding README and AGENTS release documentation

Treat TelePi as the working reference implementation.

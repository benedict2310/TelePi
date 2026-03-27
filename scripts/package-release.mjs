#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageJsonPath = join(repoRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const packageNameForArtifacts = packageJson.name.startsWith("@")
  ? packageJson.name.split("/").at(-1)
  : packageJson.name;
const releaseName = `${packageNameForArtifacts}-v${packageJson.version}`;
const artifactsDir = join(repoRoot, "artifacts");
const tarballPath = join(artifactsDir, `${releaseName}.tar.gz`);
const checksumPath = `${tarballPath}.sha256`;
const stagingRoot = mkdtempSync(join(tmpdir(), `${releaseName}-`));
const stagingDir = join(stagingRoot, releaseName);

const releaseFiles = [
  ".env.example",
  "README.md",
  "package.json",
  "package-lock.json",
  "dist",
  "extensions/telepi-handoff.ts",
  "launchd/com.telepi.plist",
];

const { devDependencies: _devDependencies, ...releasePackageJsonBase } = packageJson;
const releasePackageJson = {
  ...releasePackageJsonBase,
  scripts: {
    start: packageJson.scripts?.start ?? "node dist/index.js",
  },
};

try {
  for (const relativePath of releaseFiles) {
    const sourcePath = join(repoRoot, relativePath);
    if (!existsSync(sourcePath)) {
      throw new Error(`Missing release input: ${relativePath}`);
    }
  }

  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });

  for (const relativePath of releaseFiles) {
    const sourcePath = join(repoRoot, relativePath);
    const destinationPath = join(stagingDir, relativePath);

    mkdirSync(dirname(destinationPath), { recursive: true });
    if (relativePath === "package.json") {
      writeFileSync(destinationPath, `${JSON.stringify(releasePackageJson, null, 2)}\n`);
      continue;
    }
    cpSync(sourcePath, destinationPath, { recursive: true });
  }

  rmSync(tarballPath, { force: true });
  rmSync(checksumPath, { force: true });

  try {
    execFileSync("tar", ["-czf", tarballPath, "-C", stagingRoot, releaseName], {
      stdio: "inherit",
    });

    const checksum = createHash("sha256")
      .update(readFileSync(tarballPath))
      .digest("hex");
    writeFileSync(checksumPath, `${checksum}  ${basename(tarballPath)}\n`);
  } catch (error) {
    rmSync(tarballPath, { force: true });
    rmSync(checksumPath, { force: true });
    throw error;
  }

  console.log(`Created ${tarballPath}`);
  console.log(`Created ${checksumPath}`);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}

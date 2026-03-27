import { homedir } from "node:os";
import path from "node:path";

export const DOCKER_WORKSPACE_PATH = "/workspace";
const DEFAULT_CONFIG_DIRNAME = path.join(".config", "telepi");
const DEFAULT_CONFIG_FILENAME = "config.env";

export function getHomeDirectory(): string {
  return process.env.HOME?.trim() || homedir();
}

export function expandHomePath(filePath: string): string {
  const normalized = filePath.trim();
  if (normalized === "~") {
    return getHomeDirectory();
  }

  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return path.join(getHomeDirectory(), normalized.slice(2));
  }

  return normalized;
}

export function resolvePathFromCwd(filePath: string, cwd: string = process.cwd()): string {
  const expandedPath = expandHomePath(filePath);
  return path.isAbsolute(expandedPath) ? expandedPath : path.resolve(cwd, expandedPath);
}

export function getDefaultTelePiConfigPath(homeDirectory: string = getHomeDirectory()): string {
  return path.join(homeDirectory, DEFAULT_CONFIG_DIRNAME, DEFAULT_CONFIG_FILENAME);
}

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import path from "node:path";

import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

import type { TelePiConfig } from "./config.js";
import {
  resolveInitialScopedModelSelection,
  resolveScopedModels,
} from "./model-scope.js";
import { expandHomePath } from "./paths.js";

/**
 * Default timeout (seconds) for bash commands in TelePi sessions.
 *
 * TelePi runs headless — interactive commands (e.g. `pi models`, `vim`)
 * or long-running scans (e.g. `find ~`) would hang forever without a timeout.
 * The LLM can still pass an explicit `timeout` to override this per-call.
 */
const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
import { describeEntry, type SessionTreeNodeLike as SessionTreeNode } from "./tree.js";

export interface PiSessionCallbacks {
  onTextDelta: (delta: string) => void;
  onToolStart: (toolName: string, toolCallId: string) => void;
  onToolUpdate: (toolCallId: string, partialResult: string) => void;
  onToolEnd: (toolCallId: string, isError: boolean) => void;
  onAgentEnd: () => void;
}

export interface PiSessionInfo {
  sessionId: string;
  sessionFile?: string;
  workspace: string;
  sessionName?: string;
  modelFallbackMessage?: string;
  model?: string;
}

export interface PiSessionModelOption {
  provider: string;
  id: string;
  name: string;
  current: boolean;
  thinkingLevel?: ThinkingLevel;
}

export interface PiSessionContext {
  chatId: number | string;
  messageThreadId?: number;
}

export interface ResolvedSessionReference {
  id: string;
  path: string;
  cwd?: string;
  workspaceWarning?: string;
  matchType: "path" | "id" | "prefix";
}

interface PiSessionHandle {
  session: AgentSession;
  modelRegistry: ModelRegistry;
  modelFallbackMessage?: string;
  dispose: () => void;
}

interface SessionHeaderInfo {
  id: string;
  cwd?: string;
}

/**
 * Patch the bash tool on a live session to enforce a default timeout.
 *
 * The Pi SDK bash tool has no default timeout — if the LLM omits `timeout`,
 * commands run indefinitely. In TelePi's headless context this causes hangs
 * on interactive commands (e.g. `pi models` launches a TUI).
 *
 * We can't override the tool via `createAgentSession({ tools })` because the
 * SDK only reads tool names from that option and rebuilds implementations
 * internally. Instead, we patch the live tool on `session.agent` after creation.
 */
function patchBashTimeout(session: AgentSession): void {
  const tools = session.agent.state.tools;
  const patched = tools.map((tool) => {
    if (tool.name !== "bash") return tool;

    const originalExecute = tool.execute;
    return {
      ...tool,
      description:
        tool.description +
        ` Commands time out after ${DEFAULT_BASH_TIMEOUT_SECONDS} seconds by default. Pass a longer timeout for slow commands (e.g. npm install, test suites).`,
      execute: (toolCallId: string, args: { command: string; timeout?: number }, signal?: AbortSignal, onUpdate?: any) =>
        originalExecute(
          toolCallId,
          { ...args, timeout: args.timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS },
          signal,
          onUpdate,
        ),
    };
  });
  session.agent.setTools(patched);
}

export async function createPiSession(
  config: TelePiConfig,
  overrideSessionPath?: string,
  overrideWorkspace?: string,
): Promise<PiSessionHandle> {
  const workspace = overrideWorkspace ?? config.workspace;
  const sessionPath = overrideSessionPath ?? config.piSessionPath;
  return createPiSessionHandle(config, workspace, createSessionManager(config, workspace, overrideSessionPath), {
    hasExistingSession: Boolean(sessionPath && existsSync(resolveSessionPathForRuntime(sessionPath))),
  });
}

async function createNewPiSession(config: TelePiConfig, workspace: string): Promise<PiSessionHandle> {
  return createPiSessionHandle(config, workspace, SessionManager.create(workspace), {
    hasExistingSession: false,
  });
}

async function createPiSessionHandle(
  config: TelePiConfig,
  workspace: string,
  sessionManager: SessionManager,
  options: { hasExistingSession: boolean },
): Promise<PiSessionHandle> {
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const settingsManager = SettingsManager.create(workspace);
  drainSettingsWarnings(settingsManager);
  const configuredModel = resolveModelOverride(modelRegistry, config.piModel);
  const scopedModels = await resolveScopedModels(settingsManager, modelRegistry);
  const { model, thinkingLevel } = resolveInitialScopedModelSelection({
    configuredModel,
    scopedModels,
    settingsManager,
    modelRegistry,
    hasExistingSession: options.hasExistingSession,
  });

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: workspace,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel,
    scopedModels,
    sessionManager,
    settingsManager,
    tools: createCodingTools(workspace),
  });
  patchBashTimeout(session);

  return {
    session,
    modelRegistry,
    modelFallbackMessage,
    dispose: () => session.dispose(),
  };
}

export function subscribeToSession(
  session: AgentSession,
  callbacks: PiSessionCallbacks,
): () => void {
  return session.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          callbacks.onTextDelta(event.assistantMessageEvent.delta);
        }
        break;
      case "tool_execution_start":
        callbacks.onToolStart(event.toolName, event.toolCallId);
        break;
      case "tool_execution_update":
        callbacks.onToolUpdate(event.toolCallId, stringifyToolData(event.partialResult));
        break;
      case "tool_execution_end":
        callbacks.onToolEnd(event.toolCallId, event.isError);
        break;
      case "agent_end":
        callbacks.onAgentEnd();
        break;
      default:
        break;
    }
  });
}

export async function promptSession(session: AgentSession, text: string): Promise<void> {
  try {
    await session.prompt(text);
  } catch (error) {
    throw wrapError("Pi session prompt failed", error);
  }
}

export class PiSessionService {
  private handle?: PiSessionHandle;
  private currentWorkspace: string;

  private constructor(private readonly config: TelePiConfig) {
    this.currentWorkspace = config.workspace;
  }

  static async create(config: TelePiConfig): Promise<PiSessionService> {
    const service = new PiSessionService(config);
    service.handle = await createPiSession(config);
    return service;
  }

  getSession(): AgentSession {
    return this.getHandle().session;
  }

  isStreaming(): boolean {
    return this.handle?.session.isStreaming ?? false;
  }

  hasActiveSession(): boolean {
    return this.handle !== undefined;
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  getInfo(): PiSessionInfo {
    if (!this.handle) {
      return {
        sessionId: "(no active session)",
        sessionFile: undefined,
        workspace: this.currentWorkspace,
        sessionName: undefined,
        modelFallbackMessage: undefined,
        model: undefined,
      };
    }

    const { session, modelFallbackMessage } = this.handle;
    const model = session.model;
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      workspace: this.currentWorkspace,
      sessionName: session.sessionName,
      modelFallbackMessage,
      model: model ? `${model.provider}/${model.id}` : undefined,
    };
  }

  subscribe(callbacks: PiSessionCallbacks): () => void {
    return subscribeToSession(this.getSession(), callbacks);
  }

  async prompt(text: string): Promise<void> {
    await promptSession(this.getSession(), text);
  }

  async abort(): Promise<void> {
    if (!this.handle) {
      return;
    }
    await this.handle.session.abort();
  }

  async listAllSessions(): Promise<
    Array<{
      id: string;
      firstMessage: string;
      path: string;
      messageCount: number;
      cwd: string;
      modified: Date;
      name?: string;
    }>
  > {
    const sessions = await SessionManager.listAll();
    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return sessions.map((s) => ({
      id: s.id,
      firstMessage: s.firstMessage,
      path: s.path,
      messageCount: s.messageCount,
      cwd: s.cwd,
      modified: s.modified,
      name: s.name,
    }));
  }

  async listWorkspaces(): Promise<string[]> {
    const sessions = await SessionManager.listAll();
    const workspaces = new Set<string>();
    for (const session of sessions) {
      if (session.cwd) {
        workspaces.add(session.cwd);
      }
    }
    return [...workspaces].sort();
  }

  async newSession(workspace?: string): Promise<{ info: PiSessionInfo; created: boolean }> {
    const effectiveWorkspace = workspace ?? this.currentWorkspace;

    if (!this.handle || effectiveWorkspace !== this.currentWorkspace) {
      const nextHandle = await createNewPiSession(this.config, effectiveWorkspace);
      const previousHandle = this.handle;
      this.handle = nextHandle;
      this.currentWorkspace = effectiveWorkspace;
      try {
        previousHandle?.dispose();
      } catch (error) {
        console.error("Failed to dispose previous session:", error);
      }
      return { info: this.getInfo(), created: true };
    }

    const created = await this.getSession().newSession();
    return { info: this.getInfo(), created };
  }

  async listModels(showAll = false): Promise<PiSessionModelOption[]> {
    const session = this.getSession();
    const currentModel = session.model;
    const availableModels = this.getModelRegistry().getAvailable();
    const availableKeys = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
    const scopedThinkingLevels = new Map(
      session.scopedModels.map((scoped) => [
        `${scoped.model.provider}/${scoped.model.id}`,
        scoped.thinkingLevel,
      ]),
    );
    const available = showAll || session.scopedModels.length === 0
      ? availableModels
      : session.scopedModels
          .map((scoped) => scoped.model)
          .filter((model) => availableKeys.has(`${model.provider}/${model.id}`));

    return available.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      current: currentModel
        ? model.provider === currentModel.provider && model.id === currentModel.id
        : false,
      thinkingLevel: scopedThinkingLevels.get(`${model.provider}/${model.id}`),
    }));
  }

  async setModel(provider: string, modelId: string, thinkingLevel?: ThinkingLevel): Promise<string> {
    const session = this.getSession();
    const modelRegistry = this.getModelRegistry();
    const model = modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`Model not found: ${provider}/${modelId}`);
    }
    await session.setModel(model);
    if (thinkingLevel !== undefined) {
      session.setThinkingLevel(thinkingLevel);
    }
    return `${model.provider}/${model.id}`;
  }

  async resolveSessionReference(sessionReference: string): Promise<ResolvedSessionReference> {
    const normalizedReference = sessionReference.trim();
    if (!normalizedReference) {
      throw new Error("Session reference cannot be empty.");
    }

    const remappedReferencePath = resolveSessionPathForRuntime(normalizedReference);
    const looksLikePath = normalizedReference.includes("/")
      || normalizedReference.includes("\\")
      || normalizedReference.endsWith(".jsonl")
      || normalizedReference.startsWith("~");
    if (looksLikePath) {
      if (!existsSync(remappedReferencePath)) {
        throw new Error(`Saved session not found: ${normalizedReference}`);
      }

      const header = readSessionHeader(remappedReferencePath);

      let indexedWorkspace: string | undefined;
      try {
        const indexedMatch = (await this.listAllSessions()).find((session) =>
          session.path === normalizedReference
          || session.path === remappedReferencePath
          || resolveSessionPathForRuntime(session.path) === remappedReferencePath
        );
        indexedWorkspace = indexedMatch?.cwd;
      } catch {
        indexedWorkspace = undefined;
      }

      const workspaceResolution = this.resolveSessionWorkspace(indexedWorkspace ?? header?.cwd);
      return {
        id: header?.id ?? path.basename(remappedReferencePath),
        path: remappedReferencePath,
        cwd: workspaceResolution.cwd,
        ...(workspaceResolution.workspaceWarning
          ? { workspaceWarning: workspaceResolution.workspaceWarning }
          : {}),
        matchType: "path",
      };
    }

    const allSessions = await this.listAllSessions();
    const currentWorkspaceSessions = allSessions.filter((session) => session.cwd === this.currentWorkspace);

    const exactIdMatch = currentWorkspaceSessions.find((session) => session.id === normalizedReference)
      ?? allSessions.find((session) => session.id === normalizedReference);
    if (exactIdMatch) {
      const workspaceResolution = this.resolveSessionWorkspace(exactIdMatch.cwd);
      return {
        id: exactIdMatch.id,
        path: exactIdMatch.path,
        cwd: workspaceResolution.cwd,
        ...(workspaceResolution.workspaceWarning
          ? { workspaceWarning: workspaceResolution.workspaceWarning }
          : {}),
        matchType: "id",
      };
    }

    const localPrefixMatches = currentWorkspaceSessions.filter((session) => session.id.startsWith(normalizedReference));
    if (localPrefixMatches.length === 1) {
      const [prefixMatch] = localPrefixMatches;
      const workspaceResolution = this.resolveSessionWorkspace(prefixMatch.cwd);
      return {
        id: prefixMatch.id,
        path: prefixMatch.path,
        cwd: workspaceResolution.cwd,
        ...(workspaceResolution.workspaceWarning
          ? { workspaceWarning: workspaceResolution.workspaceWarning }
          : {}),
        matchType: "prefix",
      };
    }

    if (localPrefixMatches.length > 1) {
      throw new Error(
        `Session ID prefix "${normalizedReference}" matches ${localPrefixMatches.length} saved sessions in the current workspace. Use more characters or /sessions to pick one.`,
      );
    }

    const prefixMatches = allSessions.filter((session) => session.id.startsWith(normalizedReference));
    if (prefixMatches.length === 1) {
      const [prefixMatch] = prefixMatches;
      const workspaceResolution = this.resolveSessionWorkspace(prefixMatch.cwd);
      return {
        id: prefixMatch.id,
        path: prefixMatch.path,
        cwd: workspaceResolution.cwd,
        ...(workspaceResolution.workspaceWarning
          ? { workspaceWarning: workspaceResolution.workspaceWarning }
          : {}),
        matchType: "prefix",
      };
    }

    if (prefixMatches.length > 1) {
      throw new Error(
        `Session ID prefix "${normalizedReference}" matches ${prefixMatches.length} saved sessions. Use more characters or /sessions to pick one.`,
      );
    }

    throw new Error(
      `No saved session matches "${normalizedReference}". Use /sessions to browse, or pass a full session path or session ID.`,
    );
  }

  async resolveWorkspaceForSession(sessionPath: string): Promise<string | undefined> {
    try {
      const match = await this.resolveSessionReference(sessionPath);
      return match.cwd;
    } catch {
      return undefined;
    }
  }

  async switchSession(sessionPath: string, workspace?: string): Promise<PiSessionInfo> {
    const effectiveWorkspace = workspace ?? this.currentWorkspace;
    const nextHandle = await createPiSession(this.config, sessionPath, effectiveWorkspace);
    const previousHandle = this.handle;
    this.handle = nextHandle;
    this.currentWorkspace = effectiveWorkspace;
    try {
      previousHandle?.dispose();
    } catch (error) {
      console.error("Failed to dispose previous session:", error);
    }
    return this.getInfo();
  }

  private resolveSessionWorkspace(workspace: string | undefined): {
    cwd?: string;
    workspaceWarning?: string;
  } {
    const resolvedWorkspace = resolveWorkspacePathForRuntime(workspace);
    if (resolvedWorkspace) {
      return { cwd: resolvedWorkspace };
    }

    if (!workspace) {
      return {};
    }

    return {
      cwd: undefined,
      workspaceWarning:
        `Saved workspace ${workspace} is unavailable in this TelePi runtime. Continuing in the current workspace instead.`,
    };
  }

  private getUnavailableSavedWorkspace(sessionFile: string): string | undefined {
    const header = readSessionHeader(sessionFile);
    if (!header?.cwd || header.cwd === this.currentWorkspace) {
      return undefined;
    }

    return resolveWorkspacePathForRuntime(header.cwd) ? undefined : header.cwd;
  }

  getTree(): SessionTreeNode[] {
    return this.getSession().sessionManager.getTree();
  }

  getLeafId(): string | null {
    return this.getSession().sessionManager.getLeafId();
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.getSession().sessionManager.getEntry(id);
  }

  getChildren(id: string): SessionEntry[] {
    return this.getSession().sessionManager.getChildren(id);
  }

  async navigateTree(
    targetId: string,
    options?: { summarize?: boolean },
  ): Promise<{ editorText?: string; cancelled: boolean }> {
    return this.getSession().navigateTree(targetId, options);
  }

  setLabel(targetId: string, label: string): void {
    this.getSession().sessionManager.appendLabelChange(targetId, label);
  }

  getLabels(): Array<{ id: string; label: string; description: string }> {
    const tree = this.getTree();
    const labels: Array<{ id: string; label: string; description: string }> = [];

    const walk = (node: SessionTreeNode): void => {
      if (node.label) {
        labels.push({
          id: node.entry.id,
          label: node.label,
          description: describeEntry(node.entry),
        });
      }

      for (const child of node.children) {
        walk(child);
      }
    };

    for (const root of tree) {
      walk(root);
    }

    return labels;
  }

  async handback(): Promise<{ sessionFile?: string; workspace: string }> {
    const info = {
      sessionFile: this.handle?.session.sessionFile,
      workspace: this.currentWorkspace,
    };

    const unavailableWorkspace = info.sessionFile
      ? this.getUnavailableSavedWorkspace(info.sessionFile)
      : undefined;
    if (unavailableWorkspace) {
      throw new Error(
        `Cannot hand back this session while its saved workspace is unavailable (${unavailableWorkspace}). Reopen it from a valid workspace first.`,
      );
    }

    try {
      this.handle?.dispose();
    } catch (error) {
      console.error("Failed to dispose session during handback:", error);
    }
    this.handle = undefined;

    return info;
  }

  dispose(): void {
    this.handle?.dispose();
    this.handle = undefined;
  }

  private getHandle(): PiSessionHandle {
    if (!this.handle) {
      throw new Error("Pi session is not initialized");
    }
    return this.handle;
  }

  private getModelRegistry(): ModelRegistry {
    return this.getHandle().modelRegistry;
  }
}

export function getPiSessionContextKey(context: PiSessionContext): string {
  return `${String(context.chatId)}::${context.messageThreadId ?? "root"}`;
}

export class PiSessionRegistry {
  private readonly services = new Map<string, PiSessionService>();
  private readonly inflight = new Map<string, Promise<PiSessionService>>();
  private readonly generations = new Map<string, number>();
  private bootstrapSessionPath?: string;

  private constructor(private readonly config: TelePiConfig) {
    this.bootstrapSessionPath = config.piSessionPath;
  }

  static async create(config: TelePiConfig): Promise<PiSessionRegistry> {
    return new PiSessionRegistry(config);
  }

  has(context: PiSessionContext): boolean {
    return this.services.has(getPiSessionContextKey(context));
  }

  get(context: PiSessionContext): PiSessionService | undefined {
    return this.services.get(getPiSessionContextKey(context));
  }

  getInfo(context: PiSessionContext): PiSessionInfo {
    return this.get(context)?.getInfo() ?? {
      sessionId: "(no active session)",
      sessionFile: undefined,
      workspace: this.config.workspace,
      sessionName: undefined,
      modelFallbackMessage: undefined,
      model: undefined,
    };
  }

  async getOrCreate(context: PiSessionContext): Promise<PiSessionService> {
    const key = getPiSessionContextKey(context);
    const existing = this.services.get(key);
    if (existing) {
      return existing;
    }

    const inflight = this.inflight.get(key);
    if (inflight) {
      return inflight;
    }

    const generation = this.bumpGeneration(key);
    const createPromise = PiSessionService.create(this.createServiceConfig())
      .then((service) => {
        this.inflight.delete(key);

        if (this.generations.get(key) !== generation) {
          service.dispose();
          const replacement = this.services.get(key);
          if (replacement) {
            return replacement;
          }
          throw new Error("Session removed during initialization");
        }

        this.services.set(key, service);
        return service;
      })
      .catch((error) => {
        this.inflight.delete(key);
        throw error;
      });

    this.inflight.set(key, createPromise);
    return createPromise;
  }

  remove(context: PiSessionContext): void {
    const key = getPiSessionContextKey(context);
    this.bumpGeneration(key);
    const service = this.services.get(key);
    service?.dispose();
    this.services.delete(key);
    this.inflight.delete(key);
  }

  dispose(): void {
    const allKeys = new Set<string>([...this.services.keys(), ...this.inflight.keys()]);
    for (const key of allKeys) {
      this.bumpGeneration(key);
    }
    for (const service of this.services.values()) {
      service.dispose();
    }
    this.services.clear();
    this.inflight.clear();
  }

  private createServiceConfig(): TelePiConfig {
    const initialSessionPath = this.consumeBootstrapSessionPath();
    return {
      ...this.config,
      telegramAllowedUserIdSet: new Set(this.config.telegramAllowedUserIds),
      piSessionPath: initialSessionPath,
    };
  }

  private consumeBootstrapSessionPath(): string | undefined {
    const sessionPath = this.bootstrapSessionPath;
    this.bootstrapSessionPath = undefined;
    return sessionPath;
  }

  private bumpGeneration(key: string): number {
    const nextGeneration = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, nextGeneration);
    return nextGeneration;
  }
}

function drainSettingsWarnings(settingsManager: SettingsManager): void {
  const errors = settingsManager.drainErrors?.() ?? [];
  for (const error of errors) {
    console.warn(`Pi settings warning (${error.scope}): ${error.error.message}`);
  }
}

function createSessionManager(
  config: TelePiConfig,
  workspace: string,
  overrideSessionPath?: string,
): SessionManager {
  const sessionPath = overrideSessionPath ?? config.piSessionPath;
  if (sessionPath) {
    const runtimeSessionPath = resolveSessionPathForRuntime(sessionPath);
    const sessionManager = SessionManager.create(workspace, path.resolve(runtimeSessionPath, ".."));
    sessionManager.setSessionFile(runtimeSessionPath);
    return sessionManager;
  }

  return SessionManager.create(workspace);
}

function resolveSessionPathForRuntime(sessionPath: string): string {
  const expandedPath = expandHomePath(sessionPath);
  if (existsSync(expandedPath)) {
    return expandedPath;
  }

  // Remap host paths to container paths (e.g. /Users/<user>/.pi/agent/... → /home/telepi/.pi/agent/...)
  const marker = `${path.sep}.pi${path.sep}agent${path.sep}`;
  const markerIndex = expandedPath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return expandedPath;
  }

  const suffix = expandedPath.slice(markerIndex + marker.length);
  for (const base of ["/home/telepi/.pi/agent", "/root/.pi/agent"]) {
    const remapped = path.resolve(base, suffix);
    // Ensure remapped path stays within the base directory (prevent traversal)
    if (!remapped.startsWith(base + path.sep) && remapped !== base) {
      continue;
    }
    if (existsSync(remapped)) {
      return remapped;
    }
  }

  return expandedPath;
}

function readSessionHeader(sessionPath: string): SessionHeaderInfo | undefined {
  try {
    const fd = openSync(sessionPath, "r");
    try {
      const buffer = Buffer.alloc(1024);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0]?.trim();
      if (!firstLine) {
        return undefined;
      }

      const parsed = JSON.parse(firstLine) as { type?: string; id?: unknown; cwd?: unknown };
      if (parsed.type !== "session" || typeof parsed.id !== "string") {
        return undefined;
      }

      return {
        id: parsed.id,
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function resolveWorkspacePathForRuntime(workspace: string | undefined): string | undefined {
  if (!workspace) {
    return undefined;
  }

  if (existsSync(workspace)) {
    return workspace;
  }

  return undefined;
}

function resolveModelOverride(
  modelRegistry: ModelRegistry,
  modelRef: string | undefined,
): Model<Api> | undefined {
  if (!modelRef) {
    return undefined;
  }

  const normalized = modelRef.trim();
  const slashIndex = normalized.indexOf("/");

  if (slashIndex >= 0) {
    const provider = normalized.slice(0, slashIndex).trim();
    const rawModelId = normalized.slice(slashIndex + 1).trim();
    const modelId = rawModelId.split(":")[0]?.trim();

    if (!provider || !modelId) {
      throw new Error(`Invalid PI_MODEL value: ${modelRef}`);
    }

    const model = modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`Could not resolve PI_MODEL: ${modelRef}`);
    }

    return model;
  }

  const matches = modelRegistry.getAll().filter((model) => model.id === normalized);
  if (matches.length === 0) {
    throw new Error(`Could not resolve PI_MODEL: ${modelRef}`);
  }

  if (matches.length > 1) {
    const providers = matches.map((model) => model.provider).join(", ");
    throw new Error(`PI_MODEL is ambiguous. Use provider/modelId instead. Matches: ${providers}`);
  }

  return matches[0];
}

function stringifyToolData(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function wrapError(message: string, error: unknown): Error {
  if (error instanceof Error) {
    return new Error(`${message}: ${error.message}`, { cause: error });
  }

  return new Error(`${message}: ${String(error)}`);
}

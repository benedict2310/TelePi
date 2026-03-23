import { existsSync } from "node:fs";
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
import { resolveModelScope } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/model-resolver.js";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

import type { TelePiConfig } from "./config.js";

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

interface PiSessionHandle {
  session: AgentSession;
  modelRegistry: ModelRegistry;
  modelFallbackMessage?: string;
  dispose: () => void;
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
  const sessionManager = createSessionManager(config, workspace, overrideSessionPath);
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const settingsManager = SettingsManager.create(workspace);
  const configuredModel = resolveModelOverride(modelRegistry, config.piModel);
  const scopedModels = await resolveScopedModels(settingsManager, modelRegistry);
  const { model, thinkingLevel } = resolveInitialModelSelection({
    configuredModel,
    scopedModels,
    settingsManager,
    modelRegistry,
    hasExistingSession: Boolean(sessionPath),
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

async function createNewPiSession(config: TelePiConfig, workspace: string): Promise<PiSessionHandle> {
  const sessionManager = SessionManager.create(workspace);
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const settingsManager = SettingsManager.create(workspace);
  const configuredModel = resolveModelOverride(modelRegistry, config.piModel);
  const scopedModels = await resolveScopedModels(settingsManager, modelRegistry);
  const { model, thinkingLevel } = resolveInitialModelSelection({
    configuredModel,
    scopedModels,
    settingsManager,
    modelRegistry,
    hasExistingSession: false,
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
    const scopedThinkingLevels = new Map(
      session.scopedModels.map((scoped) => [
        `${scoped.model.provider}/${scoped.model.id}`,
        scoped.thinkingLevel,
      ]),
    );
    const available = showAll || session.scopedModels.length === 0
      ? this.getModelRegistry().getAvailable()
      : session.scopedModels.map((scoped) => scoped.model);

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

  async resolveWorkspaceForSession(sessionPath: string): Promise<string | undefined> {
    try {
      const allSessions = await SessionManager.listAll();
      const match = allSessions.find((s) => s.path === sessionPath);
      return match?.cwd;
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

async function resolveScopedModels(
  settingsManager: SettingsManager,
  modelRegistry: ModelRegistry,
): Promise<Awaited<ReturnType<typeof resolveModelScope>>> {
  const modelPatterns = settingsManager.getEnabledModels();
  if (!modelPatterns || modelPatterns.length === 0) {
    return [];
  }

  return resolveModelScope(modelPatterns, modelRegistry);
}

function resolveInitialModelSelection(options: {
  configuredModel: Model<Api> | undefined;
  scopedModels: Awaited<ReturnType<typeof resolveModelScope>>;
  settingsManager: SettingsManager;
  modelRegistry: ModelRegistry;
  hasExistingSession: boolean;
}): { model: Model<Api> | undefined; thinkingLevel: ThinkingLevel | undefined } {
  const { configuredModel, scopedModels, settingsManager, modelRegistry, hasExistingSession } = options;

  if (configuredModel || hasExistingSession || scopedModels.length === 0) {
    return { model: configuredModel, thinkingLevel: undefined };
  }

  const defaultProvider = settingsManager.getDefaultProvider();
  const defaultModelId = settingsManager.getDefaultModel();
  const defaultModel = defaultProvider && defaultModelId
    ? modelRegistry.find(defaultProvider, defaultModelId)
    : undefined;

  const selectedScopedModel = defaultModel
    ? scopedModels.find((scoped) => scoped.model.provider === defaultModel.provider && scoped.model.id === defaultModel.id)
    : undefined;
  const fallbackScopedModel = selectedScopedModel ?? scopedModels[0];

  return {
    model: fallbackScopedModel?.model,
    thinkingLevel: fallbackScopedModel?.thinkingLevel,
  };
}

function createSessionManager(
  config: TelePiConfig,
  workspace: string,
  overrideSessionPath?: string,
): SessionManager {
  const sessionPath = overrideSessionPath ?? config.piSessionPath;
  if (sessionPath) {
    return SessionManager.open(resolveSessionPathForRuntime(sessionPath));
  }

  return SessionManager.create(workspace);
}

function resolveSessionPathForRuntime(sessionPath: string): string {
  if (existsSync(sessionPath)) {
    return sessionPath;
  }

  // Remap host paths to container paths (e.g. /Users/<user>/.pi/agent/... → /home/telepi/.pi/agent/...)
  const marker = `${path.sep}.pi${path.sep}agent${path.sep}`;
  const markerIndex = sessionPath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return sessionPath;
  }

  const suffix = sessionPath.slice(markerIndex + marker.length);
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

  return sessionPath;
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

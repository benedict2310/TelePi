import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";

import type { TelePiConfig } from "../src/config.js";

const mockState = vi.hoisted(() => {
  const models = [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  ];

  let sessionCounter = 0;
  let runtimeCounter = 0;
  let sessionFileCounter = 0;
  const createdSessions: Array<{ session: any; options: any }> = [];
  const createdRuntimes: Array<{ runtime: any; options: any }> = [];
  const modelRegistryInstances: any[] = [];
  const sessionSubscribers = new WeakMap<object, (event: any) => void>();
  const sessionPathWorkspaces = new Map<string, string>();
  const resolvedSessionPaths = new Map<string, string>();
  const defaultActiveBuiltInToolNames = ["read", "bash", "edit", "write"];
  const extensionToolName = "extension-tool";
  let slashCommands = [
    { name: "deploy", description: "Deploy app", source: "extension", path: "/ext/deploy.ts" },
    { name: "review", description: "Review staged changes", source: "prompt", path: "/prompts/review.md" },
  ];

  const defaultSessions = () => {
    const sessions = [
      {
        id: "s2",
        firstMessage: "World",
        path: "/sessions/s2.jsonl",
        messageCount: 3,
        cwd: "/workspace/projectB",
        modified: new Date("2025-01-01T00:00:00.000Z"),
        name: "Second",
      },
      {
        id: "s1",
        firstMessage: "Hello",
        path: "/sessions/s1.jsonl",
        messageCount: 5,
        cwd: "/workspace/projectA",
        modified: new Date("2025-01-02T00:00:00.000Z"),
        name: "First",
      },
    ];

    for (const session of sessions) {
      sessionPathWorkspaces.set(session.path, session.cwd);
    }

    return sessions;
  };

  const createSessionManagerInstance = (workspace: string, sessionDir = "/sessions") => {
    const manager: any = {
      kind: "create",
      workspace,
      sessionDir,
      sessionPath: undefined,
      parentSession: undefined,
      setSessionFile: vi.fn().mockImplementation((sessionPath: string) => {
        manager.sessionPath = sessionPath;
        sessionPathWorkspaces.set(sessionPath, workspace);
      }),
      newSession: vi.fn().mockImplementation((options?: { id?: string; parentSession?: string }) => {
        manager.parentSession = options?.parentSession;
        manager.sessionPath = path.join(sessionDir, `${options?.id ?? `generated-${++sessionFileCounter}`}.jsonl`);
        sessionPathWorkspaces.set(manager.sessionPath, workspace);
        return manager.sessionPath;
      }),
      getSessionFile: vi.fn().mockImplementation(() => manager.sessionPath),
      getSessionDir: vi.fn().mockImplementation(() => manager.sessionDir),
      getCwd: vi.fn().mockImplementation(() => manager.workspace),
      getSessionId: vi.fn().mockImplementation(() => {
        const sessionFile = manager.sessionPath;
        return sessionFile ? path.basename(sessionFile, ".jsonl") : `manager-${sessionCounter + 1}`;
      }),
      isPersisted: vi.fn().mockImplementation(() => Boolean(manager.sessionPath)),
      buildSessionContext: vi.fn().mockReturnValue({ messages: [] }),
    };
    return manager;
  };

  const createSession = (options: Record<string, unknown> = {}) => {
    sessionCounter += 1;

    const bashExecute = vi.fn();
    const sessionManager = options.sessionManager as any ?? createSessionManagerInstance(
      (options.cwd as string | undefined) ?? "/workspace/base",
    );
    let activeToolNames = [
      ...((options.activeToolNames as string[] | undefined) ?? [
        ...defaultActiveBuiltInToolNames,
        extensionToolName,
      ]),
    ];

    const session: any = {
      sessionId: options.sessionId ?? `session-${sessionCounter}`,
      sessionFile: options.sessionFile ?? sessionManager.getSessionFile?.() ?? `/tmp/session-${sessionCounter}.jsonl`,
      sessionName: options.sessionName,
      model: options.model ?? models[0],
      thinkingLevel: options.thinkingLevel ?? "medium",
      scopedModels: options.scopedModels ?? [],
      isStreaming: false,
      agent: {
        state: {
          messages: [],
          tools: [
            { name: "read", description: "Read files", execute: vi.fn() },
            { name: "bash", description: "Execute bash", execute: bashExecute, label: "bash", parameters: {} },
            { name: "edit", description: "Edit files", execute: vi.fn() },
            { name: "write", description: "Write files", execute: vi.fn() },
          ],
        },
      },
      prompt: vi.fn().mockResolvedValue(undefined),
      bindExtensions: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn().mockResolvedValue(undefined),
      navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
      getActiveToolNames: vi.fn().mockImplementation(() => [...activeToolNames]),
      setActiveToolsByName: vi.fn().mockImplementation((toolNames: string[]) => {
        activeToolNames = [...toolNames];
      }),
      extensionRunner: {
        getCommands: vi.fn().mockImplementation(() => slashCommands),
        hasHandlers: vi.fn().mockReturnValue(false),
      },
      sessionManager: {
        ...sessionManager,
        getTree: vi.fn().mockReturnValue([]),
        getLeafId: vi.fn().mockReturnValue("leaf-id"),
        getEntry: vi.fn().mockImplementation((id: string) =>
          id === "known-id"
            ? {
                type: "message",
                id: "known-id",
                parentId: null,
                timestamp: "2025-01-01T00:00:00Z",
                message: { role: "user", content: "Known entry" },
              }
            : undefined,
        ),
        getChildren: vi.fn().mockReturnValue([]),
        appendLabelChange: vi.fn(),
      },
      setModel: vi.fn().mockImplementation(async (model) => {
        session.model = model;
      }),
      setThinkingLevel: vi.fn().mockImplementation((thinkingLevel) => {
        session.thinkingLevel = thinkingLevel;
      }),
      subscribe: vi.fn().mockImplementation((callback) => {
        sessionSubscribers.set(session, callback);
        return () => {
          if (sessionSubscribers.get(session) === callback) {
            sessionSubscribers.delete(session);
          }
        };
      }),
      dispose: vi.fn(),
    };

    createdSessions.push({ session, options: { ...options, bashExecute } });
    return session;
  };

  const createAgentSession = vi.fn().mockImplementation(async (options: any) => {
    const activeToolNames = options.tools
      ? [...options.tools]
      : options.noTools === "all"
        ? []
        : options.noTools === "builtin"
          ? [extensionToolName]
          : [...defaultActiveBuiltInToolNames, extensionToolName];

    return {
      session: createSession({
        cwd: options.services.cwd,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        scopedModels: options.scopedModels,
        sessionManager: options.sessionManager,
        sessionFile: options.sessionManager?.getSessionFile?.(),
        activeToolNames,
      }),
      extensionsResult: {
        runtime: {
          getCommands: vi.fn().mockImplementation(() => slashCommands),
        },
      },
      modelFallbackMessage: options.model ? undefined : "fallback-model",
    };
  });

  const createAgentSessionServices = vi.fn().mockImplementation(async (options: any) => ({
    cwd: options.cwd,
    agentDir: options.agentDir ?? "/mock-agent",
    settingsManager: options.settingsManager,
    modelRuntime: { kind: "model-runtime", reloadConfig: vi.fn().mockResolvedValue(undefined) },
    resourceLoader: { kind: "resource-loader", cwd: options.cwd },
    diagnostics: [],
  }));

  const createAgentSessionRuntime = vi.fn().mockImplementation(async (factory: any, options: any) => {
    runtimeCounter += 1;

    let result = await factory(options);
    let currentSession = result.session;
    let currentServices = result.services;
    let currentDiagnostics = result.diagnostics;
    let currentFallbackMessage = result.modelFallbackMessage;

    const runtime: any = {
      id: `runtime-${runtimeCounter}`,
      get session() {
        return currentSession;
      },
      get services() {
        return currentServices;
      },
      get cwd() {
        return currentServices.cwd;
      },
      get diagnostics() {
        return currentDiagnostics;
      },
      get modelFallbackMessage() {
        return currentFallbackMessage;
      },
      newSession: vi.fn().mockImplementation(async (runtimeOptions?: any) => {
        const sessionDir = currentSession.sessionManager.getSessionDir();
        const sessionManager = SessionManager.create(currentServices.cwd, sessionDir);
        if (runtimeOptions?.parentSession) {
          sessionManager.newSession({ parentSession: runtimeOptions.parentSession });
        }
        const nextResult = await factory({
          cwd: currentServices.cwd,
          agentDir: currentServices.agentDir,
          sessionManager,
          sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile: currentSession.sessionFile },
        });
        currentSession.dispose();
        currentSession = nextResult.session;
        currentServices = nextResult.services;
        currentDiagnostics = nextResult.diagnostics;
        currentFallbackMessage = nextResult.modelFallbackMessage;
        if (runtimeOptions?.setup) {
          await runtimeOptions.setup(currentSession.sessionManager);
          currentSession.agent.state.messages = currentSession.sessionManager.buildSessionContext().messages;
        }
        return { cancelled: false };
      }),
      switchSession: vi.fn().mockImplementation(
        async (
          sessionPath: string,
          options?: { cwdOverride?: string } | string,
        ) => {
          const cwdOverride = typeof options === "string"
            ? options
            : options?.cwdOverride;
          const sessionManager = SessionManager.open(sessionPath, undefined, cwdOverride);
          const nextResult = await factory({
            cwd: sessionManager.getCwd(),
            agentDir: currentServices.agentDir,
            sessionManager,
            sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: currentSession.sessionFile },
          });
          currentSession.dispose();
          currentSession = nextResult.session;
          currentServices = nextResult.services;
          currentDiagnostics = nextResult.diagnostics;
          currentFallbackMessage = nextResult.modelFallbackMessage;
          return { cancelled: false };
        },
      ),
      fork: vi.fn().mockImplementation(async (_entryId: string) => {
        const sessionManager = SessionManager.create(currentServices.cwd, currentSession.sessionManager.getSessionDir());
        sessionManager.newSession({ parentSession: currentSession.sessionFile });
        const nextResult = await factory({
          cwd: currentServices.cwd,
          agentDir: currentServices.agentDir,
          sessionManager,
          sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile: currentSession.sessionFile },
        });
        currentSession.dispose();
        currentSession = nextResult.session;
        currentServices = nextResult.services;
        currentDiagnostics = nextResult.diagnostics;
        currentFallbackMessage = nextResult.modelFallbackMessage;
        return { cancelled: false, selectedText: "Known entry" };
      }),
      dispose: vi.fn().mockImplementation(async () => {
        currentSession.dispose();
      }),
    };

    createdRuntimes.push({ runtime, options });
    return runtime;
  });

  const createCodingTools = vi.fn().mockReturnValue([
    { name: "mock-tool", description: "Mock tool" },
  ]);

  const ModelRegistry = vi.fn().mockImplementation((runtime: any) => {
    const instance = {
      runtime,
      getAvailable: vi.fn().mockReturnValue(models),
      getAll: vi.fn().mockReturnValue(models),
      find: vi.fn().mockImplementation((provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      ),
    };
    modelRegistryInstances.push(instance);
    return instance;
  });

  const SessionManager = {
    create: vi.fn().mockImplementation((workspace: string, sessionDir?: string) =>
      createSessionManagerInstance(workspace, sessionDir ?? "/sessions")
    ),
    open: vi.fn().mockImplementation((sessionPath: string, sessionDir?: string, cwdOverride?: string) => {
      const manager = createSessionManagerInstance(
        cwdOverride ?? sessionPathWorkspaces.get(sessionPath) ?? "/workspace/base",
        sessionDir ?? path.resolve(sessionPath, ".."),
      );
      manager.kind = "open";
      manager.setSessionFile(sessionPath);
      return manager;
    }),
    listAll: vi.fn().mockResolvedValue(defaultSessions()),
  };

  const SettingsManager = {
    create: vi.fn().mockImplementation(() => ({
      getEnabledModels: vi.fn().mockReturnValue(undefined),
      getDefaultProvider: vi.fn().mockReturnValue(undefined),
      getDefaultModel: vi.fn().mockReturnValue(undefined),
      drainErrors: vi.fn().mockReturnValue([]),
    })),
  };

  return {
    models,
    createdSessions,
    createdRuntimes,
    modelRegistryInstances,
    createAgentSession,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createCodingTools,
    ModelRegistry,
    SessionManager,
    SettingsManager,
    getSubscriber: (session: object) => sessionSubscribers.get(session),
    setSessionPathWorkspace: (sessionPath: string, workspace: string) => {
      sessionPathWorkspaces.set(sessionPath, workspace);
    },
    resolveSessionPathForRuntime: (
      sessionPath: string,
      fallback: (sessionPath: string) => string,
    ) => resolvedSessionPaths.get(sessionPath) ?? fallback(sessionPath),
    setResolvedSessionPath: (sessionPath: string, resolvedPath: string) => {
      resolvedSessionPaths.set(sessionPath, resolvedPath);
    },
    reset: () => {
      sessionCounter = 0;
      runtimeCounter = 0;
      sessionFileCounter = 0;
      createdSessions.length = 0;
      createdRuntimes.length = 0;
      modelRegistryInstances.length = 0;
      sessionPathWorkspaces.clear();
      resolvedSessionPaths.clear();
      createAgentSession.mockClear();
      createAgentSessionRuntime.mockClear();
      createAgentSessionServices.mockClear();
      createCodingTools.mockClear();
      ModelRegistry.mockClear();
      SessionManager.create.mockClear();
      SessionManager.open.mockClear();
      SessionManager.listAll.mockReset();
      SessionManager.listAll.mockResolvedValue(defaultSessions());
      SettingsManager.create.mockClear();
      slashCommands = [
        { name: "deploy", description: "Deploy app", source: "extension", path: "/ext/deploy.ts" },
        { name: "review", description: "Review staged changes", source: "prompt", path: "/prompts/review.md" },
      ];
    },
    setSlashCommands: (commands: Array<{ name: string; description?: string; source: string; path?: string }>) => {
      slashCommands = commands;
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSessionFromServices: mockState.createAgentSession,
  createAgentSessionRuntime: mockState.createAgentSessionRuntime,
  createAgentSessionServices: mockState.createAgentSessionServices,
  createCodingTools: mockState.createCodingTools,
  ModelRegistry: mockState.ModelRegistry,
  SessionManager: mockState.SessionManager,
  SettingsManager: mockState.SettingsManager,
  getAgentDir: vi.fn().mockReturnValue("/mock-agent"),
}));

vi.mock("../src/pi-session-paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/pi-session-paths.js")>("../src/pi-session-paths.js");

  return {
    ...actual,
    resolveSessionPathForRuntime: vi.fn((sessionPath: string) =>
      mockState.resolveSessionPathForRuntime(sessionPath, actual.resolveSessionPathForRuntime)
    ),
  };
});

import { getPiSessionContextKey, PiSessionRegistry, PiSessionService } from "../src/pi-session.js";

describe("PiSessionService", () => {
  const createConfig = (overrides: Partial<TelePiConfig> = {}): TelePiConfig => ({
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace/base",
    piSessionPath: undefined,
    piModel: undefined,
    toolVerbosity: "summary",
    promptInboxDir: undefined,
    promptInboxIntervalMs: 60000,
    ...overrides,
  });

  beforeEach(() => {
    mockState.reset();
  });

  const getPatchedBashTool = (session: any) =>
    session.agent.state.tools.find((tool: any) => tool.name === "bash");

  it("creates a session service and initializes the Pi session runtime", async () => {
    const service = await PiSessionService.create(createConfig());

    expect(mockState.ModelRegistry).toHaveBeenCalledTimes(1);
    expect(mockState.ModelRegistry).toHaveBeenCalledWith(expect.objectContaining({ kind: "model-runtime" }));
    expect(mockState.createAgentSessionRuntime).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        cwd: "/workspace/base",
        agentDir: "/mock-agent",
      }),
    );
    expect(mockState.SettingsManager.create).toHaveBeenCalledWith("/workspace/base");
    expect(mockState.createAgentSessionServices).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/workspace/base",
      }),
    );
    expect(mockState.createCodingTools).toHaveBeenCalledWith("/workspace/base");
    expect(mockState.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        services: expect.objectContaining({ cwd: "/workspace/base" }),
        model: undefined,
        scopedModels: [],
      }),
    );
    expect(mockState.createAgentSession.mock.calls[0]?.[0]).not.toHaveProperty("tools");

    expect(service.getInfo()).toEqual({
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
      workspace: "/workspace/base",
      sessionName: undefined,
      modelFallbackMessage: "fallback-model",
      model: "anthropic/claude-sonnet-4-5",
    });
  });

  it("activates coding built-ins after session creation without disabling extension/custom tools on pi 0.70.x", async () => {
    mockState.createCodingTools.mockReturnValueOnce([
      { name: "read", description: "Read files" },
      { name: "bash", description: "Execute bash" },
      { name: "write", description: "Write files" },
      { name: "find", description: "Find files" },
      { name: "ls", description: "List files" },
    ]);

    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;

    expect(mockState.createAgentSession.mock.calls[0]?.[0]).not.toHaveProperty("tools");
    expect(currentSession.setActiveToolsByName).toHaveBeenCalledWith(
      expect.arrayContaining(["read", "bash", "edit", "write", "find", "ls", "extension-tool"]),
    );
    expect(service.getSession().getActiveToolNames()).toEqual(
      expect.arrayContaining(["read", "bash", "edit", "write", "find", "ls", "extension-tool"]),
    );
  });

  it("collects runtime diagnostics for Telegram-visible session info", async () => {
    mockState.SettingsManager.create.mockImplementationOnce(() => ({
      getEnabledModels: vi.fn().mockReturnValue(undefined),
      getDefaultProvider: vi.fn().mockReturnValue(undefined),
      getDefaultModel: vi.fn().mockReturnValue(undefined),
      drainErrors: vi.fn().mockReturnValue([
        { scope: "project", error: new Error("failed to parse .pi/settings.json") },
      ]),
    }));

    const originalCreateServices = mockState.createAgentSessionServices.getMockImplementation();
    mockState.createAgentSessionServices.mockImplementationOnce(async (options: any) => {
      const result = await originalCreateServices!(options);
      return {
        ...result,
        diagnostics: [{ type: "warning", message: "Project auth: no API key configured for anthropic" }],
        resourceLoader: {
          ...result.resourceLoader,
          getExtensions: vi.fn().mockReturnValue({
            extensions: [],
            errors: [{ path: "/ext/bad.ts", error: "boom" }],
            runtime: { pendingProviderRegistrations: [] },
          }),
          getSkills: vi.fn().mockReturnValue({
            skills: [],
            diagnostics: [{ type: "warning", message: "skill path does not exist", path: "/skills/missing" }],
          }),
          getPrompts: vi.fn().mockReturnValue({ prompts: [], diagnostics: [] }),
          getThemes: vi.fn().mockReturnValue({
            themes: [],
            diagnostics: [{ type: "warning", message: "theme path does not exist", path: "/themes/missing.json" }],
          }),
        },
      };
    });

    const service = await PiSessionService.create(createConfig());

    expect(service.getInfo()).toMatchObject({
      diagnostics: [
        { type: "warning", message: "Project auth: no API key configured for anthropic" },
        { type: "warning", message: "Project settings: failed to parse .pi/settings.json" },
        { type: "error", message: 'Failed to load extension "/ext/bad.ts": boom' },
        { type: "warning", message: "Skill issue (/skills/missing): skill path does not exist" },
        { type: "warning", message: "Theme issue (/themes/missing.json): theme path does not exist" },
      ],
    });
  });

  it("patches the live bash tool via agent state mutation", async () => {
    await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;
    const originalExecute = mockState.createdSessions[0]?.options?.bashExecute;
    const bashTool = currentSession.agent.state.tools.find((tool: any) => tool.name === "bash");

    expect(bashTool.description).toContain("Commands time out after 120 seconds by default.");
    expect(bashTool.execute).not.toBe(originalExecute);

    await bashTool.execute("tool-1", { command: "pwd" });

    expect(originalExecute).toHaveBeenCalledWith(
      "tool-1",
      { command: "pwd", timeout: 120 },
      undefined,
      undefined,
    );
  });

  it("rejects TelePi launchctl self-management commands before they execute", async () => {
    await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;
    const originalBashTool = mockState.createdSessions[0]?.options?.bashExecute;
    const patchedBashTool = getPatchedBashTool(currentSession);

    const blockedCommands = [
      "launchctl kickstart -k gui/$UID/com.telepi",
      "echo ready & launchctl kickstart -k gui/$UID/com.telepi",
      "sudo -E launchctl kickstart -k gui/$UID/com.telepi",
      '(launchctl kickstart -k gui/$UID/com.telepi)',
      'bash -c "launchctl kickstart -k gui/$UID/com.telepi"',
    ];

    for (const [index, command] of blockedCommands.entries()) {
      expect(() => patchedBashTool.execute(`tool-${index + 1}`, { command })).toThrow(
        "Blocked TelePi self-management command. launchctl commands targeting com.telepi cannot run from inside a TelePi session.",
      );
    }

    expect(originalBashTool).not.toHaveBeenCalled();
  });

  it("adds the provider-response notice extension factory to session services", async () => {
    await PiSessionService.create(createConfig());

    expect(mockState.createAgentSessionServices).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceLoaderOptions: expect.objectContaining({
          extensionFactories: [expect.any(Function)],
        }),
      }),
    );
  });

  it("binds extension hooks through the underlying session", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;
    const bindings = {
      onError: vi.fn(),
      uiContext: { notify: vi.fn() },
    } as any;

    await service.bindExtensions(bindings);

    expect(currentSession.bindExtensions).toHaveBeenCalledWith(bindings);
  });

  it("lists discovered slash commands from the Pi session runtime", async () => {
    mockState.setSlashCommands([
      { name: "skill:browser-tools", description: "Browser automation", source: "skill", path: "/skills/browser.md" },
      { name: "/review", description: "Review staged changes", source: "prompt", path: "/prompts/review.md" },
      { name: "deploy", description: "Deploy app", source: "extension", path: "/ext/deploy.ts" },
      { name: "deploy", description: "Duplicate deploy", source: "extension", path: "/ext/deploy-2.ts" },
    ]);

    const service = await PiSessionService.create(createConfig());

    await expect(service.listSlashCommands()).resolves.toEqual([
      { name: "deploy", description: "Deploy app", source: "extension", path: "/ext/deploy.ts" },
      { name: "review", description: "Review staged changes", source: "prompt", path: "/prompts/review.md" },
      { name: "skill:browser-tools", description: "Browser automation", source: "skill", path: "/skills/browser.md" },
    ]);
  });

  it("returns an empty slash-command list when runtime discovery is unavailable", async () => {
    const originalImpl = mockState.createAgentSession.getMockImplementation();
    mockState.createAgentSession.mockImplementationOnce(async (options: any) => {
      const result = await (originalImpl as any)(options);
      result.extensionsResult = {
        runtime: {},
      };
      return result;
    });

    const service = await PiSessionService.create(createConfig());

    await expect(service.listSlashCommands()).resolves.toEqual([]);
  });

  it("resolves PI_MODEL overrides during creation", async () => {
    await PiSessionService.create(createConfig({ piModel: "openai/gpt-4o" }));

    expect(mockState.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
      }),
    );
  });

  it("supports model lookup by bare id during creation", async () => {
    await PiSessionService.create(createConfig({ piModel: "gpt-4o" }));

    expect(mockState.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
      }),
    );
  });

  it("delegates isStreaming and tracks active sessions", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;
    currentSession.isStreaming = true;

    expect(service.isStreaming()).toBe(true);
    expect(service.hasActiveSession()).toBe(true);
  });

  it("creates a new session in the current workspace via AgentSessionRuntime", async () => {
    const service = await PiSessionService.create(createConfig());
    const runtime = mockState.createdRuntimes[0]?.runtime;

    const result = await service.newSession();

    expect(runtime.newSession).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      created: true,
      info: service.getInfo(),
    });
    expect(mockState.createAgentSession).toHaveBeenCalledTimes(2);
  });

  it("forwards runtime new-session options and rebinds extensions and subscriptions after replacement", async () => {
    const service = await PiSessionService.create(createConfig());
    const initialSession = mockState.createdSessions[0]?.session;
    const runtime = mockState.createdRuntimes[0]?.runtime;
    const bindings = { uiContext: { notify: vi.fn() } } as any;
    const onTextDelta = vi.fn();

    await service.bindExtensions(bindings);
    service.subscribe({
      onTextDelta,
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onAgentEnd: vi.fn(),
    });

    const setup = vi.fn().mockResolvedValue(undefined);
    const withSession = vi.fn().mockResolvedValue(undefined);
    const result = await service.newSession({ parentSession: "/tmp/parent.jsonl", setup, withSession });
    const nextSession = mockState.createdSessions[1]?.session;

    expect(runtime.newSession).toHaveBeenCalledWith({ parentSession: "/tmp/parent.jsonl", setup, withSession });
    expect(result.created).toBe(true);
    expect(setup).toHaveBeenCalledWith(nextSession.sessionManager);
    expect(nextSession.bindExtensions).toHaveBeenCalledWith(bindings);
    expect(mockState.getSubscriber(initialSession)).toBeUndefined();
    expect(mockState.getSubscriber(nextSession)).toBeTypeOf("function");

    mockState.getSubscriber(nextSession)?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Rebound" },
    });
    expect(onTextDelta).toHaveBeenCalledWith("Rebound");
  });

  it("creates a new handle when starting a session in another workspace", async () => {
    const service = await PiSessionService.create(createConfig());
    const previousSession = mockState.createdSessions[0]?.session;

    const result = await service.newSession("/workspace/other");

    expect(mockState.SessionManager.create).toHaveBeenLastCalledWith("/workspace/other");
    expect(mockState.createAgentSession).toHaveBeenCalledTimes(2);
    expect(previousSession.dispose).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(true);
    expect(result.info.workspace).toBe("/workspace/other");
    expect(service.getCurrentWorkspace()).toBe("/workspace/other");
  });

  it("throws when withSession is requested for a cross-workspace new session", async () => {
    const service = await PiSessionService.create(createConfig());
    const withSession = vi.fn().mockResolvedValue(undefined);

    await expect(service.newSession({ workspace: "/workspace/other", withSession })).rejects.toThrow(
      "TelePi only supports withSession callbacks for runtime-backed new-session replacements.",
    );

    expect(mockState.createAgentSession).toHaveBeenCalledTimes(1);
    expect(withSession).not.toHaveBeenCalled();
    expect(service.getCurrentWorkspace()).toBe("/workspace/base");
  });

  it("clears the active handle when extension rebinding fails during replacement", async () => {
    const service = await PiSessionService.create(createConfig());
    const previousSession = mockState.createdSessions[0]?.session;
    const bindings = { uiContext: { notify: vi.fn() } } as any;
    const originalCreateAgentSession = mockState.createAgentSession.getMockImplementation();

    await service.bindExtensions(bindings);
    mockState.createAgentSession.mockImplementationOnce(async (options: any) => {
      const result = await originalCreateAgentSession!(options);
      result.session.bindExtensions.mockRejectedValueOnce(new Error("extension rebinding exploded"));
      return result;
    });

    await expect(service.newSession("/workspace/other")).rejects.toThrow("extension rebinding exploded");

    expect(mockState.createdSessions[1]?.session.bindExtensions).toHaveBeenCalledWith(bindings);
    expect(mockState.createdRuntimes[1]?.runtime.dispose).toHaveBeenCalledTimes(1);
    expect(previousSession.dispose).toHaveBeenCalledTimes(1);
    expect(service.hasActiveSession()).toBe(false);
    expect(service.getInfo()).toEqual({
      sessionId: "(no active session)",
      sessionFile: undefined,
      workspace: "/workspace/base",
      sessionName: undefined,
      modelFallbackMessage: undefined,
      model: undefined,
    });
    expect(() => service.getSession()).toThrow("Pi session is not initialized");
  });

  it("clears the active handle when extension rebinding fails during same-runtime new-session replacement", async () => {
    const service = await PiSessionService.create(createConfig());
    const previousSession = mockState.createdSessions[0]?.session;
    const runtime = mockState.createdRuntimes[0]?.runtime;
    const bindings = { uiContext: { notify: vi.fn() } } as any;
    const originalCreateAgentSession = mockState.createAgentSession.getMockImplementation();

    await service.bindExtensions(bindings);
    service.subscribe({
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onAgentEnd: vi.fn(),
    });

    mockState.createAgentSession.mockImplementationOnce(async (options: any) => {
      const result = await originalCreateAgentSession!(options);
      result.session.bindExtensions.mockRejectedValueOnce(new Error("extension rebinding exploded"));
      return result;
    });

    await expect(service.newSession()).rejects.toThrow("extension rebinding exploded");

    const nextSession = mockState.createdSessions[1]?.session;
    expect(nextSession.bindExtensions).toHaveBeenCalledWith(bindings);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    expect(previousSession.dispose).toHaveBeenCalledTimes(1);
    expect(nextSession.dispose).toHaveBeenCalledTimes(1);
    expect(mockState.getSubscriber(previousSession)).toBeUndefined();
    expect(mockState.getSubscriber(nextSession)).toBeUndefined();
    expect(service.hasActiveSession()).toBe(false);
    expect(service.getInfo()).toEqual({
      sessionId: "(no active session)",
      sessionFile: undefined,
      workspace: "/workspace/base",
      sessionName: undefined,
      modelFallbackMessage: undefined,
      model: undefined,
    });
    expect(() => service.getSession()).toThrow("Pi session is not initialized");
  });

  it("disposes the created runtime when cross-workspace setup fails", async () => {
    const service = await PiSessionService.create(createConfig());
    const previousSession = mockState.createdSessions[0]?.session;
    const setup = vi.fn().mockRejectedValue(new Error("setup exploded"));

    await expect(service.newSession({ workspace: "/workspace/other", setup })).rejects.toThrow("setup exploded");

    expect(setup).toHaveBeenCalledWith(mockState.createdSessions[1]?.session.sessionManager);
    expect(mockState.createdRuntimes[1]?.runtime.dispose).toHaveBeenCalledTimes(1);
    expect(mockState.createdSessions[1]?.session.dispose).toHaveBeenCalledTimes(1);
    expect(previousSession.dispose).not.toHaveBeenCalled();
    expect(service.getCurrentWorkspace()).toBe("/workspace/base");
    expect(service.getInfo().sessionId).toBe("session-1");
  });

  it("switches to a specific saved session and workspace via AgentSessionRuntime", async () => {
    const service = await PiSessionService.create(createConfig());
    const previousSession = mockState.createdSessions[0]?.session;
    const runtime = mockState.createdRuntimes[0]?.runtime;

    const info = await service.switchSession("/sessions/saved.jsonl", "/workspace/projectA");

    expect(runtime.switchSession).toHaveBeenCalledWith(
      "/sessions/saved.jsonl",
      { cwdOverride: "/workspace/projectA" },
    );
    expect(mockState.SessionManager.open).toHaveBeenLastCalledWith(
      "/sessions/saved.jsonl",
      undefined,
      "/workspace/projectA",
    );
    expect(previousSession.dispose).toHaveBeenCalledTimes(1);
    expect(info.workspace).toBe("/workspace/projectA");
    expect(info.sessionFile).toBe("/sessions/saved.jsonl");
  });

  it("forwards runtime switch-session options", async () => {
    const service = await PiSessionService.create(createConfig());
    const runtime = mockState.createdRuntimes[0]?.runtime;
    const withSession = vi.fn().mockResolvedValue(undefined);

    await service.switchSession("/sessions/saved.jsonl", {
      workspace: "/workspace/projectA",
      withSession,
    });

    expect(runtime.switchSession).toHaveBeenCalledWith(
      "/sessions/saved.jsonl",
      { cwdOverride: "/workspace/projectA", withSession },
    );
  });

  it("adopts the runtime-resolved cwd when switching without an explicit workspace override", async () => {
    const targetWorkspace = mkdtempSync(path.join(tmpdir(), "telepi-session-"));

    try {
      const sessionPath = path.join(targetWorkspace, "cross-cwd.jsonl");
      writeFileSync(
        sessionPath,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "crosscwd1",
          timestamp: "2025-01-03T00:00:00.000Z",
          cwd: targetWorkspace,
        })}\n`,
      );
      const service = await PiSessionService.create(createConfig({ workspace: "/workspace/projectA" }));
      const runtime = mockState.createdRuntimes[0]?.runtime;

      const info = await service.switchSession(sessionPath);

      expect(runtime.switchSession).toHaveBeenCalledWith(sessionPath, { cwdOverride: targetWorkspace });
      expect(service.getCurrentWorkspace()).toBe(targetWorkspace);
      expect(info.workspace).toBe(targetWorkspace);
    } finally {
      rmSync(targetWorkspace, { recursive: true, force: true });
    }
  });

  it("switches using the resolved session path when the caller passes a ~ path", async () => {
    mockState.SessionManager.listAll.mockRejectedValueOnce(new Error("boom"));
    const tempDir = mkdtempSync(path.join(homedir(), "telepi-session-"));

    try {
      const sessionPath = path.join(tempDir, "tilde-switch.jsonl");
      writeFileSync(
        sessionPath,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "tilde-switch",
          timestamp: "2025-01-03T00:00:00.000Z",
          cwd: tempDir,
        })}\n`,
      );
      const tildePath = sessionPath.replace(homedir(), "~");
      const service = await PiSessionService.create(createConfig({ workspace: "/workspace/projectA" }));
      const runtime = mockState.createdRuntimes[0]?.runtime;

      const info = await service.switchSession(tildePath);

      expect(runtime.switchSession).toHaveBeenCalledWith(sessionPath, { cwdOverride: tempDir });
      expect(mockState.SessionManager.open).toHaveBeenLastCalledWith(sessionPath, undefined, tempDir);
      expect(info.sessionFile).toBe(sessionPath);
      expect(info.workspace).toBe(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("switches using the remapped runtime session path instead of the raw caller input", async () => {
    mockState.SessionManager.listAll.mockRejectedValueOnce(new Error("boom"));
    const tempDir = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    const rawSessionPath = "/Users/example/.pi/agent/sessions/remapped.jsonl";

    try {
      const resolvedSessionPath = path.join(tempDir, "remapped.jsonl");
      writeFileSync(
        resolvedSessionPath,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "remapped1",
          timestamp: "2025-01-03T00:00:00.000Z",
          cwd: tempDir,
        })}\n`,
      );
      mockState.setResolvedSessionPath(rawSessionPath, resolvedSessionPath);
      const service = await PiSessionService.create(createConfig({ workspace: "/workspace/projectA" }));
      const runtime = mockState.createdRuntimes[0]?.runtime;

      const info = await service.switchSession(rawSessionPath);

      expect(runtime.switchSession).toHaveBeenCalledWith(resolvedSessionPath, { cwdOverride: tempDir });
      expect(mockState.SessionManager.open).toHaveBeenLastCalledWith(resolvedSessionPath, undefined, tempDir);
      expect(info.sessionFile).toBe(resolvedSessionPath);
      expect(info.workspace).toBe(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rethrows unexpected session-resolution errors instead of silently falling back", async () => {
    mockState.SessionManager.listAll.mockRejectedValueOnce(new Error("list exploded"));
    const service = await PiSessionService.create(createConfig());
    const runtime = mockState.createdRuntimes[0]?.runtime;

    await expect(service.switchSession("s1")).rejects.toThrow("list exploded");
    expect(runtime.switchSession).not.toHaveBeenCalled();
  });

  it("switches using the resolved session path after handback when no handle is active", async () => {
    mockState.SessionManager.listAll.mockRejectedValueOnce(new Error("boom"));
    const tempDir = mkdtempSync(path.join(homedir(), "telepi-session-"));

    try {
      const sessionPath = path.join(tempDir, "tilde-reopen.jsonl");
      writeFileSync(
        sessionPath,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "tilde-reopen",
          timestamp: "2025-01-03T00:00:00.000Z",
          cwd: tempDir,
        })}\n`,
      );
      const tildePath = sessionPath.replace(homedir(), "~");
      const service = await PiSessionService.create(createConfig({ workspace: "/workspace/projectA" }));

      await service.handback();
      expect(service.hasActiveSession()).toBe(false);

      const info = await service.switchSession(tildePath);

      expect(mockState.SessionManager.open).toHaveBeenLastCalledWith(sessionPath, undefined, tempDir);
      expect(info.sessionFile).toBe(sessionPath);
      expect(info.workspace).toBe(tempDir);
      expect(service.hasActiveSession()).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when withSession is requested for a switch without an active handle", async () => {
    const service = await PiSessionService.create(createConfig());
    const withSession = vi.fn().mockResolvedValue(undefined);

    await service.handback();
    expect(service.hasActiveSession()).toBe(false);

    await expect(service.switchSession("/sessions/saved.jsonl", { withSession })).rejects.toThrow(
      "TelePi only supports withSession callbacks for runtime-backed session switches.",
    );

    expect(mockState.SessionManager.open).not.toHaveBeenCalled();
    expect(mockState.createAgentSession).toHaveBeenCalledTimes(1);
    expect(withSession).not.toHaveBeenCalled();
  });

  it("recreates the model registry each time the runtime factory creates a same-runtime replacement session", async () => {
    const service = await PiSessionService.create(createConfig());

    await service.switchSession("/sessions/saved.jsonl", "/workspace/projectA");

    expect(mockState.ModelRegistry).toHaveBeenCalledTimes(2);
    const firstRegistry = mockState.modelRegistryInstances[0];
    const secondRegistry = mockState.modelRegistryInstances[1];
    expect(secondRegistry).not.toBe(firstRegistry);
  });

  it("recreates the model registry and reapplies coding-tool activation for cross-runtime replacements", async () => {
    mockState.createCodingTools.mockReturnValue([
      { name: "read", description: "Read files" },
      { name: "bash", description: "Execute bash" },
      { name: "edit", description: "Edit files" },
      { name: "write", description: "Write files" },
      { name: "find", description: "Find files" },
    ]);
    const service = await PiSessionService.create(createConfig());

    await service.newSession("/workspace/other");

    const replacementSession = mockState.createdSessions[1]?.session;
    expect(mockState.ModelRegistry).toHaveBeenCalledTimes(2);
    const secondRegistry = mockState.modelRegistryInstances[1];
    expect(secondRegistry).not.toBe(mockState.modelRegistryInstances[0]);
    expect(replacementSession.setActiveToolsByName).toHaveBeenCalledWith(
      expect.arrayContaining(["read", "bash", "edit", "write", "find", "extension-tool"]),
    );
    expect(replacementSession.getActiveToolNames()).toEqual(
      expect.arrayContaining(["read", "bash", "edit", "write", "find", "extension-tool"]),
    );
  });

  it("returns the runtime cancellation signal when switching sessions is cancelled", async () => {
    const service = await PiSessionService.create(createConfig());
    const previousSession = mockState.createdSessions[0]?.session;
    const runtime = mockState.createdRuntimes[0]?.runtime;
    const initialInfo = service.getInfo();

    runtime.switchSession.mockResolvedValueOnce({ cancelled: true });

    const result = await service.switchSession("/sessions/saved.jsonl", "/workspace/projectA");

    expect(result).toEqual({
      ...initialInfo,
      cancelled: true,
    });
    expect(previousSession.dispose).not.toHaveBeenCalled();
  });

  it("clears the active handle when extension rebinding fails during same-runtime session switching", async () => {
    const service = await PiSessionService.create(createConfig());
    const previousSession = mockState.createdSessions[0]?.session;
    const runtime = mockState.createdRuntimes[0]?.runtime;
    const bindings = { uiContext: { notify: vi.fn() } } as any;
    const originalCreateAgentSession = mockState.createAgentSession.getMockImplementation();

    await service.bindExtensions(bindings);
    service.subscribe({
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onAgentEnd: vi.fn(),
    });

    mockState.createAgentSession.mockImplementationOnce(async (options: any) => {
      const result = await originalCreateAgentSession!(options);
      result.session.bindExtensions.mockRejectedValueOnce(new Error("extension rebinding exploded"));
      return result;
    });

    await expect(service.switchSession("/sessions/saved.jsonl", "/workspace/projectA")).rejects.toThrow(
      "extension rebinding exploded",
    );

    const nextSession = mockState.createdSessions[1]?.session;
    expect(nextSession.bindExtensions).toHaveBeenCalledWith(bindings);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    expect(previousSession.dispose).toHaveBeenCalledTimes(1);
    expect(nextSession.dispose).toHaveBeenCalledTimes(1);
    expect(mockState.getSubscriber(previousSession)).toBeUndefined();
    expect(mockState.getSubscriber(nextSession)).toBeUndefined();
    expect(service.hasActiveSession()).toBe(false);
    expect(service.getCurrentWorkspace()).toBe("/workspace/base");
    expect(service.getInfo()).toEqual({
      sessionId: "(no active session)",
      sessionFile: undefined,
      workspace: "/workspace/base",
      sessionName: undefined,
      modelFallbackMessage: undefined,
      model: undefined,
    });
  });

  it("hands back the active session and clears the handle", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;

    await expect(service.handback()).resolves.toEqual({
      sessionFile: "/tmp/session-1.jsonl",
      workspace: "/workspace/base",
    });

    expect(currentSession.dispose).toHaveBeenCalledTimes(1);
    expect(service.hasActiveSession()).toBe(false);
    expect(service.getInfo()).toEqual({
      sessionId: "(no active session)",
      sessionFile: undefined,
      workspace: "/workspace/base",
      sessionName: undefined,
      modelFallbackMessage: undefined,
      model: undefined,
    });
  });

  it("returns an empty handback after the session is already handed back", async () => {
    const service = await PiSessionService.create(createConfig());

    await service.handback();

    await expect(service.handback()).resolves.toEqual({
      sessionFile: undefined,
      workspace: "/workspace/base",
    });
  });

  it("blocks handback when continuing a session in a fallback workspace", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    const sessionPath = path.join(tempDir, "moved.jsonl");
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "moved1234",
        timestamp: "2025-01-03T00:00:00.000Z",
        cwd: "/definitely/missing/workspace",
      })}\n`,
    );
    const service = await PiSessionService.create(createConfig());

    await service.switchSession(sessionPath, "/workspace/base");
    await expect(service.handback()).rejects.toThrow(
      "Cannot hand back this session while its saved workspace is unavailable (/definitely/missing/workspace).",
    );
    expect(service.hasActiveSession()).toBe(true);
  });

  it("aborts the active session and becomes a no-op without one", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;

    await service.abort();
    expect(currentSession.abort).toHaveBeenCalledTimes(1);

    await service.handback();
    await expect(service.abort()).resolves.toBeUndefined();
    expect(currentSession.abort).toHaveBeenCalledTimes(1);
  });

  it("lists all sessions sorted by modified date descending", async () => {
    mockState.SessionManager.listAll.mockResolvedValueOnce([
      {
        id: "older",
        firstMessage: "Old",
        path: "/sessions/old.jsonl",
        messageCount: 1,
        cwd: "/workspace/b",
        modified: new Date("2025-01-01T00:00:00.000Z"),
        name: "Old name",
      },
      {
        id: "newer",
        firstMessage: "New",
        path: "/sessions/new.jsonl",
        messageCount: 2,
        cwd: "/workspace/a",
        modified: new Date("2025-01-02T00:00:00.000Z"),
        name: "New name",
      },
    ]);

    const service = await PiSessionService.create(createConfig());
    const sessions = await service.listAllSessions();

    expect(sessions.map((session) => session.id)).toEqual(["newer", "older"]);
    expect(sessions[0]).toMatchObject({ name: "New name", cwd: "/workspace/a" });
  });

  it("lists unique workspaces in sorted order", async () => {
    mockState.SessionManager.listAll.mockResolvedValueOnce([
      {
        id: "a",
        firstMessage: "One",
        path: "/sessions/a.jsonl",
        messageCount: 1,
        cwd: "/workspace/z",
        modified: new Date(),
      },
      {
        id: "b",
        firstMessage: "Two",
        path: "/sessions/b.jsonl",
        messageCount: 2,
        cwd: "/workspace/a",
        modified: new Date(),
      },
      {
        id: "c",
        firstMessage: "Three",
        path: "/sessions/c.jsonl",
        messageCount: 3,
        cwd: "/workspace/z",
        modified: new Date(),
      },
    ]);

    const service = await PiSessionService.create(createConfig());

    await expect(service.listWorkspaces()).resolves.toEqual(["/workspace/a", "/workspace/z"]);
  });

  it("resolves a saved session reference by path, exact ID, or unique ID prefix", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    const tempDirTwo = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    const sessionPath = path.join(tempDir, "one.jsonl");
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "abc12345",
        timestamp: "2025-01-03T00:00:00.000Z",
        cwd: tempDir,
      })}\n`,
    );
    mockState.SessionManager.listAll.mockResolvedValue([
      {
        id: "abc12345",
        firstMessage: "One",
        path: sessionPath,
        messageCount: 1,
        cwd: tempDir,
        modified: new Date("2025-01-03T00:00:00.000Z"),
      },
      {
        id: "def67890",
        firstMessage: "Two",
        path: "/sessions/two.jsonl",
        messageCount: 1,
        cwd: tempDirTwo,
        modified: new Date("2025-01-02T00:00:00.000Z"),
      },
    ]);
    const service = await PiSessionService.create(createConfig());

    await expect(service.resolveSessionReference(sessionPath)).resolves.toEqual({
      id: "abc12345",
      path: sessionPath,
      cwd: tempDir,
      matchType: "path",
    });
    await expect(service.resolveSessionReference("def67890")).resolves.toEqual({
      id: "def67890",
      path: "/sessions/two.jsonl",
      cwd: tempDirTwo,
      matchType: "id",
    });
    await expect(service.resolveSessionReference("abc1")).resolves.toEqual({
      id: "abc12345",
      path: sessionPath,
      cwd: tempDir,
      matchType: "prefix",
    });
  });

  it("falls back to an explicit existing session path even when the session index is unavailable", async () => {
    mockState.SessionManager.listAll.mockRejectedValueOnce(new Error("boom"));
    const tempDir = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    const sessionPath = path.join(tempDir, "manual.jsonl");
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "manual1234",
        timestamp: "2025-01-03T00:00:00.000Z",
        cwd: tempDir,
      })}\n`,
    );
    const service = await PiSessionService.create(createConfig());

    await expect(service.resolveSessionReference(sessionPath)).resolves.toEqual({
      id: "manual1234",
      path: sessionPath,
      cwd: tempDir,
      matchType: "path",
    });
  });

  it("falls back to the current workspace when an explicit session path has an unavailable workspace", async () => {
    mockState.SessionManager.listAll.mockRejectedValueOnce(new Error("boom"));
    const tempDir = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    const sessionPath = path.join(tempDir, "moved.jsonl");
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "moved1234",
        timestamp: "2025-01-03T00:00:00.000Z",
        cwd: "/definitely/missing/workspace",
      })}\n`,
    );
    const service = await PiSessionService.create(createConfig());

    await expect(service.resolveSessionReference(sessionPath)).resolves.toEqual({
      id: "moved1234",
      path: sessionPath,
      cwd: undefined,
      workspaceWarning:
        "Saved workspace /definitely/missing/workspace is unavailable in this TelePi runtime. Continuing in the current workspace instead.",
      matchType: "path",
    });
  });

  it("expands ~ when switching by explicit session path", async () => {
    mockState.SessionManager.listAll.mockRejectedValueOnce(new Error("boom"));
    const tempDir = mkdtempSync(path.join(homedir(), "telepi-session-"));
    const sessionPath = path.join(tempDir, "tilde.jsonl");
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "tilde1234",
        timestamp: "2025-01-03T00:00:00.000Z",
        cwd: tempDir,
      })}\n`,
    );
    const tildePath = sessionPath.replace(homedir(), "~");

    try {
      const service = await PiSessionService.create(createConfig());
      await expect(service.resolveSessionReference(tildePath)).resolves.toEqual({
        id: "tilde1234",
        path: sessionPath,
        cwd: tempDir,
        matchType: "path",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allows explicit path recovery for existing session files with an invalid header", async () => {
    mockState.SessionManager.listAll.mockRejectedValueOnce(new Error("boom"));
    const tempDir = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    const sessionPath = path.join(tempDir, "broken.jsonl");
    writeFileSync(sessionPath, "not-json\n");
    const service = await PiSessionService.create(createConfig());

    await expect(service.resolveSessionReference(sessionPath)).resolves.toEqual({
      id: "broken.jsonl",
      path: sessionPath,
      cwd: undefined,
      matchType: "path",
    });
  });

  it("accepts legacy session files without cwd when switching by explicit path", async () => {
    mockState.SessionManager.listAll.mockRejectedValueOnce(new Error("boom"));
    const tempDir = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    const sessionPath = path.join(tempDir, "legacy.jsonl");
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        id: "legacy1234",
      })}\n`,
    );
    const service = await PiSessionService.create(createConfig());

    await expect(service.resolveSessionReference(sessionPath)).resolves.toEqual({
      id: "legacy1234",
      path: sessionPath,
      cwd: undefined,
      matchType: "path",
    });
  });

  it("prefers exact ID matches over prefix matches", async () => {
    const exactWorkspace = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    const prefixWorkspace = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    mockState.SessionManager.listAll.mockResolvedValueOnce([
      {
        id: "abc",
        firstMessage: "Exact",
        path: "/sessions/exact.jsonl",
        messageCount: 1,
        cwd: exactWorkspace,
        modified: new Date("2025-01-03T00:00:00.000Z"),
      },
      {
        id: "abcdef12",
        firstMessage: "Prefix",
        path: "/sessions/prefix.jsonl",
        messageCount: 1,
        cwd: prefixWorkspace,
        modified: new Date("2025-01-02T00:00:00.000Z"),
      },
    ]);
    const service = await PiSessionService.create(createConfig());

    await expect(service.resolveSessionReference("abc")).resolves.toEqual({
      id: "abc",
      path: "/sessions/exact.jsonl",
      cwd: exactWorkspace,
      matchType: "id",
    });
  });

  it("falls back to the current workspace for saved session IDs whose workspace is unavailable", async () => {
    mockState.SessionManager.listAll.mockResolvedValueOnce([
      {
        id: "bad12345",
        firstMessage: "Broken",
        path: "/sessions/bad.jsonl",
        messageCount: 1,
        cwd: "/definitely/missing/workspace",
        modified: new Date("2025-01-03T00:00:00.000Z"),
      },
    ]);
    const service = await PiSessionService.create(createConfig());

    await expect(service.resolveSessionReference("bad12345")).resolves.toEqual({
      id: "bad12345",
      path: "/sessions/bad.jsonl",
      cwd: undefined,
      workspaceWarning:
        "Saved workspace /definitely/missing/workspace is unavailable in this TelePi runtime. Continuing in the current workspace instead.",
      matchType: "id",
    });
  });

  it("prefers a unique prefix match from the current workspace before searching globally", async () => {
    const currentWorkspace = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    const otherWorkspace = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    mockState.SessionManager.listAll.mockResolvedValueOnce([
      {
        id: "abc-local",
        firstMessage: "Local",
        path: "/sessions/local.jsonl",
        messageCount: 1,
        cwd: currentWorkspace,
        modified: new Date("2025-01-03T00:00:00.000Z"),
      },
      {
        id: "abc-global",
        firstMessage: "Global",
        path: "/sessions/global.jsonl",
        messageCount: 1,
        cwd: otherWorkspace,
        modified: new Date("2025-01-02T00:00:00.000Z"),
      },
    ]);
    const service = await PiSessionService.create(createConfig({ workspace: currentWorkspace }));

    await expect(service.resolveSessionReference("abc")).resolves.toEqual({
      id: "abc-local",
      path: "/sessions/local.jsonl",
      cwd: currentWorkspace,
      matchType: "prefix",
    });
  });

  it("rejects ambiguous or missing saved session references", async () => {
    mockState.SessionManager.listAll.mockResolvedValueOnce([
      {
        id: "abcd1111",
        firstMessage: "One",
        path: "/sessions/one.jsonl",
        messageCount: 1,
        cwd: "/workspace/one",
        modified: new Date("2025-01-03T00:00:00.000Z"),
      },
      {
        id: "abcd2222",
        firstMessage: "Two",
        path: "/sessions/two.jsonl",
        messageCount: 1,
        cwd: "/workspace/two",
        modified: new Date("2025-01-02T00:00:00.000Z"),
      },
    ]);
    const service = await PiSessionService.create(createConfig());

    await expect(service.resolveSessionReference("abcd")).rejects.toThrow(
      'Session ID prefix "abcd" matches 2 saved sessions.',
    );
    await expect(service.resolveSessionReference("missing")).rejects.toThrow(
      'No saved session matches "missing".',
    );
    await expect(service.resolveSessionReference("/sessions/missing.jsonl")).rejects.toThrow(
      "Saved session not found: /sessions/missing.jsonl",
    );
  });

  it("resolves a workspace for a saved session reference", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    const secondWorkspace = mkdtempSync(path.join(tmpdir(), "telepi-session-"));
    const sessionPath = path.join(tempDir, "s1.jsonl");
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "s1",
        timestamp: "2025-01-03T00:00:00.000Z",
        cwd: tempDir,
      })}\n`,
    );
    mockState.SessionManager.listAll.mockResolvedValue([
      {
        id: "s1",
        firstMessage: "Hello",
        path: sessionPath,
        messageCount: 5,
        cwd: tempDir,
        modified: new Date("2025-01-02T00:00:00.000Z"),
        name: "First",
      },
      {
        id: "s2",
        firstMessage: "World",
        path: "/sessions/s2.jsonl",
        messageCount: 3,
        cwd: secondWorkspace,
        modified: new Date("2025-01-01T00:00:00.000Z"),
        name: "Second",
      },
    ]);
    const service = await PiSessionService.create(createConfig());

    await expect(service.resolveWorkspaceForSession(sessionPath)).resolves.toBe(tempDir);
    await expect(service.resolveWorkspaceForSession("s2")).resolves.toBe(secondWorkspace);
  });

  it("returns undefined when resolving a workspace fails", async () => {
    mockState.SessionManager.listAll.mockRejectedValueOnce(new Error("boom"));
    const service = await PiSessionService.create(createConfig());

    await expect(service.resolveWorkspaceForSession("/sessions/missing.jsonl")).resolves.toBeUndefined();
  });

  it("returns undefined when an ID-based workspace lookup hits an unexpected index failure", async () => {
    mockState.SessionManager.listAll.mockRejectedValueOnce(new Error("boom"));
    const service = await PiSessionService.create(createConfig());

    await expect(service.resolveWorkspaceForSession("s1")).resolves.toBeUndefined();
  });

  it("lists models with the current one marked", async () => {
    const service = await PiSessionService.create(createConfig());

    await expect(service.listModels()).resolves.toEqual([
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet",
        current: true,
        thinkingLevel: undefined,
      },
      {
        provider: "openai",
        id: "gpt-4o",
        name: "GPT-4o",
        current: false,
        thinkingLevel: undefined,
      },
    ]);
  });

  it("lists only scoped models when the session has a model scope", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;

    currentSession.scopedModels = [{ model: mockState.models[1], thinkingLevel: "high" }];

    await expect(service.listModels()).resolves.toEqual([
      {
        provider: "openai",
        id: "gpt-4o",
        name: "GPT-4o",
        current: false,
        thinkingLevel: "high",
      },
    ]);
  });

  it("can list all models even when a scope is active", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;

    currentSession.scopedModels = [{ model: mockState.models[1], thinkingLevel: "high" }];

    await expect(service.listModels(true)).resolves.toEqual([
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet",
        current: true,
        thinkingLevel: undefined,
      },
      {
        provider: "openai",
        id: "gpt-4o",
        name: "GPT-4o",
        current: false,
        thinkingLevel: "high",
      },
    ]);
  });

  it("derives scoped models from pi settings when enabled models are configured", async () => {
    mockState.SettingsManager.create.mockReturnValueOnce({
      getEnabledModels: vi.fn().mockReturnValue(["openai/gpt-4o"]),
      getDefaultProvider: vi.fn().mockReturnValue(undefined),
      getDefaultModel: vi.fn().mockReturnValue(undefined),
      drainErrors: vi.fn().mockReturnValue([]),
    });

    await PiSessionService.create(createConfig());

    expect(mockState.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        scopedModels: [{ model: mockState.models[1] }],
      }),
    );
  });

  it("starts a new session on the preferred scoped default model", async () => {
    mockState.SettingsManager.create.mockReturnValueOnce({
      getEnabledModels: vi.fn().mockReturnValue(["anthropic/claude-sonnet-4-5", "openai/gpt-4o:high"]),
      getDefaultProvider: vi.fn().mockReturnValue("openai"),
      getDefaultModel: vi.fn().mockReturnValue("gpt-4o"),
      drainErrors: vi.fn().mockReturnValue([]),
    });

    await PiSessionService.create(createConfig());

    expect(mockState.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mockState.models[1],
        thinkingLevel: "high",
        scopedModels: [
          { model: mockState.models[0] },
          { model: mockState.models[1], thinkingLevel: "high" },
        ],
      }),
    );
  });

  it("falls back to the first scoped model when no scoped default is saved", async () => {
    mockState.SettingsManager.create.mockReturnValueOnce({
      getEnabledModels: vi.fn().mockReturnValue(["openai/gpt-4o:high"]),
      getDefaultProvider: vi.fn().mockReturnValue(undefined),
      getDefaultModel: vi.fn().mockReturnValue(undefined),
      drainErrors: vi.fn().mockReturnValue([]),
    });

    await PiSessionService.create(createConfig());

    expect(mockState.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mockState.models[1],
        thinkingLevel: "high",
      }),
    );
  });

  it("does not override the model when opening an existing session file", async () => {
    mockState.SettingsManager.create.mockReturnValueOnce({
      getEnabledModels: vi.fn().mockReturnValue(["openai/gpt-4o:high"]),
      getDefaultProvider: vi.fn().mockReturnValue(undefined),
      getDefaultModel: vi.fn().mockReturnValue(undefined),
      drainErrors: vi.fn().mockReturnValue([]),
    });

    await PiSessionService.create(createConfig({ piSessionPath: "/etc/hosts" }));

    expect(mockState.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: undefined,
        thinkingLevel: undefined,
        scopedModels: [{ model: mockState.models[1], thinkingLevel: "high" }],
      }),
    );
  });

  it("switches models via the underlying session", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;

    await expect(service.setModel("openai", "gpt-4o")).resolves.toBe("openai/gpt-4o");
    expect(currentSession.setModel).toHaveBeenCalledWith({
      provider: "openai",
      id: "gpt-4o",
      name: "GPT-4o",
    });
    expect(currentSession.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("applies a scoped thinking-level override when switching models", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;

    await expect(service.setModel("openai", "gpt-4o", "high")).resolves.toBe("openai/gpt-4o");
    expect(currentSession.setModel).toHaveBeenCalledWith({
      provider: "openai",
      id: "gpt-4o",
      name: "GPT-4o",
    });
    expect(currentSession.setThinkingLevel).toHaveBeenCalledWith("high");
  });

  it("forks via AgentSessionRuntime", async () => {
    const service = await PiSessionService.create(createConfig());
    const runtime = mockState.createdRuntimes[0]?.runtime;
    const withSession = vi.fn().mockResolvedValue(undefined);

    await expect(service.fork("known-id", { position: "before", withSession })).resolves.toEqual({ cancelled: false });
    expect(runtime.fork).toHaveBeenCalledWith("known-id", { position: "before", withSession });
  });

  it("clears the active handle when extension rebinding fails during same-runtime forks", async () => {
    const service = await PiSessionService.create(createConfig());
    const previousSession = mockState.createdSessions[0]?.session;
    const runtime = mockState.createdRuntimes[0]?.runtime;
    const bindings = { uiContext: { notify: vi.fn() } } as any;
    const originalCreateAgentSession = mockState.createAgentSession.getMockImplementation();

    await service.bindExtensions(bindings);

    mockState.createAgentSession.mockImplementationOnce(async (options: any) => {
      const result = await originalCreateAgentSession!(options);
      result.session.bindExtensions.mockRejectedValueOnce(new Error("extension rebinding exploded"));
      return result;
    });

    await expect(service.fork("known-id")).rejects.toThrow("extension rebinding exploded");

    const nextSession = mockState.createdSessions[1]?.session;
    expect(nextSession.bindExtensions).toHaveBeenCalledWith(bindings);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    expect(previousSession.dispose).toHaveBeenCalledTimes(1);
    expect(nextSession.dispose).toHaveBeenCalledTimes(1);
    expect(service.hasActiveSession()).toBe(false);
    expect(service.getInfo()).toEqual({
      sessionId: "(no active session)",
      sessionFile: undefined,
      workspace: "/workspace/base",
      sessionName: undefined,
      modelFallbackMessage: undefined,
      model: undefined,
    });
  });

  it("delegates tree access, navigation, and labels", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;

    currentSession.sessionManager.getTree.mockReturnValue([
      {
        entry: {
          type: "message",
          id: "labelled-id",
          parentId: null,
          timestamp: "2025-01-01T00:00:00Z",
          message: { role: "user", content: "Pinned point" },
        },
        children: [],
        label: "checkpoint",
      },
    ]);
    currentSession.sessionManager.getChildren.mockReturnValueOnce([
      {
        type: "message",
        id: "child-id",
        parentId: "known-id",
        timestamp: "2025-01-01T00:00:00Z",
        message: { role: "assistant", content: "Child" },
      },
    ]);

    expect(service.getTree()).toEqual([
      expect.objectContaining({
        entry: expect.objectContaining({ id: "labelled-id" }),
        label: "checkpoint",
      }),
    ]);
    expect(currentSession.sessionManager.getTree).toHaveBeenCalledTimes(1);

    expect(service.getLeafId()).toBe("leaf-id");
    expect(currentSession.sessionManager.getLeafId).toHaveBeenCalledTimes(1);

    expect(service.getEntry("known-id")).toEqual(
      expect.objectContaining({ type: "message", id: "known-id" }),
    );
    expect(service.getEntry("missing-id")).toBeUndefined();

    expect(service.getChildren("known-id")).toEqual([
      expect.objectContaining({ id: "child-id" }),
    ]);
    expect(currentSession.sessionManager.getChildren).toHaveBeenCalledWith("known-id");

    await expect(service.navigateTree("known-id", { summarize: true })).resolves.toEqual({
      cancelled: false,
    });
    expect(currentSession.navigateTree).toHaveBeenCalledWith("known-id", { summarize: true });

    await expect(service.fork("known-id")).resolves.toEqual({ cancelled: false });
    expect(mockState.createdRuntimes[0]?.runtime.fork).toHaveBeenCalledWith("known-id", undefined);

    const forkedSession = mockState.createdSessions[1]?.session;
    forkedSession.sessionManager.getTree.mockReturnValue(currentSession.sessionManager.getTree());

    await expect(service.reload()).resolves.toBeUndefined();
    expect(forkedSession.reload).toHaveBeenCalledTimes(1);

    service.setLabel("known-id", "saved");
    expect(forkedSession.sessionManager.appendLabelChange).toHaveBeenCalledWith("known-id", "saved");

    expect(service.getLabels()).toEqual([
      {
        id: "labelled-id",
        label: "checkpoint",
        description: 'user: "Pinned point"',
      },
    ]);
  });

  it("throws for tree helpers when no active session exists", async () => {
    const service = await PiSessionService.create(createConfig());
    await service.handback();

    expect(() => service.getTree()).toThrow("Pi session is not initialized");
    expect(() => service.getLeafId()).toThrow("Pi session is not initialized");
    expect(() => service.getEntry("known-id")).toThrow("Pi session is not initialized");
    expect(() => service.getChildren("known-id")).toThrow("Pi session is not initialized");
    expect(() => service.setLabel("known-id", "saved")).toThrow("Pi session is not initialized");
    expect(() => service.getLabels()).toThrow("Pi session is not initialized");
    await expect(service.navigateTree("known-id")).rejects.toThrow("Pi session is not initialized");
  });

  it("subscribes to session events and forwards callbacks", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;

    const onTextDelta = vi.fn();
    const onToolStart = vi.fn();
    const onToolUpdate = vi.fn();
    const onToolEnd = vi.fn();
    const onAgentEnd = vi.fn();

    const unsubscribe = service.subscribe({
      onTextDelta,
      onToolStart,
      onToolUpdate,
      onToolEnd,
      onAgentEnd,
    });

    const emit = mockState.getSubscriber(currentSession);
    emit?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } });
    emit?.({ type: "tool_execution_start", toolName: "bash", toolCallId: "tool-1" });
    emit?.({ type: "tool_execution_update", toolCallId: "tool-1", partialResult: { ok: true } });
    emit?.({ type: "tool_execution_end", toolCallId: "tool-1", isError: false });
    emit?.({ type: "agent_end" });
    unsubscribe();

    expect(onTextDelta).toHaveBeenCalledWith("Hello");
    expect(onToolStart).toHaveBeenCalledWith("bash", "tool-1");
    expect(onToolUpdate).toHaveBeenCalledWith("tool-1", '{\n  "ok": true\n}');
    expect(onToolEnd).toHaveBeenCalledWith("tool-1", false);
    expect(onAgentEnd).toHaveBeenCalledTimes(1);
  });

  it("passes image attachments through when prompting", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;
    const images = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] as any;

    await service.prompt("hello", images);

    expect(currentSession.prompt).toHaveBeenCalledWith("hello", { images });
  });

  it("wraps prompt errors with a helpful message", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;
    currentSession.prompt.mockRejectedValueOnce(new Error("boom"));

    await expect(service.prompt("hello")).rejects.toThrow("Pi session prompt failed: boom");
  });

  it("disposes the active session", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;

    service.dispose();

    expect(currentSession.dispose).toHaveBeenCalledTimes(1);
    expect(service.hasActiveSession()).toBe(false);
  });

  it("throws when setting an unknown model", async () => {
    const service = await PiSessionService.create(createConfig());

    await expect(service.setModel("unknown", "fake-model")).rejects.toThrow("Model not found: unknown/fake-model");
  });

  it("throws when getSession is called after dispose", async () => {
    const service = await PiSessionService.create(createConfig());
    service.dispose();

    expect(() => service.getSession()).toThrow("Pi session is not initialized");
  });

  it("re-creates handle when newSession is called without an active handle", async () => {
    const service = await PiSessionService.create(createConfig());
    await service.handback(); // clear handle
    expect(service.hasActiveSession()).toBe(false);

    const result = await service.newSession();

    expect(result.created).toBe(true);
    expect(service.hasActiveSession()).toBe(true);
    expect(mockState.createAgentSession).toHaveBeenCalledTimes(2);
  });

  it("builds stable context keys for chat/topic pairs", () => {
    expect(getPiSessionContextKey({ chatId: 123 })).toBe("123::root");
    expect(getPiSessionContextKey({ chatId: 123, messageThreadId: 77 })).toBe("123::77");
  });

  it("creates independent services per Telegram context", async () => {
    const registry = await PiSessionRegistry.create(createConfig({ piSessionPath: "/sessions/bootstrap.jsonl" }));

    const rootService = await registry.getOrCreate({ chatId: 1 });
    const topicService = await registry.getOrCreate({ chatId: 1, messageThreadId: 99 });
    const rootAgain = await registry.getOrCreate({ chatId: 1 });

    expect(rootAgain).toBe(rootService);
    expect(topicService).not.toBe(rootService);
    expect(mockState.createAgentSession).toHaveBeenCalledTimes(2);
    expect(mockState.SessionManager.open).toHaveBeenNthCalledWith(1, "/sessions/bootstrap.jsonl", undefined, "/workspace/base");
    expect(mockState.SessionManager.create).toHaveBeenNthCalledWith(1, "/workspace/base");
    expect(mockState.createAgentSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        services: expect.objectContaining({ cwd: "/workspace/base" }),
        sessionManager: expect.objectContaining({ sessionPath: "/sessions/bootstrap.jsonl" }),
      }),
    );
  });

  it("deduplicates concurrent getOrCreate calls for the same context", async () => {
    const registry = await PiSessionRegistry.create(createConfig());
    const originalImpl = mockState.createAgentSessionRuntime.getMockImplementation();
    let resolveCreate!: () => void;

    mockState.createAgentSessionRuntime.mockImplementationOnce(async (factory: any, options: any) => {
      await new Promise<void>((resolve) => {
        resolveCreate = resolve;
      });
      return originalImpl!(factory, options);
    });

    const first = registry.getOrCreate({ chatId: 7, messageThreadId: 1 });
    const second = registry.getOrCreate({ chatId: 7, messageThreadId: 1 });

    await Promise.resolve();
    expect(mockState.createAgentSessionRuntime).toHaveBeenCalledTimes(1);

    resolveCreate();
    const [firstService, secondService] = await Promise.all([first, second]);

    expect(firstService).toBe(secondService);
    expect(mockState.createAgentSessionRuntime).toHaveBeenCalledTimes(1);
  });

  it("returns fallback info for untouched contexts in the registry", async () => {
    const registry = await PiSessionRegistry.create(createConfig());

    expect(registry.getInfo({ chatId: 42 })).toEqual({
      sessionId: "(no active session)",
      sessionFile: undefined,
      workspace: "/workspace/base",
      sessionName: undefined,
      modelFallbackMessage: undefined,
      model: undefined,
    });
  });

  it("removes and disposes individual context services", async () => {
    const registry = await PiSessionRegistry.create(createConfig());
    const service = await registry.getOrCreate({ chatId: 9, messageThreadId: 3 });

    registry.remove({ chatId: 9, messageThreadId: 3 });

    expect(service.hasActiveSession()).toBe(false);
    expect(registry.get({ chatId: 9, messageThreadId: 3 })).toBeUndefined();
  });

  it("rejects inflight creations that are removed before they finish", async () => {
    const registry = await PiSessionRegistry.create(createConfig());
    const originalImpl = mockState.createAgentSessionRuntime.getMockImplementation();
    let resolveCreate!: () => void;

    mockState.createAgentSessionRuntime.mockImplementationOnce(async (factory: any, options: any) => {
      await new Promise<void>((resolve) => {
        resolveCreate = resolve;
      });
      return originalImpl!(factory, options);
    });

    const pending = registry.getOrCreate({ chatId: 11, messageThreadId: 4 });
    await Promise.resolve();
    registry.remove({ chatId: 11, messageThreadId: 4 });
    resolveCreate();

    await expect(pending).rejects.toThrow("Session removed during initialization");
    expect(registry.get({ chatId: 11, messageThreadId: 4 })).toBeUndefined();
  });
});

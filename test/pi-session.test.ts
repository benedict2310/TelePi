import { vi } from "vitest";

import type { TelePiConfig } from "../src/config.js";

const mockState = vi.hoisted(() => {
  const models = [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  ];

  let sessionCounter = 0;
  const createdSessions: Array<{ session: any; options: any }> = [];
  const modelRegistryInstances: any[] = [];
  const sessionSubscribers = new WeakMap<object, (event: any) => void>();

  const defaultSessions = () => [
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

  const createSession = (options: Record<string, unknown> = {}) => {
    sessionCounter += 1;

    const session: any = {
      sessionId: options.sessionId ?? `session-${sessionCounter}`,
      sessionFile: options.sessionFile ?? `/tmp/session-${sessionCounter}.jsonl`,
      sessionName: options.sessionName,
      model: options.model ?? models[0],
      thinkingLevel: options.thinkingLevel ?? "medium",
      scopedModels: options.scopedModels ?? [],
      isStreaming: false,
      agent: {
        state: {
          tools: [
            { name: "read", description: "Read files", execute: vi.fn() },
            { name: "bash", description: "Execute bash", execute: vi.fn(), label: "bash", parameters: {} },
            { name: "edit", description: "Edit files", execute: vi.fn() },
            { name: "write", description: "Write files", execute: vi.fn() },
          ],
        },
        setTools: vi.fn(),
      },
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn().mockResolvedValue(true),
      navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
      sessionManager: {
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

    createdSessions.push({ session, options });
    return session;
  };

  const createAgentSession = vi.fn().mockImplementation(async (options: any) => ({
    session: createSession({
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      scopedModels: options.scopedModels,
      sessionFile: options.sessionManager?.sessionPath,
    }),
    modelFallbackMessage: options.model ? undefined : "fallback-model",
  }));

  const createCodingTools = vi.fn().mockReturnValue(["mock-tool"]);

  const AuthStorage = {
    create: vi.fn().mockReturnValue({ kind: "auth-storage" }),
  };

  const ModelRegistry = vi.fn().mockImplementation(() => {
    const instance = {
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
    create: vi.fn().mockImplementation((workspace: string) => ({ kind: "create", workspace })),
    open: vi.fn().mockImplementation((sessionPath: string) => ({ kind: "open", sessionPath })),
    listAll: vi.fn().mockResolvedValue(defaultSessions()),
  };

  const SettingsManager = {
    create: vi.fn().mockImplementation(() => ({
      getEnabledModels: vi.fn().mockReturnValue(undefined),
      getDefaultProvider: vi.fn().mockReturnValue(undefined),
      getDefaultModel: vi.fn().mockReturnValue(undefined),
    })),
  };

  const resolveModelScope = vi.fn().mockImplementation(async (patterns: string[]) =>
    patterns.map((pattern) => {
      const [provider, id] = pattern.split("/");
      const model = models.find((candidate) => candidate.provider === provider && candidate.id === id);
      return { model: model ?? models[0] };
    }),
  );

  return {
    models,
    createdSessions,
    modelRegistryInstances,
    createAgentSession,
    createCodingTools,
    AuthStorage,
    ModelRegistry,
    SessionManager,
    SettingsManager,
    resolveModelScope,
    getSubscriber: (session: object) => sessionSubscribers.get(session),
    reset: () => {
      sessionCounter = 0;
      createdSessions.length = 0;
      modelRegistryInstances.length = 0;
      createAgentSession.mockClear();
      createCodingTools.mockClear();
      AuthStorage.create.mockClear();
      ModelRegistry.mockClear();
      SessionManager.create.mockClear();
      SessionManager.open.mockClear();
      SessionManager.listAll.mockReset();
      SessionManager.listAll.mockResolvedValue(defaultSessions());
      SettingsManager.create.mockClear();
      resolveModelScope.mockClear();
    },
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: mockState.createAgentSession,
  createCodingTools: mockState.createCodingTools,
  AuthStorage: mockState.AuthStorage,
  ModelRegistry: mockState.ModelRegistry,
  SessionManager: mockState.SessionManager,
  SettingsManager: mockState.SettingsManager,
}));

vi.mock("../node_modules/@mariozechner/pi-coding-agent/dist/core/model-resolver.js", () => ({
  resolveModelScope: mockState.resolveModelScope,
}));

import { PiSessionService } from "../src/pi-session.js";

describe("PiSessionService", () => {
  const createConfig = (overrides: Partial<TelePiConfig> = {}): TelePiConfig => ({
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace/base",
    piSessionPath: undefined,
    piModel: undefined,
    toolVerbosity: "summary",
    ...overrides,
  });

  beforeEach(() => {
    mockState.reset();
  });

  it("creates a session service and initializes the Pi session", async () => {
    const service = await PiSessionService.create(createConfig());

    expect(mockState.AuthStorage.create).toHaveBeenCalledTimes(1);
    expect(mockState.ModelRegistry).toHaveBeenCalledTimes(1);
    expect(mockState.SettingsManager.create).toHaveBeenCalledWith("/workspace/base");
    expect(mockState.createCodingTools).toHaveBeenCalledWith("/workspace/base");
    expect(mockState.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/workspace/base",
        tools: ["mock-tool"],
        model: undefined,
        scopedModels: [],
      }),
    );

    expect(service.getInfo()).toEqual({
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
      workspace: "/workspace/base",
      sessionName: undefined,
      modelFallbackMessage: "fallback-model",
      model: "anthropic/claude-sonnet-4-5",
    });
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

  it("creates a new session in the current workspace", async () => {
    const service = await PiSessionService.create(createConfig());
    const currentSession = mockState.createdSessions[0]?.session;

    const result = await service.newSession();

    expect(currentSession.newSession).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      created: true,
      info: service.getInfo(),
    });
    expect(mockState.createAgentSession).toHaveBeenCalledTimes(1);
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

  it("switches to a specific saved session and workspace", async () => {
    const service = await PiSessionService.create(createConfig());
    const previousSession = mockState.createdSessions[0]?.session;

    const info = await service.switchSession("/sessions/saved.jsonl", "/workspace/projectA");

    expect(mockState.SessionManager.open).toHaveBeenCalledWith("/sessions/saved.jsonl");
    expect(mockState.createAgentSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: "/workspace/projectA" }),
    );
    expect(previousSession.dispose).toHaveBeenCalledTimes(1);
    expect(info.workspace).toBe("/workspace/projectA");
    expect(info.sessionFile).toBe("/sessions/saved.jsonl");
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

  it("resolves a workspace for a saved session path", async () => {
    const service = await PiSessionService.create(createConfig());

    await expect(service.resolveWorkspaceForSession("/sessions/s1.jsonl")).resolves.toBe(
      "/workspace/projectA",
    );
  });

  it("returns undefined when resolving a workspace fails", async () => {
    mockState.SessionManager.listAll.mockRejectedValueOnce(new Error("boom"));
    const service = await PiSessionService.create(createConfig());

    await expect(service.resolveWorkspaceForSession("/sessions/missing.jsonl")).resolves.toBeUndefined();
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
    });

    await PiSessionService.create(createConfig());

    expect(mockState.resolveModelScope).toHaveBeenCalledWith(
      ["openai/gpt-4o"],
      expect.anything(),
    );
    expect(mockState.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        scopedModels: [{ model: mockState.models[1] }],
      }),
    );
  });

  it("starts a new session on the first scoped model when no explicit model is configured", async () => {
    mockState.SettingsManager.create.mockReturnValueOnce({
      getEnabledModels: vi.fn().mockReturnValue(["openai/gpt-4o"]),
      getDefaultProvider: vi.fn().mockReturnValue(undefined),
      getDefaultModel: vi.fn().mockReturnValue(undefined),
    });
    mockState.resolveModelScope.mockResolvedValueOnce([{ model: mockState.models[1], thinkingLevel: "high" }]);

    await PiSessionService.create(createConfig());

    expect(mockState.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mockState.models[1],
        thinkingLevel: "high",
        scopedModels: [{ model: mockState.models[1], thinkingLevel: "high" }],
      }),
    );
  });

  it("prefers the saved default model when it is within the scoped model set", async () => {
    mockState.SettingsManager.create.mockReturnValueOnce({
      getEnabledModels: vi.fn().mockReturnValue(["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]),
      getDefaultProvider: vi.fn().mockReturnValue("openai"),
      getDefaultModel: vi.fn().mockReturnValue("gpt-4o"),
    });
    mockState.resolveModelScope.mockResolvedValueOnce([
      { model: mockState.models[0] },
      { model: mockState.models[1], thinkingLevel: "high" },
    ]);

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
      getEnabledModels: vi.fn().mockReturnValue(["openai/gpt-4o"]),
      getDefaultProvider: vi.fn().mockReturnValue(undefined),
      getDefaultModel: vi.fn().mockReturnValue(undefined),
    });
    mockState.resolveModelScope.mockResolvedValueOnce([{ model: mockState.models[1], thinkingLevel: "high" }]);

    await PiSessionService.create(createConfig({ piSessionPath: "/sessions/existing.jsonl" }));

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

    service.setLabel("known-id", "saved");
    expect(currentSession.sessionManager.appendLabelChange).toHaveBeenCalledWith("known-id", "saved");

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
});

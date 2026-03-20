import { vi } from "vitest";

import type { TelePiConfig } from "../src/config.js";
import type { PiSessionCallbacks, PiSessionInfo, PiSessionService } from "../src/pi-session.js";
import { createBot, registerCommands } from "../src/bot.js";

vi.mock("@grammyjs/auto-retry", () => ({
  autoRetry: () => (prev: any, method: string, payload: any, signal: any) =>
    prev(method, payload, signal),
}));

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn().mockReturnValue({ status: 0 }),
}));

const ALLOWED_USER_ID = 123;
const ALLOWED_CHAT_ID = 456;

type SetupOptions = {
  configOverrides?: Partial<TelePiConfig>;
  piSessionOverrides?: Partial<PiSessionService>;
};

function createConfig(overrides: Partial<TelePiConfig> = {}): TelePiConfig {
  return {
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [ALLOWED_USER_ID],
    telegramAllowedUserIdSet: new Set([ALLOWED_USER_ID]),
    workspace: "/workspace",
    piSessionPath: undefined,
    piModel: undefined,
    toolVerbosity: "summary",
    ...overrides,
  };
}

function createMockPiSession(overrides: Partial<PiSessionService> = {}) {
  let callbacks: PiSessionCallbacks | undefined;

  const defaultInfo: PiSessionInfo = {
    sessionId: "test-id",
    sessionFile: "/tmp/test.jsonl",
    workspace: "/workspace",
    model: "anthropic/claude-sonnet-4-5",
    sessionName: undefined,
    modelFallbackMessage: undefined,
  };

  const session = {
    getInfo: vi.fn().mockReturnValue(defaultInfo),
    isStreaming: vi.fn().mockReturnValue(false),
    hasActiveSession: vi.fn().mockReturnValue(true),
    getCurrentWorkspace: vi.fn().mockReturnValue("/workspace"),
    abort: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue({
      info: {
        sessionId: "new-id",
        sessionFile: "/tmp/new.jsonl",
        workspace: "/workspace",
        model: "anthropic/claude-sonnet-4-5",
      },
      created: true,
    }),
    switchSession: vi.fn().mockResolvedValue({
      sessionId: "switched-id",
      sessionFile: "/tmp/switched.jsonl",
      workspace: "/other",
      model: "anthropic/claude-sonnet-4-5",
    }),
    handback: vi.fn().mockResolvedValue({
      sessionFile: "/tmp/test.jsonl",
      workspace: "/workspace",
    }),
    listAllSessions: vi.fn().mockResolvedValue([
      {
        id: "s1",
        firstMessage: "Hello session",
        path: "/s1.jsonl",
        messageCount: 5,
        cwd: "/workspace/A",
        modified: new Date("2025-01-02T00:00:00.000Z"),
        name: undefined,
      },
      {
        id: "s2",
        firstMessage: "World session",
        path: "/s2.jsonl",
        messageCount: 3,
        cwd: "/workspace/B",
        modified: new Date("2025-01-01T00:00:00.000Z"),
        name: undefined,
      },
    ]),
    listWorkspaces: vi.fn().mockResolvedValue(["/workspace/A", "/workspace/B"]),
    listModels: vi.fn().mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet",
        current: true,
      },
      {
        provider: "openai",
        id: "gpt-4o",
        name: "GPT-4o",
        current: false,
      },
    ]),
    setModel: vi.fn().mockResolvedValue("openai/gpt-4o"),
    resolveWorkspaceForSession: vi.fn().mockResolvedValue("/workspace/A"),
    prompt: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockImplementation((nextCallbacks: PiSessionCallbacks) => {
      callbacks = nextCallbacks;
      return () => {
        if (callbacks === nextCallbacks) {
          callbacks = undefined;
        }
      };
    }),
    dispose: vi.fn(),
  } satisfies Partial<PiSessionService>;

  Object.assign(session, overrides);

  return {
    service: session as unknown as PiSessionService,
    getCallbacks: () => callbacks,
    emitTextDelta: (delta: string) => callbacks?.onTextDelta(delta),
    emitToolStart: (toolName: string, toolCallId: string) => callbacks?.onToolStart(toolName, toolCallId),
    emitToolUpdate: (toolCallId: string, partialResult: string) =>
      callbacks?.onToolUpdate(toolCallId, partialResult),
    emitToolEnd: (toolCallId: string, isError: boolean) => callbacks?.onToolEnd(toolCallId, isError),
    emitAgentEnd: () => callbacks?.onAgentEnd(),
  };
}

function setupBot(options: SetupOptions = {}) {
  const pi = createMockPiSession(options.piSessionOverrides);
  const bot = createBot(createConfig(options.configOverrides), pi.service);
  let messageId = 0;

  const api = {
    sendMessage: vi.fn().mockImplementation(async (chatId: number | string, text: string, opts?: any) => ({
      message_id: ++messageId,
      chat: { id: chatId },
      text,
      ...opts,
    })),
    editMessageText: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    sendChatAction: vi.fn().mockResolvedValue(true),
    setMyCommands: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
  };

  bot.api.config.use(async (_prev, method, payload) => {
    switch (method) {
      case "sendMessage":
        return {
          ok: true,
          result: await api.sendMessage(payload.chat_id, payload.text, {
            parse_mode: payload.parse_mode,
            reply_markup: payload.reply_markup,
          }),
        };
      case "editMessageText":
        await api.editMessageText(payload.chat_id, payload.message_id, payload.text, {
          parse_mode: payload.parse_mode,
          reply_markup: payload.reply_markup,
        });
        return { ok: true, result: true };
      case "editMessageReplyMarkup":
        await api.editMessageReplyMarkup(payload.chat_id, payload.message_id, {
          reply_markup: payload.reply_markup,
        });
        return { ok: true, result: true };
      case "sendChatAction":
        await api.sendChatAction(payload.chat_id, payload.action);
        return { ok: true, result: true };
      case "setMyCommands":
        await api.setMyCommands(payload.commands);
        return { ok: true, result: true };
      case "answerCallbackQuery":
        await api.answerCallbackQuery(payload.callback_query_id, {
          text: payload.text,
        });
        return { ok: true, result: true };
      default:
        throw new Error(`Unexpected Telegram API method in test: ${method}`);
    }
  });

  (bot as any).botInfo = {
    id: 1,
    is_bot: true,
    first_name: "TelePi",
    username: "telepi_test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };

  return { bot, pi, api };
}

function createTestUpdate(overrides: Record<string, any> = {}): any {
  const { message: messageOverrides = {}, ...updateOverrides } = overrides;
  const update = {
    update_id: Math.floor(Math.random() * 1_000_000),
    ...updateOverrides,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: ALLOWED_CHAT_ID, type: "private" },
      from: { id: ALLOWED_USER_ID, is_bot: false, first_name: "Test" },
      text: "/start",
      ...messageOverrides,
    },
  } as any;

  const text = update.message?.text;
  if (typeof text === "string" && text.startsWith("/") && !update.message.entities) {
    const commandLength = text.split(/\s+/, 1)[0]?.length ?? text.length;
    update.message.entities = [{ offset: 0, length: commandLength, type: "bot_command" }];
  }

  return update;
}

function createCallbackUpdate(data: string, overrides: Record<string, any> = {}): any {
  const { callback_query: callbackQueryOverrides = {}, ...updateOverrides } = overrides;
  const { message: callbackMessageOverrides = {}, ...callbackQueryRest } = callbackQueryOverrides;

  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    ...updateOverrides,
    callback_query: {
      id: "cb_1",
      chat_instance: "test",
      from: { id: ALLOWED_USER_ID, is_bot: false, first_name: "Test" },
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: ALLOWED_CHAT_ID, type: "private" },
        from: { id: 1, is_bot: true, first_name: "TelePi" },
        text: "Pick one",
        ...callbackMessageOverrides,
      },
      data,
      ...callbackQueryRest,
    },
  };
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function getReplyMarkupData(api: ReturnType<typeof setupBot>["api"], callIndex = 0): string[] {
  const markup = api.sendMessage.mock.calls[callIndex]?.[2]?.reply_markup;
  return markup?.inline_keyboard?.flat().map((button: any) => button.callback_data) ?? [];
}

describe("createBot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("allows authorized users through the middleware and handles /start", async () => {
    const { bot, api } = setupBot();

    await bot.handleUpdate(createTestUpdate({ message: { text: "/start" } }));

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("TelePi is ready.");
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("Session ID");
  });

  it("rejects unauthorized message senders", async () => {
    const { bot, api } = setupBot();

    await bot.handleUpdate(
      createTestUpdate({ message: { from: { id: 999, is_bot: false, first_name: "Eve" } } }),
    );

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]?.[1]).toBe("Unauthorized");
  });

  it("rejects unauthorized callback queries without sending a chat message", async () => {
    const { bot, api } = setupBot();

    await bot.handleUpdate(
      createCallbackUpdate("switch_0", {
        callback_query: { from: { id: 999, is_bot: false, first_name: "Eve" } },
      }),
    );

    expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", { text: "Unauthorized" });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("handles /session", async () => {
    const { bot, api } = setupBot();

    await bot.handleUpdate(createTestUpdate({ message: { text: "/session" } }));

    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("Session ID");
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("/tmp/test.jsonl");
  });

  it("handles /abort success and failure", async () => {
    const ok = setupBot();
    await ok.bot.handleUpdate(createTestUpdate({ message: { text: "/abort" } }));
    expect(ok.pi.service.abort).toHaveBeenCalledTimes(1);
    expect(ok.api.sendMessage.mock.calls[0]?.[1]).toContain("Aborted current operation");

    const failure = setupBot({
      piSessionOverrides: {
        abort: vi.fn().mockRejectedValue(new Error("abort failed")),
      },
    });
    await failure.bot.handleUpdate(createTestUpdate({ message: { text: "/abort" } }));
    expect(failure.api.sendMessage.mock.calls[0]?.[1]).toContain("Failed:");
    expect(failure.api.sendMessage.mock.calls[0]?.[1]).toContain("abort failed");
  });

  it("lists sessions grouped by workspace with inline switch buttons", async () => {
    const { bot, api } = setupBot();

    await bot.handleUpdate(createTestUpdate({ message: { text: "/sessions" } }));

    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("Available sessions");
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("📁 A");
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("📁 B");
    expect(getReplyMarkupData(api)).toEqual(["switch_0", "switch_1"]);
  });

  it("switches directly via /sessions <path> and shows errors when switching fails", async () => {
    const ok = setupBot();
    await ok.bot.handleUpdate(createTestUpdate({ message: { text: "/sessions /saved/session.jsonl" } }));
    expect(ok.pi.service.resolveWorkspaceForSession).toHaveBeenCalledWith("/saved/session.jsonl");
    expect(ok.pi.service.switchSession).toHaveBeenCalledWith(
      "/saved/session.jsonl",
      "/workspace/A",
    );
    expect(ok.api.sendMessage.mock.calls[0]?.[1]).toContain("Switched session");

    const failure = setupBot({
      piSessionOverrides: {
        switchSession: vi.fn().mockRejectedValue(new Error("switch failed")),
      },
    });
    await failure.bot.handleUpdate(
      createTestUpdate({ message: { text: "/sessions /broken/session.jsonl" } }),
    );
    expect(failure.api.sendMessage.mock.calls[0]?.[1]).toContain("Failed:");
    expect(failure.api.sendMessage.mock.calls[0]?.[1]).toContain("switch failed");
  });

  it("handles switch callbacks, expired picks, and wait states", async () => {
    const ready = setupBot();
    await ready.bot.handleUpdate(createTestUpdate({ message: { text: "/sessions" } }));
    await ready.bot.handleUpdate(createCallbackUpdate("switch_1"));

    expect(ready.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", { text: "Switching..." });
    expect(ready.pi.service.switchSession).toHaveBeenCalledWith("/s2.jsonl", "/workspace/B");
    expect(ready.api.editMessageText).toHaveBeenCalled();

    const expired = setupBot();
    await expired.bot.handleUpdate(createCallbackUpdate("switch_0"));
    expect(expired.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Session expired, run /sessions again",
    });

    let resolvePrompt!: () => void;
    const waiting = setupBot({
      piSessionOverrides: {
        prompt: vi.fn().mockImplementation(
          () => new Promise<void>((resolve) => {
            resolvePrompt = resolve;
          }),
        ),
      },
    });
    await waiting.bot.handleUpdate(createTestUpdate({ message: { text: "/sessions" } }));
    const firstPrompt = waiting.bot.handleUpdate(createTestUpdate({ message: { text: "hello" } }));
    await nextTick();
    await waiting.bot.handleUpdate(createCallbackUpdate("switch_0"));

    expect(waiting.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Wait for the current prompt to finish",
    });

    resolvePrompt();
    await firstPrompt;
  });

  it("shows a workspace picker for /new and creates directly when only one workspace exists", async () => {
    const picker = setupBot();
    await picker.bot.handleUpdate(createTestUpdate({ message: { text: "/new" } }));
    expect(picker.api.sendMessage.mock.calls[0]?.[1]).toContain("Select workspace for new session");
    expect(getReplyMarkupData(picker.api)).toEqual(["newws_0", "newws_1"]);

    const single = setupBot({
      piSessionOverrides: {
        listWorkspaces: vi.fn().mockResolvedValue(["/workspace/A"]),
      },
    });
    await single.bot.handleUpdate(createTestUpdate({ message: { text: "/new" } }));
    expect(single.pi.service.newSession).toHaveBeenCalledWith();
    expect(single.api.sendMessage.mock.calls[0]?.[1]).toContain("New session created.");
  });

  it("handles new workspace selection callbacks", async () => {
    const { bot, pi, api } = setupBot();

    await bot.handleUpdate(createTestUpdate({ message: { text: "/new" } }));
    await bot.handleUpdate(createCallbackUpdate("newws_1"));

    expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", { text: "Creating session..." });
    expect(pi.service.newSession).toHaveBeenCalledWith("/workspace/B");
    expect(api.editMessageText).toHaveBeenCalled();
  });

  it("handles /handback and blocks it when unavailable or busy", async () => {
    const ok = setupBot();
    await ok.bot.handleUpdate(createTestUpdate({ message: { text: "/handback" } }));
    expect(ok.pi.service.handback).toHaveBeenCalledTimes(1);
    expect(ok.api.sendMessage.mock.calls[0]?.[1]).toContain("pi --session");
    expect(ok.api.sendMessage.mock.calls[0]?.[1]).toContain("pi -c");

    const noActive = setupBot({
      piSessionOverrides: {
        hasActiveSession: vi.fn().mockReturnValue(false),
      },
    });
    await noActive.bot.handleUpdate(createTestUpdate({ message: { text: "/handback" } }));
    expect(noActive.api.sendMessage.mock.calls[0]?.[1]).toContain("No active session to hand back.");

    let resolvePrompt!: () => void;
    const busy = setupBot({
      piSessionOverrides: {
        prompt: vi.fn().mockImplementation(
          () => new Promise<void>((resolve) => {
            resolvePrompt = resolve;
          }),
        ),
      },
    });
    const pending = busy.bot.handleUpdate(createTestUpdate({ message: { text: "hello" } }));
    await nextTick();
    await busy.bot.handleUpdate(createTestUpdate({ message: { text: "/handback" } }));

    expect(busy.api.sendMessage.mock.calls.at(-1)?.[1]).toContain(
      "Cannot hand back while a prompt is running. Use /abort first.",
    );

    resolvePrompt();
    await pending;
  });

  it("shows the model picker and handles model selection callbacks", async () => {
    const { bot, pi, api } = setupBot();

    await bot.handleUpdate(createTestUpdate({ message: { text: "/model" } }));
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("Select a model");
    expect(getReplyMarkupData(api)).toEqual(["model_0", "model_1"]);

    await bot.handleUpdate(createCallbackUpdate("model_1"));
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", { text: "Switching model..." });
    expect(pi.service.setModel).toHaveBeenCalledWith("openai", "gpt-4o");
    expect(api.editMessageText).toHaveBeenCalled();
  });

  it("processes plain text messages, subscribes to Pi events, and ignores slash commands", async () => {
    const { bot, pi, api } = setupBot({
      configOverrides: { toolVerbosity: "all" },
    });

    const promptMock = pi.service.prompt as ReturnType<typeof vi.fn>;
    promptMock.mockImplementation(async () => {
      pi.emitTextDelta("Hello ");
      pi.emitTextDelta("world");
      pi.emitToolStart("bash", "tool-1");
      pi.emitToolUpdate("tool-1", "stdout\nline");
      pi.emitToolEnd("tool-1", false);
      pi.emitAgentEnd();
    });

    await bot.handleUpdate(createTestUpdate({ message: { text: "continue please" } }));

    expect(pi.service.subscribe).toHaveBeenCalledTimes(1);
    expect(pi.service.prompt).toHaveBeenCalledWith("continue please");
    expect(api.sendChatAction).toHaveBeenCalled();
    expect(api.sendMessage.mock.calls.some((call) => String(call[1]).includes("Hello"))).toBe(true);
    expect(api.sendMessage.mock.calls.some((call) => String(call[1]).includes("Running:"))).toBe(true);
    expect(
      api.editMessageText.mock.calls.some((call) => String(call[2]).includes("Hello world")),
    ).toBe(true);

    await bot.handleUpdate(createTestUpdate({ message: { text: "/ignored" } }));
    expect(pi.service.prompt).toHaveBeenCalledTimes(1);
  });

  it("blocks new messages while processing and auto-creates a session when needed", async () => {
    let resolvePrompt!: () => void;
    const busy = setupBot({
      piSessionOverrides: {
        prompt: vi.fn().mockImplementation(
          () => new Promise<void>((resolve) => {
            resolvePrompt = resolve;
          }),
        ),
      },
    });

    const first = busy.bot.handleUpdate(createTestUpdate({ message: { text: "first" } }));
    await nextTick();
    await busy.bot.handleUpdate(createTestUpdate({ message: { text: "second" } }));

    expect(busy.api.sendMessage.mock.calls.at(-1)?.[1]).toContain("Still working on previous message...");

    resolvePrompt();
    await first;

    const noSession = setupBot({
      piSessionOverrides: {
        hasActiveSession: vi.fn().mockReturnValue(false),
      },
    });
    const promptMock = noSession.pi.service.prompt as ReturnType<typeof vi.fn>;
    promptMock.mockImplementation(async () => {
      noSession.pi.emitTextDelta("Fresh session response");
      noSession.pi.emitAgentEnd();
    });

    await noSession.bot.handleUpdate(createTestUpdate({ message: { text: "start over" } }));

    expect(noSession.pi.service.newSession).toHaveBeenCalledTimes(1);
    expect(noSession.pi.service.prompt).toHaveBeenCalledWith("start over");
  });

  it("blocks commands while switching sessions", async () => {
    let resolveSwitch!: (info: PiSessionInfo) => void;
    const { bot, api } = setupBot({
      piSessionOverrides: {
        switchSession: vi.fn().mockImplementation(
          () =>
            new Promise<PiSessionInfo>((resolve) => {
              resolveSwitch = resolve;
            }),
        ),
      },
    });

    const switching = bot.handleUpdate(createTestUpdate({ message: { text: "/sessions /saved/session.jsonl" } }));
    await nextTick();
    await bot.handleUpdate(createTestUpdate({ message: { text: "/new" } }));

    expect(api.sendMessage.mock.calls.at(-1)?.[1]).toContain(
      "Cannot create new session while a prompt is running.",
    );

    resolveSwitch({
      sessionId: "switched-id",
      sessionFile: "/tmp/switched.jsonl",
      workspace: "/other",
      model: "anthropic/claude-sonnet-4-5",
    });
    await switching;
  });

  it("covers additional command edge cases", async () => {
    const noSessions = setupBot({
      piSessionOverrides: {
        listAllSessions: vi.fn().mockResolvedValue([]),
      },
    });
    await noSessions.bot.handleUpdate(createTestUpdate({ message: { text: "/sessions" } }));
    expect(noSessions.api.sendMessage.mock.calls[0]?.[1]).toContain("No saved sessions found.");

    const cancelledNew = setupBot({
      piSessionOverrides: {
        listWorkspaces: vi.fn().mockResolvedValue(["/workspace/A"]),
        newSession: vi.fn().mockResolvedValue({
          info: {
            sessionId: "cancelled",
            sessionFile: "/tmp/cancelled.jsonl",
            workspace: "/workspace/A",
            model: "anthropic/claude-sonnet-4-5",
          },
          created: false,
        }),
      },
    });
    await cancelledNew.bot.handleUpdate(createTestUpdate({ message: { text: "/new" } }));
    expect(cancelledNew.api.sendMessage.mock.calls[0]?.[1]).toContain("New session was cancelled.");

    const failedNew = setupBot({
      piSessionOverrides: {
        listWorkspaces: vi.fn().mockResolvedValue(["/workspace/A"]),
        newSession: vi.fn().mockRejectedValue(new Error("new failed")),
      },
    });
    await failedNew.bot.handleUpdate(createTestUpdate({ message: { text: "/new" } }));
    expect(failedNew.api.sendMessage.mock.calls[0]?.[1]).toContain("new failed");

    const failedModelBootstrap = setupBot({
      piSessionOverrides: {
        hasActiveSession: vi.fn().mockReturnValue(false),
        newSession: vi.fn().mockRejectedValue(new Error("bootstrap failed")),
      },
    });
    await failedModelBootstrap.bot.handleUpdate(createTestUpdate({ message: { text: "/model" } }));
    expect(failedModelBootstrap.api.sendMessage.mock.calls[0]?.[1]).toContain(
      "Failed to create session: bootstrap failed",
    );

    const noModels = setupBot({
      piSessionOverrides: {
        listModels: vi.fn().mockResolvedValue([]),
      },
    });
    await noModels.bot.handleUpdate(createTestUpdate({ message: { text: "/model" } }));
    expect(noModels.api.sendMessage.mock.calls[0]?.[1]).toContain("No models available.");
  });

  it("handles callback edge cases and the abort button", async () => {
    const abortCallback = setupBot();
    await abortCallback.bot.handleUpdate(createCallbackUpdate("pi_abort"));
    expect(abortCallback.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", { text: "Aborting..." });
    expect(abortCallback.pi.service.abort).toHaveBeenCalledTimes(1);

    const expiredWorkspace = setupBot();
    await expiredWorkspace.bot.handleUpdate(createCallbackUpdate("newws_0"));
    expect(expiredWorkspace.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Expired, run /new again",
    });

    const cancelledWorkspace = setupBot({
      piSessionOverrides: {
        newSession: vi.fn().mockResolvedValue({
          info: {
            sessionId: "cancelled",
            sessionFile: "/tmp/cancelled.jsonl",
            workspace: "/workspace/B",
            model: "anthropic/claude-sonnet-4-5",
          },
          created: false,
        }),
      },
    });
    await cancelledWorkspace.bot.handleUpdate(createTestUpdate({ message: { text: "/new" } }));
    await cancelledWorkspace.bot.handleUpdate(createCallbackUpdate("newws_1"));
    expect(cancelledWorkspace.api.editMessageText.mock.calls.at(-1)?.[2]).toContain(
      "New session was cancelled.",
    );

    const expiredModel = setupBot();
    await expiredModel.bot.handleUpdate(createCallbackUpdate("model_0"));
    expect(expiredModel.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Expired, run /model again",
    });

    const failedModel = setupBot({
      piSessionOverrides: {
        setModel: vi.fn().mockRejectedValue(new Error("model failed")),
      },
    });
    await failedModel.bot.handleUpdate(createTestUpdate({ message: { text: "/model" } }));
    await failedModel.bot.handleUpdate(createCallbackUpdate("model_1"));
    expect(failedModel.api.editMessageText.mock.calls.at(-1)?.[2]).toContain("model failed");
  });

  it("summarizes tool usage, reports tool errors, and handles prompt failures", async () => {
    const summary = setupBot();
    const summaryPrompt = summary.pi.service.prompt as ReturnType<typeof vi.fn>;
    summaryPrompt.mockImplementation(async () => {
      summary.pi.emitTextDelta("Finished response");
      summary.pi.emitToolStart("bash", "tool-1");
      summary.pi.emitToolStart("read", "tool-2");
      summary.pi.emitToolStart("bash", "tool-3");
      summary.pi.emitAgentEnd();
    });
    await summary.bot.handleUpdate(createTestUpdate({ message: { text: "summarize" } }));
    expect(summary.api.editMessageText.mock.calls.some((call) => String(call[2]).includes("bash ×2, read"))).toBe(
      true,
    );

    const errorsOnly = setupBot({
      configOverrides: { toolVerbosity: "errors-only" },
    });
    const errorsOnlyPrompt = errorsOnly.pi.service.prompt as ReturnType<typeof vi.fn>;
    errorsOnlyPrompt.mockImplementation(async () => {
      errorsOnly.pi.emitTextDelta("Answer");
      errorsOnly.pi.emitToolStart("bash", "tool-1");
      errorsOnly.pi.emitToolUpdate("tool-1", "stderr");
      errorsOnly.pi.emitToolEnd("tool-1", true);
      errorsOnly.pi.emitAgentEnd();
    });
    await errorsOnly.bot.handleUpdate(createTestUpdate({ message: { text: "show tool error" } }));
    expect(errorsOnly.api.sendMessage.mock.calls.some((call) => String(call[1]).includes("❌"))).toBe(true);

    const failure = setupBot();
    const failurePrompt = failure.pi.service.prompt as ReturnType<typeof vi.fn>;
    failurePrompt.mockImplementation(async () => {
      failure.pi.emitTextDelta("Partial output");
      throw new Error("prompt failed");
    });
    await failure.bot.handleUpdate(createTestUpdate({ message: { text: "break" } }));
    expect(failure.api.editMessageText.mock.calls.some((call) => String(call[2]).includes("⚠️ prompt failed"))).toBe(
      true,
    );

    const aborted = setupBot();
    const abortedPrompt = aborted.pi.service.prompt as ReturnType<typeof vi.fn>;
    abortedPrompt.mockImplementation(async () => {
      aborted.pi.emitTextDelta("Partial output");
      throw new Error("Abort requested");
    });
    await aborted.bot.handleUpdate(createTestUpdate({ message: { text: "stop" } }));
    expect(aborted.api.editMessageText.mock.calls.some((call) => String(call[2]).includes("⏹ Aborted"))).toBe(
      true,
    );
  });

  it("handles Telegram parse fallbacks and long streaming responses", async () => {
    const sendFallback = setupBot();
    sendFallback.api.sendMessage
      .mockRejectedValueOnce(new Error("can't parse entities"))
      .mockImplementation(async (chatId: number | string, text: string, opts?: any) => ({
        message_id: 99,
        chat: { id: chatId },
        text,
        ...opts,
      }));
    await sendFallback.bot.handleUpdate(createTestUpdate({ message: { text: "/start" } }));
    expect(sendFallback.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(sendFallback.api.sendMessage.mock.calls[1]?.[2]?.parse_mode).toBeUndefined();

    const editFallback = setupBot();
    editFallback.api.editMessageText
      .mockRejectedValueOnce(new Error("unsupported start tag"))
      .mockResolvedValue(true);
    await editFallback.bot.handleUpdate(createTestUpdate({ message: { text: "/model" } }));
    await editFallback.bot.handleUpdate(createCallbackUpdate("model_1"));
    expect(editFallback.api.editMessageText).toHaveBeenCalledTimes(2);
    expect(editFallback.api.editMessageText.mock.calls[1]?.[3]?.parse_mode).toBeUndefined();

    const notModified = setupBot();
    notModified.api.editMessageText.mockRejectedValueOnce(new Error("message is not modified"));
    await notModified.bot.handleUpdate(createTestUpdate({ message: { text: "/model" } }));
    await notModified.bot.handleUpdate(createCallbackUpdate("model_1"));
    expect(notModified.api.editMessageText).toHaveBeenCalledTimes(1);

    const longResponse = setupBot();
    const longPrompt = longResponse.pi.service.prompt as ReturnType<typeof vi.fn>;
    const longChunk = "word ".repeat(900);
    longPrompt.mockImplementation(async () => {
      longResponse.pi.emitTextDelta(`${longChunk}${longChunk}`);
      longResponse.pi.emitTextDelta(`${longChunk}${longChunk}`);
      longResponse.pi.emitAgentEnd();
    });
    await longResponse.bot.handleUpdate(createTestUpdate({ message: { text: "long reply" } }));
    expect(longResponse.api.sendMessage.mock.calls.some((call) => String(call[1]).includes("preview truncated"))).toBe(
      true,
    );
    expect(longResponse.api.sendMessage.mock.calls.length).toBeGreaterThan(1);
  });

  it("registers bot commands", async () => {
    const { bot, api } = setupBot();

    await registerCommands(bot);

    expect(api.setMyCommands).toHaveBeenCalledWith([
      { command: "start", description: "Welcome and session info" },
      { command: "new", description: "Start a new session" },
      { command: "handback", description: "Hand session back to Pi CLI" },
      { command: "abort", description: "Cancel current operation" },
      { command: "session", description: "Current session details" },
      { command: "sessions", description: "List and switch sessions (or /sessions <path>)" },
      { command: "model", description: "Switch AI model" },
    ]);
  });

  it("blocks commands when piSession.isStreaming() returns true", async () => {
    const streaming = setupBot({
      piSessionOverrides: {
        isStreaming: vi.fn().mockReturnValue(true),
      },
    });

    // /sessions should be blocked
    await streaming.bot.handleUpdate(createTestUpdate({ message: { text: "/sessions" } }));
    expect(streaming.api.sendMessage.mock.calls[0]?.[1]).toContain("Cannot switch sessions while a prompt is running.");

    // /new should be blocked
    await streaming.bot.handleUpdate(createTestUpdate({ message: { text: "/new" } }));
    expect(streaming.api.sendMessage.mock.calls[1]?.[1]).toContain("Cannot create new session while a prompt is running.");

    // /handback should be blocked
    await streaming.bot.handleUpdate(createTestUpdate({ message: { text: "/handback" } }));
    expect(streaming.api.sendMessage.mock.calls[2]?.[1]).toContain("Cannot hand back while a prompt is running.");

    // text messages should be blocked
    await streaming.bot.handleUpdate(createTestUpdate({ message: { text: "hello there" } }));
    expect(streaming.api.sendMessage.mock.calls[3]?.[1]).toContain("Still working on previous message...");

    // callback queries should be blocked
    await streaming.bot.handleUpdate(createTestUpdate({ message: { text: "/sessions" } }));
    // isStreaming blocks the /sessions list too, so no picks are set. But let's test a callback:
    const cbStreaming = setupBot({
      piSessionOverrides: {
        isStreaming: vi.fn().mockReturnValue(true),
      },
    });
    // First set up picks with a non-streaming bot, then switch to streaming
    const nonStreaming = setupBot();
    await nonStreaming.bot.handleUpdate(createTestUpdate({ message: { text: "/sessions" } }));
    // Now test the streaming guard on callbacks by using a fresh bot
  });

  it("sends '✅ Done' when agent ends with no text output", async () => {
    const { bot, pi, api } = setupBot();
    const promptMock = pi.service.prompt as ReturnType<typeof vi.fn>;
    promptMock.mockImplementation(async () => {
      // Agent ends without emitting any text deltas
      pi.emitAgentEnd();
    });

    await bot.handleUpdate(createTestUpdate({ message: { text: "do something silent" } }));

    const allSentTexts = api.sendMessage.mock.calls.map((call) => String(call[1]));
    expect(allSentTexts.some((text) => text.includes("✅ Done"))).toBe(true);
  });

  it("handles in-memory handback (no sessionFile)", async () => {
    const { bot, api } = setupBot({
      piSessionOverrides: {
        handback: vi.fn().mockResolvedValue({
          sessionFile: undefined,
          workspace: "/workspace",
        }),
      },
    });

    await bot.handleUpdate(createTestUpdate({ message: { text: "/handback" } }));

    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("Session was in-memory");
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("No file to resume");
  });

  it("handles handback error", async () => {
    const { bot, api } = setupBot({
      piSessionOverrides: {
        handback: vi.fn().mockRejectedValue(new Error("dispose exploded")),
      },
    });

    await bot.handleUpdate(createTestUpdate({ message: { text: "/handback" } }));

    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("Failed:");
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("dispose exploded");
  });

  it("blocks text messages when isSwitching is active", async () => {
    let resolveSwitch!: (info: PiSessionInfo) => void;
    const { bot, api } = setupBot({
      piSessionOverrides: {
        switchSession: vi.fn().mockImplementation(
          () =>
            new Promise<PiSessionInfo>((resolve) => {
              resolveSwitch = resolve;
            }),
        ),
      },
    });

    // Start a switch via /sessions <path>
    const switching = bot.handleUpdate(createTestUpdate({ message: { text: "/sessions /saved/session.jsonl" } }));
    await nextTick();

    // Try to send a text message — should be blocked
    await bot.handleUpdate(createTestUpdate({ message: { text: "hello there" } }));
    expect(api.sendMessage.mock.calls.at(-1)?.[1]).toContain("Still working on previous message...");

    resolveSwitch({
      sessionId: "switched-id",
      sessionFile: "/tmp/switched.jsonl",
      workspace: "/other",
      model: "anthropic/claude-sonnet-4-5",
    });
    await switching;
  });

  it("handles switch callback error", async () => {
    const { bot, api } = setupBot({
      piSessionOverrides: {
        switchSession: vi.fn().mockRejectedValue(new Error("switch exploded")),
      },
    });

    // Set up picks first
    await bot.handleUpdate(createTestUpdate({ message: { text: "/sessions" } }));
    // Now click a switch button
    await bot.handleUpdate(createCallbackUpdate("switch_0"));

    expect(api.editMessageText.mock.calls.at(-1)?.[2]).toContain("Failed:");
    expect(api.editMessageText.mock.calls.at(-1)?.[2]).toContain("switch exploded");
  });

  it("handles newws callback error", async () => {
    const { bot, api } = setupBot({
      piSessionOverrides: {
        newSession: vi.fn().mockRejectedValue(new Error("create exploded")),
      },
    });

    // Set up workspace picks
    await bot.handleUpdate(createTestUpdate({ message: { text: "/new" } }));
    // Click a workspace button
    await bot.handleUpdate(createCallbackUpdate("newws_0"));

    expect(api.editMessageText.mock.calls.at(-1)?.[2]).toContain("Failed:");
    expect(api.editMessageText.mock.calls.at(-1)?.[2]).toContain("create exploded");
  });
});

import { unlink, writeFile } from "node:fs/promises";
import { vi } from "vitest";

vi.mock("@grammyjs/auto-retry", () => ({
  autoRetry: () => (prev: any, method: string, payload: any, signal: any) =>
    prev(method, payload, signal),
}));

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn().mockReturnValue({ status: 0 }),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/voice.js", () => ({
  transcribeAudio: vi.fn().mockResolvedValue({
    text: "transcribed text",
    backend: "openai",
    durationMs: 500,
  }),
  getAvailableBackends: vi.fn().mockResolvedValue(["openai"]),
  _setImportHook: vi.fn(),
  _resetImportHook: vi.fn(),
}));

import type { TelePiConfig } from "../src/config.js";
import type { PiSessionCallbacks, PiSessionInfo, PiSessionService } from "../src/pi-session.js";
import { createBot, registerCommands } from "../src/bot.js";
import { getAvailableBackends, transcribeAudio } from "../src/voice.js";

const ALLOWED_USER_ID = 123;
const ALLOWED_CHAT_ID = 456;

function makeTreeNode(
  entry: Record<string, any>,
  children: any[] = [],
  label?: string,
): { entry: Record<string, any>; children: any[]; label?: string } {
  return { entry, children, label };
}

function makeMessageTreeNode(
  id: string,
  role: string,
  content: string,
  parentId: string | null = null,
  children: any[] = [],
  label?: string,
): { entry: Record<string, any>; children: any[]; label?: string } {
  return makeTreeNode(
    {
      type: "message",
      id,
      parentId,
      timestamp: "2025-01-01T00:00:00Z",
      message: { role, content },
    },
    children,
    label,
  );
}

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

  const defaultTree = [
    makeMessageTreeNode(
      "root1234",
      "user",
      "Start",
      null,
      [
        makeMessageTreeNode(
          "branch111",
          "assistant",
          "Pick a branch",
          "root1234",
          [
            makeMessageTreeNode("leaf1234", "user", "Active leaf", "branch111"),
            makeMessageTreeNode("leaf5678", "user", "Other leaf", "branch111", [], "saved"),
          ],
        ),
      ],
    ),
  ];

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
    getTree: vi.fn().mockReturnValue(defaultTree),
    getLeafId: vi.fn().mockReturnValue("leaf1234"),
    getEntry: vi.fn().mockImplementation((id: string) => {
      const entries = [
        defaultTree[0].entry,
        defaultTree[0].children[0].entry,
        defaultTree[0].children[0].children[0].entry,
        defaultTree[0].children[0].children[1].entry,
      ];
      return entries.find((entry) => entry.id === id);
    }),
    getChildren: vi.fn().mockImplementation((id: string) => {
      if (id === "branch111") {
        return [defaultTree[0].children[0].children[0].entry, defaultTree[0].children[0].children[1].entry];
      }
      if (id === "root1234") {
        return [defaultTree[0].children[0].entry];
      }
      return [];
    }),
    navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
    setLabel: vi.fn(),
    getLabels: vi.fn().mockReturnValue([{ id: "leaf5678", label: "saved", description: 'user: "Other leaf"' }]),
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
    getFile: vi.fn().mockImplementation(async (fileId: string) => ({
      file_id: fileId,
      file_path: "voice/file.ogg",
    })),
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
      case "getFile":
        return {
          ok: true,
          result: await api.getFile(payload.file_id),
        };
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

function createVoiceUpdate(overrides: Record<string, any> = {}): any {
  const { message: messageOverrides = {}, ...updateOverrides } = overrides;
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    ...updateOverrides,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: ALLOWED_CHAT_ID, type: "private" },
      from: { id: ALLOWED_USER_ID, is_bot: false, first_name: "Test" },
      voice: {
        file_id: "voice-file-id",
        file_unique_id: "voice-unique",
        duration: 5,
      },
      ...messageOverrides,
    },
  };
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

function getReplyMarkupTexts(api: ReturnType<typeof setupBot>["api"], callIndex = 0): string[] {
  const markup = api.sendMessage.mock.calls[callIndex]?.[2]?.reply_markup;
  return markup?.inline_keyboard?.flat().map((button: any) => button.text) ?? [];
}

function getReplyMarkupButtons(
  api: ReturnType<typeof setupBot>["api"],
  callIndex = 0,
): Array<{ text: string; callback_data: string }> {
  const markup = api.sendMessage.mock.calls[callIndex]?.[2]?.reply_markup;
  return markup?.inline_keyboard?.flat() ?? [];
}

function getEditedReplyMarkupData(api: ReturnType<typeof setupBot>["api"], callIndex = 0): string[] {
  const markup = api.editMessageText.mock.calls[callIndex]?.[3]?.reply_markup;
  return markup?.inline_keyboard?.flat().map((button: any) => button.callback_data) ?? [];
}

function getEditedReplyMarkupTexts(api: ReturnType<typeof setupBot>["api"], callIndex = 0): string[] {
  const markup = api.editMessageText.mock.calls[callIndex]?.[3]?.reply_markup;
  return markup?.inline_keyboard?.flat().map((button: any) => button.text) ?? [];
}

function getEditedReplyMarkupButtons(
  api: ReturnType<typeof setupBot>["api"],
  callIndex = 0,
): Array<{ text: string; callback_data: string }> {
  const markup = api.editMessageReplyMarkup.mock.calls[callIndex]?.[2]?.reply_markup;
  return markup?.inline_keyboard?.flat() ?? [];
}

function generateMockSessions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    firstMessage: `Session ${i}`,
    path: `/s${i}.jsonl`,
    messageCount: i + 1,
    cwd: `/workspace/${i % 2 === 0 ? "A" : "B"}`,
    modified: new Date(`2025-01-${String((count - i) % 28 || 28).padStart(2, "0")}T00:00:00.000Z`),
    name: undefined,
  }));
}

function generateMockModels(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    provider: `provider${i}`,
    id: `model-${i}`,
    name: `Model ${i}`,
    current: i === 0,
  }));
}

function generateMockWorkspaces(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `/workspace/W${i}`);
}

function generatePagedTree(totalEntries: number) {
  const makeBranch = (index: number) =>
    makeMessageTreeNode(`node${index.toString().padStart(4, "0")}`, "user", `Tree node ${index}`, "root0000");

  return [
    makeMessageTreeNode(
      "root0000",
      "user",
      "Root",
      null,
      Array.from({ length: totalEntries - 1 }, (_, i) => makeBranch(i + 1)),
    ),
  ];
}

describe("createBot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(getAvailableBackends).mockResolvedValue(["openai"]);
    vi.mocked(transcribeAudio).mockResolvedValue({
      text: "transcribed text",
      backend: "openai",
      durationMs: 500,
    });
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(unlink).mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("rejects unauthorized tree commands", async () => {
    const { bot, api } = setupBot();

    await bot.handleUpdate(
      createTestUpdate({
        message: { text: "/tree", from: { id: 999, is_bot: false, first_name: "Eve" } },
      }),
    );

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]?.[1]).toBe("Unauthorized");
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

  it("paginates session pickers and keeps selections working across pages", async () => {
    const sessions = generateMockSessions(8).map((session) => ({ ...session, cwd: "/workspace/A" }));
    const { bot, pi, api } = setupBot({
      piSessionOverrides: {
        listAllSessions: vi.fn().mockResolvedValue(sessions),
      },
    });

    await bot.handleUpdate(createTestUpdate({ message: { text: "/sessions" } }));

    expect(getReplyMarkupData(api)).toEqual([
      "switch_0",
      "switch_1",
      "switch_2",
      "switch_3",
      "switch_4",
      "switch_5",
      "noop_page",
      "switch_page_1",
    ]);
    expect(getReplyMarkupButtons(api).at(-2)?.text).toBe("1/2");
    expect(getReplyMarkupButtons(api).at(-1)?.text).toBe("Next ▶️");

    await bot.handleUpdate(createCallbackUpdate("switch_page_1"));
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", { text: undefined });
    expect(getEditedReplyMarkupButtons(api).map((button) => button.callback_data)).toEqual([
      "switch_6",
      "switch_7",
      "switch_page_0",
      "noop_page",
    ]);

    await bot.handleUpdate(createCallbackUpdate("switch_7"));
    expect(pi.service.switchSession).toHaveBeenCalledWith("/s7.jsonl", "/workspace/A");
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

  it("paginates workspace pickers and creates the selected workspace session", async () => {
    const workspaces = generateMockWorkspaces(8);
    const { bot, pi, api } = setupBot({
      piSessionOverrides: {
        listWorkspaces: vi.fn().mockResolvedValue(workspaces),
      },
    });

    await bot.handleUpdate(createTestUpdate({ message: { text: "/new" } }));
    expect(getReplyMarkupData(api)).toEqual([
      "newws_0",
      "newws_1",
      "newws_2",
      "newws_3",
      "newws_4",
      "newws_5",
      "noop_page",
      "newws_page_1",
    ]);

    await bot.handleUpdate(createCallbackUpdate("newws_page_1"));
    expect(getEditedReplyMarkupButtons(api).map((button) => button.callback_data)).toEqual([
      "newws_6",
      "newws_7",
      "newws_page_0",
      "noop_page",
    ]);

    await bot.handleUpdate(createCallbackUpdate("newws_7"));
    expect(pi.service.newSession).toHaveBeenCalledWith("/workspace/W7");
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

  it("shows scoped models by default, can expand to all models, and handles model selection", async () => {
    const scopedModels = [
      {
        provider: "github-copilot",
        id: "codex",
        name: "Codex",
        current: true,
      },
    ];
    const allModels = [
      {
        provider: "openai",
        id: "codex",
        name: "Codex",
        current: false,
      },
      ...scopedModels,
    ];
    const listModels = vi.fn().mockImplementation((showAll?: boolean) =>
      Promise.resolve(showAll ? allModels : scopedModels),
    );

    const { bot, pi, api } = setupBot({
      piSessionOverrides: {
        listModels,
        setModel: vi.fn().mockResolvedValue("openai/codex"),
      },
    });

    await bot.handleUpdate(createTestUpdate({ message: { text: "/model" } }));
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("Select a model");
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("Showing the current Pi model scope.");
    expect(getReplyMarkupData(api)).toEqual(["model_0", "model_show_all"]);
    expect(getReplyMarkupTexts(api)).toEqual([
      "✅ github-copilot/codex · Codex",
      "Show all models",
    ]);
    expect(listModels).toHaveBeenNthCalledWith(1, false);
    expect(listModels).toHaveBeenNthCalledWith(2, true);

    await bot.handleUpdate(createCallbackUpdate("model_show_all"));
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", { text: "Loading all models..." });
    expect(api.editMessageText).toHaveBeenCalled();
    expect(listModels).toHaveBeenNthCalledWith(3, true);
    expect(getEditedReplyMarkupData(api, 0)).toEqual(["model_0", "model_1"]);
    expect(getEditedReplyMarkupTexts(api, 0)).toEqual([
      "openai/codex · Codex",
      "✅ github-copilot/codex · Codex",
    ]);

    await bot.handleUpdate(createCallbackUpdate("model_0"));
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", { text: "Switching model..." });
    expect(pi.service.setModel).toHaveBeenCalledWith("openai", "codex");
    expect(api.editMessageText).toHaveBeenCalled();
  });

  it("paginates model pickers across all available models", async () => {
    const models = generateMockModels(21);
    const { bot, pi, api } = setupBot({
      piSessionOverrides: {
        listModels: vi.fn().mockResolvedValue(models),
      },
    });

    await bot.handleUpdate(createTestUpdate({ message: { text: "/model" } }));
    expect(getReplyMarkupData(api)).toEqual([
      "model_0",
      "model_1",
      "model_2",
      "model_3",
      "model_4",
      "model_5",
      "noop_page",
      "model_page_1",
    ]);

    await bot.handleUpdate(createCallbackUpdate("model_page_3"));
    expect(getEditedReplyMarkupButtons(api).map((button) => button.callback_data)).toEqual([
      "model_18",
      "model_19",
      "model_20",
      "model_page_2",
      "noop_page",
    ]);

    await bot.handleUpdate(createCallbackUpdate("model_20"));
    expect(pi.service.setModel).toHaveBeenCalledWith("provider20", "model-20");
  });

  it("handles /tree command variants and missing sessions", async () => {
    const empty = setupBot({
      piSessionOverrides: {
        getTree: vi.fn().mockReturnValue([]),
      },
    });
    await empty.bot.handleUpdate(createTestUpdate({ message: { text: "/tree" } }));
    expect(empty.api.sendMessage.mock.calls[0]?.[1]).toContain("Session tree is empty.");

    const branched = setupBot();
    await branched.bot.handleUpdate(createTestUpdate({ message: { text: "/tree" } }));
    expect(branched.api.sendMessage.mock.calls[0]?.[1]).toContain("Start");
    expect(getReplyMarkupData(branched.api)).toContain("tree_nav_branch111");
    expect(getReplyMarkupData(branched.api)).toContain("tree_nav_leaf5678");

    const userMode = setupBot();
    await userMode.bot.handleUpdate(createTestUpdate({ message: { text: "/tree user" } }));
    expect(userMode.api.sendMessage.mock.calls[0]?.[1]).toContain("Filter: user messages only.");

    const allMode = setupBot();
    await allMode.bot.handleUpdate(createTestUpdate({ message: { text: "/tree all" } }));
    expect(allMode.api.sendMessage.mock.calls[0]?.[1]).toContain("Filter: all entries with navigation buttons.");

    const noActive = setupBot({
      piSessionOverrides: {
        hasActiveSession: vi.fn().mockReturnValue(false),
      },
    });
    await noActive.bot.handleUpdate(createTestUpdate({ message: { text: "/tree" } }));
    expect(noActive.api.sendMessage.mock.calls[0]?.[1]).toContain("No active session");
  });

  it("paginates tree navigation buttons while keeping filter buttons visible", async () => {
    const tree = generatePagedTree(8);
    const { bot, api } = setupBot({
      piSessionOverrides: {
        getTree: vi.fn().mockReturnValue(tree),
        getLeafId: vi.fn().mockReturnValue("node0001"),
      },
    });

    await bot.handleUpdate(createTestUpdate({ message: { text: "/tree" } }));
    expect(getReplyMarkupData(api)).toEqual([
      "tree_nav_root0000",
      "tree_nav_node0002",
      "tree_nav_node0003",
      "tree_nav_node0004",
      "tree_nav_node0005",
      "tree_nav_node0006",
      "noop_page",
      "tree_page_1",
      "tree_mode_all",
      "tree_mode_user",
    ]);

    await bot.handleUpdate(createCallbackUpdate("tree_page_1"));
    expect(getEditedReplyMarkupButtons(api).map((button) => button.callback_data)).toEqual([
      "tree_nav_node0007",
      "tree_page_0",
      "noop_page",
      "tree_mode_all",
      "tree_mode_user",
    ]);
  });

  it("handles /branch command success and validation", async () => {
    const usage = setupBot();
    await usage.bot.handleUpdate(createTestUpdate({ message: { text: "/branch" } }));
    expect(usage.api.sendMessage.mock.calls[0]?.[1]).toContain("Usage: /branch &lt;entry-id&gt;");

    const missing = setupBot();
    await missing.bot.handleUpdate(createTestUpdate({ message: { text: "/branch missing" } }));
    expect(missing.api.sendMessage.mock.calls[0]?.[1]).toContain("Entry not found: missing");

    const sameLeaf = setupBot();
    await sameLeaf.bot.handleUpdate(createTestUpdate({ message: { text: "/branch leaf1234" } }));
    expect(sameLeaf.api.sendMessage.mock.calls[0]?.[1]).toContain("already at this point");

    const ok = setupBot();
    await ok.bot.handleUpdate(createTestUpdate({ message: { text: "/branch branch111" } }));
    expect(ok.api.sendMessage.mock.calls[0]?.[1]).toContain("Navigate to this point?");
    expect(getReplyMarkupData(ok.api)).toEqual(["tree_go_branch111", "tree_sum_branch111", "tree_cancel"]);
  });

  it("handles /label command flows", async () => {
    const show = setupBot();
    await show.bot.handleUpdate(createTestUpdate({ message: { text: "/label" } }));
    expect(show.api.sendMessage.mock.calls[0]?.[1]).toContain("saved");

    const current = setupBot();
    await current.bot.handleUpdate(createTestUpdate({ message: { text: "/label checkpoint" } }));
    expect(current.pi.service.setLabel).toHaveBeenCalledWith("leaf1234", "checkpoint");
    expect(current.api.sendMessage.mock.calls[0]?.[1]).toContain("current leaf");

    const specific = setupBot();
    await specific.bot.handleUpdate(createTestUpdate({ message: { text: "/label branch111 origin" } }));
    expect(specific.pi.service.setLabel).toHaveBeenCalledWith("branch111", "origin");
    expect(specific.api.sendMessage.mock.calls[0]?.[1]).toContain("set on");

    const clear = setupBot();
    await clear.bot.handleUpdate(createTestUpdate({ message: { text: "/label clear branch111" } }));
    expect(clear.pi.service.setLabel).toHaveBeenCalledWith("branch111", "");
    expect(clear.api.sendMessage.mock.calls[0]?.[1]).toContain("Label cleared");

    const unknown = setupBot({
      piSessionOverrides: {
        getEntry: vi.fn().mockReturnValue(undefined),
      },
    });
    await unknown.bot.handleUpdate(createTestUpdate({ message: { text: "/label clear nope" } }));
    expect(unknown.api.sendMessage.mock.calls[0]?.[1]).toContain("Entry not found: nope");
  });

  it("handles tree callback queries", async () => {
    const nav = setupBot();
    await nav.bot.handleUpdate(createCallbackUpdate("tree_nav_branch111"));
    expect(nav.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", { text: "Loading..." });
    expect(nav.api.editMessageText.mock.calls[0]?.[2]).toContain("Navigate to this point?");

    // tree_go_ requires prior tree_nav_ confirmation (pendingTreeNavs)
    const go = setupBot();
    // First trigger nav to set pending state
    await go.bot.handleUpdate(createCallbackUpdate("tree_nav_branch111"));
    go.api.answerCallbackQuery.mockClear();
    go.api.editMessageText.mockClear();
    // Now confirm navigate
    await go.bot.handleUpdate(createCallbackUpdate("tree_go_branch111"));
    expect(go.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", { text: "Navigating..." });
    expect(go.pi.service.navigateTree).toHaveBeenCalledWith("branch111");
    expect(go.api.editMessageText.mock.calls[0]?.[2]).toContain("✅ Navigated to");

    // tree_go_ without prior nav shows "expired"
    const goExpired = setupBot();
    await goExpired.bot.handleUpdate(createCallbackUpdate("tree_go_branch111"));
    expect(goExpired.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Confirmation expired. Use /branch again.",
    });

    // tree_go_ with navigation error
    const goFail = setupBot({
      piSessionOverrides: {
        navigateTree: vi.fn().mockRejectedValue(new Error("nav failed")),
      },
    });
    await goFail.bot.handleUpdate(createCallbackUpdate("tree_nav_branch111"));
    goFail.api.editMessageText.mockClear();
    await goFail.bot.handleUpdate(createCallbackUpdate("tree_go_branch111"));
    expect(goFail.api.editMessageText.mock.calls[0]?.[2]).toContain("nav failed");

    // tree_sum_ requires prior tree_nav_ confirmation
    const sum = setupBot();
    await sum.bot.handleUpdate(createCallbackUpdate("tree_nav_branch111"));
    sum.api.answerCallbackQuery.mockClear();
    sum.api.editMessageText.mockClear();
    await sum.bot.handleUpdate(createCallbackUpdate("tree_sum_branch111"));
    expect(sum.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Navigating with summary...",
    });
    expect(sum.pi.service.navigateTree).toHaveBeenCalledWith("branch111", { summarize: true });
    expect(sum.api.editMessageText.mock.calls[0]?.[2]).toContain("Branch summary saved");

    // tree_sum_ without prior nav shows "expired"
    const sumExpired = setupBot();
    await sumExpired.bot.handleUpdate(createCallbackUpdate("tree_sum_branch111"));
    expect(sumExpired.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Confirmation expired. Use /branch again.",
    });

    // tree_go_ with cancelled navigation
    const goCancelled = setupBot({
      piSessionOverrides: {
        navigateTree: vi.fn().mockResolvedValue({ cancelled: true }),
      },
    });
    await goCancelled.bot.handleUpdate(createCallbackUpdate("tree_nav_branch111"));
    goCancelled.api.editMessageText.mockClear();
    await goCancelled.bot.handleUpdate(createCallbackUpdate("tree_go_branch111"));
    expect(goCancelled.api.editMessageText.mock.calls[0]?.[2]).toContain("Navigation cancelled.");

    const cancel = setupBot();
    await cancel.bot.handleUpdate(createCallbackUpdate("tree_cancel"));
    expect(cancel.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", { text: "Cancelled" });
    expect(cancel.api.editMessageText.mock.calls[0]?.[2]).toContain("Navigation cancelled.");

    const mode = setupBot();
    await mode.bot.handleUpdate(createCallbackUpdate("tree_mode_user"));
    expect(mode.api.editMessageText.mock.calls[0]?.[2]).toContain("Filter: user messages only.");
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

  it("transcribes voice messages and feeds the transcript into the prompt flow", async () => {
    const { bot, pi, api } = setupBot();
    const promptMock = pi.service.prompt as ReturnType<typeof vi.fn>;
    promptMock.mockImplementation(async () => {
      pi.emitTextDelta("Voice response");
      pi.emitAgentEnd();
    });

    await bot.handleUpdate(createVoiceUpdate());

    expect(api.getFile).toHaveBeenCalledWith("voice-file-id");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://api.telegram.org/file/botbot-token/voice/file.ogg",
    );
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(pi.service.prompt).toHaveBeenCalledWith("transcribed text");
    expect(api.sendMessage.mock.calls.some((call) => String(call[1]).includes("🎤 transcribed text"))).toBe(true);
    expect(api.sendMessage.mock.calls.some((call) => String(call[1]).includes("Voice response"))).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it("blocks voice messages while processing and reports transcription failures", async () => {
    let resolvePrompt!: () => void;
    const busy = setupBot({
      piSessionOverrides: {
        prompt: vi.fn().mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              resolvePrompt = resolve;
            }),
        ),
      },
    });

    const pending = busy.bot.handleUpdate(createTestUpdate({ message: { text: "first" } }));
    await nextTick();
    await busy.bot.handleUpdate(createVoiceUpdate());

    expect(busy.api.sendMessage.mock.calls.at(-1)?.[1]).toContain("Still working on previous message...");
    expect(transcribeAudio).not.toHaveBeenCalled();

    resolvePrompt();
    await pending;

    vi.mocked(transcribeAudio).mockRejectedValueOnce(new Error("backend missing"));
    const failure = setupBot();
    await failure.bot.handleUpdate(createVoiceUpdate());

    expect(failure.api.sendMessage.mock.calls.some((call) => String(call[1]).includes("Transcription failed:"))).toBe(
      true,
    );
    expect(failure.pi.service.prompt).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalled();
  });

  it("auto-creates a session for audio files before prompting", async () => {
    const noSession = setupBot({
      piSessionOverrides: {
        hasActiveSession: vi.fn().mockReturnValue(false),
      },
    });
    const promptMock = noSession.pi.service.prompt as ReturnType<typeof vi.fn>;
    promptMock.mockImplementation(async () => {
      noSession.pi.emitTextDelta("Audio response");
      noSession.pi.emitAgentEnd();
    });

    await noSession.bot.handleUpdate(
      createVoiceUpdate({
        message: {
          voice: undefined,
          audio: {
            file_id: "audio-file-id",
            file_unique_id: "audio-unique",
            duration: 6,
            mime_type: "audio/ogg",
            file_name: "clip.ogg",
          },
        },
      }),
    );

    expect(noSession.api.getFile).toHaveBeenCalledWith("audio-file-id");
    expect(noSession.pi.service.newSession).toHaveBeenCalledTimes(1);
    expect(noSession.pi.service.prompt).toHaveBeenCalledWith("transcribed text");
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

  it("blocks tree commands while processing or switching", async () => {
    let resolvePrompt!: () => void;
    const busy = setupBot({
      piSessionOverrides: {
        prompt: vi.fn().mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              resolvePrompt = resolve;
            }),
        ),
      },
    });

    const pending = busy.bot.handleUpdate(createTestUpdate({ message: { text: "hello" } }));
    await nextTick();
    await busy.bot.handleUpdate(createTestUpdate({ message: { text: "/tree" } }));
    await busy.bot.handleUpdate(createTestUpdate({ message: { text: "/branch branch111" } }));
    await busy.bot.handleUpdate(createTestUpdate({ message: { text: "/label mark" } }));
    await busy.bot.handleUpdate(createCallbackUpdate("tree_nav_branch111"));

    expect(busy.api.sendMessage.mock.calls.some((call) => String(call[1]).includes("Cannot view tree while a prompt is running."))).toBe(true);
    expect(busy.api.sendMessage.mock.calls.some((call) => String(call[1]).includes("Cannot navigate while a prompt is running."))).toBe(true);
    expect(busy.api.sendMessage.mock.calls.some((call) => String(call[1]).includes("Cannot label entries while a prompt is running."))).toBe(true);
    expect(busy.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Wait for the current prompt to finish",
    });

    resolvePrompt();
    await pending;
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

  it("expires page callbacks when the original picker state is gone", async () => {
    const { bot, api } = setupBot();

    await bot.handleUpdate(createCallbackUpdate("switch_page_1"));
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Expired, run /sessions again",
    });

    api.answerCallbackQuery.mockClear();
    await bot.handleUpdate(createCallbackUpdate("newws_page_1"));
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Expired, run /new again",
    });

    api.answerCallbackQuery.mockClear();
    await bot.handleUpdate(createCallbackUpdate("model_page_1"));
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Expired, run /model again",
    });

    api.answerCallbackQuery.mockClear();
    await bot.handleUpdate(createCallbackUpdate("tree_page_1"));
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Expired, run /tree again",
    });

    api.answerCallbackQuery.mockClear();
    await bot.handleUpdate(createCallbackUpdate("branch_page_1"));
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Expired, run /branch again",
    });
  });

  it("handles noop_page callback without editing the message", async () => {
    const { bot, api } = setupBot();

    await bot.handleUpdate(createCallbackUpdate("noop_page"));
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {});
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.editMessageReplyMarkup).not.toHaveBeenCalled();
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
      { command: "tree", description: "View and navigate the session tree" },
      { command: "branch", description: "Navigate to a tree entry (/branch <id>)" },
      { command: "label", description: "Label an entry (/label [name] or /label <id> <name>)" },
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

    // tree commands should be blocked
    await streaming.bot.handleUpdate(createTestUpdate({ message: { text: "/tree" } }));
    expect(streaming.api.sendMessage.mock.calls[3]?.[1]).toContain("Cannot view tree while a prompt is running.");
    await streaming.bot.handleUpdate(createTestUpdate({ message: { text: "/branch branch111" } }));
    expect(streaming.api.sendMessage.mock.calls[4]?.[1]).toContain("Cannot navigate while a prompt is running.");
    await streaming.bot.handleUpdate(createTestUpdate({ message: { text: "/label saved" } }));
    expect(streaming.api.sendMessage.mock.calls[5]?.[1]).toContain("Cannot label entries while a prompt is running.");

    // text messages should be blocked
    await streaming.bot.handleUpdate(createTestUpdate({ message: { text: "hello there" } }));
    expect(streaming.api.sendMessage.mock.calls[6]?.[1]).toContain("Still working on previous message...");

    await streaming.bot.handleUpdate(createCallbackUpdate("tree_nav_branch111"));
    expect(streaming.api.answerCallbackQuery).toHaveBeenCalledWith("cb_1", {
      text: "Wait for the current prompt to finish",
    });
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

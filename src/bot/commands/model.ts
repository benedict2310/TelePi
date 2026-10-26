import { type Context } from "grammy";

import { escapeHTML } from "../../format.js";
import type { PiSessionContext, PiSessionInfo, PiSessionModelOption, PiSessionService } from "../../pi-session.js";
import { type KeyboardItem } from "../keyboard.js";
import { renderFailedText, renderPrefixedError, renderSessionInfoPlain, renderSessionInfoHTML } from "../message-rendering.js";
import type { TextOptions } from "../telegram-transport.js";

export function createModelCommandHandlers(deps: {
  getContextKey: (target: PiSessionContext) => string;
  getExistingSession: (target: PiSessionContext) => PiSessionService | undefined;
  getOrCreateSession: (target: PiSessionContext) => Promise<PiSessionService>;
  isBusy: (target: PiSessionContext) => boolean;
  refreshChatScopedCommands: (target: PiSessionContext, piSession: PiSessionService) => Promise<void>;
  pendingModelPicks: Map<string, PiSessionModelOption[]>;
  pendingModelButtons: Map<string, KeyboardItem[]>;
  pendingModelExtraButtons: Map<string, KeyboardItem[]>;
  pendingModelFilters?: Map<string, string | undefined>;
  buildKeyboard: (
    items: KeyboardItem[],
    page: number,
    prefix: string,
    extraItems?: KeyboardItem[],
  ) => any;
  safeReply: (ctx: Context, text: string, options?: TextOptions, target?: PiSessionContext) => Promise<void>;
  safeEditMessage: (target: PiSessionContext, messageId: number, text: string, options?: TextOptions) => Promise<void>;
  surfaceStartupErrorDiagnostics: (ctx: Context, target: PiSessionContext, info: PiSessionInfo) => Promise<void>;
}) {
  const {
    getContextKey,
    getExistingSession,
    getOrCreateSession,
    isBusy,
    refreshChatScopedCommands,
    pendingModelPicks,
    pendingModelButtons,
    pendingModelExtraButtons,
    pendingModelFilters,
    buildKeyboard,
    safeReply,
    safeEditMessage,
    surfaceStartupErrorDiagnostics,
  } = deps;

  const renderModelPicker = async (
    ctx: Context,
    target: PiSessionContext,
    piSession: PiSessionService,
    options?: { showAll?: boolean; messageId?: number; filter?: string },
  ): Promise<void> => {
    const contextKey = getContextKey(target);
    const showAll = options?.showAll ?? false;
    const messageId = options?.messageId;
    const filter = options?.filter?.trim() ? options.filter.trim() : undefined;
    // Preserve the legacy single-arg call shape when no filter is set so existing
    // mocks expecting listModels(showAll) keep passing.
    const models = filter
      ? await piSession.listModels(showAll, filter)
      : await piSession.listModels(showAll);

    if (models.length === 0) {
      const hint = filter
        ? `No models match "${filter}". Try /model with a different provider or search text (e.g. /model opencode-go, /model openai-codex, /model muse-spark).`
        : "No models available.";
      if (messageId) {
        await safeEditMessage(target, messageId, escapeHTML(hint), { fallbackText: hint });
      } else {
        await safeReply(ctx, escapeHTML(hint), { fallbackText: hint }, target);
      }
      return;
    }

    pendingModelPicks.set(contextKey, models);
    pendingModelFilters?.set(contextKey, filter);

    const modelButtons = models.map((model, index) => {
      const modelRef = `${model.provider}/${model.id}`;
      const nameSuffix = model.name && model.name !== model.id ? ` · ${model.name}` : "";
      const thinkingSuffix = model.thinkingLevel ? ` : ${model.thinkingLevel}` : "";
      return {
        label: `${model.current ? "✅ " : ""}${modelRef}${nameSuffix}${thinkingSuffix}`,
        callbackData: `model_${index}`,
      };
    });
    pendingModelButtons.set(contextKey, modelButtons);

    let extraButtons: KeyboardItem[] = [];
    let allForSummary: PiSessionModelOption[] | undefined;
    if (!showAll) {
      const allModels = filter
        ? await piSession.listModels(true, filter)
        : await piSession.listModels(true);
      if (allModels.length > models.length) {
        extraButtons = [{ label: "Show all models", callbackData: "model_show_all" }];
      }
      // Reuse the unfiltered full list for the provider summary when no filter
      // is active to avoid an extra catalog fetch.
      allForSummary = filter ? undefined : allModels;
    } else {
      allForSummary = filter ? undefined : models;
    }
    pendingModelExtraButtons.set(contextKey, extraButtons);

    const info = piSession.getInfo();
    const currentModelText = info.model ? `Current: ${info.model}` : "No model selected";
    const scopeHint = extraButtons.length > 0 ? "Showing the current Pi model scope." : undefined;
    // Grouped provider summary so the full authenticated set is visible at a glance.
    // listModels(true) reflects the Pi CLI catalog (models-store.json + auth filtering)
    // after the SDK upgrade, so counts here match `pi --list-models`.
    if (!allForSummary) {
      allForSummary = await piSession.listModels(true);
    }
    const providerSummary = summarizeProviders(allForSummary);
    const filterHint = filter ? `Filter: ${filter} (${models.length} match${models.length === 1 ? "" : "es"}) — /model clears the filter.` : undefined;
    const usageHint = "Tip: /model &lt;provider or text&gt; filters (e.g. /model opencode-go, /model openai-codex, /model muse-spark).";
    const html = ["<b>Select a model</b>", escapeHTML(currentModelText), providerSummary ? `<i>${escapeHTML(providerSummary)}</i>` : undefined, filterHint ? `<i>${escapeHTML(filterHint)}</i>` : undefined, scopeHint ? `<i>${escapeHTML(scopeHint)}</i>` : undefined, `<i>${usageHint}</i>`]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const fallbackText = ["Select a model", currentModelText, providerSummary, filterHint, scopeHint, "Tip: /model <provider or text> filters."]
      .filter((line): line is string | undefined => line !== undefined)
      .join("\n");
    const replyMarkup = buildKeyboard(modelButtons, 0, "model", extraButtons);

    if (messageId) {
      await safeEditMessage(target, messageId, html, { fallbackText, replyMarkup });
      return;
    }

    await safeReply(ctx, html, { fallbackText, replyMarkup }, target);
  };

  const handleModelCommand = async (ctx: Context, target: PiSessionContext): Promise<void> => {
    const existing = getExistingSession(target);
    const hadActiveSession = existing?.hasActiveSession() === true;
    const piSession = await getOrCreateSession(target);

    if (!piSession.hasActiveSession()) {
      try {
        await piSession.newSession();
      } catch (error) {
        const failure = renderPrefixedError("Failed to create session", error);
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
        return;
      }
    }

    if (!hadActiveSession) {
      await surfaceStartupErrorDiagnostics(ctx, target, piSession.getInfo());
    }

    await refreshChatScopedCommands(target, piSession);
    const filter = extractModelFilter(ctx);
    await renderModelPicker(ctx, target, piSession, filter ? { filter } : undefined);
  };

  return {
    renderModelPicker,
    handleModelCommand,
  };
}

export function extractModelFilter(ctx: Context): string | undefined {
  const text = (ctx.message as { text?: string } | undefined)?.text ?? "";
  // Telegram sends "/model", "/model@BotName", or "/model <filter>".
  const match = text.match(/^\/model(?:@[A-Za-z0-9_]+)?\s*(.*)$/s);
  const filter = (match?.[1] ?? "").trim();
  return filter ? filter : undefined;
}

export function summarizeProviders(models: PiSessionModelOption[]): string | undefined {
  if (models.length === 0) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const model of models) {
    counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, count]) => `${provider} (${count})`);
  return `Providers: ${parts.join(" • ")}`;
}

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { NOOP_PAGE_CALLBACK_DATA } from "./callback-data.js";
import { escapeHTML } from "./format.js";

export interface SessionTreeNodeLike {
  entry: SessionEntry;
  children: SessionTreeNodeLike[];
  label?: string;
}

const DEFAULT_TREE_LIMIT = 10;
const TELEGRAM_TREE_TEXT_LIMIT = 3900;
const ENTRY_DESCRIPTION_LIMIT = 120;
const BUTTON_LABEL_DESCRIPTION_LIMIT = 20;
const TREE_BUTTON_PAGE_LIMIT = 6;

type TreeEntryLike = { type: string; id?: string; [key: string]: any };

type DisplayNode = {
  node: SessionTreeNodeLike;
  children: DisplayNode[];
};

type FlatDisplayNode = {
  node: SessionTreeNodeLike;
  depth: number;
  isLast: boolean;
  ancestorHasNext: boolean[];
};

type TreePage = {
  nodes: FlatDisplayNode[];
  startIndex: number;
  endIndex: number;
};

export interface TreeButton {
  label: string;
  callbackData: string;
}

export interface TreeRenderResult {
  text: string;
  buttons: TreeButton[];
  totalEntries: number;
  shownEntries: number;
  page: number;
  totalPages: number;
}

export type TreeFilterMode = "default" | "user-only" | "all-with-buttons";

export function truncateText(text: string, maxLen: number): string {
  if (maxLen <= 0) {
    return "";
  }

  if (text.length <= maxLen) {
    return text;
  }

  if (maxLen === 1) {
    return "…";
  }

  return `${text.slice(0, maxLen - 1)}…`;
}

export function describeEntry(entry: TreeEntryLike): string {
  switch (entry.type) {
    case "message": {
      const role = entry.message?.role;
      if (role === "user") {
        return `user: ${formatQuotedText(extractTextContent(entry.message?.content))}`;
      }

      if (role === "assistant") {
        const text = extractTextContent(entry.message?.content);
        if (text) {
          return `assistant: ${formatQuotedText(text)}`;
        }

        const toolName = extractToolCallName(entry.message?.content);
        if (toolName) {
          return `assistant: [tool ${toolName}]`;
        }

        return "assistant: [no text]";
      }

      if (role === "toolResult") {
        return `toolResult: ${entry.message?.toolName ?? "tool"}`;
      }

      if (role) {
        return `[${role}]`;
      }

      return "[message]";
    }
    case "compaction":
      return "[compaction]";
    case "branch_summary":
      return "[branch summary]";
    case "model_change":
      return `[model ${entry.provider ?? "unknown"}/${entry.modelId ?? "unknown"}]`;
    case "thinking_level_change":
      return `[thinking level ${entry.thinkingLevel ?? "unknown"}]`;
    case "custom":
    case "custom_message":
      return `[custom ${entry.customType ?? "unknown"}]`;
    case "label":
      return `[label ${entry.label ?? ""}]`;
    case "session_info":
      return `[session ${entry.name ?? "unnamed"}]`;
    default:
      return `[${entry.type}]`;
  }
}

export function renderTree(
  tree: SessionTreeNodeLike[],
  leafId: string | null,
  options: {
    mode?: TreeFilterMode;
    limit?: number;
    page?: number;
  } = {},
): TreeRenderResult {
  if (tree.length === 0) {
    return {
      text: "Session tree is empty.",
      buttons: [],
      totalEntries: 0,
      shownEntries: 0,
      page: 0,
      totalPages: 0,
    };
  }

  const mode = options.mode ?? "default";
  const pageEntryLimit = Math.max(1, options.limit ?? DEFAULT_TREE_LIMIT);
  const displayTree = buildDisplayTree(tree, mode);
  const flattened = flattenDisplayTree(displayTree);

  if (flattened.length === 0) {
    return {
      text: buildTreeHtml(
        ["No matching entries."],
        {
          totalEntries: 0,
          shownEntries: 0,
          page: 0,
          totalPages: 0,
          rangeStart: 0,
          rangeEnd: 0,
          mode,
          focusPage: 0,
          showFocusNote: false,
        },
      ),
      buttons: buildTreeButtons([], [], leafId, mode, 0, 0, 0),
      totalEntries: 0,
      shownEntries: 0,
      page: 0,
      totalPages: 0,
    };
  }

  const totalEntries = flattened.length;
  const pages = buildTreePages(flattened, leafId, mode, pageEntryLimit);
  const focusIndex = getFocusIndex(tree, flattened, leafId);
  const focusPage = getPageIndexForEntry(pages, focusIndex);
  const safePage = clampPage(options.page ?? focusPage, pages.length);
  const visiblePage = pages[safePage] ?? pages[0];
  const visibleNodes = visiblePage?.nodes ?? [];
  const pageBaseDepth = visibleNodes.reduce((minDepth, flatNode) => Math.min(minDepth, flatNode.depth), Number.POSITIVE_INFINITY);
  const renderedLines = visibleNodes.map((flatNode) =>
    renderTreeLine(flatNode, leafId, Number.isFinite(pageBaseDepth) ? pageBaseDepth : 0)
  );
  const html = buildTreeHtml(renderedLines, {
    totalEntries,
    shownEntries: visibleNodes.length,
    page: safePage,
    totalPages: pages.length,
    rangeStart: visibleNodes.length === 0 ? 0 : visiblePage.startIndex + 1,
    rangeEnd: visibleNodes.length === 0 ? 0 : visiblePage.endIndex + 1,
    mode,
    focusPage,
    showFocusNote: leafId !== null,
  });
  const buttons = buildTreeButtons(flattened, visibleNodes, leafId, mode, safePage, pages.length, focusIndex);

  return {
    text: html,
    buttons,
    totalEntries,
    shownEntries: visibleNodes.length,
    page: safePage,
    totalPages: pages.length,
  };
}

export function renderBranchConfirmation(
  entry: { type: string; id: string; [key: string]: any },
  children: Array<{ type: string; id: string; [key: string]: any }>,
  leafId: string | null,
  labels: Map<string, string>,
): { text: string; buttons: TreeButton[] } {
  const lines = [
    "<b>Navigate to this point?</b>",
    "",
    `${renderEntryRef(entry.id)} ${escapeHTML(describeEntry(entry))}`,
  ];

  if (children.length > 0) {
    lines.push("", "<b>Children</b>");
    for (const child of children) {
      const active = child.id === leafId ? " ← active" : "";
      const label = labels.get(child.id);
      const labelText = label ? ` <b>[${escapeHTML(label)}]</b>` : "";
      lines.push(`${renderEntryRef(child.id)} ${escapeHTML(describeEntry(child))}${labelText}${escapeHTML(active)}`);
    }
  }

  lines.push("", "Choose how to navigate:");

  return {
    text: lines.join("\n"),
    buttons: [
      { label: "🔀 Navigate here", callbackData: `tree_go_${entry.id}` },
      { label: "📝 Navigate + Summarize", callbackData: `tree_sum_${entry.id}` },
      { label: "❌ Cancel", callbackData: "tree_cancel" },
    ],
  };
}

export function renderLabels(tree: SessionTreeNodeLike[]): string {
  const labeled: string[] = [];

  const walk = (node: SessionTreeNodeLike): void => {
    if (node.label) {
      labeled.push(
        `🏷️ ${renderEntryRef(node.entry.id)} <b>[${escapeHTML(node.label)}]</b> — ${escapeHTML(describeEntry(node.entry))}`,
      );
    }

    for (const child of node.children) {
      walk(child);
    }
  };

  for (const root of tree) {
    walk(root);
  }

  if (labeled.length === 0) {
    return "No labels set.";
  }

  return labeled.join("\n");
}

function buildDisplayTree(tree: SessionTreeNodeLike[], mode: TreeFilterMode): DisplayNode[] {
  const result: DisplayNode[] = [];

  for (const node of tree) {
    const visibleChildren = buildDisplayTree(node.children, mode);
    if (shouldIncludeEntry(node.entry, mode)) {
      result.push({ node, children: visibleChildren });
    } else {
      result.push(...visibleChildren);
    }
  }

  return result;
}

function flattenDisplayTree(nodes: DisplayNode[], depth = 0, ancestorHasNext: boolean[] = []): FlatDisplayNode[] {
  const result: FlatDisplayNode[] = [];

  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    result.push({
      node: node.node,
      depth,
      isLast,
      ancestorHasNext,
    });
    result.push(...flattenDisplayTree(node.children, depth + 1, [...ancestorHasNext, !isLast]));
  });

  return result;
}

function shouldIncludeEntry(entry: SessionEntry, mode: TreeFilterMode): boolean {
  if (mode === "user-only") {
    return entry.type === "message" && entry.message.role === "user";
  }

  return true;
}

function buildTreePages(
  flattened: FlatDisplayNode[],
  leafId: string | null,
  mode: TreeFilterMode,
  pageEntryLimit: number,
): TreePage[] {
  const pages: TreePage[] = [];
  let currentNodes: FlatDisplayNode[] = [];
  let currentStartIndex = 0;
  let currentNavButtonCount = 0;

  flattened.forEach((flatNode, index) => {
    const nextButtonCount = getNavButton(flatNode.node, leafId, mode) ? 1 : 0;
    const wouldOverflowEntryLimit = currentNodes.length >= pageEntryLimit;
    const wouldOverflowButtonLimit = currentNodes.length > 0
      && currentNavButtonCount + nextButtonCount > TREE_BUTTON_PAGE_LIMIT;

    if (currentNodes.length > 0 && (wouldOverflowEntryLimit || wouldOverflowButtonLimit)) {
      pages.push({
        nodes: currentNodes,
        startIndex: currentStartIndex,
        endIndex: index - 1,
      });
      currentNodes = [];
      currentStartIndex = index;
      currentNavButtonCount = 0;
    }

    currentNodes.push(flatNode);
    currentNavButtonCount += nextButtonCount;
  });

  if (currentNodes.length > 0) {
    pages.push({
      nodes: currentNodes,
      startIndex: currentStartIndex,
      endIndex: flattened.length - 1,
    });
  }

  return pages.length > 0 ? pages : [{ nodes: [], startIndex: 0, endIndex: 0 }];
}

function getFocusIndex(
  tree: SessionTreeNodeLike[],
  flattened: FlatDisplayNode[],
  leafId: string | null,
): number {
  if (flattened.length === 0) {
    return 0;
  }

  if (!leafId) {
    return flattened.length - 1;
  }

  const exactIndex = flattened.findIndex((flatNode) => flatNode.node.entry.id === leafId);
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const ancestorIds = collectAncestorIds(tree, leafId);
  for (let index = flattened.length - 1; index >= 0; index -= 1) {
    if (ancestorIds.has(flattened[index]!.node.entry.id)) {
      return index;
    }
  }

  return flattened.length - 1;
}

function collectAncestorIds(tree: SessionTreeNodeLike[], leafId: string): Set<string> {
  const parentById = new Map<string, string | null>();

  const walk = (node: SessionTreeNodeLike): void => {
    parentById.set(node.entry.id, node.entry.parentId ?? null);
    for (const child of node.children) {
      walk(child);
    }
  };

  for (const root of tree) {
    walk(root);
  }

  const result = new Set<string>();
  const visited = new Set<string>();
  let currentId: string | null = leafId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    result.add(currentId);
    currentId = parentById.get(currentId) ?? null;
  }

  return result;
}

function getPageIndexForEntry(pages: TreePage[], entryIndex: number): number {
  const safeEntryIndex = Math.max(0, entryIndex);
  const pageIndex = pages.findIndex((page) => safeEntryIndex >= page.startIndex && safeEntryIndex <= page.endIndex);
  return pageIndex >= 0 ? pageIndex : 0;
}

function clampPage(page: number, totalPages: number): number {
  if (totalPages <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(page, totalPages - 1));
}

function renderTreeLine(flatNode: FlatDisplayNode, leafId: string | null, baseDepth = 0): string {
  const { node, depth, isLast, ancestorHasNext } = flatNode;
  const relativeDepth = Math.max(0, depth - baseDepth);
  const visibleAncestors = relativeDepth > 0 ? ancestorHasNext.slice(-relativeDepth) : [];
  const hiddenPrefix = baseDepth > 0 && relativeDepth === 0 ? "… " : "";
  const indent = visibleAncestors.map((hasNext) => (hasNext ? "│  " : "   ")).join("");
  const connector = relativeDepth === 0 ? "" : isLast ? "└─ " : "├─ ";
  const shortId = node.entry.id.slice(0, 4);
  const label = node.label ? ` [${node.label}]` : "";
  const active = node.entry.id === leafId ? " ← active" : "";
  return `${hiddenPrefix}${indent}${connector}${shortId} ${describeEntry(node.entry)}${label}${active}`;
}

function buildTreeHtml(
  lines: string[],
  details: {
    totalEntries: number;
    shownEntries: number;
    page: number;
    totalPages: number;
    rangeStart: number;
    rangeEnd: number;
    mode: TreeFilterMode;
    focusPage: number;
    showFocusNote: boolean;
  },
): string {
  const notes: string[] = [];
  const pageLabel = `Page ${details.page + 1}/${Math.max(details.totalPages, 1)}`;

  if (details.totalEntries === 0) {
    notes.push(`${pageLabel} · no matching entries.`);
  } else {
    notes.push(`${pageLabel} · entries ${details.rangeStart}-${details.rangeEnd} of ${details.totalEntries}.`);
  }

  if (details.mode === "default") {
    if (details.showFocusNote && details.page === details.focusPage) {
      notes.push("Current branch context.");
    } else if (details.showFocusNote) {
      notes.push(`Current branch page: ${details.focusPage + 1}/${Math.max(details.totalPages, 1)}.`);
    }
  } else if (details.mode === "user-only") {
    notes.push("Filter: user messages only.");
  } else if (details.mode === "all-with-buttons") {
    notes.push("Filter: all entries with navigation buttons.");
  }

  const notesHtml = `<i>${escapeHTML(notes.join(" "))}</i>`;
  const renderHtml = (renderedLines: string[]): string => [wrapTreeText(renderedLines.join("\n")), notesHtml].join("\n");

  const html = renderHtml(lines);
  if (html.length <= TELEGRAM_TREE_TEXT_LIMIT) {
    return html;
  }

  for (const width of [220, 160, 120, 90, 60, 40]) {
    const compactHtml = renderHtml(lines.map((line) => truncateText(line, width)));
    if (compactHtml.length <= TELEGRAM_TREE_TEXT_LIMIT) {
      return compactHtml;
    }
  }

  let emergencyBudget = TELEGRAM_TREE_TEXT_LIMIT - notesHtml.length - 16;
  while (emergencyBudget > 40) {
    const emergencyHtml = renderHtml([truncateText(lines.join("\n"), emergencyBudget)]);
    if (emergencyHtml.length <= TELEGRAM_TREE_TEXT_LIMIT) {
      return emergencyHtml;
    }
    emergencyBudget -= 50;
  }

  return renderHtml([truncateText(lines.join("\n"), 40)]);
}

function buildTreeButtons(
  flattened: FlatDisplayNode[],
  visibleNodes: FlatDisplayNode[],
  leafId: string | null,
  mode: TreeFilterMode,
  page: number,
  totalPages: number,
  focusIndex: number,
): TreeButton[] {
  const buttons: TreeButton[] = [];
  const seenIds = new Set<string>();

  const pushNavButton = (flatNode: FlatDisplayNode): void => {
    const button = getNavButton(flatNode.node, leafId, mode);
    if (!button || seenIds.has(flatNode.node.entry.id)) {
      return;
    }

    buttons.push(button);
    seenIds.add(flatNode.node.entry.id);
  };

  for (const flatNode of visibleNodes) {
    pushNavButton(flatNode);
  }

  if (mode === "default" && buttons.length === 0) {
    const fallbackCandidates = flattened
      .map((flatNode, index) => ({ flatNode, index }))
      .filter(({ flatNode }) => getNavButton(flatNode.node, leafId, mode) !== undefined)
      .sort((left, right) => {
        const leftDistance = Math.abs(left.index - focusIndex);
        const rightDistance = Math.abs(right.index - focusIndex);
        if (leftDistance !== rightDistance) {
          return leftDistance - rightDistance;
        }
        return left.index - right.index;
      });

    for (const candidate of fallbackCandidates) {
      if (buttons.length >= TREE_BUTTON_PAGE_LIMIT) {
        break;
      }
      pushNavButton(candidate.flatNode);
    }
  }

  if (totalPages > 1) {
    if (page > 0) {
      buttons.push({ label: "◀️ Prev", callbackData: `tree_page_${page - 1}` });
    }
    buttons.push({ label: `${page + 1}/${totalPages}`, callbackData: NOOP_PAGE_CALLBACK_DATA });
    if (page < totalPages - 1) {
      buttons.push({ label: "Next ▶️", callbackData: `tree_page_${page + 1}` });
    }
  }

  buttons.push(...buildFilterButtons(mode));
  return buttons;
}

function getNavButton(node: SessionTreeNodeLike, leafId: string | null, mode: TreeFilterMode): TreeButton | undefined {
  const shortId = node.entry.id.slice(0, 4);
  const description = truncateText(cleanTextForButton(describeEntry(node.entry)), BUTTON_LABEL_DESCRIPTION_LIMIT);

  if (mode === "all-with-buttons") {
    return {
      label: `🔀 ${shortId} · ${description}`,
      callbackData: `tree_nav_${node.entry.id}`,
    };
  }

  if (mode === "user-only") {
    return {
      label: `👤 ${shortId} · ${description}`,
      callbackData: `tree_nav_${node.entry.id}`,
    };
  }

  if (node.children.length >= 2) {
    return {
      label: `🔀 ${shortId} · ${description}`,
      callbackData: `tree_nav_${node.entry.id}`,
    };
  }

  if (node.label) {
    return {
      label: `🏷️ ${shortId} · ${truncateText(node.label, 14)}`,
      callbackData: `tree_nav_${node.entry.id}`,
    };
  }

  if (node.children.length === 0 && node.entry.id !== leafId) {
    return {
      label: `🌿 ${shortId} · ${description}`,
      callbackData: `tree_nav_${node.entry.id}`,
    };
  }

  return undefined;
}

function buildFilterButtons(mode: TreeFilterMode): TreeButton[] {
  const buttons: TreeButton[] = [];

  if (mode !== "default") {
    buttons.push({ label: "🌲 Default", callbackData: "tree_mode_default" });
  }

  if (mode !== "all-with-buttons") {
    buttons.push({ label: "📄 All", callbackData: "tree_mode_all" });
  }

  if (mode !== "user-only") {
    buttons.push({ label: "👤 User", callbackData: "tree_mode_user" });
  }

  return buttons;
}

function wrapTreeText(text: string): string {
  return `<pre>${escapeHTML(text)}</pre>`;
}

function renderEntryRef(id: string): string {
  return `<code>${escapeHTML(id.slice(0, 4))}</code>`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return normalizeWhitespace(content);
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const text = content
    .filter((item) => typeof item === "object" && item !== null && "type" in item && item.type === "text")
    .map((item) => String((item as { text?: unknown }).text ?? ""))
    .join(" ");

  return normalizeWhitespace(text);
}

function extractToolCallName(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  for (const item of content) {
    if (typeof item !== "object" || item === null || !("type" in item)) {
      continue;
    }

    if (item.type !== "toolCall") {
      continue;
    }

    const maybeName = (item as { name?: unknown }).name;
    if (typeof maybeName === "string" && maybeName.trim()) {
      return maybeName.trim();
    }
  }

  return undefined;
}

function formatQuotedText(text: string): string {
  return `"${truncateText(text || "", ENTRY_DESCRIPTION_LIMIT)}"`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cleanTextForButton(text: string): string {
  return text.replace(/[\[\]"]+/g, "").replace(/\s+/g, " ").trim();
}

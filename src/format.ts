const CODE_BLOCK_PREFIX = "\uE000CODE_";
const CODE_BLOCK_SUFFIX = "_\uE000";
const INLINE_CODE_PREFIX = "\uE001INLINE_";
const INLINE_CODE_SUFFIX = "_\uE001";

export function escapeHTML(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatTelegramHTML(markdown: string): string {
  if (!markdown) {
    return "";
  }

  const escaped = escapeHTML(markdown);
  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  let text = extractCodeBlocks(escaped, codeBlocks);
  text = extractInlineCode(text, inlineCode);
  text = formatBold(text);
  text = formatItalic(text);
  text = formatLinks(text);
  text = formatBlockquotes(text);
  text = restorePlaceholders(text, INLINE_CODE_PREFIX, INLINE_CODE_SUFFIX, inlineCode);
  text = restorePlaceholders(text, CODE_BLOCK_PREFIX, CODE_BLOCK_SUFFIX, codeBlocks);

  return text;
}

function extractCodeBlocks(text: string, codeBlocks: string[]): string {
  return text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, rawLanguage: string, rawCode: string) => {
    const language = sanitizeLanguage(rawLanguage);
    const code = language
      ? `<pre><code class="language-${language}">${rawCode}</code></pre>`
      : `<pre><code>${rawCode}</code></pre>`;
    const index = codeBlocks.push(code) - 1;
    return `${CODE_BLOCK_PREFIX}${index}${CODE_BLOCK_SUFFIX}`;
  });
}

function extractInlineCode(text: string, inlineCode: string[]): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      result += text[index];
      index += 1;
      continue;
    }

    let tickCount = 1;
    while (text[index + tickCount] === "`") {
      tickCount += 1;
    }

    const fence = "`".repeat(tickCount);
    const start = index + tickCount;
    const end = text.indexOf(fence, start);

    if (end === -1) {
      result += fence;
      index += tickCount;
      continue;
    }

    const content = text.slice(start, end);
    if (content.includes("\n")) {
      result += fence;
      index += tickCount;
      continue;
    }

    const placeholder = `${INLINE_CODE_PREFIX}${inlineCode.push(`<code>${content}</code>`) - 1}${INLINE_CODE_SUFFIX}`;
    result += placeholder;
    index = end + tickCount;
  }

  return result;
}

function formatBold(text: string): string {
  return text.replace(/(?<!\*)\*\*(?!\s)([^\n]*?\S)\*\*(?!\*)/g, "<b>$1</b>");
}

function formatItalic(text: string): string {
  const withUnderscores = text.replace(
    /(?<![\w_])_(?!\s)([^_\n]*?\S)_(?![\w_])/g,
    "<i>$1</i>",
  );

  return withUnderscores.replace(
    /(?<![\w*])\*(?!\s)([^*\n]*?\S)\*(?![\w*])/g,
    "<i>$1</i>",
  );
}

function formatLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    const safeUrl = sanitizeUrl(url);
    return `<a href="${safeUrl}">${label}</a>`;
  });
}

function formatBlockquotes(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let quoteLines: string[] = [];

  const flush = (): void => {
    if (quoteLines.length === 0) {
      return;
    }

    output.push(`<blockquote>${quoteLines.join("\n")}</blockquote>`);
    quoteLines = [];
  };

  for (const line of lines) {
    const match = line.match(/^&gt; (.*)$/);
    if (match) {
      quoteLines.push(match[1]);
      continue;
    }

    flush();
    output.push(line);
  }

  flush();
  return output.join("\n");
}

function restorePlaceholders(
  text: string,
  prefix: string,
  suffix: string,
  values: string[],
): string {
  const pattern = new RegExp(`${escapeRegExp(prefix)}(\\d+)${escapeRegExp(suffix)}`, "g");
  return text.replace(pattern, (_match, rawIndex: string) => values[Number.parseInt(rawIndex, 10)] ?? "");
}

function sanitizeLanguage(language: string): string {
  return language.trim().replace(/[^a-zA-Z0-9_+-]/g, "");
}

const SAFE_URL_PROTOCOL = /^(https?|tg|mailto):/i;

function sanitizeUrl(url: string): string {
  const trimmed = url.trim().replace(/"/g, "%22");
  if (!SAFE_URL_PROTOCOL.test(trimmed)) {
    return "#";
  }
  return trimmed;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

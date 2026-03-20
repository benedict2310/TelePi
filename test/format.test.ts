import { escapeHTML, formatTelegramHTML } from "../src/format.js";

describe("escapeHTML", () => {
  it("escapes HTML entities", () => {
    expect(escapeHTML("<div>& hi ></div>")).toBe("&lt;div&gt;&amp; hi &gt;&lt;/div&gt;");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHTML("hello world")).toBe("hello world");
  });
});

describe("formatTelegramHTML", () => {
  it("formats fenced code blocks with a language", () => {
    const input = "```ts\nconst x = 1 < 2;\n```";
    expect(formatTelegramHTML(input)).toBe(
      '<pre><code class="language-ts">const x = 1 &lt; 2;\n</code></pre>',
    );
  });

  it("formats fenced code blocks without a language and does not parse nested markdown", () => {
    const input = "```\n**bold**\n`code`\n```";
    expect(formatTelegramHTML(input)).toBe("<pre><code>**bold**\n`code`\n</code></pre>");
  });

  it("formats inline code with single and double backticks", () => {
    expect(formatTelegramHTML("Use `const x = 1` now")).toBe("Use <code>const x = 1</code> now");
    expect(formatTelegramHTML("Use ``a ` tricky` value`` now")).toBe(
      "Use <code>a ` tricky` value</code> now",
    );
  });

  it("formats bold and italic markers", () => {
    expect(formatTelegramHTML("**bold** _italics_ *also italics*")).toBe(
      "<b>bold</b> <i>italics</i> <i>also italics</i>",
    );
  });

  it("formats links and sanitizes unsafe URLs", () => {
    expect(formatTelegramHTML("[safe](https://example.com) [mail](mailto:test@example.com)")).toBe(
      '<a href="https://example.com">safe</a> <a href="mailto:test@example.com">mail</a>',
    );
    expect(formatTelegramHTML("[bad](javascript:alert(1))")).toBe('<a href="#">bad</a>)');
  });

  it("formats blockquotes", () => {
    expect(formatTelegramHTML("> first\n> second\nplain")).toBe(
      "<blockquote>first\nsecond</blockquote>\nplain",
    );
  });

  it("supports mixed formatting in the same message", () => {
    const input = "Hello **bold** with `code` and _italics_ plus [link](tg://resolve?domain=pi)";
    expect(formatTelegramHTML(input)).toBe(
      'Hello <b>bold</b> with <code>code</code> and <i>italics</i> plus <a href="tg://resolve?domain=pi">link</a>',
    );
  });

  it("handles empty and whitespace-only strings", () => {
    expect(formatTelegramHTML("")).toBe("");
    expect(formatTelegramHTML("   ")).toBe("   ");
  });

  it("leaves unclosed markers untouched", () => {
    expect(formatTelegramHTML("**bold")).toBe("**bold");
    expect(formatTelegramHTML("`code")).toBe("`code");
    expect(formatTelegramHTML("[link](https://example.com")).toBe("[link](https://example.com");
  });

  it("escapes HTML before applying markdown formatting", () => {
    expect(formatTelegramHTML("<b>not bold</b> & **yes**")).toBe(
      "&lt;b&gt;not bold&lt;/b&gt; &amp; <b>yes</b>",
    );
  });

  it("does not escape double quotes (intentional for HTML content)", () => {
    expect(escapeHTML('say "hello"')).toBe('say "hello"');
  });

  it("handles blockquote-only input", () => {
    const result = formatTelegramHTML("> quoted line");
    expect(result).toBe("<blockquote>quoted line</blockquote>");
  });

  it("handles multi-line blockquotes", () => {
    const result = formatTelegramHTML("> line one\n> line two\nnot quoted");
    expect(result).toBe("<blockquote>line one\nline two</blockquote>\nnot quoted");
  });
});

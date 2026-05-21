import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type TelegramExtensionNoticeType = "info" | "warning" | "error";

type TelegramThemeShim = Pick<
  ExtensionUIContext["theme"],
  | "fg"
  | "bg"
  | "bold"
  | "italic"
  | "underline"
  | "inverse"
  | "strikethrough"
  | "getFgAnsi"
  | "getBgAnsi"
  | "getColorMode"
  | "getThinkingBorderColor"
  | "getBashModeBorderColor"
>;

const passthroughText = (text: string): string => text;

const plainTextTheme: TelegramThemeShim = {
  fg(_color, text) {
    return text;
  },
  bg(_color, text) {
    return text;
  },
  bold: passthroughText,
  italic: passthroughText,
  underline: passthroughText,
  inverse: passthroughText,
  strikethrough: passthroughText,
  getFgAnsi() {
    return "";
  },
  getBgAnsi() {
    return "";
  },
  getColorMode() {
    return "truecolor";
  },
  getThinkingBorderColor() {
    return passthroughText;
  },
  getBashModeBorderColor() {
    return passthroughText;
  },
};

export interface CreateTelegramUIContextOptions {
  notify: (message: string, type?: TelegramExtensionNoticeType) => void;
  select?: (title: string, options: string[], dialogOptions?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>;
  confirm?: (title: string, message: string, dialogOptions?: { signal?: AbortSignal; timeout?: number }) => Promise<boolean>;
  input?: (title: string, placeholder?: string, dialogOptions?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>;
}

function unsupported(method: string): never {
  throw new Error(`TelePi does not yet support extension UI method '${method}'.`);
}

export function createTelegramUIContext(options: CreateTelegramUIContextOptions): ExtensionUIContext {
  return {
    async select(title, choices, dialogOptions) {
      if (!options.select) {
        unsupported("select");
      }
      return options.select(title, choices, dialogOptions);
    },
    async confirm(title, message, dialogOptions) {
      if (!options.confirm) {
        unsupported("confirm");
      }
      return options.confirm(title, message, dialogOptions);
    },
    async input(title, placeholder, dialogOptions) {
      if (!options.input) {
        unsupported("input");
      }
      return options.input(title, placeholder, dialogOptions);
    },
    notify(message, type) {
      options.notify(message, type);
    },
    onTerminalInput() {
      return () => {};
    },
    setStatus() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    async custom() {
      unsupported("custom");
    },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() {
      return "";
    },
    async editor() {
      unsupported("editor");
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    // Pi exposes ctx.ui.theme in degraded UI modes like RPC. TelePi does not render ANSI,
    // so we provide a plain-text shim instead of the interactive terminal Theme instance.
    theme: plainTextTheme as unknown as ExtensionUIContext["theme"],
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "TelePi does not support theme switching through extension UI." };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  };
}

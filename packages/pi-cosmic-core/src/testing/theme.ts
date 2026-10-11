import {
  Theme,
  type ThemeBg,
  type ThemeColor,
  type ThemeStyle,
} from "@earendil-works/pi-coding-agent";
import { overlay } from "./overlay.ts";

const terminalDefaultForegrounds = {
  accent: "",
  border: "",
  borderAccent: "",
  borderMuted: "",
  success: "",
  error: "",
  warning: "",
  muted: "",
  dim: "",
  text: "",
  thinkingText: "",
  scrollbarTrack: "",
  scrollbarThumb: "",
  searchMatchText: "",
  userMessageText: "",
  customMessageText: "",
  customMessageLabel: "",
  toolTitle: "",
  toolOutput: "",
  mdHeading: "",
  mdLink: "",
  mdLinkUrl: "",
  mdCode: "",
  mdCodeBlock: "",
  mdCodeBlockBorder: "",
  mdQuote: "",
  mdQuoteBorder: "",
  mdHr: "",
  mdListBullet: "",
  toolDiffAdded: "",
  toolDiffRemoved: "",
  toolDiffContext: "",
  syntaxComment: "",
  syntaxKeyword: "",
  syntaxFunction: "",
  syntaxVariable: "",
  syntaxString: "",
  syntaxNumber: "",
  syntaxType: "",
  syntaxOperator: "",
  syntaxPunctuation: "",
  thinkingOff: "",
  thinkingMinimal: "",
  thinkingLow: "",
  thinkingMedium: "",
  thinkingHigh: "",
  thinkingXhigh: "",
  thinkingMax: "",
  bashMode: "",
} satisfies Record<ThemeColor, string>;

const terminalDefaultBackgrounds = {
  selectedBg: "",
  searchMatchBg: "",
  userMessageBg: "",
  customMessageBg: "",
  toolPendingBg: "",
  toolSuccessBg: "",
  toolErrorBg: "",
} satisfies Record<ThemeBg, string>;

const unstyled = (text: string): string => text;

export class PlainTheme extends Theme {
  constructor() {
    super(terminalDefaultForegrounds, terminalDefaultBackgrounds, "truecolor", { name: "plain" });
  }

  override fg(_color: ThemeColor, text: string): string {
    return text;
  }

  override bg(_color: ThemeBg, text: string): string {
    return text;
  }

  override style(text: string, _options: ThemeStyle): string {
    return text;
  }

  override bold(text: string): string {
    return text;
  }

  override italic(text: string): string {
    return text;
  }

  override underline(text: string): string {
    return text;
  }

  override inverse(text: string): string {
    return text;
  }

  override strikethrough(text: string): string {
    return text;
  }

  override getFgAnsi(): string {
    return "";
  }

  override getBgAnsi(): string {
    return "";
  }

  override getThinkingBorderColor(): (text: string) => string {
    return unstyled;
  }

  override getBashModeBorderColor(): (text: string) => string {
    return unstyled;
  }
}

export const plainTheme: Theme = new PlainTheme();

export const themeFixture = (overrides: Partial<Theme> = {}): Theme =>
  overlay<Theme>(new PlainTheme(), overrides);

interface FailingThemeOptions {
  readonly message?: string;
  readonly when?: (token: string, text: string) => boolean;
  readonly bold?: boolean;
}

export const failingTheme = ({
  message = "theme unavailable",
  when = () => true,
  bold = false,
}: FailingThemeOptions = {}): Theme => {
  const fail = (): never => {
    throw new Error(message);
  };
  return themeFixture({
    fg: (color, text) => (when(color, text) ? fail() : text),
    bold: (text) => (bold ? fail() : text),
  });
};

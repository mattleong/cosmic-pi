import { hyperlink } from "@earendil-works/pi-tui";

export const isSafeWebUrl = (url: string): boolean =>
  /^https?:\/\//iu.test(url) && !/[\p{Cc}\s]/u.test(url) && URL.canParse(url);

export const webHyperlink = (text: string, url: string | undefined): string =>
  url !== undefined && isSafeWebUrl(url) ? hyperlink(text, url) : text;

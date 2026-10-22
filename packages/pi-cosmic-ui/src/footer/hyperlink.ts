import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

export const isSafeWebUrl = (url: string): boolean =>
  /^https?:\/\//iu.test(url) && !/[\p{Cc}\s]/u.test(url) && URL.canParse(url);

// Like Pi's own links, stay plain where pi-tui detects no OSC 8 support or PI_HYPERLINKS disables it.
export const webHyperlink = (text: string, url: string | undefined): string =>
  url !== undefined && isSafeWebUrl(url) && getCapabilities().hyperlinks
    ? hyperlink(text, url)
    : text;

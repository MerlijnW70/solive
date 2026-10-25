export const UNPARSEABLE_URL = "an unparseable url";

export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return [parsed.protocol, "", parsed.host].join("/");
  } catch {
    return UNPARSEABLE_URL;
  }
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi;

export const redactUrls = (text: string): string => text.replace(URL_IN_TEXT, (found) => redactUrl(found));

import type { Readable } from "node:stream";
import { escapedOutput } from "./untrusted-text.js";

export const CHECK_OUTPUT_LIMIT = 1_000_000;

export const outputCut = (limit: number): string => `\n[the check printed more than ${limit} characters; the rest was read but not shown]\n`;

export type Relay = { shown: () => number };

export function relayOutput(streams: readonly (Readable | null)[], write: (text: string) => void, limit: number = CHECK_OUTPUT_LIMIT): Relay {
  let shown = 0;
  let cut = false;
  for (const stream of streams) {
    if (stream === null) {
      continue;
    }
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (cut) {
        return;
      }
      const room = limit - shown;
      const part = chunk.length > room ? chunk.slice(0, room) : chunk;
      shown += part.length;
      write(escapedOutput(part));
      if (chunk.length > room) {
        cut = true;
        write(outputCut(limit));
      }
    });
  }
  return { shown: () => shown };
}

export const toStderr = (text: string): void => {
  process.stderr.write(text);
};

import { createHash } from "node:crypto";
import { AGENT_CHARS, MARK_CHARS } from "./limits.js";
import type { Headers } from "./request.js";

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function callerMark(secret: string | undefined, nowMs: number, caller: string): string | undefined {
  if (secret === undefined) return undefined;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return createHash("sha256").update(secret).update("\n").update(day).update("\n").update(caller).digest("hex").slice(0, MARK_CHARS);
}

export function agentOf(headers: Headers): string | undefined {
  const value = headers["user-agent"];
  const raw = typeof value === "string" ? value : value?.[0];
  if (raw === undefined) return undefined;
  return raw.replace(CONTROL, "").slice(0, AGENT_CHARS);
}

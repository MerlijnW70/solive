import { isSdkError } from "@intent-engine/core";
import { ENGINE_ERROR_LIST, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";

export type EngineError = { code: number; name: string; message: string };

export const ENGINE_ERRORS: ReadonlyMap<number, EngineError> = new Map(ENGINE_ERROR_LIST.map(({ code, name, message }) => [code, { code, name, message }]));

const ENGINE_FAILED = new RegExp(`Program ${INTENT_ENGINE_PROGRAM_ADDRESS} failed: custom program error: 0x([0-9a-f]+)`, "i");
const PROGRAM_FAILED = /Program \w{32,44} failed: custom program error: 0x[0-9a-f]+/i;
const CUSTOM_HEX = /custom program error: 0x([0-9a-f]+)/i;
const CUSTOM_DECIMAL = /\bCustom\W{1,3}(\d+)/;
const CAUSE_DEPTH = 8;

function codeInText(text: string): number | null {
  const engine = ENGINE_FAILED.exec(text);
  if (engine !== null) {
    return Number.parseInt(engine[1] ?? "", 16);
  }
  if (PROGRAM_FAILED.test(text)) {
    return null;
  }
  const hex = CUSTOM_HEX.exec(text);
  if (hex !== null) {
    return Number.parseInt(hex[1] ?? "", 16);
  }
  const decimal = CUSTOM_DECIMAL.exec(text);
  return decimal === null ? null : Number(decimal[1]);
}

function codeOf(error: unknown, depth: number): number | null {
  if (depth > CAUSE_DEPTH || error === null || error === undefined) {
    return null;
  }
  if (typeof error === "string") {
    return codeInText(error);
  }
  if (typeof error !== "object") {
    return null;
  }
  const carried = error as { code?: unknown; context?: { code?: unknown }; message?: unknown; logs?: unknown; cause?: unknown };
  for (const code of [carried.context?.code, carried.code]) {
    if (typeof code === "number" && ENGINE_ERRORS.has(code)) {
      return code;
    }
  }
  const texts = [
    ...(typeof carried.message === "string" ? [carried.message] : []),
    ...(Array.isArray(carried.logs) ? carried.logs.filter((line): line is string => typeof line === "string") : []),
  ];
  for (const text of texts) {
    const code = codeInText(text);
    if (code !== null) {
      return code;
    }
  }
  return codeOf(carried.cause, depth + 1);
}

export function explain(error: unknown): EngineError | null {
  if (isSdkError(error, "failed-on-chain") && error.program !== null) {
    return error.engine ?? null;
  }
  const code = codeOf(error, 0);
  return code === null ? null : (ENGINE_ERRORS.get(code) ?? null);
}

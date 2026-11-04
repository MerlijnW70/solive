import { InvalidInput } from "@intent-engine/core";
import { isSha256Hex } from "@intent-engine/core/internal";

export function specHashText(value: unknown, field: string): string {
  const lowered = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!isSha256Hex(lowered)) {
    throw new InvalidInput(field, "format", `${field} must be a sha256 as 64 hex digits`);
  }
  return lowered;
}

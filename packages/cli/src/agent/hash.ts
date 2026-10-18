import { createHash } from "node:crypto";
import { define } from "./actions.js";
import { tool } from "./names.js";
import { object, text } from "./schema.js";

export const hashText = define({
  name: tool("hash"),
  title: "Hash text to a sha256",
  description: `Returns the sha256, as 64 hex digits, of the given text: use it to get the spec_hash for ${tool("wallet_escrow")}, or the delivered work's hash for ${tool("wallet_deliver")}, without leaving this server. Hash the exact bytes you will publish.`,
  effect: "read",
  input: object({ text: text("the exact text to hash, such as a spec or a delivery's contents") }),
  output: object({ sha256: text("64 hex: the sha256 of the text") }),
  run: async (_ctx, input) => ({ sha256: createHash("sha256").update(input.text).digest("hex") }),
});

import { beforeAll, describe, expect, it } from "vitest";
import { transactionPda } from "../src/layout.js";
import { EXIT_FAILED } from "../src/main.js";
import { SQUADS_PROGRAM } from "../src/squads-addresses.js";
import { craftConfig, multisig, openSvm, proposalOf, s } from "./multisig-world.js";

beforeAll(openSvm);

const CONFIG_HEAD = 8;
const KEPT = 12;

describe("a config transaction that does not decode", () => {
  it("is described as an undecodable config transaction, never a batch, and approve still refuses it", async () => {
    const m = await multisig("bad-config", 2);
    const index = await craftConfig(m, [{ __kind: "SetTimeLock", newTimeLock: 0 }]);
    const at = await transactionPda(m.address, index);
    const stored = s.account(at);
    if (!stored.exists) {
      throw new Error("the config transaction was not created");
    }
    expect(stored.programAddress).toBe(SQUADS_PROGRAM);
    s.set(at, SQUADS_PROGRAM, Uint8Array.from(stored.data).slice(0, CONFIG_HEAD + KEPT));
    const shown = await proposalOf(m, index);
    expect(shown).toMatchObject({ kind: "other", summary: ["A config transaction this tool cannot decode"], problems: ["its config transaction does not decode"] });
    expect(JSON.stringify(shown)).not.toMatch(/batch/i);
    for (const allow of [[], ["--allow-config"]]) {
      const refused = await s.cli("approve", "--multisig", m.address, "--index", index.toString(), "--keypair", m.file("b"), ...allow, "--yes");
      expect([refused.code, String(refused.json()["error"]).startsWith(`refusing to sign proposal ${index}: its config transaction does not decode; `)]).toEqual([EXIT_FAILED, true]);
    }
    expect((await proposalOf(m, index))["approved"]).toEqual([]);
  });
});

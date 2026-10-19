import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { ConfirmMismatch, confirmOnBoth, NO_ACCOUNT, nodeView, type Transport } from "../src/index.js";

const unused = async (): Promise<never> => {
  throw new Error("not read by a confirmation");
};

function stub(genesis: string, data: Uint8Array | null, down = false): Transport & { reads: number } {
  const node = {
    reads: 0,
    getAccount: async () => {
      node.reads++;
      if (down) {
        throw new TypeError("fetch failed");
      }
      return data === null ? null : { owner: "11111111111111111111111111111111" as Address, data, lamports: 1n };
    },
    getAccounts: unused,
    send: unused,
    latestBlockhash: unused,
    sendWire: unused,
    submitWire: unused,
    simulate: unused,
    genesisHash: async () => {
      node.reads++;
      if (down) {
        throw new TypeError("fetch failed");
      }
      return genesis;
    },
    intents: unused,
    engineTransactions: unused,
    recentFees: unused,
    budget: unused,
    airdrop: unused,
  };
  return node;
}

const digest = (bytes: Uint8Array) => `sha256 ${createHash("sha256").update(bytes).digest("hex")}`;

describe("confirmOnBoth", () => {
  it("returns the view both nodes agree on and refuses any difference, naming it and both values", async () => {
    const intent = (await generateKeyPairSigner()).address;
    const target = { intent, attestor: intent };
    const bytes = Uint8Array.from([1, 2, 3]);
    expect(await confirmOnBoth(stub("g", bytes), stub("g", bytes), target)).toEqual({ genesis: "g", intent: digest(bytes), announcer: undefined });
    expect(await nodeView(stub("g", null), target)).toEqual({ genesis: "g", intent: NO_ACCOUNT, announcer: undefined });
    const refusal = async (second: Transport) => {
      try {
        await confirmOnBoth(stub("g", bytes), second, target);
      } catch (error) {
        return error;
      }
      throw new Error("not refused");
    };
    expect(await refusal(stub("h", bytes))).toMatchObject({ name: "ConfirmMismatch", field: "genesis hash", first: "g", second: "h" });
    const other = Uint8Array.from([1, 2, 4]);
    const changed = await refusal(stub("g", other));
    expect(changed).toBeInstanceOf(ConfirmMismatch);
    expect(changed).toMatchObject({ field: "intent account", first: digest(bytes), second: digest(other) });
    expect((changed as Error).message).toBe(`the two RPC nodes report a different intent account: the first ${digest(bytes)}, the second ${digest(other)}; nothing was signed or sent`);
    expect(await refusal(stub("g", null))).toMatchObject({ field: "intent account", second: NO_ACCOUNT });
    const down = await refusal(stub("g", bytes, true));
    expect(down).toMatchObject({ field: "second node", second: "unreadable: fetch failed" });
    expect((down as Error).message).toBe("the second RPC node could not be read (unreadable: fetch failed), so the release is not confirmed; nothing was signed or sent");
  });

  it("compares the named accounts too and refuses a node that reports another balance or none", async () => {
    const intent = (await generateKeyPairSigner()).address;
    const held = (await generateKeyPairSigner()).address;
    const bytes = Uint8Array.from([1, 2, 3]);
    const holding = (amount: number | null) => {
      const node = stub("g", bytes);
      node.getAccounts = async (addresses) => addresses.map(() => (amount === null ? null : { owner: intent, data: Uint8Array.from([amount]), lamports: 1n }));
      return node;
    };
    const target = { intent, accounts: [held] };
    expect(await confirmOnBoth(holding(5), holding(5), target)).toEqual({ genesis: "g", intent: digest(bytes), announcer: undefined, accounts: [digest(Uint8Array.from([5]))] });
    const refused = async (second: Transport) => confirmOnBoth(holding(5), second, target).then(() => null, (error: unknown) => error);
    expect(await refused(holding(6))).toMatchObject({ name: "ConfirmMismatch", field: "account", first: `${held} ${digest(Uint8Array.from([5]))}`, second: `${held} ${digest(Uint8Array.from([6]))}` });
    expect(await refused(holding(null))).toMatchObject({ field: "account", second: `${held} ${NO_ACCOUNT}` });
    expect(await confirmOnBoth(holding(5), holding(6), { intent })).toEqual({ genesis: "g", intent: digest(bytes), announcer: undefined });
  });
});

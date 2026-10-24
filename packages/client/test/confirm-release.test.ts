import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { blobLayout, buildAnnounceDelivery, Kind, NATIVE_MINT, sealDeliveryV4 } from "@intent-engine/core";
import { ConfirmMismatch, confirmOnBoth, createClient, NO_ACCOUNT, nodeView, REFUSED, type Transport } from "../src/index.js";
import { world } from "./svm.js";
import { announced, fundedSigner, keyed, LOCAL, nativeMint, sha, specHash, workUrl } from "./work.js";

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

  it("compares the book, the announcements up to the first opening and the opening itself, and agrees on a refusal both nodes share", async () => {
    const w = await world();
    nativeMint(w);
    const client = createClient({ url: LOCAL, transport: w.chain.transport });
    const judge = await keyed(w);
    const owner = await fundedSigner(w);
    const params = { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: specHash("the confirmed spec"), judgeFee: 0n } as const;
    const { intent } = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
    const [griefer, honest] = [await fundedSigner(w), await fundedSigner(w)];
    const blob = await sealDeliveryV4({ source: new Uint8Array(32).fill(4), url: workUrl("grief"), recipients: [judge.signer.address] }, intent, griefer.address);
    const wrapped = blobLayout(1, blob.length).wrapped;
    blob[wrapped] = (blob[wrapped] ?? 0) ^ 1;
    const { announcement: grief, instruction } = await buildAnnounceDelivery({ worker: griefer, intent, attestor: judge.signer.address, commitment: new Uint8Array(32).fill(7), blob });
    await client.send([instruction], griefer);
    const work = sha("the confirmed work");
    const made = await announced(client, honest, intent, work);
    const node = w.chain.transport;
    const target = { intent, attestor: judge.signer.address, sha256: work, keypair: judge.keypair };
    const agreed = await confirmOnBoth(node, node, { ...target, payees: [honest.address] });
    expect(agreed).toMatchObject({ announcer: `${honest.address} in ${made.announcement}`, book: "next seq 3 live 2" });
    expect(agreed.announcements).toHaveLength(2);
    const keyless = { ...target, keypair: undefined };
    const refused = await confirmOnBoth(node, node, keyless);
    expect(refused.announcer).toMatch(new RegExp(`^${REFUSED} key-not-given at ${grief} seq 1 by ${griefer.address} sealed to ${judge.signer.address} wallet [0-9a-f]+$`));
    expect(refused.announcements).toHaveLength(1);
    const unpaid = await confirmOnBoth(node, node, { ...keyless, payees: [honest.address] }).catch((error: unknown) => error);
    expect(unpaid).toMatchObject({ name: "ConfirmMismatch", field: "payee", second: refused.announcer });
    expect((unpaid as Error).message).toContain("both RPC nodes name no first opening");
    const listAll = node.engineAccounts as NonNullable<Transport["engineAccounts"]>;
    const hiding: Transport = { ...node, engineAccounts: async (filter) => (await listAll(filter)).filter(({ address }) => address !== made.announcement) };
    expect(await nodeView(hiding, target)).toMatchObject({ announcer: `${REFUSED} incomplete missing 2` });
    expect(await confirmOnBoth(node, hiding, target).catch((error: unknown) => error)).toMatchObject({ name: "ConfirmMismatch", field: "announcements", second: NO_ACCOUNT });
    expect(await confirmOnBoth(hiding, hiding, keyless)).toMatchObject({ announcer: `${REFUSED} incomplete missing 2` });
  });
});

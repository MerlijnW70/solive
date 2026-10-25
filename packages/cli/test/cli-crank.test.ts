import { createAddressWithSeed, type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import {
  AccountState,
  getTokenEncoder,
  getCloseAccountInstruction,
  getApproveInstruction,
  getTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { type Intent } from "@intent-engine/core";
import { findConfigPda, getConfigDecoder, findIntentPda, findVaultPda, INTENT_VERSION } from "@intent-engine/core/internal";
import { rentExemptMinimum } from "@intent-engine/client/internal";
import { crankAction, IMMUTABLE_OWNER, refundable, refundSeed, TOKEN_ACCOUNT_BYTES, UNFUNDED } from "../src/commands.js";
import { rentFor, rentRate } from "../src/agent/budget.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { costlyFunding, fundingRent } from "../src/crank.js";
import { ata, balance, cli, ESCROW, funded, h, NOW, send, transport, world } from "./harness.js";
import { createSwap } from "./cli-kit.js";

describe("cli against the deployed engine", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;
  let owner: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;
  let ownerInput: Address;

  beforeEach(async () => {
    ({ authority, feeRecipient, owner, inputMint, outputMint, ownerInput } = await world());
  });

  const create = (nonce: string, expiresAt: bigint) => createSwap(inputMint, outputMint, nonce, expiresAt);

  it("cranks expired intents to refunds and leaves cancelled ones to the wallet that paid for them", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    for (const [nonce, expiry] of [
      ["0", NOW + 10n],
      ["2", NOW + 3_600n],
    ] as const) {
      expect((await cli(create(nonce, expiry), { "owner.json": owner })).code).toBe(EXIT_OK);
    }
    await cli(["cancel", "--keypair", "owner.json", "--nonce", "2", "--yes"], { "owner.json": owner });
    expect((await cli(create("1", NOW + 3_600n), { "owner.json": owner })).code).toBe(EXIT_OK);
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const cranker = await funded();
    const dry = await cli(["crank", "--keypair", "c.json", "--dry-run"], { "c.json": cranker });
    const [i0] = await findIntentPda({ owner: owner.address, nonce: 0n });
    const [i2] = await findIntentPda({ owner: owner.address, nonce: 2n });
    expect(dry.json()).toEqual({
      now: (NOW + 10n).toString(),
      dryRun: true,
      untouched: 2,
      actions: [{ intent: i0, action: "expire" }],
    });
    const wet = (await cli(["crank", "--keypair", "c.json"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; signature?: string; error?: string }[];
    };
    expect(wet.actions.map((a) => [a.intent, a.action, typeof a.signature])).toEqual([[i0, "expire", "string"]]);
    expect(h.svm.getAccount(i0).exists).toBe(false);
    expect(h.svm.getAccount(i2).exists).toBe(true);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW);
    const own = (await cli(["crank", "--keypair", "owner.json"], { "owner.json": owner })).json() as typeof wet;
    expect(own.actions.map((a) => [a.intent, a.action, typeof a.signature])).toEqual([[i2, "close", "string"]]);
    expect(h.svm.getAccount(i2).exists).toBe(false);
    const again = (await cli(["crank", "--keypair", "c.json"], { "c.json": cranker })).json() as typeof wet;
    expect(again.actions).toEqual([]);
  });

  it("skips refunds that would make the cranker pay for a missing account unless told to fund them", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    await cli(create("0", NOW + 10n), { "owner.json": owner });
    const held = balance(ownerInput);
    const sink = await ata(authority, (await generateKeyPairSigner()).address, inputMint);
    await send(owner, [
      getTransferInstruction({ source: ownerInput, destination: sink, authority: owner, amount: held }),
      getCloseAccountInstruction({ account: ownerInput, destination: owner.address, owner }),
    ]);
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const cranker = await funded();
    const lamports = h.svm.getBalance(cranker.address);
    const [i0] = await findIntentPda({ owner: owner.address, nonce: 0n });
    const skipped = (await cli(["crank", "--keypair", "c.json"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; signature?: string; error?: string; skipped?: string }[];
    };
    expect(skipped.actions).toEqual([{ intent: i0, action: "expire", skipped: UNFUNDED }]);
    expect(h.svm.getBalance(cranker.address)).toBe(lamports);
    expect(h.svm.getAccount(ownerInput).exists).toBe(false);
    const costly = (await cli(["crank", "--keypair", "c.json", "--fund-accounts"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; skipped?: string }[];
    };
    const rent = await fundingRent(transport);
    expect(costly.actions).toEqual([{ intent: i0, action: "expire", skipped: costlyFunding(0n, rent) }]);
    expect(costlyFunding(0n, rent)).toBe(
      `recreating the owner's token account costs ${rent} lamports of rent, more than this intent's 0 lamport bounty; settle it with expire or close to pay that knowingly`,
    );
    expect(rent).toBe(rentFor(TOKEN_ACCOUNT_BYTES, await rentRate(transport)));
    expect(h.svm.getBalance(cranker.address)).toBe(lamports);
    const paid = await cli(["expire", "--keypair", "c.json", "--owner", owner.address, "--nonce", "0", "--yes"], { "c.json": cranker });
    expect(paid.code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(ESCROW);
  });

  it("funds a missing refund account in a crank run when the bounty covers its rent", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    const rent = await fundingRent(transport);
    const bounty = (rent - 1n).toString();
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", bounty, "--create-fee", "0"], { "a.json": authority });
    await cli(create("0", NOW + 10n), { "owner.json": owner });
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", rent.toString(), "--create-fee", "0"], { "a.json": authority });
    await cli(create("1", NOW + 10n), { "owner.json": owner });
    const sink = await ata(authority, (await generateKeyPairSigner()).address, inputMint);
    await send(owner, [
      getTransferInstruction({ source: ownerInput, destination: sink, authority: owner, amount: balance(ownerInput) }),
      getCloseAccountInstruction({ account: ownerInput, destination: owner.address, owner }),
    ]);
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const cranker = await funded();
    const [i0] = await findIntentPda({ owner: owner.address, nonce: 0n });
    const [i1] = await findIntentPda({ owner: owner.address, nonce: 1n });
    const run = (await cli(["crank", "--keypair", "c.json", "--fund-accounts"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; signature?: string; skipped?: string }[];
    };
    const by = new Map(run.actions.map((a) => [a.intent, a]));
    expect(typeof by.get(i1)?.signature).toBe("string");
    expect(h.svm.getAccount(i1).exists).toBe(false);
    expect(balance(ownerInput)).toBeGreaterThanOrEqual(ESCROW);
    const first = by.get(i0);
    expect(first?.signature !== undefined || first?.skipped === costlyFunding(rent - 1n, rent)).toBe(true);
  });

  it("records a failing crank action and carries on with the rest", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    await cli(create("0", NOW + 10n), { "owner.json": owner });
    await cli(create("1", NOW + 10n), { "owner.json": owner });
    const [i0] = await findIntentPda({ owner: owner.address, nonce: 0n });
    const [i1] = await findIntentPda({ owner: owner.address, nonce: 1n });
    const [vault0] = await findVaultPda({ intent: i0 });
    const frozen = h.svm.getAccount(vault0);
    if (!frozen.exists) {
      throw new Error("vault missing");
    }
    const data = new Uint8Array(frozen.data);
    data[108] = 2;
    h.svm.setAccount({ ...frozen, data });
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const cranker = await funded();
    const run = (await cli(["crank", "--keypair", "c.json"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; signature?: string; error?: string }[];
    };
    expect(run.actions.map((a) => [a.intent, a.action])).toEqual([
      [i0, "expire"],
      [i1, "expire"],
    ]);
    expect(run.actions[0]?.error).toMatch(/Custom|0x11/);
    expect(run.actions[0]?.signature).toBeUndefined();
    expect(typeof run.actions[1]?.signature).toBe("string");
    expect(h.svm.getAccount(i1).exists).toBe(false);
    expect(h.svm.getAccount(i0).exists).toBe(true);
  });

  it("refunds into a fresh account the owner holds when their own one cannot take it, only when told to fund it", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    const rent = await fundingRent(transport);
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", rent.toString(), "--create-fee", "0"], { "a.json": authority });
    await cli(create("0", NOW + 10n), { "owner.json": owner });
    const meddler = await funded();
    await send(owner, [
      getApproveInstruction({ source: ownerInput, delegate: meddler.address, owner, amount: 1n }),
    ]);
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const cranker = await funded();
    const [i0] = await findIntentPda({ owner: owner.address, nonce: 0n });
    const skipped = (await cli(["crank", "--keypair", "c.json"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; skipped?: string }[];
    };
    expect(skipped.actions).toEqual([{ intent: i0, action: "expire", skipped: UNFUNDED }]);
    const before = balance(ownerInput);
    const done = (await cli(["crank", "--keypair", "c.json", "--fund-accounts"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; signature?: string }[];
    };
    expect(done.actions.map((a) => [a.intent, typeof a.signature])).toEqual([[i0, "string"]]);
    expect(h.svm.getAccount(i0).exists).toBe(false);
    expect(balance(ownerInput)).toBe(before);
    const spare = await createAddressWithSeed({
      baseAddress: cranker.address,
      programAddress: TOKEN_PROGRAM_ADDRESS,
      seed: refundSeed(owner.address, inputMint),
    });
    expect(refundSeed(owner.address, inputMint)).toBe(owner.address.slice(0, 16) + inputMint.slice(0, 16));
    expect(balance(spare)).toBe(ESCROW);
    expect(h.svm.getBalance(spare)).toBe(rent);
    expect(rent).toBe(await rentExemptMinimum(transport, TOKEN_ACCOUNT_BYTES));
    expect(rent).toBe(h.svm.minimumBalanceForRentExemption(BigInt(TOKEN_ACCOUNT_BYTES)));
    await cli(create("1", NOW + 20n), { "owner.json": owner });
    clock.unixTimestamp = NOW + 20n;
    h.svm.setClock(clock);
    const lamports = h.svm.getBalance(cranker.address) ?? 0n;
    await cli(["crank", "--keypair", "c.json", "--fund-accounts"], { "c.json": cranker });
    expect(balance(spare)).toBe(2n * ESCROW);
    expect(lamports - (h.svm.getBalance(cranker.address) ?? 0n)).toBeLessThan(rent);
  });

  it("refuses to show an intent of a version it does not understand and names close-legacy", async () => {
    await cli(create("4", NOW + 3_600n), { "owner.json": owner });
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 4n });
    const account = h.svm.getAccount(intent);
    if (!account.exists) {
      throw new Error("intent missing");
    }
    const data = new Uint8Array(account.data);
    data[8 + 164] = INTENT_VERSION + 1;
    h.svm.setAccount({ ...account, data });
    const shown = await cli(["show", "intent", "--owner", owner.address, "--nonce", "4"], {});
    expect(shown.code).toBe(EXIT_FAILED);
    expect(shown.err).toContain(`this intent account is of version ${INTENT_VERSION + 1}; this SDK reads intent versions 1 to ${INTENT_VERSION} only. Close it with intent-engine close-legacy`);
  });

  it("sets the economics and pays an expiring cranker the bounty held by each intent", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    const economics = [
      "set-economics",
      "--keypair",
      "admin.json",
      "--yes",
      "--bounty",
      "90000",
      "--create-fee",
      "20000",
      "--kind-fees",
      "swap=3,attested=9",
      "--partner-cut",
      "2000",
    ];
    expect((await cli(economics, { "admin.json": owner })).code).toBe(EXIT_FAILED);
    expect((await cli(economics, { "admin.json": authority })).code).toBe(EXIT_OK);
    const [configAddress] = await findConfigPda();
    const view = await transport.getAccount(configAddress);
    const config = getConfigDecoder().decode(view?.data ?? new Uint8Array());
    expect(config).toMatchObject({
      crankBounty: 90_000,
      createFee: 20_000,
      kindFeeMask: 0b1_0010,
      partnerCutBps: 2_000,
    });
    expect(Array.from(config.kindFeeBps)).toEqual([3, 0, 0, 9]);
    const treasury = h.svm.getBalance(feeRecipient.address) ?? 0n;
    await cli(create("0", NOW + 10n), { "owner.json": owner });
    expect(h.svm.getBalance(feeRecipient.address)).toBe(treasury + 20_000n);
    const shown = (await cli(["show", "intent", "--owner", owner.address, "--nonce", "0"], {})).json();
    expect(shown["bounty"]).toBe(90_000);
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const cranker = await funded();
    const before = h.svm.getBalance(cranker.address) ?? 0n;
    await cli(["crank", "--keypair", "c.json"], { "c.json": cranker });
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 0n });
    expect(h.svm.getAccount(intent).exists).toBe(false);
    expect(h.svm.getBalance(cranker.address)).toBe(before + 90_000n - 5_000n);
  });

  const kindFees = (fees: string) => ["set-economics", "--keypair", "admin.json", "--yes", "--bounty", "0", "--create-fee", "0", "--kind-fees", fees];

  const kindFeeBps = async () => {
    const [configAddress] = await findConfigPda();
    const view = await transport.getAccount(configAddress);
    return Array.from(getConfigDecoder().decode(view?.data ?? new Uint8Array()).kindFeeBps);
  };

  it("set economics accepts attested up to 300 bps", async () => {
    const sent = h.wires.length;
    const over = await cli(kindFees("attested=301"), { "admin.json": authority });
    expect(over).toMatchObject({ code: EXIT_USAGE, err: "--kind-fees attested must be an integer from 0 to 300 bps" });
    expect(h.wires).toHaveLength(sent);
    expect((await cli(kindFees("swap=100,limit=100,dutch=100,attested=300"), { "admin.json": authority })).code).toBe(EXIT_OK);
    expect(await kindFeeBps()).toEqual([100, 100, 100, 300]);
  });

  it("set economics refuses swap above 100 bps", async () => {
    const sent = h.wires.length;
    for (const [fees, name] of [
      ["swap=101", "swap"],
      ["swap=300,attested=300", "swap"],
      ["limit=101", "limit"],
      ["dutch=101", "dutch"],
    ] as const) {
      const refused = await cli(kindFees(fees), { "admin.json": authority });
      expect(refused).toMatchObject({ code: EXIT_USAGE, err: `--kind-fees ${name} must be an integer from 0 to 100 bps` });
    }
    expect(h.wires).toHaveLength(sent);
    expect(await kindFeeBps()).toEqual([0, 0, 0, 0]);
    expect((await cli(["update-config", "--keypair", "admin.json", "--yes", "--fee-bps", "101"], { "admin.json": authority })).code).toBe(
      EXIT_USAGE,
    );
  });
});

describe("refund targets", () => {
  it("accept a token account the owner holds outright, with no extension but immutable ownership", async () => {
    const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
    const owner = (await generateKeyPairSigner()).address;
    const mint = (await generateKeyPairSigner()).address;
    const engine = (await generateKeyPairSigner()).address;
    const base = Uint8Array.from(
      getTokenEncoder().encode({
        mint,
        owner,
        amount: 0n,
        delegate: null,
        state: AccountState.Initialized,
        isNative: null,
        delegatedAmount: 0n,
        closeAuthority: null,
      }),
    );
    const extended = (type: number) => {
      const data = new Uint8Array(170);
      data.set(base);
      data[165] = 2;
      data.set([type, 0, 0, 0], 166);
      return { owner: T22, data, lamports: 0n };
    };
    expect(IMMUTABLE_OWNER).toBe(7);
    expect(refundable({ owner: T22, data: base, lamports: 0n }, owner, mint, T22, engine)).toBe(true);
    expect(refundable(extended(7), owner, mint, T22, engine)).toBe(true);
    expect(refundable(extended(1), owner, mint, T22, engine)).toBe(false);
    const chained = (second: number) => {
      const data = new Uint8Array(178);
      data.set(base);
      data[165] = 2;
      data.set([7, 0, 4, 0, 7, 0, 0, 0, second, 0, 0, 0], 166);
      return { owner: T22, data, lamports: 0n };
    };
    expect(refundable(chained(7), owner, mint, T22, engine)).toBe(true);
    expect(refundable(chained(1), owner, mint, T22, engine)).toBe(false);
    expect(refundable({ owner: TOKEN_PROGRAM_ADDRESS, data: base, lamports: 0n }, owner, mint, T22, engine)).toBe(false);
    expect(refundable(null, owner, mint, T22, engine)).toBe(false);
  });
});

describe("crank decisions", () => {
  const PAYER = "SysvarRent111111111111111111111111111111111" as Address;
  const at = (status: number, expiresAt: bigint, version = 2) =>
    ({ status, expiresAt, version, rentPayer: PAYER }) as unknown as Intent;

  it("expires open intents from their deadline and closes settled ones, cancelled ones only for their payer", () => {
    expect(crankAction(at(0, 100n), 99n)).toBeUndefined();
    expect(crankAction(at(0, 100n), 100n)).toBe("expire");
    expect(crankAction(at(0, 100n), 101n)).toBe("expire");
    for (const status of [1, 3]) {
      expect(crankAction(at(status, 100n), 0n)).toBe("close");
    }
    expect(crankAction(at(2, 100n), 0n)).toBeUndefined();
    expect(crankAction(at(2, 100n), 0n, "11111111111111111111111111111112" as Address)).toBeUndefined();
    expect(crankAction(at(2, 100n), 0n, PAYER)).toBe("close");
    expect(crankAction(at(4, 100n), 1_000n)).toBeUndefined();
    expect(crankAction(at(9, 100n), 1_000n)).toBeUndefined();
  });

  it("leaves intents of a version it does not understand alone", () => {
    for (const version of [0, 1, 3, 255]) {
      expect(crankAction(at(0, 100n, version), 1_000n)).toBeUndefined();
      expect(crankAction(at(1, 100n, version), 1_000n)).toBeUndefined();
    }
  });
});

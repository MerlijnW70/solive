import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { formatAmount, Kind, NATIVE_MINT } from "@intent-engine/core";
import { splitFee } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { testSignature } from "@intent-engine/client/testing";
import { SIGNATURE_FEE } from "../src/agent/budget.js";
import { claimsOf, returnedOf, workOf } from "../src/agent/wallet/history-work.js";
import { profitOf } from "../src/agent/wallet/history-profit.js";
import { defaultWallet } from "../src/wallet.js";
import { createdFrom, fresh, ok, preset } from "./agent-wallet-kit.js";
import { approved } from "./approved.js";
import { FEE_BPS, h, HOME, NOW, setNow, transport, world } from "./harness.js";
import { HELD_PAY, HELD_SHARE } from "./held-kit.js";
import {
  announcedEvent,
  attestedEvent,
  cancelledEvent,
  claimedEvent,
  closedEvent,
  createdEvent,
  droppedEvent,
  expiredEvent,
  heldWorld,
  landed,
  leftEvent,
  movedEvent,
  pair,
  queuedEvent,
} from "./kill-cli-wallet-survivors-kit.js";

const newAddress = async (): Promise<Address> => (await generateKeyPairSigner()).address;

const outcomes = (claims: { intent: string; stake_outcome: string }[]) => Object.fromEntries(claims.map(({ intent, stake_outcome }) => [intent, stake_outcome]));

describe("the stake outcome of a claim, read in the order the chain landed it", () => {
  it("counts an end as later only when its slot is later, or its signature is when the slot is the same", async () => {
    await world();
    h.engineLog = [];
    const wallet = await newAddress();
    const [a, b, c, d, e, f] = [await newAddress(), await newAddress(), await newAddress(), await newAddress(), await newAddress(), await newAddress()] as [Address, Address, Address, Address, Address, Address];
    const sameTx = testSignature("same");
    const [bLow, bHigh] = pair("b-low", "b-high");
    const [cLow, cHigh] = pair("c-low", "c-high");
    const [dLow, dHigh] = pair("d-low", "d-high");
    const [eLow, eHigh] = pair("e-low", "e-high");
    const [fClaim, fLate, fEarly] = [testSignature("f-claim"), testSignature("f-late"), testSignature("f-early")];
    const transactions = [
      landed(sameTx, 10n, [claimedEvent(a, wallet), movedEvent(a, wallet, wallet, 0)]),
      landed(bLow, 20n, [claimedEvent(b, wallet)]),
      landed(bHigh, 20n, [movedEvent(b, wallet, wallet, 0)]),
      landed(cHigh, 21n, [claimedEvent(c, wallet)]),
      landed(cLow, 21n, [movedEvent(c, wallet, wallet, 0)]),
      landed(dLow, 31n, [claimedEvent(d, wallet)]),
      landed(dHigh, 30n, [movedEvent(d, wallet, wallet, 0)]),
      landed(eHigh, 40n, [claimedEvent(e, wallet)]),
      landed(eLow, 41n, [movedEvent(e, wallet, wallet, 0)]),
      landed(fClaim, 50n, [claimedEvent(f, wallet)]),
      landed(fLate, 60n, [movedEvent(f, wallet, wallet, 1)]),
      landed(fEarly, 55n, [movedEvent(f, wallet, wallet, 0)]),
    ];
    const { claims } = await claimsOf(transport, wallet, transactions, 20);
    expect(outcomes(claims)).toStrictEqual({ [a]: "unknown", [b]: "returned", [c]: "unknown", [d]: "unknown", [e]: "returned", [f]: "returned" });
  });

  it("follows a stand-by to the claim it was handed, and no other escrow's claim", async () => {
    await world();
    h.engineLog = [];
    const wallet = await newAddress();
    const [queued, other, handed, forfeited] = [await newAddress(), await newAddress(), await newAddress(), await newAddress()] as [Address, Address, Address, Address];
    const transactions = [
      landed("t1", 100n, [queuedEvent(queued, wallet)]),
      landed("t2", 110n, [claimedEvent(other, wallet)]),
      landed("t3", 120n, [movedEvent(other, wallet, wallet, 0)]),
      landed("t4", 130n, [queuedEvent(handed, wallet)]),
      landed("t5", 140n, [claimedEvent(handed, wallet)]),
      landed("t6", 150n, [movedEvent(handed, wallet, wallet, 1)]),
      landed("t7", 160n, [queuedEvent(forfeited, wallet)]),
      landed("t8", 170n, [droppedEvent(forfeited, wallet)]),
      landed("t9", 180n, [queuedEvent(forfeited, wallet)]),
      landed("t10", 190n, [leftEvent(forfeited, wallet)]),
    ];
    const { claims } = await claimsOf(transport, wallet, transactions, 20);
    const byAction = (intent: Address, action: string) => claims.find((claim) => claim.intent === intent && claim.action === action)?.stake_outcome;
    expect(byAction(queued, "queued")).toBe("unknown");
    expect(byAction(other, "claimed")).toBe("returned");
    expect(byAction(handed, "queued")).toBe("forfeited");
    expect(byAction(handed, "claimed")).toBe("forfeited");
    expect(byAction(forfeited, "dropped")).toBe("returned");
    expect(byAction(forfeited, "left")).toBe("returned");
  });

  it("reads an escrow's own history only for a stand-by or a stake moved without a claim, and only the escrows it must", async () => {
    await world();
    const wallet = await newAddress();
    const [claimedBoth, standing, loose] = [await newAddress(), await newAddress(), await newAddress()] as [Address, Address, Address];
    h.engineLog = [landed("h1", 60n, [claimedEvent(claimedBoth, wallet)]), landed("h2", 90n, [claimedEvent(standing, wallet)]), landed("h3", 95n, [claimedEvent(loose, wallet)])];
    const own = [landed("o1", 70n, [claimedEvent(claimedBoth, wallet), movedEvent(claimedBoth, wallet, wallet, 0)]), landed("o2", 80n, [queuedEvent(standing, wallet)]), landed("o3", 96n, [movedEvent(loose, wallet, wallet, 0)])];
    const { claims } = await claimsOf(transport, wallet, own, 20);
    expect(claims.map(({ intent, action }) => `${action}:${intent}`).sort()).toStrictEqual(
      [`claimed:${claimedBoth}`, `queued:${standing}`, `claimed:${standing}`, `claimed:${loose}`].sort(),
    );
  });

  it("asks for the claim board only of a claim with an unknown stake, and the escrow's account only of a stand-by", async () => {
    await world();
    h.engineLog = [];
    const wallet = await newAddress();
    const [claimed, standing] = [await newAddress(), await newAddress()] as [Address, Address];
    const read: string[] = [];
    const spied: Transport = {
      ...transport,
      getAccount: async (address) => {
        read.push(address);
        return transport.getAccount(address);
      },
      getAccounts: async (addresses) => {
        read.push(...addresses);
        return transport.getAccounts(addresses);
      },
    };
    await claimsOf(spied, wallet, [landed("s1", 130n, [claimedEvent(claimed, wallet)]), landed("s2", 131n, [queuedEvent(standing, wallet)])], 20);
    expect(read).toContain(standing);
    expect(read).not.toContain(claimed);
  });

  it("lists everything it was given when no filter is passed, and says there is more only past the limit", async () => {
    await world();
    h.engineLog = [];
    const wallet = await newAddress();
    const judge = await newAddress();
    const [first, second] = [await newAddress(), await newAddress()] as [Address, Address];
    const tokens = async () => "0";
    const announces = [landed("w1", 12n, [announcedEvent(first, first, wallet, judge)]), landed("w2", 11n, [announcedEvent(second, second, wallet, judge)])];
    const all = await workOf(transport, wallet, announces, 2, tokens);
    expect(all.more).toBe(false);
    expect(all.work.map(({ intent }) => intent)).toStrictEqual([first, second]);
    const one = await workOf(transport, wallet, announces, 1, tokens);
    expect(one.more).toBe(true);
    expect(one.work.map(({ intent }) => intent)).toStrictEqual([first]);
    const claimTxs = [landed("c1", 12n, [claimedEvent(first, wallet)]), landed("c2", 11n, [claimedEvent(second, wallet)])];
    const every = await claimsOf(transport, wallet, claimTxs, 2);
    expect([every.more, every.claims.map(({ intent }) => intent)]).toStrictEqual([false, [first, second]]);
    const newest = await claimsOf(transport, wallet, claimTxs, 1);
    expect([newest.more, newest.claims.map(({ intent }) => intent)]).toStrictEqual([true, [first]]);
  });
});

describe("why announced work was not paid", () => {
  async function opened() {
    const w = await world();
    h.engineLog = [];
    const judge = await newAddress();
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: new Uint8Array(32).fill(7), judgeFee: 0n } as const;
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    return { intent, judge };
  }

  it("calls an escrow open until the second its expiry reaches the chain clock", async () => {
    const { intent, judge } = await opened();
    const wallet = await newAddress();
    const announce = [landed("u1", 5n, [announcedEvent(intent, intent, wallet, judge)])];
    const reason = async () => (await workOf(transport, wallet, announce, 5, async () => "0")).work[0]?.unpaid_reason;
    setNow(NOW + 3_599n);
    expect(await reason()).toBe("open");
    setNow(NOW + 3_600n);
    expect(await reason()).toBe("expired");
    setNow(NOW + 3_601n);
    expect(await reason()).toBe("expired");
  });

  it("names how a closed escrow ended from the events of that escrow, not of another", async () => {
    await world();
    const wallet = await newAddress();
    const [ended, other, owner, judge] = [await newAddress(), await newAddress(), await newAddress(), await newAddress()] as [Address, Address, Address, Address];
    h.engineLog = [landed("e1", 9n, [cancelledEvent(other, owner)]), landed("e2", 8n, [announcedEvent(ended, ended, owner, judge)]), landed("e3", 7n, [expiredEvent(ended, owner)])];
    const announce = [landed("e4", 3n, [announcedEvent(ended, ended, wallet, judge)])];
    expect((await workOf(transport, wallet, announce, 5, async () => "0")).work[0]?.unpaid_reason).toBe("expired");
    h.engineLog = [landed("e5", 8n, [announcedEvent(ended, ended, owner, judge)]), landed("e6", 7n, [cancelledEvent(ended, owner)])];
    expect((await workOf(transport, wallet, announce, 5, async () => "0")).work[0]?.unpaid_reason).toBe("cancelled");
    h.engineLog = [landed("e7", 8n, [announcedEvent(ended, ended, owner, judge)])];
    expect((await workOf(transport, wallet, announce, 5, async () => "0")).work[0]?.unpaid_reason).toBe("unknown");
  });
});

describe("the profit of a resold job, to the lamport", () => {
  async function profit(jobNet: bigint) {
    await world();
    preset(NATIVE_MINT);
    const [wallet, job, spent, bountied, other, judgePayee, firstPayee, jobPayee] = [
      await newAddress(),
      await newAddress(),
      await newAddress(),
      await newAddress(),
      await newAddress(),
      await newAddress(),
      await newAddress(),
      await newAddress(),
    ] as Address[] as [Address, Address, Address, Address, Address, Address, Address, Address];
    void judgePayee;
    h.engineLog = [
      landed("p1", 30n, [attestedEvent(job, other, jobPayee, jobNet, 0n, 0n)], { tokens: [{ account: jobPayee, mint: NATIVE_MINT, owner: wallet }] }),
      landed("p2", 28n, [closedEvent(bountied, wallet, wallet, 77)], { feePayer: other }),
      landed("p3", 27n, [createdEvent(bountied, wallet, 0)], { feePayer: other }),
      landed("p4", 25n, [closedEvent(spent, wallet, other, 40)], { feePayer: wallet }),
      landed("p5", 20n, [attestedEvent(spent, wallet, firstPayee, 500n, 30n, 20n)], { feePayer: wallet, tokens: [{ account: firstPayee, mint: NATIVE_MINT, owner: other }] }),
      landed("p6", 10n, [createdEvent(spent, wallet, 100)], { feePayer: wallet }),
    ];
    return profitOf(transport, wallet, job, [spent, bountied]);
  }

  it("adds the create fee, the bounty others collected and the fee of each transaction the wallet paid, and shows a leading minus only below zero", async () => {
    const feesSol = 100n + 40n + 3n * SIGNATURE_FEE;
    const expected = (net: bigint, difference: string) => ({
      escrow: expect.any(String),
      token: "SOL",
      received: formatAmount(net, 9),
      paid_out: formatAmount(500n, 9),
      fees: formatAmount(50n, 9),
      fees_sol: formatAmount(feesSol, 9),
      rent_sol: "0",
      difference,
      escrows: expect.any(Array),
    });
    const even = 500n + 50n + feesSol;
    expect(await profit(even)).toStrictEqual(expected(even, "0"));
    expect(await profit(even - 1n)).toStrictEqual(expected(even - 1n, "-0.000000001"));
    expect(await profit(even + 1n)).toStrictEqual(expected(even + 1n, "0.000000001"));
  });
});

describe("a split share the escrow's close returned to its owner", () => {
  it("reads what came back from the release and the close", async () => {
    const world_ = await heldWorld();
    const { through, made, close } = world_;
    expect(await returnedOf(through, made.intent)).toStrictEqual({ amount: HELD_SHARE, close });
  });

  it("takes the returned share off what the job paid this wallet", async () => {
    const { through, made, wallet } = await heldWorld();
    const shown = await profitOf(through, wallet, made.intent, []);
    expect(shown).toMatchObject({ received: "0", paid_out: "0", fees: "0", difference: "0", escrows: [] });
  });

  it("takes the returned share off what a paid_from escrow paid out", async () => {
    const { through, made } = await heldWorld();
    const job = await newAddress();
    const jobPayee = await newAddress();
    const paid = [
      landed("j1", 99n, [attestedEvent(job, await newAddress(), jobPayee, 1_000n, 0n, 0n)], { tokens: [{ account: jobPayee, mint: made.mint, owner: made.owner.address }] }),
    ];
    const via = {
      ...through,
      signaturesOf: undefined,
      transactionsOf: undefined,
      transactionOf: undefined,
      engineTransactions: async (limit: number, of?: Address) => (of === job ? paid : through.engineTransactions(limit, of)),
    } as unknown as Transport;
    const shown = await profitOf(via, made.owner.address, job, [made.intent]);
    const { net, fee } = splitFee(HELD_PAY, FEE_BPS);
    expect(shown).toMatchObject({ received: formatAmount(1_000n, 6), paid_out: formatAmount(net - HELD_SHARE, 6), fees: formatAmount(fee, 6) });
  });

  it("shows the returned share on the owner's activity and on no other", async () => {
    const { client, made, close } = await heldWorld();
    h.files.set(defaultWallet(HOME), JSON.stringify(Array.from(h.keypairs.get(made.owner.address) ?? [])));
    const seen = await ok(client, "wallet_history");
    expect(seen["activity"]).toMatchObject([{ intent: made.intent, outcome: "released", returned: formatAmount(HELD_SHARE, 6), returned_in: close }]);
  });
});

describe("what wallet_history narrows and says is left", () => {
  async function wallet() {
    const client = await fresh();
    const address = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(address);
    h.engineLog = [];
    const intents: Address[] = [];
    for (const hint of ["61", "62", "63"]) {
      const made = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: address, spec_hash: hint.repeat(32) }));
      intents.push(made["intent"] as Address);
    }
    const timed = (times: bigint[]) => intents.map((intent, i) => ({ ...createdFrom(intent), blockTime: times[i] ?? null })).reverse();
    return { client, address, intents, timed };
  }

  const shown = (value: Record<string, unknown>) => (value["activity"] as { intent: string }[]).map(({ intent }) => intent);

  it("looks past the newest escrows for one that ended before until, and for one after since", async () => {
    const { client, intents, timed } = await wallet();
    const [first, second] = intents as [Address, Address, Address];
    h.engineLog = timed([1_000n, 2_000n, 3_000n]);
    const before = await ok(client, "wallet_history", { limit: 1, until: "1500" });
    expect([shown(before), before["more"]]).toStrictEqual([[first], false]);
    h.engineLog = timed([3_000n, 2_000n, 500n]);
    const after = await ok(client, "wallet_history", { limit: 1, since: "1500" });
    expect([shown(after), after["more"]]).toStrictEqual([[second], true]);
    const both = await ok(client, "wallet_history", { limit: 1, since: "0", until: "9999" });
    expect(both["more"]).toBe(true);
  });

  it("says nothing is left when the limit is exactly the number of escrows, and something is when it is lower", async () => {
    const { client, intents, timed } = await wallet();
    h.engineLog = timed([1_000n, 2_000n, 3_000n]);
    const all = await ok(client, "wallet_history", { limit: 3 });
    expect([shown(all), all["more"]]).toStrictEqual([[...intents].reverse(), false]);
    expect(all["activity"]).toSatisfy((items: Record<string, unknown>[]) => items.every((item) => !("returned" in item) && !("returned_in" in item)));
    expect((await ok(client, "wallet_history", { limit: 2 }))["more"]).toBe(true);
  });

  it("keeps work announced at exactly the second since names", async () => {
    const { client, address, intents } = await wallet();
    const judge = await newAddress();
    h.engineLog = [landed("k1", 5n, [announcedEvent(intents[0] as Address, intents[0] as Address, address, judge)], { blockTime: 2_500n, feePayer: address })];
    expect(((await ok(client, "wallet_history", { since: "2500" }))["work"] as unknown[]).length).toBe(1);
    expect(((await ok(client, "wallet_history", { since: "2501" }))["work"] as unknown[]).length).toBe(0);
  });
});

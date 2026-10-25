import {
  type Address,
  generateKeyPairSigner,
  getAddressEncoder,
  type KeyPairSigner,
  lamports,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { LiteSVM } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind, splitFees } from "@intent-engine/core";
import {
  buildCreateIntent,
  requiredOut,
  findIntentPda,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "@intent-engine/core/internal";
import {
  cachedPricer,
  type Pricer,
  type QuoteRequest,
  RateLimited,
  ROUTE_ACCOUNT_BUDGETS,
  tooLarge,
  WAITING_FOR_TARGET,
} from "../src/index.js";
import {
  AMOUNT,
  deployEngine,
  type Engine,
  engineTools,
  LOOKUP_PROGRAM,
  MIN_OUT,
  NOW,
  stashMarket,
} from "./solver-engine.js";

let svm: LiteSVM;

describe("solver against the deployed engine", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;
  let owner: KeyPairSigner;
  let solver: KeyPairSigner;
  let stash: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;
  let receiver: Address;
  let solverInput: Address;
  let solverOutput: Address;
  let stashAccount: Address;
  let feeTo: Address;
  let intents: Address[];

  const engine = (): Engine => ({ svm, authority, feeRecipient, owner, solver, stash, inputMint, outputMint, receiver, solverInput, solverOutput, stashAccount, feeTo, intents });
  const { send, balance, chain, open, floors, solve } = engineTools(engine);

  beforeEach(async () => {
    ({ svm, authority, feeRecipient, owner, solver, stash, inputMint, outputMint, receiver, solverInput, solverOutput, stashAccount, feeTo, intents } = await deployEngine());
  });

  it("asks for a smaller route when a fill does not fit in one transaction, and skips it when none does", async () => {
    const intent = await open(17n);
    const unique = await Promise.all(Array.from({ length: 60 }, async () => ({ address: (await generateKeyPairSigner()).address, role: 0 })));
    const wide = { programAddress: TOKEN_PROGRAM_ADDRESS, accounts: unique, data: new Uint8Array([255]) };
    const long = { programAddress: TOKEN_PROGRAM_ADDRESS, accounts: [], data: new Uint8Array(1_000).fill(255) };
    let bloat: typeof wide | typeof long = long;
    const asked: (number | undefined)[] = [];
    const sized = (fits: (budget: number | undefined) => boolean): Pricer => ({
      async quote(request) {
        asked.push(request.maxAccounts);
        const q = await stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n).quote(request);
        return q === null || fits(request.maxAccounts) ? q : { ...q, instructions: [...q.instructions, bloat] };
      },
    });
    expect(ROUTE_ACCOUNT_BUDGETS).toEqual([40, 30, 20]);
    const smaller = await solve(sized((budget) => budget === 30));
    expect(asked).toEqual([40, 30]);
    expect(smaller.filled.map((f) => f.intent)).toEqual([intent]);
    const again = await open(18n);
    intents.length = 0;
    intents.push(again);
    asked.length = 0;
    bloat = wide;
    const never = await solve(sized(() => false));
    expect(asked).toEqual([40, 30, 20]);
    expect(never.filled).toEqual([]);
    expect(never.skipped).toHaveLength(1);
    expect(never.skipped[0]?.intent).toBe(again);
    expect(never.skipped[0]?.reason).toMatch(
      /^even the smallest route makes the fill lock \d+ accounts; a transaction holds 1232 bytes and 64 accounts$/,
    );
    expect(tooLarge(1300, 50)).toBe("even the smallest route makes the fill 1300 bytes with 50 accounts; a transaction holds 1232 bytes and 64 accounts");
    expect(tooLarge(null, 70)).toBe("even the smallest route makes the fill lock 70 accounts; a transaction holds 1232 bytes and 64 accounts");
    const third = await open(19n);
    intents.length = 0;
    intents.push(third);
    asked.length = 0;
    bloat = long;
    const heavy = await solve(sized(() => false));
    expect(asked).toEqual([40, 30, 20]);
    expect(heavy.skipped.map((s) => s.intent)).toEqual([third]);
    expect(heavy.skipped[0]?.reason).toMatch(/^even the smallest route makes the fill \d{4} bytes with \d+ accounts;/);
  });

  it("stops asking the market for the rest of a run once it is rate limited", async () => {
    const first = await open(20n);
    const second = await open(21n);
    let asked = 0;
    const limited: Pricer = {
      async quote() {
        asked += 1;
        throw new RateLimited();
      },
    };
    const report = await solve(limited, { concurrency: 1 });
    const reason = new RateLimited().message;
    expect(report).toEqual({
      filled: [],
      sent: [],
      skipped: [
        { intent: first, reason },
        { intent: second, reason },
      ],
      failed: [],
    });
    expect(asked).toBe(1);
  });

  const cachedMarket = (pay: { out: bigint }) => {
    const asked: (boolean | undefined)[] = [];
    const market = stashMarket(stash, stashAccount, outputMint, solverOutput, () => pay.out);
    const counted: Pricer = {
      quote: (request) => {
        asked.push(request.fresh);
        return market.quote(request);
      },
    };
    return { asked, pricer: cachedPricer(counted, { ttlMs: 10_000, clock: () => 0 }) };
  };

  const routeRequest = (): QuoteRequest => ({
    inputMint,
    outputMint,
    amountIn: splitFees(AMOUNT, 5, 0, 0).net,
    taker: solver.address,
    maxAccounts: ROUTE_ACCOUNT_BUDGETS[0],
  });

  it("builds a fill decided from a stored quote only from a fresh quote", async () => {
    const intent = await open(30n);
    const pay = { out: MIN_OUT + 4_000n };
    const { asked, pricer } = cachedMarket(pay);
    await pricer.quote(routeRequest());
    pay.out = MIN_OUT + 2_000n;
    const report = await solve(pricer);
    expect(report.failed).toEqual([]);
    expect(report.filled).toEqual([{ intent, profit: 2_000n, cost: expect.any(BigInt), signature: expect.any(String) }]);
    expect(asked).toEqual([undefined, true]);
    expect([balance(receiver), balance(solverOutput)]).toEqual([MIN_OUT, 2_000n]);
  });

  it("skips a fill decided from a stored quote when the fresh quote no longer pays", async () => {
    const intent = await open(31n);
    const pay = { out: MIN_OUT + 4_000n };
    const { asked, pricer } = cachedMarket(pay);
    await pricer.quote(routeRequest());
    pay.out = MIN_OUT - 1n;
    const report = await solve(pricer);
    expect(report).toEqual({
      filled: [],
      sent: [],
      skipped: [{ intent, reason: `the route pays ${MIN_OUT - 1n}, less than the ${MIN_OUT} the intent requires` }],
      failed: [],
    });
    expect(asked).toEqual([undefined, true]);
    expect([balance(receiver), balance(solverOutput)]).toEqual([0n, 0n]);
  });

  it("asks the market once for a fill from a quote that was not stored", async () => {
    const intent = await open(32n);
    const { asked, pricer } = cachedMarket({ out: MIN_OUT + 4_000n });
    const report = await solve(pricer);
    expect(report.filled).toEqual([{ intent, profit: 4_000n, cost: expect.any(BigInt), signature: expect.any(String) }]);
    expect(asked).toEqual([undefined]);
  });

  it("compresses the route through an on-chain lookup table", async () => {
    await open(7n);
    const table = (await generateKeyPairSigner()).address;
    const addresses = [stashAccount, outputMint, TOKEN_PROGRAM_ADDRESS, inputMint, receiver, feeTo];
    const data = new Uint8Array(56 + addresses.length * 32);
    new DataView(data.buffer).setUint32(0, 1, true);
    new DataView(data.buffer).setBigUint64(4, 0xffff_ffff_ffff_ffffn, true);
    addresses.forEach((a, i) => data.set(getAddressEncoder().encode(a), 56 + i * 32));
    svm.setAccount({
      address: table,
      data,
      executable: false,
      lamports: lamports(1_000_000_000n),
      programAddress: LOOKUP_PROGRAM,
      space: BigInt(data.length),
    });
    svm.warpToSlot(10n);
    const report = await solve(
      stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 3_000n, [table]),
    );
    expect(report.failed).toEqual([]);
    expect(report.filled).toHaveLength(1);
    expect(balance(receiver)).toBe(MIN_OUT);
  });

  it("waits on a falling auction below its profit target and fills it later, when it pays more", async () => {
    const params = { kind: Kind.DutchAuction, amountIn: AMOUNT, startOut: 100_000n, endOut: MIN_OUT, startTs: NOW, endTs: NOW + 600n } as const;
    await send(owner, [
      await buildCreateIntent({
        owner,
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce: 9n,
        params,
        expiresAt: NOW + 3_600n,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ]);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 9n });
    intents.push(intent);
    const out = 100_500n;
    const pricer = stashMarket(stash, stashAccount, outputMint, solverOutput, () => out);
    const strategy = { minProfit: floors(100n), maxFeeBps: 100, target: floors(5_000n) };
    const early = await solve(pricer, { strategy });
    expect(early.filled).toEqual([]);
    expect(early.failed).toEqual([]);
    expect(early.skipped).toEqual([{ intent, reason: `${WAITING_FOR_TARGET}: profit ${out - 100_000n} is below the target 5000` }]);
    expect([balance(receiver), balance(solverOutput)]).toEqual([0n, 0n]);
    const later = NOW + 300n;
    const clock = svm.getClock();
    clock.unixTimestamp = later;
    svm.setClock(clock);
    const required = requiredOut(params, AMOUNT, later);
    expect(required).toBe(95_000n);
    const filled = await solve(pricer, { strategy });
    expect(filled.failed).toEqual([]);
    expect(filled.filled).toEqual([{ intent, profit: out - required, cost: expect.any(BigInt), signature: expect.any(String) }]);
    expect(out - required).toBeGreaterThan(out - 100_000n);
    expect([balance(receiver), balance(solverOutput)]).toEqual([required, out - required]);
  });
});

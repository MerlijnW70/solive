import fc from "fast-check";
import type { Address, KeyPairSigner } from "@solana/kit";
import { getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { LiteSVM } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { feeBpsFor, type IntentParams, findAssociatedTokenAddress, Kind, splitFees } from "@intent-engine/core";
import {
  ALL_KINDS_MASK,
  buildCreateIntent,
  buildLowerPause,
  buildRaisePause,
  buildUpdateConfig,
  decodeParamsLoose,
  kindBit,
  PAUSE_FILL,
  remainingOf,
  requiredOut,
  findIntentPda,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "@intent-engine/core/internal";
import {
  compile,
  decide,
  fillInstructions,
  MAX_COMPUTE_UNITS,
} from "../src/index.js";
import {
  DIFFERENTIAL_RUNS,
  deployEngine,
  type Engine,
  engineTools,
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
  const { send, funded, ata, balance, chain, simulated, floors, solve } = engineTools(engine);

  beforeEach(async () => {
    ({ svm, authority, feeRecipient, owner, solver, stash, inputMint, outputMint, receiver, solverInput, solverOutput, stashAccount, feeTo, intents } = await deployEngine());
  });

  it("fills exactly what the program accepts and never spends on what the program refuses", async () => {
    const partner = await funded();
    await ata(authority, partner.address, inputMint);
    await send(authority, [
      getMintToInstruction({ mint: outputMint, token: stashAccount, mintAuthority: authority, amount: 1_000_000_000_000n }),
      getMintToInstruction({
        mint: inputMint,
        token: await findAssociatedTokenAddress({ owner: owner.address, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
        mintAuthority: authority,
        amount: 1_000_000_000_000n,
      }),
    ]);
    const setNow = (unix: bigint) => {
      const clock = svm.getClock();
      clock.unixTimestamp = unix;
      svm.setClock(clock);
    };
    const seen = new Map<string, number>();
    const enforced = ["fills are paused", "expired", "fills of this kind are stopped"];
    let paused = false;
    let nonce = 10n;
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          kind: fc.constantFrom(Kind.SwapExactIn, Kind.LimitOrder, Kind.DutchAuction),
          amount: fc.bigInt({ min: 1_000n, max: 1_000_000n }),
          ratio: fc.bigInt({ min: 1n, max: 200n }),
          feeBps: fc.integer({ min: 0, max: 100 }),
          partnerBps: fc.constantFrom(0, 1, 50, 100),
          pause: fc.integer({ min: 0, max: 7 }).map((n) => n === 0),
          stop: fc.integer({ min: 0, max: 7 }).map((n) => n === 0),
          age: fc.oneof({ weight: 6, arbitrary: fc.bigInt({ min: 0n, max: 3_599n }) }, { weight: 1, arbitrary: fc.bigInt({ min: 3_600n, max: 7_200n }) }),
          delta: fc.oneof({ weight: 5, arbitrary: fc.bigInt({ min: 0n, max: 5_000n }) }, { weight: 2, arbitrary: fc.bigInt({ min: -3n, max: 3n }) }),
          floor: fc.oneof({ weight: 5, arbitrary: fc.bigInt({ min: 0n, max: 200n }) }, { weight: 1, arbitrary: fc.bigInt({ min: 201n, max: 6_000n }) }),
          maxFeeBps: fc.oneof({ weight: 6, arbitrary: fc.constant(220) }, { weight: 2, arbitrary: fc.integer({ min: 0, max: 50 }) }),
        }),
        async (s) => {
          setNow(NOW);
          await send(authority, [
            await buildUpdateConfig({
              admin: authority,
              update: {
                guardian: authority.address,
                feeRecipient: feeRecipient.address,
                enabledKinds: ALL_KINDS_MASK,
                feeBps: s.feeBps,
                fillDisabledKinds: s.stop ? kindBit(s.kind) : 0n,
              },
            }),
            ...(s.pause === paused
              ? []
              : [s.pause ? await buildRaisePause({ authority, flags: PAUSE_FILL }) : await buildLowerPause({ admin: authority, flags: PAUSE_FILL })]),
          ]);
          paused = s.pause;
          const out = (s.amount * s.ratio) / 100n + 1n;
          const params: IntentParams =
            s.kind === Kind.SwapExactIn
              ? { kind: Kind.SwapExactIn, amountIn: s.amount, minOut: out }
              : s.kind === Kind.LimitOrder
                ? { kind: Kind.LimitOrder, makeAmount: s.amount, takeAmount: out }
                : { kind: Kind.DutchAuction, amountIn: s.amount, startOut: 2n * out, endOut: out, startTs: NOW, endTs: NOW + 3_600n };
          nonce += 1n;
          await send(owner, [
            await buildCreateIntent({
              owner,
              treasury: feeRecipient.address,
              maxCreateFee: MAX_CREATE_FEE,
              maxBounty: MAX_CRANK_BOUNTY,
              nonce,
              params,
              expiresAt: NOW + 3_600n,
              inputMint,
              outputMint,
              inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
              outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
              ...(s.partnerBps === 0 ? {} : { partner: { key: partner.address, bps: s.partnerBps } }),
            }),
          ]);
          const [address] = await findIntentPda({ owner: owner.address, nonce });
          intents = [address];
          const now = NOW + s.age;
          setNow(now);
          const config = await chain().config();
          const listed = await chain().intents();
          const intent = listed[0]?.intent;
          if (intent === undefined) {
            throw new Error("intent missing");
          }
          const decoded = decodeParamsLoose(intent.kind, Uint8Array.from(intent.params)) as IntentParams;
          const amountIn = remainingOf(intent);
          const required = requiredOut(decoded, amountIn, now);
          const pricer = stashMarket(stash, stashAccount, outputMint, solverOutput, () => {
            const paid = required + s.delta;
            return paid > 0n ? paid : 0n;
          });
          const strategy = { minProfit: floors(s.floor), maxFeeBps: s.maxFeeBps };
          const decision = await decide(address, intent, config, now, pricer, solver.address, strategy);
          const outcome = decision.kind === "fill" ? "fill" : decision.reason.replace(/[0-9]+/g, "N");
          seen.set(outcome, (seen.get(outcome) ?? 0) + 1);
          const before = { receiver: balance(receiver), solver: balance(solverOutput) };
          const report = await solve(pricer, { strategy });
          expect(report.failed, outcome).toEqual([]);
          if (decision.kind === "fill") {
            expect(report.filled.map((f) => f.intent), outcome).toEqual([address]);
            expect(balance(receiver) - before.receiver).toBe(decision.plan.required);
            expect(balance(solverOutput) - before.solver).toBe(decision.plan.profit);
            return;
          }
          expect(report.filled, outcome).toEqual([]);
          expect(balance(solverOutput)).toBe(before.solver);
          if (enforced.includes(decision.reason)) {
            const feeBps = feeBpsFor(config, intent.kind);
            const fees = splitFees(amountIn, feeBps, intent.partnerBps, intent.partnerCutBps);
            const route = await stashMarket(stash, stashAccount, outputMint, solverOutput, () => required + 1_000n).quote({
              inputMint: intent.inputMint,
              outputMint: intent.outputMint,
              amountIn: fees.net,
              taker: solver.address,
            });
            if (route === null) {
              throw new Error("no forced route");
            }
            const forced = await fillInstructions(
              { address, intent, amountIn, required, feeBps, fees, route, arbitrage: null, profit: 0n },
              {
                solver,
                feeRecipient: config.feeRecipient,
                inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
                outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
                computeUnits: MAX_COMPUTE_UNITS,
                unitPrice: 0n,
                createSolverInput: false,
                createSolverOutput: false,
                tip: null,
              },
            );
            const wire = await compile(forced, solver, await chain().blockhash(), {});
            expect((await simulated(wire)).err, outcome).not.toBeNull();
          }
        },
      ),
      { numRuns: DIFFERENTIAL_RUNS },
    );
    const reached = [...seen.keys()];
    for (const want of ["fill", "expired", "fills are paused", "fills of this kind are stopped", "profit N is below N"]) {
      expect(reached, `never reached: ${want}`).toContain(want);
    }
    expect(reached.some((r) => r.startsWith("the route pays N, less than")), "never reached a short route").toBe(true);
    expect(reached.some((r) => r.startsWith("fees of N bps exceed")), "never reached the fee bound").toBe(true);
    expect(seen.get("fill") ?? 0).toBeGreaterThan(DIFFERENTIAL_RUNS / 12);
  }, 600_000);
});

import { claimsOf } from "../src/agent/claims.js";
import { writeFile } from "node:fs/promises";
import {
  type Address,
  type Blockhash,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  type Instruction,
  type KeyPairSigner,
  partiallySignTransaction,
  signBytes,
} from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTokenDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  buildCancelIntent,
  buildCloseIntent,
  buildCreateIntent,
  buildExpireIntent,
  buildFillIntent,
  buildFlashFill,
  buildInitUser,
  buildRevokeMandate,
  type Config,
  feeBpsFor,
  findAssociatedTokenAddress,
  findConfigPda,
  findIntentPda,
  findMandatePda,
  findVaultPda,
  getConfigDecoder,
  getIntentDecoder,
  type IntentParams,
  IntentStatus,
  Kind,
  splitFee,
} from "@intent-engine/core";
import { chainTime, type RpcLike, rpcTransport, type Transport } from "@intent-engine/client";
import { agentServer } from "../src/agent/mcp.js";
import { budgetOf } from "../src/agent/budget.js";
import { relayOf } from "../src/agent/relay.js";
import { loadKeypairFile } from "../src/main.js";

const url = process.env["DEVNET_RPC"];
const keypair = process.env["DEVNET_KEYPAIR"];
const minutes = Number(process.env["SOAK_MINUTES"] ?? "0");
const reportPath = process.env["SOAK_REPORT"];
const keysPath = process.env["SOAK_KEYS"];
const seed = Number(process.env["SOAK_SEED"] ?? Date.now() % 2 ** 31);
const TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const OWNERS = 3;
const OWNER_TOKENS = 10_000_000n;
const SOLVER_TOKENS = 1_000_000_000n;
const OWNER_LAMPORTS = 150_000_000n;
const SOLVER_LAMPORTS = 100_000_000n;
const AGENT_LAMPORTS = 200_000_000n;
const SAFETY_SECONDS = 15n;
const CHECK_EVERY = 5;
const SIGNATURE_FEE = 5_000n;

async function savableKey(): Promise<{ signer: KeyPairSigner; secret: number[] }> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as { privateKey: CryptoKey; publicKey: CryptoKey };
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const secret = [...pkcs8.slice(-32), ...raw];
  return { signer: await createKeyPairSignerFromBytes(new Uint8Array(secret)), secret };
}

type Outcome = "open" | "filled" | "refunded";
type Origin = "plain" | "signed" | "agent";

type Record_ = {
  world: World;
  owner: KeyPairSigner;
  nonce: bigint;
  intent: Address;
  kind: number;
  params: IntentParams;
  escrow: bigint;
  expiresAt: bigint;
  origin: Origin;
  rentPayer: Address;
  mandate: Address | null;
  outcome: Outcome;
  amountOut: bigint;
  fee: bigint;
  closed: boolean;
  revoked: boolean;
  superseded: boolean;
};

type World = {
  name: string;
  tokenProgram: Address;
  inputMint: Address;
  outputMint: Address;
  ownerInputs: Address[];
  receivers: Address[];
  solverInput: Address;
  solverOutput: Address;
  feeAccount: Address;
  feeStart: bigint;
  mandates: (Address | null)[];
  mandateIds: (bigint | null)[];
};

function rng(start: number) {
  let s = start >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(url === undefined || keypair === undefined || !(minutes > 0))("devnet soak", () => {
  it(`runs random engine traffic for ${minutes} minutes against a model`, async () => {
    const random = rng(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const between = (lo: bigint, hi: bigint) => lo + BigInt(Math.floor(random() * Number(hi - lo + 1n)));
    const rpc = createSolanaRpc(url ?? "");
    const transport: Transport = rpcTransport(rpc as unknown as RpcLike);
    const payer = (await loadKeypairFile(keypair ?? "")) as KeyPairSigner;
    const report = {
      seed,
      minutes,
      startedAt: new Date().toISOString(),
      steps: 0,
      checks: 0,
      ops: {} as Record<string, { ok: number; refused: number; unexpected: number }>,
      anomalies: [] as { step: number; op: string; detail: string }[],
      violations: [] as { step: number; detail: string }[],
      latencyMs: [] as number[],
      lamports: { payerStart: 0n, payerEnd: 0n },
    };
    const tally = (op: string, result: "ok" | "refused" | "unexpected") => {
      report.ops[op] ??= { ok: 0, refused: 0, unexpected: 0 };
      report.ops[op][result] += 1;
    };
    const timed = async <T>(work: () => Promise<T>) => {
      const started = Date.now();
      try {
        return await work();
      } finally {
        report.latencyMs.push(Date.now() - started);
      }
    };
    const send = (signer: KeyPairSigner, ixs: Instruction[]) => timed(() => transport.send(ixs, signer));
    const lamportsOf = async (address: Address) => (await transport.getAccount(address))?.lamports ?? 0n;
    const tokens = async (account: Address) => {
      const view = await transport.getAccount(account);
      return view === null ? 0n : getTokenDecoder().decode(view.data).amount;
    };
    report.lamports.payerStart = await lamportsOf(payer.address);

    const [configAddress] = await findConfigPda();
    const configView = await transport.getAccount(configAddress);
    if (configView === null) {
      throw new Error("config is not initialised on this cluster");
    }
    const config: Config = getConfigDecoder().decode(configView.data);
    const saved: { address: Address; secret: number[] }[] = [];
    const fund = async (lamports: bigint) => {
      const { signer: kp, secret } = await savableKey();
      saved.push({ address: kp.address, secret });
      if (keysPath !== undefined) {
        await writeFile(keysPath, JSON.stringify(saved));
      }
      await send(payer, [getTransferSolInstruction({ source: payer, destination: kp.address, amount: lamports })]);
      return kp;
    };
    const owners: KeyPairSigner[] = [];
    for (let i = 0; i < OWNERS; i++) {
      owners.push(await fund(OWNER_LAMPORTS));
    }
    const solver = await fund(SOLVER_LAMPORTS);
    const agent = await fund(AGENT_LAMPORTS);
    for (const owner of owners) {
      await send(owner, [await buildInitUser({ owner })]);
    }

    const makeWorld = async (name: string, tokenProgram: Address): Promise<World> => {
      const mint = async () => {
        const m = await generateKeyPairSigner();
        const space = BigInt(getMintSize());
        const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
        await send(payer, [
          getCreateAccountInstruction({ payer, newAccount: m, lamports: rent, space, programAddress: tokenProgram }),
          getInitializeMint2Instruction({ mint: m.address, decimals: 6, mintAuthority: payer.address }, { programAddress: tokenProgram }),
        ]);
        return m.address;
      };
      const ata = async (owner: Address, m: Address, amount: bigint) => {
        const address = await findAssociatedTokenAddress({ owner, mint: m, tokenProgram });
        await send(payer, [
          await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: m, tokenProgram }),
          ...(amount > 0n ? [getMintToInstruction({ mint: m, token: address, mintAuthority: payer, amount }, { programAddress: tokenProgram })] : []),
        ]);
        return address;
      };
      const inputMint = await mint();
      const outputMint = await mint();
      const ownerInputs = [];
      const receivers = [];
      for (const owner of owners) {
        ownerInputs.push(await ata(owner.address, inputMint, OWNER_TOKENS));
        receivers.push(await ata(owner.address, outputMint, 0n));
      }
      const feeAccount = await ata(config.feeRecipient, inputMint, 0n);
      return {
        name,
        tokenProgram,
        inputMint,
        outputMint,
        ownerInputs,
        receivers,
        solverInput: await ata(solver.address, inputMint, 0n),
        solverOutput: await ata(solver.address, outputMint, SOLVER_TOKENS),
        feeAccount,
        feeStart: await tokens(feeAccount),
        mandates: owners.map(() => null),
        mandateIds: owners.map(() => null),
      };
    };
    const worlds = [await makeWorld("spl", TOKEN_PROGRAM_ADDRESS), await makeWorld("token-2022", TOKEN_2022_PROGRAM_ADDRESS)];

    const relay = relayOf(payer, {
      maxLamports: 1_000_000_000n,
      maxTtl: 7_200n,
      perHour: 100_000,
      hourlyLamports: 100_000_000_000n,
      fees: new Map(worlds.map((w) => [w.inputMint, 0n])),
    });
    const [near, far] = InMemoryTransport.createLinkedPair();
    await agentServer({ transport, relay, agent: { signer: agent, budget: budgetOf(100_000_000_000n), owners: new Set(owners.map((o) => o.address)) }, claims: claimsOf() }).connect(near);
    const client = new Client({ name: "soak", version: "0.0.0" });
    await client.connect(far);
    const call = async (name: string, args: object) => {
      const result = await timed(() => client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> }));
      if (result.isError === true) {
        throw new Error(`${name}: ${JSON.stringify(result.structuredContent)}`);
      }
      return result.structuredContent as Record<string, any>;
    };
    const execute = async (prepared: { transaction: string; last_valid_block_height: string }, signer: KeyPairSigner) => {
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction));
      const signed = await partiallySignTransaction([signer.keyPair], tx);
      const latest = { blockhash: "" as Blockhash, lastValidBlockHeight: BigInt(prepared.last_valid_block_height) };
      await timed(() => transport.sendWire(getBase64EncodedWireTransaction(signed), latest));
    };

    const records: Record_[] = [];
    const nextNonce = owners.map(() => 0n);
    let step = 0;
    const anomaly = (op: string, error: unknown) => {
      tally(op, "unexpected");
      report.anomalies.push({ step, op, detail: (error instanceof Error ? error.message : String(error)).slice(0, 600) });
    };
    const refusedAsExpected = async (op: string, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch {
        tally(op, "refused");
        return;
      }
      report.anomalies.push({ step, op, detail: "an operation the engine must refuse was accepted" });
      tally(op, "unexpected");
    };
    const ownerIndex = (owner: KeyPairSigner) => owners.indexOf(owner);
    const chainStatus = async (r: Record_) => {
      const view = await transport.getAccount(r.intent);
      return view === null ? null : getIntentDecoder().decode(view.data);
    };
    const common = (w: World) => ({
      inputMint: w.inputMint,
      outputMint: w.outputMint,
      inputTokenProgram: w.tokenProgram,
      outputTokenProgram: w.tokenProgram,
    });
    const randomParams = (now: bigint, expiresAt: bigint): IntentParams => {
      const amount = between(100n, 5_000n);
      const floor = amount / 100n + 1n;
      const kind = pick([Kind.SwapExactIn, Kind.LimitOrder, Kind.DutchAuction] as const);
      if (kind === Kind.SwapExactIn) {
        return { kind, amountIn: amount, minOut: between(floor, amount * 2n) };
      }
      if (kind === Kind.LimitOrder) {
        return { kind, makeAmount: amount, takeAmount: between(floor, amount * 2n) };
      }
      const endOut = between(floor, amount);
      return { kind, amountIn: amount, startOut: endOut + between(0n, amount), endOut, startTs: now, endTs: expiresAt };
    };
    const escrowOf = (p: IntentParams) => ("makeAmount" in p ? p.makeAmount : (p as { amountIn: bigint }).amountIn);
    const paysAtLeast = (p: IntentParams) =>
      p.kind === Kind.SwapExactIn ? p.minOut : p.kind === Kind.LimitOrder ? p.takeAmount : p.kind === Kind.DutchAuction ? p.startOut : 0n;
    const belowFloor = (p: IntentParams) =>
      p.kind === Kind.SwapExactIn ? p.minOut - 1n : p.kind === Kind.LimitOrder ? p.takeAmount - 1n : p.kind === Kind.DutchAuction ? p.endOut - 1n : 0n;
    const toOrder = (p: IntentParams) =>
      p.kind === Kind.SwapExactIn
        ? { kind: "swap", amount_in: p.amountIn.toString(), min_out: p.minOut.toString() }
        : p.kind === Kind.LimitOrder
          ? { kind: "limit", make_amount: p.makeAmount.toString(), take_amount: p.takeAmount.toString() }
          : p.kind === Kind.DutchAuction
            ? {
                kind: "dutch",
                amount_in: p.amountIn.toString(),
                start_out: p.startOut.toString(),
                end_out: p.endOut.toString(),
                start_time: p.startTs.toString(),
                end_time: p.endTs.toString(),
              }
            : null;
    const lifetime = () => (random() < 0.4 ? between(30n, 90n) : between(1_200n, 3_000n));

    const createPlain = async (w: World, owner: KeyPairSigner) => {
      const i = ownerIndex(owner);
      const now = await chainTime(transport);
      const expiresAt = now + lifetime();
      const params = randomParams(now, expiresAt);
      const nonce = nextNonce[i] ?? 0n;
      nextNonce[i] = nonce + 1n;
      records.push(await newRecord(w, owner, nonce, params, expiresAt, "plain", owner.address, null));
      await send(owner, [
        await buildCreateIntent({ ...common(w), owner, treasury: config.feeRecipient, maxCreateFee: config.createFee, maxBounty: config.crankBounty, nonce, params, expiresAt }),
      ]);
    };
    const newRecord = async (
      w: World,
      owner: KeyPairSigner,
      nonce: bigint,
      params: IntentParams,
      expiresAt: bigint,
      origin: Origin,
      rentPayer: Address,
      mandate: Address | null,
    ): Promise<Record_> => {
      const [intent] = await findIntentPda({ owner: owner.address, nonce });
      for (const earlier of records.filter((r) => r.intent === intent && !r.superseded)) {
        report.violations.push({
          step,
          detail: `${intent} (nonce ${nonce} of ${owner.address}) was created a second time; every intent address must be used once`,
        });
        earlier.superseded = true;
      }
      return fresh(w, owner, nonce, intent, params, expiresAt, origin, rentPayer, mandate);
    };
    const fresh = (
      w: World,
      owner: KeyPairSigner,
      nonce: bigint,
      intent: Address,
      params: IntentParams,
      expiresAt: bigint,
      origin: Origin,
      rentPayer: Address,
      mandate: Address | null,
    ): Record_ => ({
      world: w,
      owner,
      nonce,
      intent,
      kind: params.kind,
      params,
      escrow: escrowOf(params),
      expiresAt,
      origin,
      rentPayer,
      mandate,
      outcome: "open",
      amountOut: 0n,
      fee: 0n,
      closed: false,
      revoked: false,
      superseded: false,
    });
    const createSigned = async (w: World, owner: KeyPairSigner) => {
      const now = await chainTime(transport);
      const expiresIn = lifetime() + 60n;
      const params = randomParams(now, now + expiresIn);
      const prepared = await call("prepare_signed_intent", {
        owner: owner.address,
        input_mint: w.inputMint,
        output_mint: w.outputMint,
        order: toOrder(params),
        expires_in: Number(expiresIn),
        submit_within: 600,
      });
      await execute(prepared["setup"], owner);
      const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])));
      await call("submit_signed_intent", { ...prepared["submit"], signature });
      const nonce = BigInt(prepared["nonce"]);
      const i = ownerIndex(owner);
      nextNonce[i] = (nextNonce[i] ?? 0n) > nonce ? (nextNonce[i] ?? 0n) : nonce + 1n;
      records.push(await newRecord(w, owner, nonce, params, BigInt(prepared["expires_at"]), "signed", payer.address, null));
    };
    const grant = async (w: World, owner: KeyPairSigner) => {
      const granted = await call("prepare_mandate", {
        owner: owner.address,
        agent: agent.address,
        input_mint: w.inputMint,
        output_mint: w.outputMint,
        kinds: ["swap", "limit", "dutch"],
        per_intent: "10000",
        total: "1000000",
        max_intents: 100_000,
        max_ttl: 3_600,
        valid_for: Math.ceil(minutes * 60) + 3_600,
        floor: { out: "1", in: "1000" },
      });
      await execute(granted["prepared"], owner);
      const i = ownerIndex(owner);
      w.mandateIds[i] = BigInt(granted["id"]);
      w.mandates[i] = granted["mandate"] as Address;
    };
    const createByAgent = async (w: World, owner: KeyPairSigner) => {
      const i = ownerIndex(owner);
      if (w.mandates[i] === null) {
        await grant(w, owner);
        tally("grant", "ok");
      }
      const now = await chainTime(transport);
      const expiresIn = between(60n, 1_800n);
      const params = randomParams(now, now + expiresIn);
      const made = await call("agent_create", {
        owner: owner.address,
        id: (w.mandateIds[i] ?? 0n).toString(),
        order: toOrder(params),
        expires_in: Number(expiresIn),
      });
      records.push(
        await newRecord(w, owner, BigInt(made["nonce"]), params, BigInt(made["expires_at"]), "agent", agent.address, w.mandates[i] ?? null),
      );
    };
    const fillOf = async (r: Record_, amountOut: bigint, flash: boolean) => {
      const w = r.world;
      const spec = {
        ...common(w),
        solver,
        owner: r.owner.address,
        nonce: r.nonce,
        receiver: w.receivers[ownerIndex(r.owner)] as Address,
        solverOutput: w.solverOutput,
        solverInput: w.solverInput,
        feeRecipient: config.feeRecipient,
        amountIn: r.escrow,
        amountOut,
        maxFeeBps: feeBpsFor(config, r.kind),
        ...(r.mandate === null ? {} : { mandate: r.mandate }),
      };
      return flash ? buildFlashFill(spec) : [await buildFillIntent(spec)];
    };
    const fillable = async () => {
      const now = await chainTime(transport);
      return records.filter((r) => r.outcome === "open" && !r.revoked && r.expiresAt > now + SAFETY_SECONDS);
    };
    const fill = async (flash: boolean) => {
      const open = await fillable();
      if (open.length === 0) {
        return "skip";
      }
      const r = pick(open);
      r.amountOut = paysAtLeast(r.params);
      r.fee = splitFee(r.escrow, feeBpsFor(config, r.kind)).fee;
      await send(solver, await fillOf(r, r.amountOut, flash));
      r.outcome = "filled";
      return "ok";
    };
    const underpay = async () => {
      const open = (await fillable()).filter((r) => belowFloor(r.params) > 0n);
      if (open.length === 0) {
        return "skip";
      }
      const r = pick(open);
      await refusedAsExpected("underpay", async () => send(solver, await fillOf(r, belowFloor(r.params), random() < 0.5)));
      return "done";
    };
    const cancel = async () => {
      const open = (await fillable()).filter((r) => r.origin !== "agent" || random() < 0.5);
      if (open.length === 0) {
        return "skip";
      }
      const r = pick(open);
      await send(r.owner, [await buildCancelIntent({ owner: r.owner, nonce: r.nonce, inputMint: r.world.inputMint, tokenProgram: r.world.tokenProgram })]);
      r.outcome = "refunded";
      return "ok";
    };
    const stale = async () => {
      const done = records.filter((r) => r.outcome !== "open" && !r.closed);
      if (done.length === 0) {
        return "skip";
      }
      const r = pick(done);
      if (random() < 0.5) {
        await refusedAsExpected("stale-fill", async () => send(solver, await fillOf(r, paysAtLeast(r.params) + 1n, false)));
      } else {
        await refusedAsExpected("stale-cancel", async () =>
          send(r.owner, [await buildCancelIntent({ owner: r.owner, nonce: r.nonce, inputMint: r.world.inputMint, tokenProgram: r.world.tokenProgram })]),
        );
      }
      return "done";
    };
    const revokeThenFill = async () => {
      const candidates = (await fillable()).filter((r) => r.origin === "agent" && r.mandate !== null);
      if (candidates.length === 0) {
        return "skip";
      }
      const r = pick(candidates);
      const w = r.world;
      const i = ownerIndex(r.owner);
      await send(r.owner, [await buildRevokeMandate({ owner: r.owner, agent: agent.address, id: w.mandateIds[i] ?? 0n })]);
      for (const other of records.filter((x) => x.mandate === r.mandate)) {
        other.revoked = true;
      }
      w.mandates[i] = null;
      w.mandateIds[i] = null;
      await refusedAsExpected("fill-revoked", async () => send(solver, await fillOf(r, paysAtLeast(r.params), false)));
      for (const orphan of records.filter((x) => x.mandate === r.mandate && x.outcome === "open")) {
        await send(orphan.owner, [
          await buildCancelIntent({ owner: orphan.owner, nonce: orphan.nonce, inputMint: w.inputMint, tokenProgram: w.tokenProgram }),
        ]);
        orphan.outcome = "refunded";
      }
      return "ok";
    };
    const settle = async () => {
      const now = await chainTime(transport);
      let acted = false;
      for (const r of records.filter((x) => x.outcome === "open" && x.expiresAt + 3n < now)) {
        await send(solver, [
          await buildExpireIntent({ owner: r.owner.address, nonce: r.nonce, inputMint: r.world.inputMint, tokenProgram: r.world.tokenProgram, cranker: solver }),
        ]);
        r.outcome = "refunded";
        acted = true;
      }
      for (const r of records.filter((x) => x.outcome !== "open" && !x.closed)) {
        const state = await chainStatus(r);
        const closer = state?.status === IntentStatus.Cancelled ? (r.rentPayer === payer.address ? payer : r.rentPayer === agent.address ? agent : r.owner) : solver;
        await send(closer, [
          await buildCloseIntent({
            owner: r.owner.address,
            nonce: r.nonce,
            inputMint: r.world.inputMint,
            tokenProgram: r.world.tokenProgram,
            cranker: closer,
            rentPayer: r.rentPayer,
          }),
        ]);
        r.closed = true;
        acted = true;
      }
      return acted ? "ok" : "skip";
    };

    const check = async () => {
      report.checks += 1;
      const violation = (detail: string) => report.violations.push({ step, detail });
      for (const w of worlds) {
        const mine = records.filter((r) => r.world === w);
        const filled = mine.filter((r) => r.outcome === "filled");
        const expect_ = new Map<Address, bigint>();
        owners.forEach((owner, i) => {
          const held = mine.filter((r) => r.owner === owner && r.outcome !== "refunded").reduce((s, r) => s + r.escrow, 0n);
          expect_.set(w.ownerInputs[i] as Address, OWNER_TOKENS - held);
          expect_.set(w.receivers[i] as Address, filled.filter((r) => r.owner === owner).reduce((s, r) => s + r.amountOut, 0n));
        });
        expect_.set(w.solverInput, filled.reduce((s, r) => s + r.escrow - r.fee, 0n));
        expect_.set(w.solverOutput, SOLVER_TOKENS - filled.reduce((s, r) => s + r.amountOut, 0n));
        expect_.set(w.feeAccount, w.feeStart + filled.reduce((s, r) => s + r.fee, 0n));
        for (const [account, want] of expect_) {
          const got = await tokens(account);
          if (got !== want) {
            violation(`${w.name}: ${account} holds ${got}, the model expects ${want}`);
          }
        }
        let vaulted = 0n;
        for (const r of mine.filter((x) => !x.superseded)) {
          const state = await chainStatus(r);
          if (r.closed) {
            if (state !== null) {
              violation(`${w.name}: closed intent ${r.intent} still exists`);
            }
            continue;
          }
          if (state === null) {
            violation(`${w.name}: intent ${r.intent} (${r.origin}, ${r.outcome}) is missing`);
            continue;
          }
          const wantStatus = r.outcome === "open" ? [IntentStatus.Open] : r.outcome === "filled" ? [IntentStatus.Filled] : [IntentStatus.Cancelled, IntentStatus.Expired];
          if (!(wantStatus as number[]).includes(state.status)) {
            violation(`${w.name}: intent ${r.intent} has status ${state.status}, the model has ${r.outcome}`);
          }
          const vault = await tokens((await findVaultPda({ intent: r.intent }))[0]);
          const wantVault = r.outcome === "open" ? r.escrow : 0n;
          if (vault !== wantVault) {
            violation(`${w.name}: vault of ${r.intent} holds ${vault}, expected ${wantVault}`);
          }
          vaulted += vault;
        }
        const held = (await Promise.all([...w.ownerInputs, w.solverInput].map(tokens))).reduce((s, v) => s + v, 0n);
        const inputTotal = held + (await tokens(w.feeAccount)) - w.feeStart + vaulted;
        if (inputTotal !== OWNER_TOKENS * BigInt(OWNERS)) {
          violation(`${w.name}: input supply drifted to ${inputTotal}, minted ${OWNER_TOKENS * BigInt(OWNERS)}`);
        }
        const outputTotal = (await Promise.all([...w.receivers, w.solverOutput].map(tokens))).reduce((s, v) => s + v, 0n);
        if (outputTotal !== SOLVER_TOKENS) {
          violation(`${w.name}: output supply drifted to ${outputTotal}, minted ${SOLVER_TOKENS}`);
        }
      }
    };

    const reconcile = async (op: string, error: unknown) => {
      anomaly(op, error);
      for (const r of records.filter((x) => !x.closed && !x.superseded)) {
        const state = await chainStatus(r);
        if (state === null) {
          if (r.outcome === "open") {
            records.splice(records.indexOf(r), 1);
          }
          continue;
        }
        if (state.status === IntentStatus.Open || state.status === IntentStatus.Filled) {
          r.outcome = state.status === IntentStatus.Open ? "open" : "filled";
        } else {
          r.outcome = "refunded";
        }
      }
    };

    const ops: [string, number, () => Promise<string>][] = [
      ["create", 22, async () => (await createPlain(pick(worlds), pick(owners)), "ok")],
      ["create-signed", 8, async () => (await createSigned(pick(worlds), pick(owners)), "ok")],
      ["create-agent", 10, async () => (await createByAgent(pick(worlds), pick(owners)), "ok")],
      ["fill", 22, () => fill(false)],
      ["flash-fill", 8, () => fill(true)],
      ["underpay", 6, underpay],
      ["cancel", 8, cancel],
      ["stale", 5, stale],
      ["revoke", 3, revokeThenFill],
      ["settle", 8, settle],
    ];
    const weight = ops.reduce((s, [, w]) => s + w, 0);
    const choose = () => {
      let roll = random() * weight;
      for (const op of ops) {
        roll -= op[1];
        if (roll < 0) {
          return op;
        }
      }
      return ops[0] as (typeof ops)[number];
    };

    const deadline = Date.now() + minutes * 60_000;
    while (Date.now() < deadline) {
      step += 1;
      report.steps = step;
      const [name, , run] = choose();
      try {
        const result = await run();
        if (result === "ok") {
          tally(name, "ok");
        }
      } catch (error) {
        await reconcile(name, error);
      }
      if (step % CHECK_EVERY === 0) {
        await check();
      }
    }

    for (const r of records.filter((x) => x.outcome === "open")) {
      try {
        await send(r.owner, [await buildCancelIntent({ owner: r.owner, nonce: r.nonce, inputMint: r.world.inputMint, tokenProgram: r.world.tokenProgram })]);
        r.outcome = "refunded";
      } catch (error) {
        await reconcile("wind-down-cancel", error);
      }
    }
    try {
      await settle();
    } catch (error) {
      await reconcile("wind-down-close", error);
    }
    await check();
    for (const w of worlds) {
      for (let i = 0; i < owners.length; i++) {
        if (w.mandateIds[i] !== null) {
          const owner = owners[i] as KeyPairSigner;
          const [mandate] = await findMandatePda({ owner: owner.address, agent: agent.address, id: w.mandateIds[i] ?? 0n });
          if ((await transport.getAccount(mandate)) !== null) {
            await send(owner, [await buildRevokeMandate({ owner, agent: agent.address, id: w.mandateIds[i] ?? 0n })]);
          }
        }
      }
    }
    for (const kp of [...owners, solver, agent]) {
      const left = await lamportsOf(kp.address);
      if (left > SIGNATURE_FEE) {
        await send(kp, [getTransferSolInstruction({ source: kp, destination: payer.address, amount: left - SIGNATURE_FEE })]).catch(
          (error: unknown) => report.anomalies.push({ step, op: "refund", detail: String(error).slice(0, 300) }),
        );
      }
    }
    report.lamports.payerEnd = await lamportsOf(payer.address);
    await client.close();
    const sorted = [...report.latencyMs].sort((a, b) => a - b);
    const summary = {
      ...report,
      latencyMs: undefined,
      latency: {
        count: sorted.length,
        p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        max: sorted.at(-1) ?? 0,
      },
      intents: {
        total: records.length,
        filled: records.filter((r) => r.outcome === "filled").length,
        refunded: records.filter((r) => r.outcome === "refunded").length,
        byOrigin: Object.fromEntries((["plain", "signed", "agent"] as const).map((o) => [o, records.filter((r) => r.origin === o).length])),
      },
      solSpent: Number(report.lamports.payerStart - report.lamports.payerEnd) / 1e9,
    };
    const text = JSON.stringify(summary, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
    if (reportPath !== undefined) {
      await writeFile(reportPath, text);
    }
    expect(report.violations, text).toEqual([]);
  }, Math.ceil(minutes * 60_000 * 1.5) + 600_000);
});

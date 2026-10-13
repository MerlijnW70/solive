import { claimsOf } from "../src/agent/claims.js";
import {
  AccountRole,
  type Address,
  type Blockhash,
  createSolanaRpc,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  type Instruction,
  type KeyPairSigner,
  partiallySignTransaction,
  signBytes,
} from "@solana/kit";
import { compile } from "@intent-engine/solver";
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
  attestedFillMessage,
  buildAdvanceEpoch,
  buildApproveDelegate,
  buildApproveForIntent,
  buildCancelIntent,
  buildCloseIntent,
  buildCreateIntent,
  buildCreateIntentByAgent,
  buildCreateIntentSigned,
  buildCreateMandate,
  buildExpireIntent,
  buildEd25519BatchInstruction,
  buildFillAttested,
  buildFillAttestedSplit,
  buildFillIntent,
  buildFlashFill,
  buildInitUser,
  attestedSplitPreimage,
  ED25519_PROGRAM_ADDRESS,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  splitCommit,
  splitCosignEnvelope,
  splitN,
  encodeParams,
  feeBpsFor,
  findAssociatedTokenAddress,
  findConfigPda,
  findIntentPda,
  findMandatePda,
  findUserStatePda,
  getConfigDecoder,
  getIntentDecoder,
  getUserStateDecoder,
  type IntentParams,
  Kind,
  MANDATE_KINDS,
  MANDATE_NONCE_BIT,
  nextEpoch,
  signedIntentMessage,
  signEd25519Instruction,
  splitFee,
  splitFees,
} from "@intent-engine/core";
import { agentServer } from "../src/agent/mcp.js";
import { budgetOf } from "../src/agent/budget.js";
import { relayOf } from "../src/agent/relay.js";
import { chainTime, run } from "../src/commands.js";
import { loadKeypairFile } from "../src/main.js";
import { type RpcLike, rpcTransport } from "../src/transport.js";

const url = process.env["DEVNET_RPC"];
const keypair = process.env["DEVNET_KEYPAIR"];
const TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const ESCROW = 400n;
const MIN_OUT = 300n;
const FUNDED = 4_000n;
const RELAY_FEE = 3n;
const AGENT_FEE = 2n;
const PARTNER_BPS = 50;
const PARTNERED = 40_000n;

describe.skipIf(url === undefined || keypair === undefined)("devnet smoke", () => {
  for (const tokenProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
    it(`runs every settlement path and the crank on ${tokenProgram}`, async () => {
      const rpc = createSolanaRpc(url ?? "");
      const transport = rpcTransport(rpc as unknown as RpcLike);
      const payer = (await loadKeypairFile(keypair ?? "")) as KeyPairSigner;
      const send = (signer: KeyPairSigner, ixs: Instruction[]) => transport.send(ixs, signer);
      const balance = async (account: Address) => {
        const view = await transport.getAccount(account);
        return view === null ? -1n : getTokenDecoder().decode(view.data).amount;
      };
      const intentGone = async (owner: Address, nonce: bigint) =>
        (await transport.getAccount((await findIntentPda({ owner, nonce }))[0])) === null;
      const [configAddress] = await findConfigPda();
      const configView = await transport.getAccount(configAddress);
      if (configView === null) {
        throw new Error("config is not initialised on this cluster");
      }
      const config = getConfigDecoder().decode(configView.data);
      const fund = async (lamports: bigint) => {
        const kp = await generateKeyPairSigner();
        await send(payer, [getTransferSolInstruction({ source: payer, destination: kp.address, amount: lamports })]);
        return kp;
      };
      const mint = async () => {
        const m = await generateKeyPairSigner();
        const space = BigInt(getMintSize());
        const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
        await send(payer, [
          getCreateAccountInstruction({ payer, newAccount: m, lamports: rent, space, programAddress: tokenProgram }),
          getInitializeMint2Instruction(
            { mint: m.address, decimals: 6, mintAuthority: payer.address },
            { programAddress: tokenProgram },
          ),
        ]);
        return m.address;
      };
      const ata = async (owner: Address, m: Address, amount = 0n) => {
        const address = await findAssociatedTokenAddress({ owner, mint: m, tokenProgram });
        await send(payer, [
          await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: m, tokenProgram }),
          ...(amount > 0n
            ? [
                getMintToInstruction(
                  { mint: m, token: address, mintAuthority: payer, amount },
                  { programAddress: tokenProgram },
                ),
              ]
            : []),
        ]);
        return address;
      };

      const owner = await fund(60_000_000n);
      const solver = await fund(60_000_000n);
      const inputMint = await mint();
      const outputMint = await mint();
      const ownerInput = await ata(owner.address, inputMint, FUNDED);
      const receiver = await ata(owner.address, outputMint);
      const solverOutput = await ata(solver.address, outputMint, 20_000n);
      const solverInput = await ata(solver.address, inputMint);
      await ata(config.feeRecipient, inputMint);
      const common = { inputMint, outputMint, inputTokenProgram: tokenProgram, outputTokenProgram: tokenProgram };
      const swap = { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT } as const;
      const ref = (nonce: bigint) => ({ owner: owner.address, nonce, inputMint, tokenProgram });
      const fill = (nonce: bigint, amountOut: bigint, maxFeeBps: number) =>
        buildFillIntent({
          ...common,
          solver,
          owner: owner.address,
          nonce,
          receiver,
          solverOutput,
          solverInput,
          feeRecipient: config.feeRecipient,
          amountIn: ESCROW,
          amountOut,
          maxFeeBps,
        });
      const create = async (nonce: bigint, params: IntentParams, expiresAt: bigint) =>
        send(owner, [await buildCreateIntent({ ...common, owner, treasury: config.feeRecipient, maxCreateFee: config.createFee, maxBounty: config.crankBounty, nonce, params, expiresAt })]);
      const { net } = splitFee(ESCROW, config.feeBps);
      const start = await chainTime(transport);
      let delivered = 0n;
      let earned = 0n;

      await send(owner, [await buildInitUser({ owner })]);
      await create(0n, swap, start + 3_600n);
      await send(solver, [await fill(0n, MIN_OUT, config.feeBps)]);
      delivered += MIN_OUT;
      earned += net;
      expect(await balance(receiver)).toBe(delivered);
      expect(await balance(solverInput)).toBe(earned);
      await send(solver, [await buildCloseIntent({ ...ref(0n), cranker: solver })]);
      expect(await intentGone(owner.address, 0n)).toBe(true);

      await create(1n, swap, start + 3_600n);
      if (config.feeBps > 0) {
        await expect(send(solver, [await fill(1n, MIN_OUT, config.feeBps - 1)])).rejects.toThrow();
      }
      await send(owner, [await buildCancelIntent({ ...ref(1n), owner })]);
      await send(solver, [await buildCloseIntent({ ...ref(1n), cranker: solver })]);

      await create(5n, { kind: Kind.LimitOrder, makeAmount: ESCROW, takeAmount: 250n }, start + 3_600n);
      await expect(send(solver, [await fill(5n, 249n, config.feeBps)])).rejects.toThrow();
      await send(solver, [await fill(5n, 250n, config.feeBps)]);
      delivered += 250n;
      earned += net;

      const dutchStart = await chainTime(transport);
      await create(
        6n,
        {
          kind: Kind.DutchAuction,
          amountIn: ESCROW,
          startOut: 900n,
          endOut: 100n,
          startTs: dutchStart,
          endTs: dutchStart + 600n,
        },
        dutchStart + 600n,
      );
      await expect(send(solver, [await fill(6n, 99n, config.feeBps)])).rejects.toThrow();
      await send(solver, [await fill(6n, 900n, config.feeBps)]);
      delivered += 900n;
      earned += net;
      expect(await balance(receiver)).toBe(delivered);
      expect(await balance(solverInput)).toBe(earned);

      await send(owner, [
        await buildApproveForIntent({ owner, mint: inputMint, tokenProgram, decimals: 6, params: swap }),
      ]);
      const signedExpiry = (await chainTime(transport)) + 3_600n;
      const submitBy = (await chainTime(transport)) + 600n;
      const message = await signedIntentMessage({
        domain: Uint8Array.from(config.domain),
        owner: owner.address,
        ownerInput,
        inputMint,
        outputMint,
        receiver,
        nonce: 3n,
        expiresAt: signedExpiry,
        submitBy,
        kind: Kind.SwapExactIn,
        params: encodeParams(swap),
        epoch: 0n,
      });
      await send(payer, [
        await signEd25519Instruction(owner, message),
        await buildCreateIntentSigned({
          ...common,
          treasury: config.feeRecipient, maxCreateFee: config.createFee, maxBounty: config.crankBounty,
          payer,
          owner: owner.address,
          submitBy,
          nonce: 3n,
          params: swap,
          expiresAt: signedExpiry,
        }),
      ]);
      await send(
        solver,
        await buildFlashFill({
          ...common,
          solver,
          owner: owner.address,
          nonce: 3n,
          receiver,
          solverOutput,
          solverInput,
          feeRecipient: config.feeRecipient,
          amountIn: ESCROW,
          amountOut: MIN_OUT,
          maxFeeBps: config.feeBps,
        }),
      );
      delivered += MIN_OUT;
      earned += net;
      expect(await balance(receiver)).toBe(delivered);
      expect(await balance(solverInput)).toBe(earned);
      await send(payer, [await buildCloseIntent({ ...ref(3n), cranker: payer, rentPayer: payer.address })]);
      expect(await intentGone(owner.address, 3n)).toBe(true);
      const revoke = nextEpoch(0n);
      await send(owner, [await buildAdvanceEpoch({ owner, epoch: revoke })]);
      const [userState] = await findUserStatePda({ owner: owner.address });
      const userView = await transport.getAccount(userState);
      expect(userView === null ? -1n : getUserStateDecoder().decode(userView.data).epoch).toBe(revoke);

      const expiresAt = (await chainTime(transport)) + 20n;
      await create(2n, swap, expiresAt);
      while ((await chainTime(transport)) < expiresAt) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      const before = await balance(ownerInput);
      await send(solver, [await buildExpireIntent({ ...ref(2n), cranker: solver })]);
      expect(await balance(ownerInput)).toBe(before + ESCROW);
      await send(solver, [await buildCloseIntent({ ...ref(2n), cranker: solver })]);

      const crankExpiry = (await chainTime(transport)) + 20n;
      await create(7n, swap, crankExpiry);
      while ((await chainTime(transport)) < crankExpiry) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      const runtime = {
        transport: () => transport,
        loadSigner: async () => solver,
        readText: async () => {
          throw new Error("the devnet smoke test reads no files");
        },
        writeText: async () => {
          throw new Error("the devnet smoke test writes no files");
        },
        saveText: async () => {
          throw new Error("the devnet smoke test writes no files");
        },
        home: "",
        sleep: async () => false,
        env: {},
        now: () => 0n,
        fetch: (target: string, init?: RequestInit) => fetch(target, init),
        entropy: () => 0,
        serve: async () => {
          throw new Error("the devnet smoke test runs no agent server");
        },
        intentChanges: () => {
          throw new Error("the devnet smoke test watches no intents");
        },
      };
      const [crankIntent] = await findIntentPda({ owner: owner.address, nonce: 7n });
      const first = (await run({ name: "crank", url: url ?? "", priority: 0n, keypair: "solver", dryRun: false, fundAccounts: false }, runtime)) as {
        actions: { intent: string; action: string; error?: string }[];
      };
      const mine = (r: typeof first) => r.actions.filter((a) => a.intent === crankIntent);
      expect(mine(first)).toEqual([expect.objectContaining({ action: "expire" })]);
      expect(mine(first)[0]?.error).toBeUndefined();
      expect(await intentGone(owner.address, 7n)).toBe(true);
      expect(await balance(ownerInput)).toBe(FUNDED - 4n * ESCROW);

      const partner = await generateKeyPairSigner();
      const partnerTo = await ata(partner.address, inputMint);
      await ata(owner.address, inputMint, PARTNERED);
      const large = { kind: Kind.SwapExactIn, amountIn: PARTNERED, minOut: MIN_OUT } as const;
      const swapFee = feeBpsFor(config, Kind.SwapExactIn);
      await send(owner, [
        await buildCreateIntent({
          ...common,
          owner,
          treasury: config.feeRecipient,
          maxCreateFee: config.createFee,
          maxBounty: config.crankBounty,
          nonce: 8n,
          params: large,
          expiresAt: (await chainTime(transport)) + 3_600n,
          partner: { key: partner.address, bps: PARTNER_BPS },
        }),
      ]);
      const [partnered] = await findIntentPda({ owner: owner.address, nonce: 8n });
      const stored = await transport.getAccount(partnered);
      expect(stored === null ? -1 : getIntentDecoder().decode(stored.data).partnerCutBps).toBe(config.partnerCutBps);
      const shares = splitFees(PARTNERED, swapFee, PARTNER_BPS, config.partnerCutBps);
      const feeTo = await findAssociatedTokenAddress({ owner: config.feeRecipient, mint: inputMint, tokenProgram });
      const treasuryBefore = await balance(feeTo);
      await send(solver, [
        await buildFillIntent({
          ...common,
          solver,
          owner: owner.address,
          nonce: 8n,
          receiver,
          solverOutput,
          solverInput,
          feeRecipient: config.feeRecipient,
          partner: partner.address,
          amountIn: PARTNERED,
          amountOut: MIN_OUT,
          maxFeeBps: swapFee + PARTNER_BPS,
        }),
      ]);
      delivered += MIN_OUT;
      earned += shares.net;
      expect([shares.protocol > 0n, shares.partner > 0n]).toEqual([swapFee > 0, true]);
      expect(await balance(partnerTo)).toBe(shares.partner);
      expect(await balance(feeTo)).toBe(treasuryBefore + shares.protocol);
      expect(await balance(receiver)).toBe(delivered);
      expect(await balance(solverInput)).toBe(earned);

      const attestor = await generateKeyPairSigner();
      const attestedFee = feeBpsFor(config, Kind.AttestedResult);
      await create(
        9n,
        { kind: Kind.AttestedResult, amountIn: ESCROW, minResult: 10n, maxResult: 20n, attestor: attestor.address, specHash: new Uint8Array(32), judgeFee: 0n },
        (await chainTime(transport)) + 3_600n,
      );
      const [attested] = await findIntentPda({ owner: owner.address, nonce: 9n });
      const attest = (maxFeeBps: number, signedFeeBps: number) =>
        Promise.all([
          attestedFillMessage(attestor.address, {
            domain: Uint8Array.from(config.domain),
            intent: attested,
            payee: solverInput,
            amountIn: ESCROW,
            result: 15n,
            maxFeeBps: signedFeeBps,
          }).then((message) => signEd25519Instruction(attestor, message)),
          buildFillAttested({
            solver,
            owner: owner.address,
            nonce: 9n,
            inputMint,
            inputTokenProgram: tokenProgram,
            payee: solverInput,
            feeRecipient: config.feeRecipient,
            amountIn: ESCROW,
            result: 15n,
            maxFeeBps,
          }),
        ]);
      await expect(send(solver, await attest(attestedFee + 1, attestedFee))).rejects.toThrow();
      await send(solver, await attest(attestedFee, attestedFee));
      earned += splitFee(ESCROW, attestedFee).net;
      expect(await balance(solverInput)).toBe(earned);

      const agent = await fund(30_000_000n);
      const agentTo = await ata(agent.address, inputMint);
      await send(owner, [
        await buildApproveDelegate({ owner, mint: inputMint, tokenProgram, amount: ESCROW + AGENT_FEE, decimals: 6 }),
        await buildCreateMandate({
          ...common,
          owner,
          mandate: {
            id: 0n,
            agent: agent.address,
            kinds: MANDATE_KINDS,
            perIntent: ESCROW + AGENT_FEE,
            total: ESCROW + AGENT_FEE,
            maxIntents: 1,
            maxTtl: 3_600n,
            validUntil: (await chainTime(transport)) + 3_600n,
            floorOut: 1n,
            floorIn: 2n,
            agentFee: AGENT_FEE,
          },
        }),
      ]);
      const lane = MANDATE_NONCE_BIT | (1n << 32n);
      await send(agent, [
        await buildCreateIntentByAgent({
          ...common,
          agent,
          owner: owner.address,
          mandateId: 0n,
          treasury: config.feeRecipient,
          maxCreateFee: config.createFee,
          maxBounty: config.crankBounty,
          nonce: lane,
          params: swap,
          expiresAt: (await chainTime(transport)) + 600n,
        }),
      ]);
      const [mandate] = await findMandatePda({ owner: owner.address, agent: agent.address, id: 0n });
      await send(solver, [
        await buildFillIntent({
          ...common,
          solver,
          owner: owner.address,
          nonce: lane,
          receiver,
          solverOutput,
          solverInput,
          feeRecipient: config.feeRecipient,
          mandate,
          agent: agent.address,
          amountIn: ESCROW,
          amountOut: MIN_OUT,
          maxFeeBps: swapFee,
        }),
      ]);
      delivered += MIN_OUT;
      earned += net;
      expect(await balance(agentTo)).toBe(AGENT_FEE);
      expect(await balance(receiver)).toBe(delivered);
      expect(await balance(solverInput)).toBe(earned);
      expect(await balance(ownerInput)).toBe(FUNDED - 6n * ESCROW - AGENT_FEE);
    }, 900_000);
  }
});

describe.skipIf(url === undefined || keypair === undefined)("devnet agent smoke", () => {
  for (const tokenProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
    it(`creates, cancels, cranks, relays and acts under a mandate through the agent tools on ${tokenProgram}`, async () => {
      const rpc = createSolanaRpc(url ?? "");
      const transport = rpcTransport(rpc as unknown as RpcLike);
      const payer = (await loadKeypairFile(keypair ?? "")) as KeyPairSigner;
      const fund = async (lamports: bigint) => {
        const kp = await generateKeyPairSigner();
        await transport.send([getTransferSolInstruction({ source: payer, destination: kp.address, amount: lamports })], payer);
        return kp;
      };
      const mint = async () => {
        const m = await generateKeyPairSigner();
        const space = BigInt(getMintSize());
        const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
        await transport.send(
          [
            getCreateAccountInstruction({ payer, newAccount: m, lamports: rent, space, programAddress: tokenProgram }),
            getInitializeMint2Instruction(
              { mint: m.address, decimals: 6, mintAuthority: payer.address },
              { programAddress: tokenProgram },
            ),
          ],
          payer,
        );
        return m.address;
      };
      const fundTokens = async (owner: Address, m: Address) => {
        const address = await findAssociatedTokenAddress({ owner, mint: m, tokenProgram });
        await transport.send(
          [
            await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: m, tokenProgram }),
            getMintToInstruction({ mint: m, token: address, mintAuthority: payer, amount: FUNDED }, { programAddress: tokenProgram }),
          ],
          payer,
        );
        return address;
      };
      const [configAddress] = await findConfigPda();
      const configView = await transport.getAccount(configAddress);
      if (configView === null) {
        throw new Error("config is not initialised on this cluster");
      }
      const config = getConfigDecoder().decode(configView.data);
      const relayFees = new Map<Address, bigint>();
      const agentOwners = new Set<Address>();
      const relay = relayOf(payer, {
        maxLamports: BigInt(config.createFee) + BigInt(config.crankBounty),
        maxTtl: 7n * 24n * 60n * 60n,
        perHour: 10,
        hourlyLamports: 1_000_000_000n,
        fees: relayFees,
      });
      const [near, far] = InMemoryTransport.createLinkedPair();
      const agent = await fund(30_000_000n);
      await agentServer({
        transport,
        relay,
        agent: { signer: agent, budget: budgetOf(1_000_000_000n), owners: agentOwners },
        claims: claimsOf(),
      }).connect(near);
      const client = new Client({ name: "devnet", version: "0.0.0" });
      await client.connect(far);
      const call = async (name: string, args: object) => {
        const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
        expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
        return result.structuredContent as Record<string, any>;
      };
      const execute = async (prepared: { transaction: string; last_valid_block_height: string }, signer: KeyPairSigner) => {
        const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction));
        const signed = await partiallySignTransaction([signer.keyPair], tx);
        const latest = { blockhash: "" as Blockhash, lastValidBlockHeight: BigInt(prepared.last_valid_block_height) };
        await transport.sendWire(getBase64EncodedWireTransaction(signed), latest);
      };

      expect((await call("get_config", {}))["domain_matches_cluster"]).toBe(true);
      const owner = await fund(60_000_000n);
      agentOwners.add(owner.address);
      const inputMint = await mint();
      const outputMint = await mint();
      relayFees.set(inputMint, RELAY_FEE);
      const ownerInput = await fundTokens(owner.address, inputMint);
      const terms = {
        owner: owner.address,
        input_mint: inputMint,
        output_mint: outputMint,
        order: { kind: "swap", amount_in: ESCROW.toString(), min_out: MIN_OUT.toString() },
        expires_in: 3_600,
      };
      const created = await call("prepare_create", terms);
      expect(created["nonce"]).toBe("0");
      await execute(created["prepared"], owner);
      expect(await call("get_intent", { owner: owner.address, nonce: "0" })).toMatchObject({
        status: "open",
        remaining: ESCROW.toString(),
      });
      expect((await call("quote", { owner: owner.address, nonce: "0" }))["required_out"]).toBe(MIN_OUT.toString());
      const cancel = await call("prepare_cancel", { owner: owner.address, nonce: "0" });
      await execute(cancel["prepared"], owner);
      expect((await call("get_intent", { owner: owner.address, nonce: "0" }))["status"]).toBe("cancelled");
      const refused = await client.callTool({
        name: "solive_prepare_crank",
        arguments: { cranker: payer.address, owner: owner.address, nonce: "0" },
      });
      expect((refused.structuredContent as { code?: string })["code"]).toBe("NothingToCrank");
      const close = await call("prepare_crank", { cranker: owner.address, owner: owner.address, nonce: "0" });
      expect(close["action"]).toBe("close");
      await execute(close["prepared"], owner);
      expect(await transport.getAccount(created["intent"])).toBeNull();

      const signed = await call("prepare_signed_intent", { ...terms, submit_within: 600 });
      expect(signed["nonce"]).toBe("1");
      expect(signed["submit"]["relayer_fee"]).toBe(RELAY_FEE.toString());
      await execute(signed["setup"], owner);
      const message = getBase64Encoder().encode(signed["message"]);
      const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, message));
      const relayed = await call("submit_signed_intent", { ...signed["submit"], signature });
      expect(relayed["intent"]).toBe(signed["intent"]);
      expect(await call("get_intent", { owner: owner.address, nonce: "1" })).toMatchObject({ status: "open" });
      expect((await call("submit_signed_intent", { ...signed["submit"], signature }))["signature"]).toBeNull();
      await execute((await call("prepare_cancel", { owner: owner.address, nonce: "1" }))["prepared"], owner);
      await execute((await call("prepare_crank", { cranker: payer.address, owner: owner.address, nonce: "1" }))["prepared"], payer);
      const held = async (account: Address) =>
        getTokenDecoder().decode((await transport.getAccount(account))?.data ?? new Uint8Array()).amount;
      const earned = async (who: Address) => held(await findAssociatedTokenAddress({ owner: who, mint: inputMint, tokenProgram }));
      expect(await held(ownerInput)).toBe(FUNDED - RELAY_FEE);
      expect(await earned(payer.address)).toBe(RELAY_FEE);

      const granted = await call("prepare_mandate", {
        owner: owner.address,
        agent: agent.address,
        input_mint: inputMint,
        output_mint: outputMint,
        kinds: ["swap"],
        per_intent: (ESCROW + AGENT_FEE).toString(),
        total: (ESCROW + AGENT_FEE).toString(),
        max_intents: 1,
        max_ttl: 3_600,
        valid_for: 3_600,
        floor: { out: "1", in: "2" },
        agent_fee: AGENT_FEE.toString(),
      });
      await execute(granted["prepared"], owner);
      const used = await call("agent_create", {
        owner: owner.address,
        id: granted["id"],
        order: { kind: "swap", amount_in: ESCROW.toString(), min_out: MIN_OUT.toString() },
        expires_in: 600,
      });
      expect(await call("get_mandate", { owner: owner.address, agent: agent.address, id: granted["id"] })).toMatchObject({
        status: "active",
        spent: (ESCROW + AGENT_FEE).toString(),
        remaining: "0",
        agent_fee: AGENT_FEE.toString(),
        intents: 1,
      });
      expect(await call("get_intent", { owner: owner.address, nonce: used["nonce"] })).toMatchObject({ status: "open" });
      const revoke = await call("prepare_revoke_mandate", { owner: owner.address, agent: agent.address, id: granted["id"] });
      expect([revoke["cancelled"], revoke["still_open"]]).toEqual([[used["intent"]], 0]);
      await execute(revoke["prepared"], owner);
      await execute((await call("prepare_crank", { cranker: agent.address, owner: owner.address, nonce: used["nonce"] }))["prepared"], agent);
      expect(await held(ownerInput)).toBe(FUNDED - RELAY_FEE);
      expect(await earned(agent.address)).toBe(0n);
      await client.close();
    }, 900_000);
  }
});

describe.skipIf(url === undefined || keypair === undefined)("devnet collaborative split", () => {
  it("settles fill_attested_split: every co-author signs one batched message and gets its weighted share", async () => {
    const rpc = createSolanaRpc(url ?? "");
    const transport = rpcTransport(rpc as unknown as RpcLike);
    const payer = (await loadKeypairFile(keypair ?? "")) as KeyPairSigner;
    const tokenProgram = TOKEN_PROGRAM_ADDRESS;
    const send = (signer: KeyPairSigner, ixs: Instruction[]) => transport.send(ixs, signer);
    const balance = async (account: Address) => {
      const view = await transport.getAccount(account);
      return view === null ? -1n : getTokenDecoder().decode(view.data).amount;
    };
    const [configAddress] = await findConfigPda();
    const configView = await transport.getAccount(configAddress);
    if (configView === null) {
      throw new Error("config is not initialised on this cluster");
    }
    const config = getConfigDecoder().decode(configView.data);
    const fund = async (lamports: bigint) => {
      const kp = await generateKeyPairSigner();
      await send(payer, [getTransferSolInstruction({ source: payer, destination: kp.address, amount: lamports })]);
      return kp;
    };
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
    const ata = async (owner: Address, m: Address, amount = 0n) => {
      const address = await findAssociatedTokenAddress({ owner, mint: m, tokenProgram });
      await send(payer, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: m, tokenProgram }),
        ...(amount > 0n ? [getMintToInstruction({ mint: m, token: address, mintAuthority: payer, amount }, { programAddress: tokenProgram })] : []),
      ]);
      return address;
    };
    const u32le = (n: number) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, n, true);
      return b;
    };
    const u64le = (n: bigint) => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, n, true);
      return b;
    };
    const cat = (...arrs: Uint8Array[]) => {
      const out = new Uint8Array(arrs.reduce((a, x) => a + x.length, 0));
      let at = 0;
      for (const a of arrs) {
        out.set(a, at);
        at += a.length;
      }
      return out;
    };
    const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;
    const SYSTEM = "11111111111111111111111111111111" as Address;
    const legsFor = (table: Address, authority: KeyPairSigner) => [
      { address: table, role: AccountRole.WRITABLE },
      { address: authority.address, role: AccountRole.READONLY_SIGNER, signer: authority },
      { address: authority.address, role: AccountRole.WRITABLE_SIGNER, signer: authority },
      { address: SYSTEM, role: AccountRole.READONLY },
    ];
    const createLookupTable = async (authority: KeyPairSigner, addresses: Address[]): Promise<Address> => {
      let table: Address | undefined;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const recent = (await rpc.getSlot({ commitment: "finalized" }).send()) - BigInt(attempt);
        const [candidate, bump] = await getProgramDerivedAddress({
          programAddress: ALT_PROGRAM,
          seeds: [getAddressEncoder().encode(authority.address), u64le(recent)],
        });
        const createIx = { programAddress: ALT_PROGRAM, accounts: legsFor(candidate, authority), data: cat(u32le(0), u64le(recent), new Uint8Array([bump])) };
        try {
          await send(authority, [createIx]);
          table = candidate;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      if (table === undefined) {
        throw new Error("could not create a lookup table on this cluster");
      }
      const addrs = cat(...addresses.map((a) => new Uint8Array(getAddressEncoder().encode(a))));
      const extendIx = { programAddress: ALT_PROGRAM, accounts: legsFor(table, authority), data: cat(u32le(2), u64le(BigInt(addresses.length)), addrs) };
      await send(authority, [extendIx]);
      const created = await rpc.getSlot({ commitment: "confirmed" }).send();
      for (let i = 0; i < 40; i += 1) {
        if ((await rpc.getSlot({ commitment: "confirmed" }).send()) > created + 1n) {
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      return table;
    };

    const owner = await fund(60_000_000n);
    const attestor = await fund(30_000_000n);
    const inputMint = await mint();
    const outputMint = await mint();
    await ata(owner.address, inputMint, FUNDED);
    await ata(owner.address, outputMint);
    await ata(config.feeRecipient, inputMint);
    const coauthors = [await generateKeyPairSigner(), await generateKeyPairSigner(), await generateKeyPairSigner()];
    const recipients = coauthors.map((c) => c.address);
    const weights = [5000, 3000, 2000];
    const payees = [] as Address[];
    for (const r of recipients) {
      payees.push(await ata(r, inputMint));
    }
    const common = { inputMint, outputMint, inputTokenProgram: tokenProgram, outputTokenProgram: tokenProgram };
    const spec = new Uint8Array(32).fill(0x5e);
    await send(owner, [await buildInitUser({ owner })]);
    await send(owner, [
      await buildCreateIntent({
        ...common,
        owner,
        treasury: config.feeRecipient,
        maxCreateFee: config.createFee,
        maxBounty: config.crankBounty,
        nonce: 0n,
        params: { kind: Kind.AttestedResult, amountIn: ESCROW, minResult: 1n, maxResult: 1n, attestor: attestor.address, specHash: spec, judgeFee: 0n },
        expiresAt: (await chainTime(transport)) + 3_600n,
      }),
    ]);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 0n });
    const attestedFee = feeBpsFor(config, Kind.AttestedResult);
    const maxFeeBps = attestedFee + 0;
    const splitHash = await splitCommit(recipients, weights);
    const preimage = await attestedSplitPreimage({
      domain: Uint8Array.from(config.domain),
      intent,
      amountIn: ESCROW,
      result: 1n,
      maxFeeBps,
      specHash: spec,
      splitHash,
    });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", preimage.slice()));
    const message = splitCosignEnvelope(digest);
    const entries = await Promise.all(
      [...coauthors, attestor].map(async (signer) => ({
        publicKey: signer.address,
        signature: new Uint8Array(await signBytes(signer.keyPair.privateKey, message)),
      })),
    );
    const batch = buildEd25519BatchInstruction({ entries, message });
    const fill = await buildFillAttestedSplit({
      solver: owner,
      owner: owner.address,
      nonce: 0n,
      inputMint,
      inputTokenProgram: tokenProgram,
      recipients,
      weights,
      feeRecipient: config.feeRecipient,
      amountIn: ESCROW,
      result: 1n,
      maxFeeBps,
    });
    const invoked = new Set<Address>([
      INTENT_ENGINE_PROGRAM_ADDRESS,
      ED25519_PROGRAM_ADDRESS,
      tokenProgram,
      "11111111111111111111111111111111" as Address,
    ]);
    const tableAddresses = [...new Set((fill.accounts ?? []).map((a) => a.address))].filter((a) => !invoked.has(a));
    const table = await createLookupTable(owner, tableAddresses);
    const { value: latest } = await rpc.getLatestBlockhash().send();
    const wire = await compile([batch, fill], owner, latest, { [table]: tableAddresses });
    expect(getBase64Encoder().encode(wire).length).toBeLessThanOrEqual(1232);
    await transport.sendWire(wire, latest);
    const { net } = splitFee(ESCROW, attestedFee);
    const plan = splitN(net, weights);
    for (let i = 0; i < payees.length; i += 1) {
      expect(await balance(payees[i]!)).toBe(plan[i]!);
    }
    const paid = (await Promise.all(payees.map(balance))).reduce((a, b) => a + b, 0n);
    expect(paid).toBe(net);
  }, 900_000);
});

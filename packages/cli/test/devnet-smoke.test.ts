import { type Address, createSolanaRpc, generateKeyPairSigner, type Instruction, type KeyPairSigner } from "@solana/kit";
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
import { feeBpsFor, findAssociatedTokenAddress, type IntentParams, Kind, splitFees } from "@intent-engine/core";
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
  buildFillAttested,
  buildFillIntent,
  buildFlashFill,
  buildInitUser,
  encodeParams,
  findConfigPda,
  findIntentPda,
  findMandatePda,
  findUserStatePda,
  getConfigDecoder,
  getIntentDecoder,
  getUserStateDecoder,
  MANDATE_KINDS,
  MANDATE_NONCE_BIT,
  nextEpoch,
  signedIntentMessage,
  signEd25519Instruction,
  splitFee,
} from "@intent-engine/core/internal";
import { chainTime, type RpcLike, rpcTransport } from "@intent-engine/client/internal";
import { run } from "../src/commands.js";
import { loadKeypairFile } from "../src/main.js";
import { AGENT_FEE, ESCROW, FUNDED, keypair, MIN_OUT, PARTNER_BPS, PARTNERED, TOKEN_2022_PROGRAM_ADDRESS, url } from "./devnet-kit.js";

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
        loadKeypair: async () => {
          throw new Error("no key file");
        },
        specFetch: async () => {
          throw new TypeError("fetch failed");
        },
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
        platform: "linux",
        launch: async () => {
          throw new Error("the devnet smoke test launches no programs");
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

import { claimsOf } from "../src/agent/claims.js";
import {
  type Address,
  type Blockhash,
  createSolanaRpc,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
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
import { findAssociatedTokenAddress } from "@intent-engine/core";
import { findConfigPda, getConfigDecoder } from "@intent-engine/core/internal";
import { type RpcLike, rpcTransport } from "@intent-engine/client/internal";
import { agentServer } from "../src/agent/mcp.js";
import { budgetOf } from "../src/agent/budget.js";
import { relayOf } from "../src/agent/relay.js";
import { loadKeypairFile } from "../src/main.js";
import { AGENT_FEE, ESCROW, FUNDED, keypair, MIN_OUT, RELAY_FEE, TOKEN_2022_PROGRAM_ADDRESS, url } from "./devnet-kit.js";

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

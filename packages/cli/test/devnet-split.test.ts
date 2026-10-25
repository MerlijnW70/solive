import {
  AccountRole,
  type Address,
  type Blockhash,
  createSolanaRpc,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  type Instruction,
  type KeyPairSigner,
  partiallySignTransaction,
  signBytes,
} from "@solana/kit";
import { prepare } from "../src/agent/prepare.js";
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
import { feeBpsFor, findAssociatedTokenAddress, Kind } from "@intent-engine/core";
import {
  buildCreateIntent,
  buildEd25519CosignInstruction,
  buildFillAttestedSplit,
  buildInitUser,
  ED25519_PROGRAM_ADDRESS,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  splitN,
  findConfigPda,
  findIntentPda,
  getConfigDecoder,
  splitFee,
} from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { chainTime, type RpcLike, rpcTransport } from "@intent-engine/client/internal";
import { loadKeypairFile } from "../src/main.js";
import { ESCROW, FUNDED, keypair, url } from "./devnet-kit.js";

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
    const work = "5e".repeat(32);
    const client = createClient({ url: url ?? "", transport });
    const made = await client.announce({ worker: coauthors[0] as KeyPairSigner, payer: owner, intent, sha256: work, url: "https://" + "example.org/devnet-split" });
    const shares = recipients.map((wallet, i) => ({ wallet, weight: weights[i] ?? 0 }));
    const { message } = await client.splitBallot({ intent: { owner: owner.address, nonce: 0n }, announcement: made.announcement, opening: { sha256: work, salt: made.salt }, result: 1n, recipients: shares });
    const entries = await Promise.all(
      [...coauthors, attestor].map(async (signer) => ({
        publicKey: signer.address,
        signature: new Uint8Array(await signBytes(signer.keyPair.privateKey, message)),
      })),
    );
    const batch = buildEd25519CosignInstruction({ entries, message });
    const fill = await buildFillAttestedSplit({
      solver: owner,
      owner: owner.address,
      nonce: 0n,
      inputMint,
      inputTokenProgram: tokenProgram,
      recipients,
      weights,
      feeRecipient: config.feeRecipient,
      announcement: made.announcement,
      opening: { delivered: Uint8Array.from(Buffer.from(work, "hex")), salt: Uint8Array.from(Buffer.from(made.salt, "hex")) },
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
    const prepared = await prepare(transport, [batch, fill], owner.address, { [table]: tableAddresses });
    expect(getBase64Encoder().encode(prepared.transaction).length).toBeLessThanOrEqual(1232);
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction));
    const signed = await partiallySignTransaction([owner.keyPair], tx);
    await transport.sendWire(getBase64EncodedWireTransaction(signed), { blockhash: "" as Blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight });
    const { net } = splitFee(ESCROW, attestedFee);
    const plan = splitN(net, weights);
    for (let i = 0; i < payees.length; i += 1) {
      expect(await balance(payees[i]!)).toBe(plan[i]!);
    }
    const paid = (await Promise.all(payees.map(balance))).reduce((a, b) => a + b, 0n);
    expect(paid).toBe(net);
  }, 900_000);
});

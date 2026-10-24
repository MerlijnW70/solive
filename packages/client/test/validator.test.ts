import { readFileSync } from "node:fs";
import {
  type Address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  ALL_KINDS_MASK,
  findAssociatedTokenAddress,
  findEventAuthorityPda,
  findProgramDataAddress,
  getInitConfigInstructionAsync,
  getIntentDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentStatus,
  Kind,
} from "@intent-engine/core";
import {
  BlockhashExpired,
  MaybeSent,
  changedAccount,
  type Confirmed,
  confirm,
  confirmSent,
  createClient,
  intentNotifications,
  type Latest,
  type RpcLike,
  rpcTransport,
  signatureWatch,
  type Transport,
} from "../src/index.js";

const url = process.env["VALIDATOR_URL"];
const authorityFile = process.env["VALIDATOR_AUTHORITY"];
const ESCROW = 400n;
const MIN_OUT = 30n;
const SOL = 1_000_000_000n;
const HEARD_MS = 30_000;

const socketOf = (http: string) => {
  const parsed = new URL(http);
  parsed.port = String(Number(parsed.port) + 1);
  return parsed.toString();
};

async function signed(instructions: readonly Instruction[], payer: TransactionSigner, latest: Latest) {
  return signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
}

function within<T>(ms: number, pending: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return pending(controller.signal).finally(() => {
    clearTimeout(timer);
    controller.abort();
  });
}

describe.skipIf(url === undefined || authorityFile === undefined)("the client against a real validator", () => {
  const http = url ?? "http://" + "127.0.0.1:8899";
  const socket = socketOf(http);
  const rpc = createSolanaRpc(http);
  const watch = signatureWatch(socket);
  const plain = rpcTransport(rpc as unknown as RpcLike, undefined, watch);
  const confirmations = new Map<string, Confirmed & { heard: Confirmed }>();
  const recording: Transport = {
    ...plain,
    send: async (instructions, payer) => {
      const latest = await plain.latestBlockhash();
      const transaction = await signed(instructions, payer, latest);
      const signature = getSignatureFromTransaction(transaction);
      const heard = within(HEARD_MS, (signal) => watch(signature, signal));
      await plain.submitWire(getBase64EncodedWireTransaction(transaction));
      const confirmed = await confirmSent(rpc as unknown as RpcLike, signature, latest.lastValidBlockHeight, undefined, watch);
      confirmations.set(signature, { ...confirmed, heard: (await heard) ?? {} });
      return signature;
    },
  };
  const client = createClient({ url: http, transport: recording, notifications: intentNotifications(socket) });
  const sender = createClient({ url: http, transport: plain });

  const funded = async (sol: bigint, signer?: KeyPairSigner) => {
    const wallet = signer ?? (await generateKeyPairSigner());
    await plain.airdrop(wallet.address, sol * SOL);
    return wallet;
  };

  const setup = async () => {
    const authority = await funded(100n, await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(authorityFile ?? "", "utf8")) as number[])));
    const [feeRecipient, owner, solver] = await Promise.all([funded(10n), funded(10n), funded(10n)]);
    const [eventAuthority] = await findEventAuthorityPda();
    await client.send(
      [
        await getInitConfigInstructionAsync({
          authority,
          engineProgram: INTENT_ENGINE_PROGRAM_ADDRESS,
          programData: await findProgramDataAddress(),
          eventAuthority,
          program: INTENT_ENGINE_PROGRAM_ADDRESS,
          domain: Uint8Array.from(getBase58Encoder().encode(await plain.genesisHash())),
          guardian: authority.address,
          feeRecipient: feeRecipient.address,
          enabledKinds: ALL_KINDS_MASK,
          feeBps: 5,
          paused: 0,
        }),
      ],
      authority,
    );
    const space = BigInt(getMintSize());
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
    const mint = async () => {
      const created = await generateKeyPairSigner();
      await client.send(
        [
          getCreateAccountInstruction({ payer: authority, newAccount: created, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
          getInitializeMint2Instruction({ mint: created.address, decimals: 6, mintAuthority: authority.address }),
        ],
        authority,
      );
      return created.address;
    };
    const inputMint = await mint();
    const outputMint = await mint();
    const ata = (holder: Address, of: Address) => findAssociatedTokenAddress({ owner: holder, mint: of, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    await client.send(
      [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: authority, owner: owner.address, mint: inputMint }),
        getMintToInstruction({ mint: inputMint, token: await ata(owner.address, inputMint), mintAuthority: authority, amount: 1_000n }),
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: authority, owner: owner.address, mint: outputMint }),
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: authority, owner: solver.address, mint: outputMint }),
      ],
      authority,
    );
    return { authority, owner, solver, inputMint, outputMint, ata };
  };

  it("confirms a created intent at its landed slot, hears it, fills it, and reports a stale blockhash as expired", { timeout: 240_000 }, async () => {
    const { authority, owner, solver, inputMint, outputMint, ata } = await setup();

    const created = await within(HEARD_MS * 2, async (signal) => {
      const notes = (await intentNotifications(socket)(signal))[Symbol.asyncIterator]();
      const first = notes.next();
      const sent = await client.createIntent({ signer: owner, inputMint, outputMint, params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT } });
      for (let next = await first; next.done !== true; next = await notes.next()) {
        const changed = changedAccount(next.value);
        if (changed?.address === sent.intent) {
          const intent = getIntentDecoder().decode(changed.data);
          expect(intent.owner).toBe(owner.address);
          expect(intent.status).toBe(IntentStatus.Open);
          return { ...sent, noted: (next.value as { context: { slot: bigint } }).context.slot };
        }
      }
      throw new Error("the intent notifications ended before the new intent arrived");
    });

    const landed = await rpc.getTransaction(created.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
    const confirmation = confirmations.get(created.signature);
    expect(landed?.slot).toBeTypeOf("bigint");
    expect(confirmation?.slot).toBe(landed?.slot);
    expect(confirmation?.heard.slot).toBe(landed?.slot);
    expect(created.noted).toBeGreaterThanOrEqual(landed?.slot ?? 0n);
    const latest = await plain.latestBlockhash();
    expect(await confirm(rpc as unknown as RpcLike, created.signature, latest.lastValidBlockHeight)).toEqual({ slot: landed?.slot });

    const filled = await sender.fill({
      solver,
      owner: owner.address,
      nonce: created.nonce,
      route: [getMintToInstruction({ mint: outputMint, token: await ata(solver.address, outputMint), mintAuthority: authority, amount: MIN_OUT })],
    });
    expect(await plain.signatureStatuses?.([filled])).toEqual(["landed"]);
    expect((await sender.intent(owner.address, created.nonce))?.intent.status).toBe(IntentStatus.Filled);
    expect((await sender.balances(owner.address, [outputMint])).tokens.find((held) => held.mint === outputMint)?.amount).toBe(MIN_OUT);

    const stale = await plain.latestBlockhash();
    for (let height = (await rpc.getEpochInfo().send()).blockHeight; height <= stale.lastValidBlockHeight; height = (await rpc.getEpochInfo().send()).blockHeight) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const before = (await rpc.getBalance(owner.address).send()).value;
    const late = await signed([getTransferSolInstruction({ source: owner, destination: authority.address, amount: 1n })], owner, stale);
    const refused = await plain.sendWire(getBase64EncodedWireTransaction(late), stale).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(BlockhashExpired);
    expect(refused).not.toBeInstanceOf(MaybeSent);
    expect(await plain.signatureStatuses?.([getSignatureFromTransaction(late) as Signature])).toEqual([null]);
    expect((await rpc.getBalance(owner.address).send()).value).toBe(before);
  });
});

import { readFileSync } from "node:fs";
import {
  type Address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Encoder,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import { getInitializeMint2Instruction, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  ALL_KINDS_MASK,
  findConfigPda,
  findEventAuthorityPda,
  findProgramDataAddress,
  getInitConfigInstructionAsync,
  INTENT_ENGINE_PROGRAM_ADDRESS,
} from "@intent-engine/core/internal";
import type { Latest, LookupTables } from "../src/index.js";
import { type RpcLike, rpcTransport, signatureWatch } from "../src/internal.js";

export const url = process.env["VALIDATOR_URL"];
export const authorityFile = process.env["VALIDATOR_AUTHORITY"];
export const SOL = 1_000_000_000n;
export const HEARD_MS = 30_000;
export const FEE_BPS = 5;

export const socketOf = (http: string) => {
  const parsed = new URL(http);
  parsed.port = String(Number(parsed.port) + 1);
  return parsed.toString();
};

const unsigned = (instructions: readonly Instruction[], payer: TransactionSigner, latest: Latest) =>
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );

export async function signed(instructions: readonly Instruction[], payer: TransactionSigner, latest: Latest) {
  return signTransactionMessageWithSigners(unsigned(instructions, payer, latest));
}

export async function signedWithTables(instructions: readonly Instruction[], payer: TransactionSigner, latest: Latest, tables: LookupTables) {
  return signTransactionMessageWithSigners(compressTransactionMessageUsingAddressLookupTables(unsigned(instructions, payer, latest), tables));
}

export function within<T>(ms: number, pending: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return pending(controller.signal).finally(() => {
    clearTimeout(timer);
    controller.abort();
  });
}

export type Sender = (instructions: readonly Instruction[], signer: TransactionSigner) => Promise<unknown>;

export function chainOf(http: string) {
  const socket = socketOf(http);
  const rpc = createSolanaRpc(http);
  const watch = signatureWatch(socket);
  const plain = rpcTransport(rpc as unknown as RpcLike, undefined, watch);
  const funded = async (sol: bigint, signer?: KeyPairSigner) => {
    const wallet = signer ?? (await generateKeyPairSigner());
    await plain.airdrop(wallet.address, sol * SOL);
    return wallet;
  };
  const authority = async () =>
    funded(100n, await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(authorityFile ?? "", "utf8")) as number[])));
  const configured = async (send: Sender, admin: KeyPairSigner) => {
    const [config] = await findConfigPda();
    if ((await plain.getAccount(config)) !== null) {
      return;
    }
    const feeRecipient = await funded(10n);
    const [eventAuthority] = await findEventAuthorityPda();
    await send(
      [
        await getInitConfigInstructionAsync({
          authority: admin,
          engineProgram: INTENT_ENGINE_PROGRAM_ADDRESS,
          programData: await findProgramDataAddress(),
          eventAuthority,
          program: INTENT_ENGINE_PROGRAM_ADDRESS,
          domain: Uint8Array.from(getBase58Encoder().encode(await plain.genesisHash())),
          guardian: admin.address,
          feeRecipient: feeRecipient.address,
          enabledKinds: ALL_KINDS_MASK,
          feeBps: FEE_BPS,
          paused: 0,
        }),
      ],
      admin,
    );
  };
  const mint = async (send: Sender, admin: KeyPairSigner): Promise<Address> => {
    const space = BigInt(getMintSize());
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
    const created = await generateKeyPairSigner();
    await send(
      [
        getCreateAccountInstruction({ payer: admin, newAccount: created, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
        getInitializeMint2Instruction({ mint: created.address, decimals: 6, mintAuthority: admin.address }),
      ],
      admin,
    );
    return created.address;
  };
  return { socket, rpc, watch, plain, funded, authority, configured, mint };
}

import { fileURLToPath } from "node:url";
import {
  type Address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
  type KeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTokenDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { findAssociatedTokenAddress } from "../src/index.js";
import {
  ALL_KINDS_MASK,
  MANDATE_NONCE_BIT,
  findEventAuthorityPda,
  getInitConfigInstructionAsync,
  INTENT_ENGINE_PROGRAM_ADDRESS,
} from "../src/internal.js";

export const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
export const NOW = 1_700_000_000n;
export const ESCROW = 400n;
export const MIN_OUT = 300n;
export const FEE_BPS = 5;
export const INSUFFICIENT_OUTPUT = 6008;
export const SIG_MESSAGE = 6035;
export const MANDATE_BUDGET = 6069;
export const MANDATE_MISMATCH = 6073;
export const FIRST_LANE = MANDATE_NONCE_BIT | (1n << 32n);
export const MANDATE_PRICE = 6071;
export const MANDATE_REVOKED = 6072;
export const FEE_ACCOUNT_MISSING = 6030;
export const DOMAIN = new Uint8Array(32).fill(0x11);
export const enginePath =
  process.env["INTENT_ENGINE_SO"] ??
  fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

export let svm: LiteSVM;

export async function attempt(
  payer: KeyPairSigner,
  ixs: Instruction[],
): Promise<TransactionMetadata | FailedTransactionMetadata> {
  svm.expireBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return svm.sendTransaction(await signTransactionMessageWithSigners(message));
}

export function customCode(result: TransactionMetadata | FailedTransactionMetadata): number | undefined {
  if (!(result instanceof FailedTransactionMetadata)) {
    return undefined;
  }
  const failure = result.err();
  if (typeof failure !== "object" || !("err" in failure)) {
    return undefined;
  }
  const inner = failure.err();
  return typeof inner === "object" && "code" in inner ? inner.code : undefined;
}

export async function send(payer: KeyPairSigner, ixs: Instruction[]): Promise<TransactionMetadata> {
  const result = await attempt(payer, ixs);
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
  }
  return result;
}

export async function funded(): Promise<KeyPairSigner> {
  const kp = await generateKeyPairSigner();
  svm.airdrop(kp.address, lamports(100_000_000_000n));
  return kp;
}

export async function makeUpgradeAuthority(authority: Address): Promise<Address> {
  const [programData] = await getProgramDerivedAddress({
    programAddress: LOADER,
    seeds: [getAddressEncoder().encode(INTENT_ENGINE_PROGRAM_ADDRESS)],
  });
  const account = svm.getAccount(programData);
  if (!account.exists) {
    throw new Error("program data missing");
  }
  const data = new Uint8Array(account.data);
  data[12] = 1;
  data.set(getAddressEncoder().encode(authority), 13);
  svm.setAccount({ ...account, data });
  return programData;
}

export async function mint(payer: KeyPairSigner): Promise<Address> {
  const m = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  await send(payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: m,
      lamports: svm.minimumBalanceForRentExemption(space),
      space,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({ mint: m.address, decimals: 6, mintAuthority: payer.address }),
  ]);
  return m.address;
}

export async function ata(payer: KeyPairSigner, owner: Address, m: Address, amount = 0n) {
  const ix = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: m });
  const address = await findAssociatedTokenAddress({
    owner,
    mint: m,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const extra =
    amount > 0n
      ? [getMintToInstruction({ mint: m, token: address, mintAuthority: payer, amount })]
      : [];
  await send(payer, [ix, ...extra]);
  return address;
}

export function balance(address: Address): bigint {
  const account = svm.getAccount(address);
  return account.exists ? getTokenDecoder().decode(account.data).amount : -1n;
}

export let authority: KeyPairSigner;
export let feeRecipient: KeyPairSigner;

export async function deploy() {
  svm = new LiteSVM().withPrecompiles();
  svm.addProgramFromFile(INTENT_ENGINE_PROGRAM_ADDRESS, enginePath);
  const clock = svm.getClock();
  clock.unixTimestamp = NOW;
  svm.setClock(clock);
  authority = await funded();
  feeRecipient = await funded();
  const [eventAuthority] = await findEventAuthorityPda();
  await send(authority, [
    await getInitConfigInstructionAsync({
      authority,
      engineProgram: INTENT_ENGINE_PROGRAM_ADDRESS,
      programData: await makeUpgradeAuthority(authority.address),
      eventAuthority,
      program: INTENT_ENGINE_PROGRAM_ADDRESS,
      domain: DOMAIN,
      guardian: authority.address,
      feeRecipient: feeRecipient.address,
      enabledKinds: ALL_KINDS_MASK,
      feeBps: FEE_BPS,
      paused: 0,
    }),
  ]);
}

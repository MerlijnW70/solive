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
import {
  ALL_KINDS_MASK,
  type Announcement,
  buildCreateIntent,
  buildInitUser,
  type DecodedEvent,
  decodeEvent,
  delivery,
  findAssociatedTokenAddress,
  findEventAuthorityPda,
  findIntentPda,
  getAnnouncementDecoder,
  getInitConfigInstructionAsync,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  Kind,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "../src/index.js";

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
export const NOW = 1_700_000_000n;
export const ESCROW = 400n;
export const FEE_BPS = 5;
export const DOMAIN = new Uint8Array(32).fill(0x11);
export const SPEC = new Uint8Array(32).fill(0x6d);
export const TOKEN = TOKEN_PROGRAM_ADDRESS;

const enginePath =
  process.env["INTENT_ENGINE_SO"] ??
  fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

export type Sent = TransactionMetadata | FailedTransactionMetadata;

export function sealedBlob(count: number, fill: number): Uint8Array {
  const length = delivery.BLOB_FIXED_LEN + delivery.BLOB_PER_RECIPIENT_LEN * count + 40;
  const blob = new Uint8Array(length).fill(fill);
  blob.set([delivery.BLOB_VERSION, count, 0], 0);
  blob.fill(0, delivery.BLOB_HEAD_LEN, delivery.BLOB_HEAD_LEN + delivery.FINGERPRINT_LEN * count);
  return blob;
}

export class Engine {
  readonly svm: LiteSVM;
  authority!: KeyPairSigner;
  feeRecipient!: KeyPairSigner;
  inputMint!: Address;
  outputMint!: Address;

  private constructor() {
    this.svm = new LiteSVM().withPrecompiles();
  }

  static async start(): Promise<Engine> {
    const engine = new Engine();
    engine.svm.addProgramFromFile(INTENT_ENGINE_PROGRAM_ADDRESS, enginePath);
    engine.at(NOW);
    engine.authority = await engine.funded();
    engine.feeRecipient = await engine.funded();
    const [eventAuthority] = await findEventAuthorityPda();
    await engine.send(engine.authority, [
      await getInitConfigInstructionAsync({
        authority: engine.authority,
        engineProgram: INTENT_ENGINE_PROGRAM_ADDRESS,
        programData: await engine.upgradeAuthority(engine.authority.address),
        eventAuthority,
        program: INTENT_ENGINE_PROGRAM_ADDRESS,
        domain: DOMAIN,
        guardian: engine.authority.address,
        feeRecipient: engine.feeRecipient.address,
        enabledKinds: ALL_KINDS_MASK,
        feeBps: FEE_BPS,
        paused: 0,
      }),
    ]);
    engine.inputMint = await engine.mint();
    engine.outputMint = await engine.mint();
    return engine;
  }

  at(now: bigint): void {
    const clock = this.svm.getClock();
    clock.unixTimestamp = now;
    this.svm.setClock(clock);
  }

  async attempt(payer: KeyPairSigner, ixs: Instruction[]): Promise<Sent> {
    this.svm.expireBlockhash();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => this.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    return this.svm.sendTransaction(await signTransactionMessageWithSigners(message));
  }

  async send(payer: KeyPairSigner, ixs: Instruction[]): Promise<TransactionMetadata> {
    const result = await this.attempt(payer, ixs);
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
    }
    return result;
  }

  async funded(): Promise<KeyPairSigner> {
    const kp = await generateKeyPairSigner();
    this.svm.airdrop(kp.address, lamports(100_000_000_000n));
    return kp;
  }

  private async upgradeAuthority(authority: Address): Promise<Address> {
    const [programData] = await getProgramDerivedAddress({
      programAddress: LOADER,
      seeds: [getAddressEncoder().encode(INTENT_ENGINE_PROGRAM_ADDRESS)],
    });
    const account = this.svm.getAccount(programData);
    if (!account.exists) {
      throw new Error("program data missing");
    }
    const data = new Uint8Array(account.data);
    data[12] = 1;
    data.set(getAddressEncoder().encode(authority), 13);
    this.svm.setAccount({ ...account, data });
    return programData;
  }

  private async mint(): Promise<Address> {
    const m = await generateKeyPairSigner();
    const space = BigInt(getMintSize());
    await this.send(this.authority, [
      getCreateAccountInstruction({
        payer: this.authority,
        newAccount: m,
        lamports: this.svm.minimumBalanceForRentExemption(space),
        space,
        programAddress: TOKEN,
      }),
      getInitializeMint2Instruction({ mint: m.address, decimals: 6, mintAuthority: this.authority.address }),
    ]);
    return m.address;
  }

  async ata(owner: Address, amount = 0n, mint = this.inputMint): Promise<Address> {
    const ix = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: this.authority, owner, mint });
    const address = await findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN });
    const extra = amount > 0n ? [getMintToInstruction({ mint, token: address, mintAuthority: this.authority, amount })] : [];
    await this.send(this.authority, [ix, ...extra]);
    return address;
  }

  balance(address: Address): bigint {
    const account = this.svm.getAccount(address);
    return account.exists ? getTokenDecoder().decode(account.data).amount : -1n;
  }

  lamportsOf(address: Address): bigint {
    const account = this.svm.getAccount(address);
    return account.exists ? account.lamports : 0n;
  }

  exists(address: Address): boolean {
    return this.svm.getAccount(address).exists;
  }

  announcement(address: Address): Announcement {
    const account = this.svm.getAccount(address);
    if (!account.exists) {
      throw new Error(`no announcement at ${address}`);
    }
    return getAnnouncementDecoder().decode(account.data);
  }

  async proofEscrow(owner: KeyPairSigner, attestor: Address, committee?: Address): Promise<Address> {
    await this.ata(owner.address, 1_000n);
    await this.ata(owner.address, 0n, this.outputMint);
    await this.send(owner, [await buildInitUser({ owner })]);
    await this.send(owner, [
      await buildCreateIntent({
        treasury: this.feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        owner,
        nonce: 0n,
        params: { kind: Kind.AttestedResult, amountIn: ESCROW, minResult: 1n, maxResult: 1n, attestor, specHash: SPEC, judgeFee: 0n },
        expiresAt: NOW + 3_600n,
        inputMint: this.inputMint,
        outputMint: this.outputMint,
        inputTokenProgram: TOKEN,
        outputTokenProgram: TOKEN,
        ...(committee === undefined ? {} : { committee }),
      }),
    ]);
    return (await findIntentPda({ owner: owner.address, nonce: 0n }))[0];
  }
}

export function customCode(result: Sent): number | undefined {
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

export function emitted(meta: TransactionMetadata): DecodedEvent[] {
  return meta
    .innerInstructions()
    .flat()
    .map((inner) => decodeEvent(inner.instruction().data()))
    .filter((event) => event !== null);
}

export function named(events: DecodedEvent[], name: string): Record<string, unknown> {
  const found = events.find((event) => event.name === name);
  if (found === undefined) {
    throw new Error(`no ${name} event among ${events.map((e) => e.name).join(", ")}`);
  }
  return found.fields as Record<string, unknown>;
}

import { createHash } from "node:crypto";
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
import { getCreateAssociatedTokenIdempotentInstructionAsync, getInitializeMint2Instruction, getMintSize, getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { beforeAll, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentCoreError, Kind } from "../src/index.js";
import {
  ALL_KINDS_MASK,
  buildCreateIntent,
  buildCreateProfile,
  buildInitUser,
  delivery,
  deliverySecrets,
  encryptionKeyText,
  findBookPda,
  findConfigPda,
  findEventAuthorityPda,
  findIntentPda,
  findProfilePda,
  getAnnounceDeliveryInstruction,
  getInitConfigInstructionAsync,
  INTENT_ENGINE_ERROR__BLOB_MALFORMED,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
  openDeliveryV4,
  sealDeliveryV4,
} from "../src/internal.js";
import { profileMember, saltSignature, urlOf, wallet } from "./sealed-v4-reference.js";

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const NOW = 1_700_000_000n;
const enginePath = process.env["INTENT_ENGINE_SO"] ?? fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

let svm: LiteSVM;
let worker: KeyPairSigner;
let judge: KeyPairSigner;
let intent: Address;
let judgeKey: Awaited<ReturnType<typeof profileMember>>;

async function attempt(payer: KeyPairSigner, ixs: Instruction[]): Promise<TransactionMetadata | FailedTransactionMetadata> {
  svm.expireBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return svm.sendTransaction(await signTransactionMessageWithSigners(message));
}

async function send(payer: KeyPairSigner, ixs: Instruction[]): Promise<void> {
  const result = await attempt(payer, ixs);
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
  }
}

function customCode(result: TransactionMetadata | FailedTransactionMetadata): number | null {
  if (!(result instanceof FailedTransactionMetadata)) {
    return null;
  }
  const failure = result.err();
  if (typeof failure !== "object" || !("err" in failure)) {
    return -1;
  }
  const inner = failure.err();
  return typeof inner === "object" && "code" in inner ? inner.code : -1;
}

async function funded(): Promise<KeyPairSigner> {
  const kp = await generateKeyPairSigner();
  svm.airdrop(kp.address, lamports(100_000_000_000n));
  return kp;
}

async function makeUpgradeAuthority(authority: Address): Promise<Address> {
  const [programData] = await getProgramDerivedAddress({ programAddress: LOADER, seeds: [getAddressEncoder().encode(INTENT_ENGINE_PROGRAM_ADDRESS)] });
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

async function mint(payer: KeyPairSigner): Promise<Address> {
  const m = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  await send(payer, [
    getCreateAccountInstruction({ payer, newAccount: m, lamports: svm.minimumBalanceForRentExemption(space), space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: m.address, decimals: 6, mintAuthority: payer.address }),
  ]);
  return m.address;
}

async function announce(blob: Uint8Array): Promise<TransactionMetadata | FailedTransactionMetadata> {
  const digest = createHash("sha256").update(blob).digest();
  const encoder = getAddressEncoder();
  const [announcement] = await getProgramDerivedAddress({
    programAddress: INTENT_ENGINE_PROGRAM_ADDRESS,
    seeds: [new TextEncoder().encode("announcement"), encoder.encode(intent), encoder.encode(worker.address), digest],
  });
  const [[config], [eventAuthority], [book], [judgeProfile]] = await Promise.all([
    findConfigPda(),
    findEventAuthorityPda(),
    findBookPda({ intent }),
    findProfilePda({ wallet: judge.address }),
  ]);
  return attempt(worker, [
    getAnnounceDeliveryInstruction({
      worker,
      payer: worker,
      config,
      intent,
      attestor: judge.address,
      judgeProfile,
      book,
      announcement,
      eventAuthority,
      program: INTENT_ENGINE_PROGRAM_ADDRESS,
      commitment: new Uint8Array(32).fill(7),
      blob,
    }),
  ]);
}

function headVerdict(blob: Uint8Array): "accepted" | "malformed" {
  try {
    delivery.blobHead(blob);
    return "accepted";
  } catch (error) {
    if (error instanceof IntentCoreError && error.engineError === "BlobMalformed") {
      return "malformed";
    }
    throw error;
  }
}

const chainVerdict = (result: TransactionMetadata | FailedTransactionMetadata): "accepted" | "malformed" | number =>
  customCode(result) === INTENT_ENGINE_ERROR__BLOB_MALFORMED ? "malformed" : (customCode(result) ?? "accepted");

describe("sealed v4 blobs on the deployed program", () => {
  beforeAll(async () => {
    svm = new LiteSVM().withPrecompiles();
    svm.addProgramFromFile(INTENT_ENGINE_PROGRAM_ADDRESS, enginePath);
    const clock = svm.getClock();
    clock.unixTimestamp = NOW;
    svm.setClock(clock);
    const authority = await funded();
    const [eventAuthority] = await findEventAuthorityPda();
    await send(authority, [
      await getInitConfigInstructionAsync({
        authority,
        engineProgram: INTENT_ENGINE_PROGRAM_ADDRESS,
        programData: await makeUpgradeAuthority(authority.address),
        eventAuthority,
        program: INTENT_ENGINE_PROGRAM_ADDRESS,
        domain: new Uint8Array(32).fill(0x11),
        guardian: authority.address,
        feeRecipient: authority.address,
        enabledKinds: ALL_KINDS_MASK,
        feeBps: 5,
        paused: 0,
      }),
    ]);
    const owner = await funded();
    worker = await funded();
    judge = await funded();
    judgeKey = await profileMember();
    await send(judge, [await buildCreateProfile({ wallet: judge, skills: ["judge"], endpoint: "https://" + "judge.example", encryptionKey: encryptionKeyText(judgeKey.key) })]);
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    const ownerInput = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: authority, owner: owner.address, mint: inputMint });
    const ata = await findAssociatedTokenAddress({ owner: owner.address, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const receiver = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: authority, owner: owner.address, mint: outputMint });
    await send(authority, [ownerInput, receiver, getMintToInstruction({ mint: inputMint, token: ata, mintAuthority: authority, amount: 1_000n })]);
    await send(owner, [await buildInitUser({ owner })]);
    await send(owner, [
      await buildCreateIntent({
        treasury: authority.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        owner,
        nonce: 0n,
        params: { kind: Kind.AttestedResult, amountIn: 400n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(32).fill(9), judgeFee: 0n },
        expiresAt: NOW + 3_600n,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ]);
    [intent] = await findIntentPda({ owner: owner.address, nonce: 0n });
  });

  it("accepts a sealed blob whose fingerprint the program derives from the judge's profile key", async () => {
    const sig = saltSignature(wallet(), intent);
    const url = urlOf(delivery.MAX_BLOB_URL);
    const blob = await sealDeliveryV4(await deliverySecrets(url, [judgeKey.recipient], sig), intent, worker.address);
    expect(chainVerdict(await announce(blob))).toBe("accepted");
    expect((await openDeliveryV4(blob, judgeKey.opener, intent, worker.address))?.url).toBe(url);
  });

  it("refuses exactly the bytes blobHead refuses", async () => {
    const sig = saltSignature(wallet(), intent);
    const short = await sealDeliveryV4(await deliverySecrets(urlOf(24), [judgeKey.recipient], sig), intent, worker.address);
    const long = await sealDeliveryV4(await deliverySecrets(urlOf(delivery.MAX_BLOB_URL), [judgeKey.recipient], sig), intent, worker.address);
    const set = (blob: Uint8Array, at: number, value: number) => Uint8Array.from(blob, (b, i) => (i === at ? value : b));
    const cases: Uint8Array[] = [
      new Uint8Array(0),
      Uint8Array.of(4),
      Uint8Array.of(4, 1),
      Uint8Array.of(4, 1, 1),
      short.slice(0, 139),
      short.slice(0, 140),
      short.slice(0, short.length - 1),
      Uint8Array.from([...short, 0x61]),
      long.slice(0, long.length - 1),
      Uint8Array.from([...long, 0x61]),
      set(short, 0, 3),
      set(short, 0, 5),
      set(short, 1, 0),
      set(short, 1, 9),
      set(short, 1, 2),
      set(short, 2, 2),
      set(short, 2, 0x80),
      set(short, 2, 0),
      set(short, 3, (short[3] ?? 0) ^ 1),
      set(short, short.length - 1, (short[short.length - 1] ?? 0) ^ 1),
      Uint8Array.from([...long.slice(0, 2), 8, ...long.slice(3), ...new Uint8Array(40 * 7)]),
      Uint8Array.from([4, 8, 0xff, ...new Uint8Array(99 + 40 * 8 + delivery.MAX_BLOB_URL - 3)]),
      Uint8Array.from([4, 8, 0xff, ...new Uint8Array(99 + 40 * 8 + delivery.MAX_BLOB_URL - 2)]),
    ];
    const verdicts = [];
    for (const blob of cases) {
      const ts = headVerdict(blob);
      const chain = chainVerdict(await announce(blob));
      verdicts.push({ length: blob.length, ts, chain });
      expect(chain === "malformed", `blob of ${blob.length} bytes: blobHead ${ts}, program ${String(chain)}`).toBe(ts === "malformed");
    }
    expect(verdicts.filter((v) => v.ts === "malformed").length).toBeGreaterThan(10);
    expect(verdicts.filter((v) => v.ts === "accepted").length).toBeGreaterThan(4);
  });
});

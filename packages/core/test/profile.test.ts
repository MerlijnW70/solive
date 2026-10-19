import { fileURLToPath } from "node:url";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  type Instruction,
  type KeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCloseProfile,
  buildCreateProfile,
  buildUpdateProfile,
  findEventAuthorityPda,
  getCreateProfileInstructionAsync,
  getProfileSize,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentCoreError,
  type ProfileInput,
  profileAddress,
  PROFILE_DISCRIMINATOR,
  PROFILE_VERSION,
  AccountVersionError,
  profileView,
} from "../src/index.js";

const NOW = 1_700_000_000n;
const enginePath =
  process.env["INTENT_ENGINE_SO"] ?? fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

let svm: LiteSVM;

async function attempt(payer: KeyPairSigner, ixs: Instruction[]) {
  svm.expireBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const result = svm.sendTransaction(await signTransactionMessageWithSigners(message));
  return result instanceof FailedTransactionMetadata ? result.meta().logs().join("\n") : null;
}

async function funded(): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  svm.airdrop(signer.address, lamports(10_000_000_000n));
  return signer;
}

async function rawCreate(wallet: KeyPairSigner, args: { skills: string[]; endpoint: string; docUrl: string; docHash: Uint8Array }) {
  const [eventAuthority] = await findEventAuthorityPda();
  return getCreateProfileInstructionAsync({ wallet, args, eventAuthority, program: INTENT_ENGINE_PROGRAM_ADDRESS });
}

function refusal(build: () => Promise<unknown>): Promise<string> {
  return build().then(
    () => "built",
    (error: unknown) => (error instanceof IntentCoreError ? error.code : String(error)),
  );
}

const HASH = "ab".repeat(32);
const hashBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const BASE = { skills: ["rust", "code-review"], endpoint: "https://worker.example/jobs" };

type Case = { name: string; input: ProfileInput; onChain?: { skills: string[]; endpoint: string; docUrl: string; docHash: Uint8Array } };

const raw = (input: ProfileInput, docHash = new Uint8Array(32)) => ({ skills: input.skills, endpoint: input.endpoint, docUrl: input.docUrl ?? "", docHash });

const REFUSED: Case[] = [
  { skills: [] },
  { skills: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
  { skills: ["rust", "rust"] },
  { skills: ["-rust"] },
  { skills: ["rust-"] },
  { skills: ["Rust"] },
  { skills: ["ru_st"] },
  { skills: [""] },
  { skills: ["a".repeat(17)] },
  { skills: ["café"] },
].map((over) => ({ name: `skills ${JSON.stringify(over.skills)}`, input: { ...BASE, ...over } }))
  .concat(
    ["http://worker.example", "https://", "https://a b", "https://a\\b", "https://" + "a".repeat(121), "https://é", "worker.example"].map((endpoint) => ({
      name: `endpoint ${endpoint.slice(0, 24)}`,
      input: { ...BASE, endpoint },
    })),
  )
  .map((c) => ({ ...c, onChain: raw(c.input) }));

const DOC_REFUSED: Case[] = [
  { name: "a document url without its hash", input: { ...BASE, docUrl: "https://worker.example/doc" }, onChain: raw({ ...BASE, docUrl: "https://worker.example/doc" }) },
  { name: "a hash without its document url", input: { ...BASE, docSha256: HASH }, onChain: raw(BASE, hashBytes(HASH)) },
  { name: "an all-zero hash", input: { ...BASE, docUrl: "https://worker.example/doc", docSha256: "0".repeat(64) }, onChain: raw({ ...BASE, docUrl: "https://worker.example/doc" }) },
  { name: "a document url that is not https", input: { ...BASE, docUrl: "ftp://worker.example/doc", docSha256: HASH }, onChain: raw({ ...BASE, docUrl: "ftp://worker.example/doc" }, hashBytes(HASH)) },
  { name: "an empty document url", input: { ...BASE, docUrl: "", docSha256: HASH }, onChain: raw(BASE, hashBytes(HASH)) },
  { name: "a hash of 63 digits", input: { ...BASE, docUrl: "https://worker.example/doc", docSha256: HASH.slice(1) } },
];

const ACCEPTED: ProfileInput[] = [
  { skills: ["a"], endpoint: "https://x" },
  { skills: Array.from({ length: 8 }, (_, i) => `${"a".repeat(15)}${i}`), endpoint: "https://" + "b".repeat(120) },
  { skills: ["0-9", "a-b-c"], endpoint: "https://x/~!#$%&()*+,-./:;<=>?@[]^_`{|}", docUrl: "https://" + "c".repeat(120), docSha256: HASH.toUpperCase() },
];

describe("profiles", () => {
  beforeEach(() => {
    svm = new LiteSVM();
    svm.addProgramFromFile(INTENT_ENGINE_PROGRAM_ADDRESS, enginePath);
    const clock = svm.getClock();
    clock.unixTimestamp = NOW;
    svm.setClock(clock);
  });

  it("profile builders refuse every input the program would refuse", async () => {
    for (const c of [...REFUSED, ...DOC_REFUSED]) {
      const wallet = await funded();
      expect(await refusal(() => buildCreateProfile({ wallet, ...c.input })), c.name).toBe("ProfileInvalid");
      expect(await refusal(() => buildUpdateProfile({ wallet, ...c.input })), c.name).toBe("ProfileInvalid");
      if (c.onChain !== undefined) {
        expect(await attempt(wallet, [await rawCreate(wallet, c.onChain)]), c.name).toContain("ProfileInvalid");
      }
    }
    for (const input of ACCEPTED) {
      const wallet = await funded();
      expect(await attempt(wallet, [await buildCreateProfile({ wallet, ...input })])).toBeNull();
      expect(await attempt(wallet, [await buildUpdateProfile({ wallet, ...input })])).toBeNull();
      expect(await attempt(wallet, [await buildCloseProfile({ wallet })])).toBeNull();
      expect(svm.getAccount(await profileAddress(wallet.address)).exists).toBe(false);
    }
  });

  it("profileView reads back what create_profile stored", async () => {
    const wallet = await funded();
    const input = { skills: ["solana", "ts"], endpoint: "https://worker.example/jobs", docUrl: "https://worker.example/about.md", docSha256: HASH };
    expect(await attempt(wallet, [await buildCreateProfile({ wallet, ...input })])).toBeNull();
    const address = await profileAddress(wallet.address);
    const read = () => {
      const account = svm.getAccount(address);
      if (!account.exists) {
        throw new Error("no profile");
      }
      return profileView(account.data);
    };
    expect(read()).toEqual({ wallet: wallet.address, ...input, updatedAt: NOW });
    const clock = svm.getClock();
    clock.unixTimestamp = NOW + 60n;
    svm.setClock(clock);
    expect(await attempt(wallet, [await buildUpdateProfile({ wallet, skills: ["rust"], endpoint: "https://other.example" })])).toBeNull();
    expect(read()).toEqual({ wallet: wallet.address, skills: ["rust"], endpoint: "https://other.example", docUrl: null, docSha256: null, updatedAt: NOW + 60n });
    expect(() => profileView(new Uint8Array(16))).toThrow(RangeError);
  });

  it("profileView reads an account of the profile size and current version that starts with its discriminator, and nothing else", () => {
    const account = (length: number, version = PROFILE_VERSION) => {
      const data = new Uint8Array(length);
      data.set(PROFILE_DISCRIMINATOR);
      data[8 + 456] = version;
      return data;
    };
    const empty = { skills: [], endpoint: "", docUrl: null, docSha256: null, updatedAt: 0n };
    expect(profileView(account(getProfileSize()))).toMatchObject(empty);
    expect(() => profileView(account(getProfileSize() + 8))).toThrow(AccountVersionError);
    expect(() => profileView(account(getProfileSize(), PROFILE_VERSION - 1))).toThrow(`this profile account is of version ${PROFILE_VERSION - 1}`);
    expect(() => profileView(account(getProfileSize() - 1))).toThrow("the data is not a profile account");
    const wrong = account(getProfileSize());
    wrong.set([(PROFILE_DISCRIMINATOR[7] ?? 0) ^ 1], 7);
    expect(() => profileView(wrong)).toThrow("the data is not a profile account");
  });
});

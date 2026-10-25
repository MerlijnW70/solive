import { createHash } from "node:crypto";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64Decoder,
  type Instruction,
  isSignerRole,
  isWritableRole,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { expect } from "vitest";
import {
  compileVaultMessage,
  type ConfigAction,
  configTransactionCreate,
  proposalApprove,
  proposalCreate,
  proposalPda,
  transactionPda,
  vaultTransactionCreate,
} from "../src/layout.js";
import { EXIT_OK, NOT_SENT } from "../src/main.js";
import {
  type InstructionView,
  LOADER,
  programDataOf,
  readMultisig,
  vaultOf,
} from "../src/squads.js";
import { randomAddress, Svm } from "./svm.js";

export const SQUADS_SITE = ["https:", "", "app.squads.so"].join("/");

export let s: Svm;

export async function openSvm() {
  s = await Svm.open();
}

export const bytesOf = (key: Address) => new Uint8Array(getAddressEncoder().encode(key));

export const printedView = (ix: Instruction) => ({
  program: ix.programAddress,
  accounts: (ix.accounts ?? []).map((meta) => ({ address: meta.address, signer: isSignerRole(meta.role), writable: isWritableRole(meta.role) })),
  data: getBase64Decoder().decode(ix.data ?? new Uint8Array()),
});

export const printed = (signer: Address, instructions: Instruction[], summary: string[]) =>
  JSON.stringify({
    cluster: { url: "https://api.devnet.solana.com", genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" },
    summary,
    unsigned: {
      signers: [signer],
      fee_payer: signer,
      instructions: instructions.map(printedView),
      next: "import transaction_base58 into the multisig as a proposal",
    },
  });

export async function multisig(tag: string, threshold: number, timeLock = 0) {
  const members = await Promise.all(["a", "b", "c"].map((name) => s.member(`${tag}-${name}.json`)));
  const createKey = await generateKeyPairSigner();
  s.keys.set(`${tag}-create.json`, createKey);
  const args = ["create", "--members", members.map((m) => m.address).join(","), "--threshold", String(threshold)];
  const lock = timeLock === 0 ? [] : ["--time-lock", String(timeLock)];
  const keys = ["--keypair", `${tag}-a.json`, "--create-key", `${tag}-create.json`];
  const preview = await s.cli(...args, ...lock, ...keys);
  expect([preview.code, preview.json()["sent"], preview.json()["simulation"], preview.json()["next"]]).toEqual([EXIT_OK, false, "ok", NOT_SENT]);
  const created = await s.cli(...args, ...lock, ...keys, "--yes");
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  const out = created.json();
  const at = address(out["multisig"] as string);
  const vault = await vaultOf(at);
  expect(out).toMatchObject({ sent: true, vault, threshold, time_lock: timeLock });
  return { address: at, vault, members, file: (name: string) => `${tag}-${name}.json` };
}

export const paidByVault = (list: InstructionView[], vault: Address): InstructionView[] =>
  list.map((ix) => ({
    ...ix,
    accounts: ix.accounts.map((meta) => (meta.address === vault ? { ...meta, writable: true } : meta)),
  }));

export const header = (tag: number, body: Uint8Array[]) => {
  const parts = [new Uint8Array([tag, 0, 0, 0]), ...body];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

export const base64 = (bytes: number[]) => getBase64Decoder().decode(new Uint8Array(bytes));

export const sha256 = (code: Uint8Array) => {
  let end = code.length;
  while (end > 0 && code[end - 1] === 0) {
    end -= 1;
  }
  return createHash("sha256").update(code.subarray(0, end)).digest("hex");
};

export async function sendAs(payer: KeyPairSigner, instructions: Instruction[]): Promise<void> {
  const tx = await signTransaction(
    [payer.keyPair],
    compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (msg) => setTransactionMessageFeePayer(payer.address, msg),
        (msg) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: s.svm.latestBlockhash(), lastValidBlockHeight: 0n }, msg),
        (msg) => appendTransactionMessageInstructions(instructions, msg),
      ),
    ),
  );
  await s.chain.send(tx);
}

export type Made = Awaited<ReturnType<typeof multisig>>;

export const signerOf = (m: Made, name: string): KeyPairSigner => {
  const found = s.keys.get(m.file(name));
  if (found === undefined) {
    throw new Error(`no member ${name}`);
  }
  return found;
};

export async function craft(m: Made, create: (transaction: Address, creator: Address) => Instruction): Promise<bigint> {
  const creator = signerOf(m, "a");
  const index = (await readMultisig(s.chain, m.address)).transactionIndex + 1n;
  const transaction = await transactionPda(m.address, index);
  await sendAs(creator, [
    create(transaction, creator.address),
    proposalCreate({ multisig: m.address, proposal: await proposalPda(m.address, index), creator: creator.address, index }),
  ]);
  return index;
}

export const craftVault = (m: Made, instructions: Instruction[]) =>
  craft(m, (transaction, creator) =>
    vaultTransactionCreate({ multisig: m.address, transaction, creator, vaultIndex: 0, message: compileVaultMessage(m.vault, instructions) }),
  );

export const craftConfig = (m: Made, actions: ConfigAction[]) => craft(m, (transaction, creator) => configTransactionCreate({ multisig: m.address, transaction, creator, actions }));

export async function approveDirectly(m: Made, index: bigint, names: string[]): Promise<void> {
  for (const name of names) {
    const member = signerOf(m, name);
    await sendAs(member, [proposalApprove({ multisig: m.address, proposal: await proposalPda(m.address, index), member: member.address })]);
  }
}

export async function upgradeable(vault: Address): Promise<Address> {
  const program = await randomAddress();
  s.set(await programDataOf(program), LOADER, header(3, [new Uint8Array(8), new Uint8Array([1]), bytesOf(vault), new Uint8Array(16)]));
  return program;
}

export const bufferBytes = (authority: Address, code: Uint8Array) => header(1, [new Uint8Array([1]), bytesOf(authority), code]);

export async function bufferHeldBy(authority: Address, code: Uint8Array): Promise<Address> {
  const at = await randomAddress();
  s.set(at, LOADER, bufferBytes(authority, code));
  return at;
}

export const proposalOf = async (m: Made, index: bigint) => (await s.cli("show", "--multisig", m.address, "--index", index.toString())).json()["proposals"][0];

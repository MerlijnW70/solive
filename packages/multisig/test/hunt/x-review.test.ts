import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { compileVaultMessage, proposalApprove, proposalCreate, proposalPda, transactionPda, vaultTransactionCreate } from "../../src/layout.js";
import { EXIT_REFUSED } from "../../src/main.js";
import { ENGINE_PROGRAM, readMultisig, vaultOf } from "../../src/squads.js";
import { Svm } from "../svm.js";

let s: Svm;
beforeAll(async () => {
  s = await Svm.open();
});

async function multisig(tag: string, threshold: number) {
  const members = await Promise.all(["a", "b", "c"].map((name) => s.member(`${tag}-${name}.json`)));
  const createKey = await generateKeyPairSigner();
  s.keys.set(`${tag}-create.json`, createKey);
  const args = ["create", "--members", members.map((m) => m.address).join(","), "--threshold", String(threshold)];
  const keys = ["--keypair", `${tag}-a.json`, "--create-key", `${tag}-create.json`, "--yes"];
  const created = await s.cli(...args, ...keys);
  const at = address(created.json()["multisig"] as string);
  const vault = await vaultOf(at);
  return { address: at, vault, members, file: (name: string) => `${tag}-${name}.json` };
}

type Made = Awaited<ReturnType<typeof multisig>>;
const signerOf = (m: Made, name: string): KeyPairSigner => s.keys.get(m.file(name)) as KeyPairSigner;

async function sendAs(payer: KeyPairSigner, instructions: Instruction[]): Promise<void> {
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

async function craftVault(m: Made, instructions: Instruction[]): Promise<bigint> {
  const creator = signerOf(m, "a");
  const index = (await readMultisig(s.chain, m.address)).transactionIndex + 1n;
  const transaction = await transactionPda(m.address, index);
  await sendAs(creator, [
    vaultTransactionCreate({ multisig: m.address, transaction, creator: creator.address, vaultIndex: 0, message: compileVaultMessage(m.vault, instructions) }),
    proposalCreate({ multisig: m.address, proposal: await proposalPda(m.address, index), creator: creator.address, index }),
  ]);
  return index;
}

const proposalOf = async (m: Made, index: bigint): Promise<Record<string, unknown>> =>
  (await s.cli("show", "--multisig", m.address, "--index", index.toString())).json()["proposals"][0];

describe("multisig review", () => {
  it("X-4: approve signs off on an intent-engine instruction the tool cannot decode", async () => {
    const m = await multisig("undecodable", 2);
    const undecodable: Instruction = {
      programAddress: ENGINE_PROGRAM,
      accounts: [{ address: m.vault, role: AccountRole.WRITABLE_SIGNER }],
      data: Uint8Array.from([255, 255, 255, 255, 255, 255, 255, 255, 1, 2, 3, 4]),
    };
    const index = await craftVault(m, [undecodable]);

    const shown = await proposalOf(m, index);
    expect(shown["kind"]).toBe("vault");
    expect(shown["summary"]).toEqual([
      `Intent engine instruction that this version cannot decode (12 bytes of data), signed by ${m.vault}`,
    ]);
    expect(shown["problems"]).toEqual([`it carries an intent engine instruction whose 12 bytes this version cannot decode, so approving it would sign for an effect the tool cannot show`]);

    const honest = await s.cli("approve", "--multisig", m.address, "--index", index.toString(), "--keypair", m.file("b"), "--yes");

    expect(honest.code).toBe(EXIT_REFUSED);
  });
});

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, getSignatureFromTransaction, type KeyPairSigner, lamports, type Transaction } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import type { Chain } from "../src/chain.js";
import { encodeAccount, programConfigCodec, programConfigPda } from "../src/layout.js";
import { main, type Deps } from "../src/main.js";
import { SQUADS_PROGRAM } from "../src/squads.js";

export const SQUADS_SHA256 = "dec8d3e0fae58c7c8f2416e5f67c25e673f047afd6dd2bba4a47e0b29a01d34c";
export const SOL = 1_000_000_000n;

const squadsPath =
  process.env["SQUADS_SO"] ?? join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "solive-fixtures", "squads_multisig.so");

export const enginePath = process.env["INTENT_ENGINE_SO"] ?? fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

function fixture(path: string, missing: string): Uint8Array {
  if (!existsSync(path)) {
    throw new Error(`${path} is missing; ${missing}`);
  }
  return new Uint8Array(readFileSync(path));
}

export const squadsProgram = (): Uint8Array => {
  const bytes = fixture(squadsPath, "run bash scripts/fetch-squads.sh");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== SQUADS_SHA256) {
    throw new Error(`${squadsPath} hashes to ${digest}, not the pinned ${SQUADS_SHA256}; run bash scripts/fetch-squads.sh`);
  }
  return bytes;
};

export const engineProgram = (): Uint8Array => fixture(enginePath, "build the program or set INTENT_ENGINE_SO");

export const randomAddress = async (): Promise<Address> => (await generateKeyPairSigner()).address;

export class Svm {
  readonly svm = new LiteSVM();
  readonly keys = new Map<string, KeyPairSigner>();
  readonly runs: string[][] = [];
  printed = "";

  static async open(treasury?: Address): Promise<Svm> {
    const s = new Svm();
    s.svm.addProgram(SQUADS_PROGRAM, squadsProgram());
    const paidTo = treasury ?? (await randomAddress());
    s.fund(paidTo);
    const data = encodeAccount("ProgramConfig", programConfigCodec, {
      authority: await randomAddress(),
      multisigCreationFee: 0n,
      treasury: paidTo,
      reserved: new Uint8Array(64),
    });
    s.set(await programConfigPda(), SQUADS_PROGRAM, data);
    return s;
  }

  fund(key: Address, amount = 10n * SOL): void {
    this.svm.airdrop(key, lamports(amount));
  }

  set(key: Address, owner: Address, data: Uint8Array, executable = false): void {
    this.svm.setAccount({
      address: key,
      programAddress: owner,
      data,
      executable,
      lamports: lamports(this.svm.minimumBalanceForRentExemption(BigInt(data.length))),
      space: BigInt(data.length),
    });
  }

  account(key: Address) {
    return this.svm.getAccount(key);
  }

  async member(name: string): Promise<KeyPairSigner> {
    const keypair = await generateKeyPairSigner();
    this.fund(keypair.address);
    this.keys.set(name, keypair);
    return keypair;
  }

  readonly chain: Chain = {
    account: async (key) => {
      const found = this.account(key);
      return found.exists ? { data: new Uint8Array(found.data), owner: found.programAddress } : null;
    },
    blockhash: async () => ({ blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 0n }),
    simulate: async (tx: Transaction) => {
      const result = this.svm.simulateTransaction(tx);
      return result instanceof FailedTransactionMetadata
        ? { err: String(result.err()), logs: result.meta().logs() }
        : { err: null, logs: result.meta().logs() };
    },
    send: async (tx: Transaction) => {
      const result = this.svm.sendTransaction(tx);
      this.svm.expireBlockhash();
      if (result instanceof FailedTransactionMetadata) {
        throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
      }
      return getSignatureFromTransaction(tx);
    },
  };

  readonly deps: Deps = {
    chain: () => this.chain,
    keypair: async (path) => {
      const keypair = this.keys.get(path);
      if (keypair === undefined) {
        throw new Error(`no keypair at ${path}`);
      }
      return keypair;
    },
    run: async (argv) => {
      this.runs.push(argv);
      return this.printed;
    },
  };

  async cli(...argv: string[]) {
    const result = await main(argv, this.deps);
    return { ...result, json: () => JSON.parse(result.code === 0 ? result.out : result.err) as Record<string, any> };
  }
}

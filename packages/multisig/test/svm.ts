import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, getBase58Decoder, getTransactionDecoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { type AccountInfo, Keypair, PublicKey, type VersionedTransaction } from "@solana/web3.js";
import * as squads from "@sqds/multisig";
import type { Chain } from "../src/chain.js";
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

const at = (key: PublicKey) => key.toBase58() as Address;

export class Svm {
  readonly svm = new LiteSVM();
  readonly keys = new Map<string, Keypair>();
  readonly runs: string[][] = [];
  printed = "";

  constructor() {
    this.svm.addProgram(at(SQUADS_PROGRAM), squadsProgram());
    const treasury = Keypair.generate().publicKey;
    this.fund(treasury);
    const [config] = squads.getProgramConfigPda({ programId: SQUADS_PROGRAM });
    const [data] = squads.accounts.ProgramConfig.fromArgs({
      authority: Keypair.generate().publicKey,
      multisigCreationFee: 0,
      treasury,
      reserved: new Array<number>(64).fill(0),
    }).serialize();
    this.set(config, SQUADS_PROGRAM, data);
  }

  fund(key: PublicKey, amount = 10n * SOL): void {
    this.svm.airdrop(at(key), lamports(amount));
  }

  set(key: PublicKey, owner: PublicKey, data: Uint8Array, executable = false): void {
    this.svm.setAccount({
      address: at(key),
      programAddress: at(owner),
      data,
      executable,
      lamports: lamports(this.svm.minimumBalanceForRentExemption(BigInt(data.length))),
      space: BigInt(data.length),
    });
  }

  account(key: PublicKey) {
    return this.svm.getAccount(at(key));
  }

  member(name: string): Keypair {
    const keypair = Keypair.generate();
    this.fund(keypair.publicKey);
    this.keys.set(name, keypair);
    return keypair;
  }

  private decode(tx: VersionedTransaction) {
    return getTransactionDecoder().decode(tx.serialize());
  }

  readonly chain: Chain = {
    account: async (key): Promise<AccountInfo<Buffer> | null> => {
      const found = this.account(key);
      return found.exists
        ? { data: Buffer.from(found.data), owner: new PublicKey(found.programAddress), lamports: Number(found.lamports), executable: found.executable }
        : null;
    },
    blockhash: async () => this.svm.latestBlockhash(),
    simulate: async (tx) => {
      const result = this.svm.simulateTransaction(this.decode(tx));
      return result instanceof FailedTransactionMetadata
        ? { err: String(result.err()), logs: result.meta().logs() }
        : { err: null, logs: result.meta().logs() };
    },
    send: async (tx) => {
      const result = this.svm.sendTransaction(this.decode(tx));
      this.svm.expireBlockhash();
      if (result instanceof FailedTransactionMetadata) {
        throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
      }
      return getBase58Decoder().decode(tx.signatures[0] ?? new Uint8Array(64));
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

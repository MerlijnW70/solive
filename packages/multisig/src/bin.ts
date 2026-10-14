#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Keypair } from "@solana/web3.js";
import { connectionChain } from "./chain.js";
import { main } from "./main.js";
import { Refusal } from "./squads.js";

const run = promisify(execFile);

const result = await main(process.argv.slice(2), {
  chain: connectionChain,
  keypair: async (path) => {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path, "utf8")) as number[]));
    } catch (error) {
      throw new Refusal(`cannot read the keypair file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
  run: async ([file = "", ...args]) => {
    try {
      return (await run(file, args, { maxBuffer: 16 * 1024 * 1024 })).stdout;
    } catch (error) {
      const failed = error as { stderr?: string; message?: string };
      throw new Refusal(`the command failed: ${(failed.stderr ?? "").trim() || failed.message}`);
    }
  },
});
process.stdout.write(result.out);
process.stderr.write(result.err);
process.exitCode = result.code;

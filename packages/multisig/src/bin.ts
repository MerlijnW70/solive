#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connectionChain } from "./chain.js";
import { readSigner } from "./keys.js";
import { main } from "./main.js";
import { Refusal } from "./squads.js";

const run = promisify(execFile);

const result = await main(process.argv.slice(2), {
  chain: connectionChain,
  keypair: (path) => readSigner(path),
  notify: (text) => process.stderr.write(text),
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

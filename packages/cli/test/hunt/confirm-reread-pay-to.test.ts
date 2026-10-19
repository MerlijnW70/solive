import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, Kind } from "@intent-engine/core";
import { createClient, type Transport } from "@intent-engine/client";
import { main } from "../../src/main.js";
import { sealedDelivery } from "../announce.js";
import { balance, creation, funded, h, NOW, runtime, transport, world } from "../harness.js";
import { announced, SECOND, SECOND_URL, secondNode, WORK_URL } from "../confirm-node.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function shiftingPrimary(hidden: string): { node: Transport; hiddenReads: () => number } {
  let historyRead = false;
  let honest = false;
  let hiddenReads = 0;
  const node: Transport = {
    ...transport,
    genesisHash: async () => {
      if (historyRead) {
        honest = true;
      }
      return transport.genesisHash();
    },
    engineTransactions: async (limit, of, memo) => {
      historyRead = true;
      const log = await transport.engineTransactions(limit, of, memo);
      if (honest) {
        return log;
      }
      hiddenReads++;
      return log.filter((t) => t.signature !== hidden);
    },
  };
  return { node, hiddenReads: () => hiddenReads };
}

describe("judge --confirm-url pays the earliest announcer both nodes reported", () => {
  it("W-3: a primary node hides the first announcer on its first read and answers honestly once the second node is compared", async () => {
    const w = await world();
    const judge = await funded();
    const keys: Record<string, KeyPairSigner> = { "judge.json": judge };
    const worker = (await generateKeyPairSigner()).address;
    const copier = (await generateKeyPairSigner()).address;
    const dir = await mkdtemp(join(tmpdir(), "confirm-reread-"));
    const spec = join(dir, "spec.md");
    const artifact = join(dir, "count.mjs");
    await writeFile(spec, SPEC);
    await writeFile(artifact, CORRECT);
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({
      signer: w.owner,
      params: {
        kind: Kind.AttestedResult,
        amountIn: 100n,
        minResult: 1n,
        maxResult: 1n,
        attestor: judge.address,
        specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()),
        judgeFee: 0n,
      },
      inputMint: w.inputMint,
      outputMint: w.outputMint,
      nonce: 0n,
      expiresAt: NOW + 3_600n,
    });
    const [copied, honest] = await Promise.all([copier, worker].map((by) => sealedDelivery(intent, by, sha(CORRECT), WORK_URL, [judge.address])));
    h.engineLog = [announced("copy", 7n, copier, copied ?? ""), announced("first", 5n, worker, honest ?? ""), creation(intent)];

    const primary = shiftingPrimary("first");
    const second = secondNode();
    const base = runtime(keys);
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper", "--confirm-url", SECOND, "--yes"],
      { ...base, transport: (url) => (url === SECOND_URL ? second.transport : primary.node) },
      { out: (t) => out.push(t), err: (t) => err.push(t) },
    );

    expect(primary.hiddenReads()).toBeGreaterThan(0);
    expect(second.reads).toBeGreaterThan(0);
    const paidTo = async (owner: Address) => balance(await findAssociatedTokenAddress({ owner, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
    const copierPaid = await paidTo(copier);
    const reported = { code, err: err.join("\n"), copierPaid };
    expect(reported.copierPaid, `both nodes reported ${worker} as the earliest announcer; exit ${code}; ${reported.err} ${out.join("\n")}`).toBe(-1n);
  });
});

import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, Kind } from "@intent-engine/core";
import { type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { main } from "../../src/main.js";
import { announced, keyed } from "../announce.js";
import { balance, funded, NOW, runtime, transport, world } from "../harness.js";
import { SECOND, SECOND_URL, secondNode, WORK_URL } from "../confirm-node.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function shiftingPrimary(hidden: Address): { node: Transport; hiddenReads: () => number } {
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
    engineAccounts: async (filter) => {
      historyRead = true;
      const found = (await transport.engineAccounts?.(filter)) ?? [];
      if (honest) {
        return found;
      }
      hiddenReads++;
      return found.filter((account) => account.address !== hidden);
    },
  };
  return { node, hiddenReads: () => hiddenReads };
}

describe("judge --confirm-url never pays a later announcer a node hides the first one from", () => {
  it("W-3: a primary node that hides the first announcement on its first read gets an incomplete list refused before any second-node check", async () => {
    const w = await world();
    const judge = await funded();
    const keys: Record<string, KeyPairSigner> = { "judge.json": judge };
    const worker = await keyed();
    const copier = await keyed();
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
    const first = await announced(intent, worker, sha(CORRECT), WORK_URL);
    await announced(intent, copier, sha(CORRECT), "https://" + "example.org/copy.mjs");

    const primary = shiftingPrimary(first.announcement);
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
    expect(code).toBe(1);
    expect(err.join(" ")).toContain("lists its announcements with seq 1 missing");
    const paidTo = async (owner: Address) => balance(await findAssociatedTokenAddress({ owner, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
    const copierPaid = await paidTo(copier.address);
    const reported = { code, err: err.join("\n"), copierPaid };
    expect(reported.copierPaid, `both nodes reported ${worker.address} as the earliest announcer; exit ${code}; ${reported.err} ${out.join("\n")}`).toBe(-1n);
  });
});

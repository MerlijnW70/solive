import { type Address, address, generateKeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import type { Chain } from "../src/chain.js";
import { programConfigPda } from "../src/layout.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_USAGE, main } from "../src/main.js";
import { vaultOf } from "../src/squads.js";
import { Svm } from "./svm.js";

let s: Svm;

beforeAll(async () => {
  s = await Svm.open();
});

async function multisig(tag: string, threshold: number, timeLock: number) {
  const members = await Promise.all(["a", "b", "c"].map((name) => s.member(`${tag}-${name}.json`)));
  s.keys.set(`${tag}-create.json`, await generateKeyPairSigner());
  const created = await s.cli(
    "create",
    "--members",
    members.map((m) => m.address).join(","),
    "--threshold",
    threshold.toString(),
    "--time-lock",
    timeLock.toString(),
    "--keypair",
    `${tag}-a.json`,
    "--create-key",
    `${tag}-create.json`,
    "--yes",
  );
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  const at = address(created.json()["multisig"] as string);
  return { address: at, vault: await vaultOf(at), members };
}

async function counted(...argv: string[]) {
  const reads: Address[] = [];
  const chain: Chain = {
    ...s.chain,
    account: async (key) => {
      reads.push(key);
      return s.chain.account(key);
    },
  };
  const result = await main(argv, { ...s.deps, chain: () => chain });
  return { ...result, reads, json: () => JSON.parse(result.code === 0 ? result.out : result.err) as Record<string, any> };
}

describe("vault", () => {
  it("prints the vault, threshold, time lock, members and transaction index from one account read", async () => {
    const m = await multisig("vault", 2, 3600);
    const read = await counted("vault", "--multisig", m.address);
    expect([read.code, read.err]).toEqual([EXIT_OK, ""]);
    expect(read.reads).toEqual([m.address]);
    const out = read.json();
    expect(out).toEqual({
      multisig: m.address,
      vault: m.vault,
      threshold: 2,
      timeLock: 3600,
      members: expect.arrayContaining(m.members.map((k) => ({ address: k.address, permissions: ["initiate", "vote", "execute"] }))),
      transactionIndex: "0",
    });
    expect(out["members"]).toHaveLength(3);
  });

  it("reports a threshold of one and no time lock as they are", async () => {
    const m = await multisig("loose", 1, 0);
    const out = (await counted("vault", "--multisig", m.address, "--url", "devnet")).json();
    expect(out).toMatchObject({ vault: m.vault, threshold: 1, timeLock: 0, transactionIndex: "0" });
  });

  it("refuses an address that is not a Squads v4 multisig after one read", async () => {
    const m = await multisig("refuse", 2, 0);
    const funded = await s.member("refuse-funded.json");
    const config = await programConfigPda();
    for (const at of [m.vault, funded.address, config]) {
      const refused = await counted("vault", "--multisig", at);
      expect([refused.code, refused.out, refused.json()]).toEqual([EXIT_REFUSED, "", { error: `${at} is not a Squads v4 multisig`, refused: true }]);
      expect(refused.reads).toEqual([at]);
    }
  });

  it("only reads: it refuses signing flags and an index without touching the chain", async () => {
    const m = await multisig("flags", 2, 0);
    for (const extra of [["--keypair", "flags-a.json"], ["--yes"], ["--index", "1"], ["--allow-config"], ["--allow-engine-close"], ["--expect-buffer-hash", "a".repeat(64)]]) {
      const refused = await counted("vault", "--multisig", m.address, ...extra);
      expect([refused.code, refused.reads]).toEqual([EXIT_USAGE, []]);
      expect(refused.json()["error"]).toBe("vault only reads the multisig; it takes no --keypair, --yes, --index, --allow-config, --allow-engine-close or --expect-buffer-hash");
    }
    const missing = await counted("vault");
    expect([missing.code, missing.json()["error"], missing.reads]).toEqual([EXIT_USAGE, "this command needs --multisig", []]);
    const malformed = await counted("vault", "--multisig", "not-an-address");
    expect([malformed.code, malformed.reads]).toEqual([EXIT_USAGE, []]);
    expect(missing.json()["usage"]).toContain("intent-engine-multisig vault --multisig <m>");
  });
});

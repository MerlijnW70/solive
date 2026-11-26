import { createHash } from "node:crypto";
import { mkdtemp, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, KeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { createClient } from "@intent-engine/client/node";
import { COMPARE_NEEDS_KEY, SHA_FROM_OWN, SHA_FROM_PAID, TOO_LARGE_TO_COMPARE, URL_HIDDEN } from "../src/announce-commands.js";
import { MAX_ARTIFACT_BYTES } from "../src/artifact.js";
import { EXIT_OK } from "../src/main.js";
import { announced, keyed, WORK_URL } from "./announce.js";
import { cli, h, NOW, transport, type World, world } from "./harness.js";

const SPEC = "answer.txt holds 42\n";

type Job = { w: World; judge: KeyPairSigner; intent: Address; dir: string; spec: string };

async function job(): Promise<Job> {
  const w = await world();
  const judge = await keyed("judge.json");
  const dir = await mkdtemp(join(tmpdir(), "deliveries-"));
  const spec = join(dir, "spec.md");
  await writeFile(spec, SPEC);
  const specHash = new Uint8Array(createHash("sha256").update(SPEC).digest());
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  return { w, judge, intent, dir, spec };
}

type Line = { seq: string; announcement: string; announced_at: string; sha256?: string; sha256_from?: string };

describe("deliveries shows every delivery seq with its work, so a fix round compares old and new in one view", () => {
  let j: Job;

  beforeEach(async () => {
    j = await job();
  });

  it("names each seq's sha256 from this machine's deliver, a compared artifact or the paid release, with the time it landed", async () => {
    const old = join(j.dir, "old.tar");
    const fixed = join(j.dir, "answer.txt");
    await writeFile(old, "41\n");
    await writeFile(fixed, "42\n");
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    await keyed("mine.json");
    const mine = await cli(["deliver", "--keypair", "mine.json", "--intent", j.intent, "--artifact", old, "--work-url", WORK_URL, "--yes"], {});
    expect(mine.code).toBe(EXIT_OK);
    const other = await keyed();
    await announced(j.intent, other, sha("42\n"));

    const plain = await cli(["deliveries", "--intent", j.intent], {});
    const plainLines = plain.json()["announcements"] as Line[];
    expect(plainLines.map(({ seq, sha256, sha256_from }) => [seq, sha256, sha256_from])).toEqual([
      ["1", sha("41\n"), SHA_FROM_OWN],
      ["2", undefined, undefined],
    ]);
    expect(plainLines.every(({ announced_at }) => /^[1-9][0-9]*$/.test(announced_at))).toBe(true);
    expect(plain.json()["note"]).toBe(URL_HIDDEN);

    const compared = await cli(["deliveries", "--intent", j.intent, "--judge-keypair", "judge.json", "--compare", old, "--compare", fixed], {});
    expect(compared.code).toBe(EXIT_OK);
    expect((compared.json()["announcements"] as Line[]).map(({ seq, sha256, sha256_from }) => [seq, sha256, sha256_from])).toEqual([
      ["1", sha("41\n"), old],
      ["2", sha("42\n"), fixed],
    ]);
    expect(compared.json()["compared"]).toEqual([
      { path: old, sha256: sha("41\n") },
      { path: fixed, sha256: sha("42\n") },
    ]);

    const huge = join(j.dir, "huge.tar");
    await writeFile(huge, "");
    await truncate(huge, MAX_ARTIFACT_BYTES + 1);
    const withHuge = await cli(["deliveries", "--intent", j.intent, "--judge-keypair", "judge.json", "--compare", huge, "--compare", fixed], {});
    expect(withHuge.code).toBe(EXIT_OK);
    expect(withHuge.json()["compared"]).toEqual([
      { path: huge, skipped: TOO_LARGE_TO_COMPARE },
      { path: fixed, sha256: sha("42\n") },
    ]);
    expect((withHuge.json()["announcements"] as Line[])[1]?.sha256_from).toBe(fixed);

    const blind = await cli(["deliveries", "--intent", j.intent, "--compare", fixed], {});
    expect(blind.json()["note"]).toBe(`${URL_HIDDEN}; ${COMPARE_NEEDS_KEY}`);
    expect((blind.json()["announcements"] as Line[])[1]?.sha256).toBeUndefined();

    const judged = await cli(
      ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", fixed, "--run", "true", "--sandbox", "none", "--i-trust-this-work", "--yes"],
      { "judge.json": j.judge },
    );
    expect(judged.code).toBe(EXIT_OK);
    const paid = await cli(["deliveries", "--intent", j.intent], {});
    expect((paid.json()["announcements"] as Line[]).map(({ seq, sha256, sha256_from }) => [seq, sha256, sha256_from])).toEqual([
      ["1", sha("41\n"), SHA_FROM_OWN],
      ["2", sha("42\n"), SHA_FROM_PAID],
    ]);
    expect(h.files.size).toBeGreaterThan(0);
  });
});

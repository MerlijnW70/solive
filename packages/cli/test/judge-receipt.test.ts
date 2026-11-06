import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import {
  KEY_FILE,
  readReceipt,
  type Receipt,
  receiptName,
  receiptPath,
  ReceiptRefused,
  receiptsDir,
  sealReceipt,
  type Stored,
  writeReceipt,
} from "../src/judge-receipt.js";
import { authorize, boundApproval, CURRENT_PINS, EMPTY_REASON, mismatchOf, type Target } from "../src/receipt-gate.js";
import { settingsDir } from "../src/wallet.js";
import { parse } from "../src/args.js";
import { EMPTY_OVERRIDE } from "../src/trust-args.js";

const root = process.getuid?.() === 0;
const unix = process.platform !== "win32";

let judge: Address;
let other: Address;
let base: Receipt;

const home = () => mkdtemp(join(tmpdir(), "receipt-home-"));

const targetOf = (receipt: Stored): Target => ({
  cluster: receipt.cluster,
  owner: receipt.owner,
  nonce: receipt.nonce,
  intent: receipt.intent,
  specSha256: receipt.specSha256,
  deliveredSha256: receipt.deliveredSha256,
  announcement: receipt.announcement,
});

async function refusal(run: () => Promise<unknown>): Promise<ReceiptRefused> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ReceiptRefused) {
      return error;
    }
    throw error;
  }
  throw new Error("nothing was refused");
}

beforeAll(async () => {
  const [a, b, owner, intent, announcement] = await Promise.all([0, 1, 2, 3, 4].map(() => generateKeyPairSigner()));
  judge = a?.address as Address;
  other = b?.address as Address;
  base = {
    outcome: "pass",
    cluster: "genesis-of-the-test-cluster",
    judge,
    owner: owner?.address as Address,
    nonce: 7n,
    intent: intent?.address as Address,
    specSha256: "a1".repeat(32),
    deliveredSha256: "b2".repeat(32),
    announcement: announcement?.address as Address,
    route: { sandbox: "viper", command: "viper", engine: CURRENT_PINS },
  };
});

describe("the receipt matcher", () => {
  it("accepts a receipt that matches every field, for the judge that ran", () => {
    expect(mismatchOf(base, targetOf(base), [judge])).toBeUndefined();
  });

  const fields: [string, (t: Target) => Target, string][] = [
    ["cluster", (t) => ({ ...t, cluster: "another-cluster" }), "the cluster"],
    ["owner", (t) => ({ ...t, owner: other }), "the escrow owner"],
    ["nonce", (t) => ({ ...t, nonce: t.nonce + 1n }), "the escrow nonce"],
    ["intent", (t) => ({ ...t, intent: other }), "the escrow"],
    ["spec", (t) => ({ ...t, specSha256: "c3".repeat(32) }), "the spec sha256"],
    ["delivered", (t) => ({ ...t, deliveredSha256: "d4".repeat(32) }), "the delivered sha256"],
    ["announcement", (t) => ({ ...t, announcement: other }), "the announcement"],
  ];
  for (const [name, change, field] of fields) {
    it(`refuses a receipt whose ${name} differs from what is signed`, () => {
      expect(mismatchOf(base, change(targetOf(base)), [judge])).toContain(`records ${field} `);
    });
  }

  it("refuses a receipt of another judge", () => {
    expect(mismatchOf(base, targetOf(base), [other])).toContain("records the judge");
  });

  for (const outcome of ["fail", "infra", "interrupted"]) {
    it(`refuses a receipt for ${outcome}`, () => {
      expect(mismatchOf({ ...base, outcome }, targetOf(base), [judge])).toContain(`outcome ${outcome}`);
    });
  }

  it("refuses a route without its pins or with a pin the CLI does not hold", () => {
    const target = targetOf(base);
    expect(mismatchOf({ ...base, route: { sandbox: "viper", command: "viper" } }, target, [judge])).toContain("without the engine");
    expect(mismatchOf({ ...base, route: { ...base.route, engine: { ...CURRENT_PINS, wasmSha256: "e5".repeat(32) } } }, target, [judge])).toContain("viper engine");
    expect(mismatchOf({ ...base, route: { sandbox: "docker", command: "true" } }, target, [judge])).toContain("without its image");
    const run = { image: "img@sha256:" + "f6".repeat(32), run: "make check", timeout: 30 };
    expect(mismatchOf({ ...base, route: { sandbox: "docker", command: run.run, image: run.image, judgeRun: run } }, target, [judge])).toBeUndefined();
    expect(mismatchOf({ ...base, route: { sandbox: "none", command: run.run, judgeRun: run } }, target, [judge])).toContain("judge-run block");
    expect(mismatchOf({ ...base, route: { sandbox: "docker", command: "other", image: run.image, judgeRun: run } }, target, [judge])).toContain("judge-run block");
  });
});

describe("the receipt store", () => {
  it("writes a pass atomically with private modes and reads it back", async () => {
    const at = await home();
    const path = await writeReceipt(at, base);
    expect(path).toBe(receiptPath(at, base));
    expect(await readReceipt(at, base)).toEqual(base);
    expect((await readdir(receiptsDir(at))).sort()).toEqual([KEY_FILE, receiptName(base)].sort());
    if (unix) {
      expect((await lstat(receiptsDir(at))).mode & 0o777).toBe(0o700);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect((await lstat(join(receiptsDir(at), KEY_FILE))).mode & 0o777).toBe(0o600);
    }
  });

  it("never writes a receipt for fail or infra", async () => {
    const at = await home();
    for (const outcome of ["fail", "infra"]) {
      const refused = await refusal(() => writeReceipt(at, { ...base, outcome } as unknown as Receipt));
      expect(refused.why).toContain(`not ${outcome}`);
    }
    await expect(readdir(receiptsDir(at))).rejects.toThrow();
  });

  it("keys receipts so two escrows, deliveries, announcements, judges or clusters never share a file", () => {
    const names = new Set(
      [base, { ...base, intent: other }, { ...base, deliveredSha256: "d4".repeat(32) }, { ...base, announcement: other }, { ...base, judge: other }, { ...base, cluster: "x" }].map(receiptName),
    );
    expect(names.size).toBe(6);
    expect([...names].every((name) => /^[0-9a-f]{64}\.json$/.test(name))).toBe(true);
  });

  it("refuses a missing receipt, and one for another escrow under the same sha256", async () => {
    const at = await home();
    expect((await refusal(() => readReceipt(at, base))).problem).toBe("missing");
    await writeReceipt(at, base);
    expect((await refusal(() => readReceipt(at, { ...base, intent: other }))).problem).toBe("missing");
  });

  it("refuses a receipt whose bytes changed after it was written", async () => {
    const at = await home();
    const path = await writeReceipt(at, base);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace(base.specSha256, "c3".repeat(32)), { mode: 0o600 });
    const changed = await refusal(() => readReceipt(at, base));
    expect([changed.problem, changed.why]).toEqual(["tampered", expect.stringContaining("does not carry the mac")]);
    await writeFile(path, "not json", { mode: 0o600 });
    expect((await refusal(() => readReceipt(at, base))).problem).toBe("tampered");
  });

  it("refuses a receipt sealed with another key, as a planted file would be", async () => {
    const at = await home();
    const path = await writeReceipt(at, base);
    await writeFile(path, sealReceipt(new Uint8Array(32).fill(9), base), { mode: 0o600 });
    expect((await refusal(() => readReceipt(at, base))).problem).toBe("tampered");
  });

  it("refuses a fail receipt even when the user's key sealed it", async () => {
    const at = await home();
    const path = await writeReceipt(at, base);
    const key = await readFile(join(receiptsDir(at), KEY_FILE));
    await writeFile(path, sealReceipt(key, { ...base, outcome: "fail" }), { mode: 0o600 });
    const read = await readReceipt(at, base);
    expect(mismatchOf(read, targetOf(base), [judge])).toContain("outcome fail");
    expect((await refusal(() => authorize(at, targetOf(base), [judge], undefined))).why).toContain("outcome fail");
  });

  it.skipIf(!unix)("refuses a receipt that is a symbolic link, and a receipt directory that is one", async () => {
    const at = await home();
    const path = await writeReceipt(at, base);
    const elsewhere = join(at, "planted.json");
    await rename(path, elsewhere);
    await symlink(elsewhere, path);
    expect((await refusal(() => readReceipt(at, base))).why).toContain("is a symbolic link");
    const second = await home();
    await writeReceipt(second, base);
    await rename(receiptsDir(second), join(second, "moved"));
    await symlink(join(second, "moved"), receiptsDir(second));
    expect((await refusal(() => readReceipt(second, base))).why).toContain("is a symbolic link");
    expect((await refusal(() => writeReceipt(second, base))).why).toContain("is a symbolic link");
  });

  it.skipIf(!unix)("refuses a receipt directory or file that other users can write or read", async () => {
    const at = await home();
    const path = await writeReceipt(at, base);
    await chmod(receiptsDir(at), 0o777);
    expect((await refusal(() => readReceipt(at, base))).why).toContain("lets other users");
    expect((await refusal(() => writeReceipt(at, base))).why).toContain("lets other users");
    await chmod(receiptsDir(at), 0o700);
    await chmod(path, 0o644);
    expect((await refusal(() => readReceipt(at, base))).why).toContain("lets other users");
    await chmod(path, 0o600);
    await chmod(settingsDir(at), 0o777);
    expect((await refusal(() => readReceipt(at, base))).why).toContain("lets other users");
  });

  it.skipIf(!unix)("refuses a receipt store owned by another user", async () => {
    const at = await home();
    await writeReceipt(at, base);
    const uid = process.getuid?.() ?? 0;
    expect((await refusal(() => readReceipt(at, base, { uid: uid + 1 }))).why).toContain(`not to this user ${uid + 1}`);
  });

  it.skipIf(!unix)("refuses a receipt file owned by another user inside a directory this user owns", async () => {
    const at = await home();
    await writeReceipt(at, base);
    const uid = process.getuid?.() ?? 0;
    const refused = await refusal(() => readReceipt(at, base, { uid: uid + 1, dirUid: uid }));
    expect(refused.why).toContain(`belongs to user ${uid}, not to this user ${uid + 1}`);
    expect(refused.why).not.toContain("receipt directory");
  });

  it.skipIf(!unix || root)("reports a receipt that cannot be written into a directory it may not write", async () => {
    const at = await home();
    await writeReceipt(at, { ...base, intent: other });
    await chmod(receiptsDir(at), 0o500);
    await expect(writeReceipt(at, base)).rejects.toThrow();
    await chmod(receiptsDir(at), 0o700);
    expect((await refusal(() => readReceipt(at, base))).problem).toBe("missing");
  });

  it.skipIf(!unix)("refuses a key that is not a regular private file", async () => {
    const at = await home();
    await mkdir(receiptsDir(at), { recursive: true, mode: 0o700 });
    await chmod(settingsDir(at), 0o700);
    await mkdir(join(receiptsDir(at), KEY_FILE));
    expect((await refusal(() => writeReceipt(at, base))).why).toContain("not a regular file");
  });
});

describe("the override's sources", () => {
  it("comes only from the command line flag, never from the environment or saved settings", () => {
    const owner = "11111111111111111111111111111111";
    const vote = ["committee", "vote", "--keypair", "m.json", "--owner", owner, "--nonce", "0", "--sha256", "ab".repeat(32), "--result", "1"];
    const release = ["committee", "release", "--keypair", "m.json", "--vote", "a.json", "--no-confirm-url"];
    const env = { "without-receipt": "set", WITHOUT_RECEIPT: "set", INTENT_ENGINE_WITHOUT_RECEIPT: "set", without_receipt: "set" };
    expect(parse(vote, env)).not.toHaveProperty("withoutReceipt");
    expect(parse([...vote, "--without-receipt", "a reason"], env)).toMatchObject({ withoutReceipt: "a reason" });
    expect(() => parse([...vote, "--without-receipt", ""])).toThrow(EMPTY_OVERRIDE);
    expect(parse(release, env)).not.toHaveProperty("withoutReceipt");
    expect(() => parse([...release, "--without-receipt", "a reason"])).toThrow();
  });
});

describe("the gate", () => {
  it("authorizes with a matching receipt and refuses everything else", async () => {
    const at = await home();
    await writeReceipt(at, base);
    expect(await authorize(at, targetOf(base), [judge], undefined)).toEqual({ by: "receipt", judge });
    expect(await authorize(at, targetOf(base), [other, judge], undefined)).toEqual({ by: "receipt", judge });
    expect((await refusal(() => authorize(at, { ...targetOf(base), specSha256: "c3".repeat(32) }, [judge], undefined))).why).toContain("the spec sha256");
    expect((await refusal(() => authorize(at, targetOf(base), [other], undefined))).problem).toBe("missing");
  });

  it("takes the override only with a reason, records it and binds it into the approval", async () => {
    const at = await home();
    expect((await refusal(() => authorize(at, targetOf(base), [judge], "  "))).why).toBe(EMPTY_REASON);
    const granted = await authorize(at, targetOf(base), [judge], "a reviewed manual check‮");
    expect(granted).toEqual({ by: "override", unchecked: { reason: expect.stringContaining("a reviewed manual check"), warning: expect.stringContaining(base.deliveredSha256) } });
    if (granted.by !== "override") {
      throw new Error("no override");
    }
    expect(granted.unchecked.reason).not.toContain("‮");
    expect(granted.unchecked.warning).toContain("signed without a judge receipt");
    expect(boundApproval("0123456789abcdef", granted)).not.toBe("0123456789abcdef");
    expect(boundApproval("0123456789abcdef", { by: "receipt", judge })).toBe("0123456789abcdef");
  });
});

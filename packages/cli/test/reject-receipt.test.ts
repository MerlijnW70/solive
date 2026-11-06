import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FailReceipt, keptReceipt, type Receipt, ReceiptRefused, receiptsDir, writeFailReceipt, writeReceipt } from "../src/judge-receipt.js";
import { authorize, CURRENT_PINS, type Target } from "../src/receipt-gate.js";

const homes: string[] = [];

const home = async (): Promise<string> => {
  const made = await mkdtemp(join(tmpdir(), "reject-receipt-"));
  homes.push(made);
  return made;
};

let pass: Receipt;
let fail: FailReceipt;
let target: Target;

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
  const [judge, owner, intent, announcement] = await Promise.all([0, 1, 2, 3].map(() => generateKeyPairSigner()));
  pass = {
    outcome: "pass",
    cluster: "genesis-of-the-test-cluster",
    judge: judge?.address as Address,
    owner: owner?.address as Address,
    nonce: 7n,
    intent: intent?.address as Address,
    specSha256: "a1".repeat(32),
    deliveredSha256: "b2".repeat(32),
    announcement: announcement?.address as Address,
    route: { sandbox: "viper", command: "viper", engine: CURRENT_PINS },
  };
  fail = { ...pass, outcome: "fail" };
  const { outcome: _outcome, judge: _judge, route: _route, ...rest } = pass;
  target = rest;
});

afterAll(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
});

describe("the receipt of a failing judge run", () => {
  it("authorizes a reject and nothing else, and a pass authorizes no reject", async () => {
    const failed = await home();
    await writeFailReceipt(failed, fail);
    expect(await authorize(failed, target, [pass.judge], undefined, {}, "fail")).toEqual({ by: "receipt", judge: pass.judge });
    expect((await refusal(() => authorize(failed, target, [pass.judge], undefined))).problem).toBe("missing");
    const passed = await home();
    await writeReceipt(passed, pass);
    expect((await refusal(() => authorize(passed, target, [pass.judge], undefined, {}, "fail"))).why).toContain("failed the work");
    expect(await authorize(passed, target, [pass.judge], undefined)).toEqual({ by: "receipt", judge: pass.judge });
  });

  it("lives apart from the pass receipts, so a fail never leaves a file where a signature looks", async () => {
    const at = await home();
    expect(await keptReceipt(at, fail)).toHaveProperty("receipt");
    await expect(readdir(receiptsDir(at))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(receiptsDir(at, "judge-fail-receipt"))).toHaveLength(2);
    expect((await refusal(() => writeFailReceipt(at, pass as unknown as FailReceipt))).problem).toBe("unwritable");
    expect((await refusal(() => writeReceipt(at, fail as unknown as Receipt))).problem).toBe("unwritable");
  });

  it("is refused for another announcement, judge or work", async () => {
    const at = await home();
    await writeFailReceipt(at, fail);
    const other = (await generateKeyPairSigner()).address;
    expect((await refusal(() => authorize(at, { ...target, announcement: other }, [pass.judge], undefined, {}, "fail"))).problem).toBe("missing");
    expect((await refusal(() => authorize(at, { ...target, deliveredSha256: "c3".repeat(32) }, [pass.judge], undefined, {}, "fail"))).problem).toBe("missing");
    expect((await refusal(() => authorize(at, target, [other], undefined, {}, "fail"))).problem).toBe("missing");
  });
});

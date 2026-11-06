import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind } from "@intent-engine/core";
import { getIntentDecoder, sortMembers } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { VOTE_NOT_SIGNED } from "../src/committee-commands.js";
import { VOTE_NEXT } from "../src/judge.js";
import { NOT_SENT } from "../src/flows.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { announced, keyed } from "./announce.js";
import { balance, cli, funded, h, NOW, transport, world } from "./harness.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
const WRONG = "export default function count(text) { return text.length; }\n";
const PAY = 100n;
const JUDGE_FEE = 10n;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function panel(module: string) {
  const w = await world();
  const members = await Promise.all([0, 1, 2].map(() => funded()));
  const outsider = await funded();
  const payer = await funded();
  const solver = await funded();
  const worker = await keyed();
  const feeWallet = (await generateKeyPairSigner()).address;
  const keys: Record<string, KeyPairSigner> = { "payer.json": payer, "solver.json": solver, "outsider.json": outsider };
  members.forEach((m, i) => (keys[`m${i}.json`] = m));
  const addresses = sortMembers(members.map((m) => m.address));
  const created = await cli(
    ["committee", "create", "--keypair", "payer.json", "--members", addresses.join(","), "--threshold", "2", "--fee-wallet", feeWallet, "--yes"],
    keys,
  );
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  const committee = created.json()["committee"] as Address;
  const dir = await mkdtemp(join(tmpdir(), "committee-"));
  const spec = join(dir, "spec.md");
  const artifact = join(dir, "count.mjs");
  await writeFile(spec, SPEC);
  await writeFile(artifact, module);
  const params = {
    kind: Kind.AttestedResult,
    amountIn: PAY,
    minResult: 1n,
    maxResult: 1n,
    attestor: committee,
    specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()),
    judgeFee: JUDGE_FEE,
  } as const;
  const client = createClient({ url: "http://cluster", transport });
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const made = await announced(intent, worker, sha(module), "https://" + "example.org/count.mjs");
  const judging = (member: string, verdict: string) => [
    "judge", "--keypair", member, "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper", "--verdict", verdict,
  ];
  const paid = async (owner: Address) =>
    balance(await findAssociatedTokenAddress({ owner, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
  const status = () => {
    const account = h.svm.getAccount(intent);
    return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
  };
  return { w, keys, committee, addresses, worker, feeWallet, intent, dir, judging, paid, status, made };
}

describe("intent-engine committee", () => {
  it("creates once, shows its terms, and refuses a threshold above its members", async () => {
    const p = await panel(CORRECT);
    const shown = await cli(["committee", "show", "--committee", p.committee], p.keys);
    expect(shown.json()).toMatchObject({ committee: p.committee, members: p.addresses, threshold: 2, fee_wallet: p.feeWallet });
    const again = await cli(
      ["committee", "create", "--keypair", "payer.json", "--members", [...p.addresses].reverse().join(","), "--threshold", "2", "--fee-wallet", p.feeWallet],
      p.keys,
    );
    expect(again.json()).toMatchObject({ committee: p.committee, sent: false, exists: true });
    const high = await cli(
      ["committee", "create", "--keypair", "payer.json", "--members", p.addresses.join(","), "--threshold", "4", "--fee-wallet", p.feeWallet],
      p.keys,
    );
    expect(high.code).toBe(EXIT_USAGE);
    const preview = await cli(
      ["committee", "create", "--keypair", "payer.json", "--members", p.addresses.slice(0, 2).join(","), "--threshold", "1", "--fee-wallet", p.feeWallet],
      p.keys,
    );
    expect(preview.json()).toMatchObject({ sent: false, next: NOT_SENT });
  });

  it("pays the first announcer once two members' viper verdicts carry their votes", async () => {
    const p = await panel(CORRECT);
    await announced(p.intent, await keyed(), "ef".repeat(32), "https://" + "example.org/other.mjs");
    const v0 = join(p.dir, "v0.json");
    const v2 = join(p.dir, "v2.json");
    for (const [member, file] of [["m0.json", v0], ["m2.json", v2]] as const) {
      const judged = await cli(p.judging(member, file), p.keys);
      expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
      expect(judged.json()).toMatchObject({
        verdict: "pass",
        signature: null,
        committee: p.committee,
        next: VOTE_NEXT,
        announcement: p.made.announcement,
        vote: { announcement: p.made.announcement, sha256: sha(CORRECT), salt: p.made.salt },
      });
    }
    expect(p.status()).toBe(IntentStatus.Open);
    const release = ["committee", "release", "--keypair", "m2.json", "--vote", v0, "--vote", v2];
    const preview = await cli(release, p.keys);
    expect(preview.json()).toMatchObject({ intent: p.intent, committee: p.committee, announcement: p.made.announcement, sent: false, next: NOT_SENT });
    const sent = await cli([...release, "--yes"], p.keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(p.status()).toBe(IntentStatus.Filled);
    expect(await p.paid(p.feeWallet)).toBe(JUDGE_FEE);
    expect(await p.paid(p.worker.address)).toBeGreaterThan(0n);
  });

  it("gives no vote on a failing delivery and refuses a lone vote or a judge outside the committee", async () => {
    const wrong = await panel(WRONG);
    const failed = await cli(wrong.judging("m1.json", join(wrong.dir, "v1.json")), wrong.keys);
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.json()).not.toHaveProperty("vote");
    const p = await panel(CORRECT);
    const outsider = await cli(p.judging("outsider.json", join(p.dir, "o.json")), p.keys);
    expect(outsider.code).toBe(EXIT_FAILED);
    expect(outsider.err).toContain("is not one of its members");
    const v1 = join(p.dir, "v1.json");
    await cli(p.judging("m1.json", v1), p.keys);
    const lone = await cli(["committee", "release", "--keypair", "solver.json", "--vote", v1, "--yes"], p.keys);
    expect(lone.code).toBe(EXIT_FAILED);
    expect(lone.err).toContain("needs 2 distinct votes, got 1");
    expect(p.status()).toBe(IntentStatus.Open);
  });

  it("lets a member vote by hand and refuses votes on different ballots", async () => {
    const p = await panel(CORRECT);
    const other = "ef".repeat(32);
    await announced(p.intent, await keyed(), other, "https://" + "example.org/other.mjs");
    const base = ["committee", "vote", "--owner", p.w.owner.address, "--nonce", "0", "--result", "1"];
    const unjudged = await cli([...base, "--keypair", "m0.json", "--sha256", sha(CORRECT)], p.keys);
    expect([unjudged.code, unjudged.err]).toEqual([EXIT_FAILED, expect.stringContaining("no judge receipt on this machine")]);
    await cli(p.judging("m0.json", join(p.dir, "judged.json")), p.keys);
    const unsigned = await cli([...base, "--keypair", "m0.json", "--sha256", sha(CORRECT)], p.keys);
    expect(unsigned.json()).toMatchObject({ intent: p.intent, announcement: p.made.announcement, signed: false, next: VOTE_NOT_SIGNED });
    const a = join(p.dir, "a.json");
    const b = join(p.dir, "b.json");
    await cli([...base, "--keypair", "m0.json", "--sha256", sha(CORRECT), "--out", a, "--yes"], p.keys);
    await cli([...base, "--keypair", "m1.json", "--sha256", other, "--out", b, "--without-receipt", "no work under this sha256 can be fetched", "--yes"], p.keys);
    expect(JSON.parse(await readFile(a, "utf8"))).toMatchObject({ kind: "committee-vote", member: p.keys["m0.json"]?.address, announcement: p.made.announcement });
    const split = await cli(["committee", "release", "--keypair", "solver.json", "--vote", a, "--vote", b], p.keys);
    expect(split.code).toBe(EXIT_FAILED);
    expect(split.err).toContain("votes on announcement");
    const unknown = await cli([...base, "--keypair", "m0.json", "--sha256", "ab".repeat(32)], p.keys);
    expect(unknown.code).toBe(EXIT_FAILED);
    expect(unknown.err).toContain("has no announcement that opens to the work");
    const stranger = await cli([...base, "--keypair", "outsider.json", "--sha256", sha(CORRECT)], p.keys);
    expect(stranger.code).toBe(EXIT_FAILED);
    expect(stranger.err).toContain("is not a member of committee");
  });

  it("releases on votes signed by hand", async () => {
    const p = await panel(CORRECT);
    const base = ["committee", "vote", "--owner", p.w.owner.address, "--nonce", "0", "--result", "1", "--sha256", sha(CORRECT), "--yes"];
    const files = [join(p.dir, "a.json"), join(p.dir, "b.json")];
    for (const member of ["m0.json", "m1.json"]) {
      await cli(p.judging(member, join(p.dir, `${member}.verdict`)), p.keys);
    }
    for (const [member, file] of [["m0.json", files[0] ?? ""], ["m1.json", files[1] ?? ""]] as const) {
      const voted = await cli([...base, "--keypair", member, "--out", file], p.keys);
      expect([voted.code, voted.err]).toEqual([EXIT_OK, ""]);
    }
    const release = ["committee", "release", "--keypair", "m0.json", ...files.flatMap((file) => ["--vote", file]), "--yes"];
    const sent = await cli(release, p.keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(p.status()).toBe(IntentStatus.Filled);
    expect(await p.paid(p.worker.address)).toBeGreaterThan(0n);
  });
});

describe("intent-engine committee without a judge receipt", () => {
  it("refuses a vote for work its member did not judge here, signs it with the override, printed and recorded, and a wallet outside the committee relays the votes with no receipt", async () => {
    const p = await panel(CORRECT);
    const vote = ["committee", "vote", "--owner", p.w.owner.address, "--nonce", "0", "--result", "1", "--sha256", sha(CORRECT), "--yes"];
    const files = [join(p.dir, "a.json"), join(p.dir, "b.json")];
    const refused = await cli([...vote, "--keypair", "m0.json", "--out", files[0] ?? ""], p.keys);
    expect([refused.code, refused.out]).toEqual([EXIT_FAILED, ""]);
    expect(refused.err).toContain("--without-receipt <reason>");
    await expect(readFile(files[0] ?? "", "utf8")).rejects.toThrow();
    const empty = await cli([...vote, "--keypair", "m0.json", "--without-receipt", " "], p.keys);
    expect(empty.code).toBe(EXIT_USAGE);
    const voted = await cli([...vote, "--keypair", "m0.json", "--out", files[0] ?? "", "--without-receipt", "judged on the member's own machine"], p.keys);
    const unchecked = voted.json()["unchecked"] as { reason: string; warning: string };
    expect([voted.code, voted.err, unchecked.reason]).toEqual([EXIT_OK, `WARNING: ${unchecked.warning}`, "judged on the member's own machine"]);
    await cli(p.judging("m2.json", join(p.dir, "m2.verdict")), p.keys);
    const other = await cli([...vote, "--keypair", "m1.json", "--out", files[1] ?? ""], p.keys);
    expect([other.code, other.err]).toEqual([EXIT_FAILED, expect.stringContaining("no judge receipt on this machine")]);
    await cli(p.judging("m1.json", join(p.dir, "m1.verdict")), p.keys);
    const judged = await cli([...vote, "--keypair", "m1.json", "--out", files[1] ?? ""], p.keys);
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).not.toHaveProperty("unchecked");
    const release = ["committee", "release", "--keypair", "solver.json", ...files.flatMap((file) => ["--vote", file]), "--yes"];
    expect((await cli([...release, "--without-receipt", "a reason"], p.keys)).code).toBe(EXIT_USAGE);
    const sent = await cli(release, p.keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ sent: true });
    expect(sent.json()).not.toHaveProperty("unchecked");
    expect(p.status()).toBe(IntentStatus.Filled);
  });

  it("saves a receipt from a member's passing judge run that its later vote and release use, and none from a failing one", async () => {
    const wrong = await panel(WRONG);
    await cli(wrong.judging("m0.json", join(wrong.dir, "fail.json")), wrong.keys);
    const after = await cli(["committee", "vote", "--keypair", "m0.json", "--owner", wrong.w.owner.address, "--nonce", "0", "--result", "1", "--sha256", sha(WRONG)], wrong.keys);
    expect(after.code).toBe(EXIT_FAILED);
    expect(after.err).toContain("no judge receipt on this machine");
    const p = await panel(CORRECT);
    const judged = await cli(p.judging("m1.json", join(p.dir, "m1.verdict")), p.keys);
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).not.toHaveProperty("receiptRefused");
    const voted = await cli(["committee", "vote", "--keypair", "m1.json", "--owner", p.w.owner.address, "--nonce", "0", "--result", "1", "--sha256", sha(CORRECT)], p.keys);
    expect([voted.code, voted.err]).toEqual([EXIT_OK, ""]);
    expect(voted.json()).not.toHaveProperty("unchecked");
  });
});

describe("intent-engine reputation and feedback", () => {
  it("reads an empty record for a wallet that announced nothing", async () => {
    const p = await panel(CORRECT);
    const quiet = (await generateKeyPairSigner()).address;
    const read = await cli(["reputation", "--worker", quiet], p.keys);
    expect([read.code, read.err]).toEqual([EXIT_OK, ""]);
    expect(read.json()).toMatchObject({ wallet: quiet, announced: 0, paid: 0, earned: [] });
  });

  it("refuses feedback on an escrow that was not released, and a score out of range", async () => {
    const p = await panel(CORRECT);
    const early = await cli(["feedback", "--keypair", "payer.json", "--intent", p.intent, "--score", "80"], p.keys);
    expect(early.code).toBe(EXIT_FAILED);
    expect(early.err).toContain("has no release");
    const high = await cli(["feedback", "--keypair", "payer.json", "--intent", p.intent, "--score", "101"], p.keys);
    expect(high.code).toBe(EXIT_USAGE);
  });
});

import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, getAddressEncoder, type KeyPairSigner, lamports, signBytes } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, formatAmount, IntentStatus, Kind, splitFees } from "@intent-engine/core";
import { buildCreateProfile, getIntentDecoder, sortMembers, splitN } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { LOOKUP_TABLE_HEADER } from "@intent-engine/solver";
import { COSIGN_FLAG, SPLIT_VOTE_NOT_SIGNED } from "../src/committee-commands.js";
import { EXIT_FAILED, EXIT_OK, main } from "../src/main.js";
import { announced, keyed } from "./announce.js";
import { balance, cli, FEE_BPS, funded, h, NOW, runtime, send, transport, world } from "./harness.js";
import { device, type Device, deviceKey as newKey, found, type Key, MESSAGE, messageThen, SIGN, transactionThen } from "./ledger-device.js";
import { airdropped } from "./airdrop.js";
import { judgedBy } from "./receipt-kit.js";

const LEVELS = [44, 501];
const LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;
const PAY = 1_000n;
const DECIMALS = 6;
const WEIGHTS = [6_000, 4_000];
const JUDGE_FEE = 100n;
const SHARES = splitN(splitFees(PAY, FEE_BPS, 0, 0).net, WEIGHTS);
const FEE_SHARES = splitN(splitFees(PAY - JUDGE_FEE, FEE_BPS, 0, 0).net, WEIGHTS);

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

async function run(argv: string[], keys: Record<string, KeyPairSigner>, ledger: Device) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { ...runtime(keys), ledger: ledger.open }, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, err: err.join("\n"), out: out.join("\n"), json: () => JSON.parse(out.join("\n")) as Record<string, any> };
}

async function panel(member?: () => Promise<Address>, outsider = false) {
  const judgeFee = outsider ? JUDGE_FEE : 0n;
  const w = await world();
  const memberAddress = member === undefined ? undefined : await member();
  const [m0, m1, m2, solver] = await Promise.all([funded(), funded(), funded(), funded()]);
  const [worker, coauthor] = await Promise.all([keyed(), keyed()]);
  const keys: Record<string, KeyPairSigner> = { "m0.json": m0, "m1.json": m1, "m2.json": m2, "solver.json": solver, "payer.json": await funded() };
  const first = memberAddress ?? m0.address;
  const members = sortMembers(outsider ? [first, m1.address, m2.address] : [first, m1.address]);
  const created = await cli(["committee", "create", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", solver.address, "--yes"], keys);
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  const committee = created.json()["committee"] as Address;
  const client = createClient({ url: "http://cluster", transport });
  const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: committee, specHash: new Uint8Array(32).fill(4), judgeFee } as const;
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const work = sha("split work");
  const made = await announced(intent, worker, work);
  await judgedBy(members, { owner: w.owner.address, nonce: 0n, intent, specSha256: "04".repeat(32), deliveredSha256: work, announcement: made.announcement });
  const dir = await mkdtemp(join(tmpdir(), "committee-split-"));
  const recipients = [worker.address, outsider ? coauthor.address : m1.address];
  const vote = (path: string, extra: string[] = []) => [
    "committee", "vote", "--keypair", path, "--owner", w.owner.address, "--nonce", "0", "--sha256", work, "--result", "1", "--recipients", recipients.join(","), "--weights", WEIGHTS.join(","), ...extra,
  ];
  const paid = async (owner: Address) => balance(await findAssociatedTokenAddress({ owner, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
  const status = () => {
    const account = h.svm.getAccount(intent);
    return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
  };
  const judgeLine = `Pays the judge fee: ${formatAmount(JUDGE_FEE, DECIMALS)} of ${w.inputMint} to the committee's fee wallet ${solver.address}, carved out of the escrow`;
  return { w, keys, committee, worker, coauthor, m0, m1, solver, intent, made, work, dir, recipients, vote, paid, status, judgeLine };
}

describe("intent-engine committee on a split", () => {
  it("previews the shares, votes on the split, and releases it to every co-author by weight on the votes and the co-author's --cosign", async () => {
    const p = await panel();
    const preview = await cli(p.vote("m0.json"), p.keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    const shown = preview.json();
    expect(shown).toMatchObject({ intent: p.intent, announcement: p.made.announcement, signed: false, next: SPLIT_VOTE_NOT_SIGNED });
    expect((shown["paid"] as { amount: string }[]).map((r) => r.amount)).toEqual(SHARES.map((a) => formatAmount(a, DECIMALS)));
    const lines = shown["summary"] as string[];
    expect(lines).toEqual(expect.arrayContaining(p.recipients.map((wallet, i) => `  ${wallet}: ${WEIGHTS[i]} bps -> ${formatAmount(SHARES[i] ?? 0n, DECIMALS)} of ${p.w.inputMint}`)));
    const files = [join(p.dir, "a.json"), join(p.dir, "b.json")];
    for (const [member, file] of [["m0.json", files[0] ?? ""], ["m1.json", files[1] ?? ""]] as const) {
      const voted = await cli(p.vote(member, ["--out", file, "--yes"]), p.keys);
      expect([voted.code, voted.err]).toEqual([EXIT_OK, ""]);
    }
    expect(JSON.parse(await readFile(files[0] ?? "", "utf8"))).toMatchObject({ kind: "committee-vote", member: p.m0.address, recipients: p.recipients.map((wallet, i) => ({ wallet, weight: WEIGHTS[i] })) });
    const plain = join(p.dir, "plain.json");
    expect((await cli(["committee", "vote", "--keypair", "m1.json", "--owner", p.w.owner.address, "--nonce", "0", "--sha256", p.work, "--result", "1", "--out", plain, "--yes"], p.keys)).code).toBe(EXIT_OK);
    const mixed = await cli(["committee", "release", "--keypair", "solver.json", "--vote", files[0] ?? "", "--vote", plain], p.keys);
    expect([mixed.code, mixed.err]).toEqual([EXIT_FAILED, expect.stringContaining("votes on the split no split")]);

    const release = ["committee", "release", "--keypair", "solver.json", ...files.flatMap((file) => ["--vote", file])];
    const elsewhere = files.map((file) => `${file}.elsewhere`);
    for (const [i, file] of files.entries()) {
      await writeFile(elsewhere[i] ?? "", JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), committee: p.m0.address }));
    }
    const misnamed = await cli(["committee", "release", "--keypair", "solver.json", ...elsewhere.flatMap((file) => ["--vote", file])], p.keys);
    expect([misnamed.code, misnamed.err]).toEqual([EXIT_FAILED, `the votes are for escrow ${p.intent} and committee ${p.m0.address}, not ${p.intent} and ${p.committee}`]);
    const missing = await cli(release, p.keys);
    expect([missing.code, missing.err]).toEqual([EXIT_FAILED, expect.stringContaining(COSIGN_FLAG)]);
    const envelope = Buffer.from(shown["envelope"] as string, "hex");
    const cosign = `${p.worker.address}:${hexOf(new Uint8Array(await signBytes(p.worker.keyPair.privateKey, envelope)))}`;
    const forged = await cli([...release, "--cosign", `${p.worker.address}:${"ab".repeat(64)}`], p.keys);
    expect([forged.code, forged.err]).toEqual([EXIT_FAILED, expect.stringContaining(COSIGN_FLAG)]);
    const previewed = await cli([...release, "--cosign", cosign], p.keys);
    expect([previewed.code, previewed.err]).toEqual([EXIT_OK, ""]);
    expect(previewed.json()).toMatchObject({ intent: p.intent, committee: p.committee, sent: false, signers: sortMembers([p.m0.address, p.m1.address]) });
    expect((previewed.json()["paid"] as { amount: string }[]).map((r) => r.amount)).toEqual(SHARES.map((a) => formatAmount(a, DECIMALS)));
    expect(p.status()).toBe(IntentStatus.Open);
    const sent = await cli([...release, "--cosign", cosign, "--yes"], p.keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(p.status()).toBe(IntentStatus.Filled);
    expect([await p.paid(p.worker.address), await p.paid(p.m1.address)]).toEqual(SHARES);
  });

  it("refuses a split release over the packet limit and sends it with --lookup-table holding the preview's lookup_accounts", async () => {
    const p = await panel(undefined, true);
    const files = [join(p.dir, "a.json"), join(p.dir, "b.json")];
    for (const [member, file] of [["m0.json", files[0] ?? ""], ["m1.json", files[1] ?? ""]] as const) {
      expect((await cli(p.vote(member, ["--out", file, "--yes"]), p.keys)).code).toBe(EXIT_OK);
    }
    const envelope = Buffer.from((await cli(p.vote("m0.json"), p.keys)).json()["envelope"] as string, "hex");
    const cosigns = await Promise.all([p.worker, p.coauthor].map(async (signer) => ["--cosign", `${signer.address}:${hexOf(new Uint8Array(await signBytes(signer.keyPair.privateKey, envelope)))}`]));
    const release = ["committee", "release", "--keypair", "solver.json", ...files.flatMap((file) => ["--vote", file]), ...cosigns.flat()];
    const preview = await cli(release, p.keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ sent: false, next: expect.stringContaining("pass --lookup-table") });
    expect(preview.json()["summary"]).toContain(p.judgeLine);
    expect((await cli(p.vote("m0.json"), p.keys)).json()["summary"]).toContain(p.judgeLine);
    const refused = await cli([...release, "--yes"], p.keys);
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, expect.stringContaining("over the 1232-byte limit")]);
    expect(p.status()).toBe(IntentStatus.Open);
    const lookups = preview.json()["lookup_accounts"] as Address[];
    expect(lookups).toContain(p.committee);
    const table = (await generateKeyPairSigner()).address;
    const header = new Uint8Array(LOOKUP_TABLE_HEADER);
    const view = new DataView(header.buffer);
    view.setUint32(0, 1, true);
    view.setBigUint64(4, 0xffff_ffff_ffff_ffffn, true);
    header[20] = lookups.length;
    const data = Uint8Array.from([...header, ...lookups.flatMap((address) => [...getAddressEncoder().encode(address)])]);
    h.svm.setAccount({ address: table, data, executable: false, lamports: lamports(h.svm.minimumBalanceForRentExemption(BigInt(data.length))), programAddress: LOOKUP_TABLE_PROGRAM, space: BigInt(data.length) });
    const sent = await cli([...release, "--lookup-table", table, "--yes"], p.keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(p.status()).toBe(IntentStatus.Filled);
    expect([await p.paid(p.worker.address), await p.paid(p.coauthor.address)]).toEqual(FEE_SHARES);
    expect(await p.paid(p.solver.address)).toBe(JUDGE_FEE);
  });

  it("a member on a Ledger votes on the split with one message and releases it one transaction at a time", async () => {
    const key: Key = await newKey();
    const p = await panel(async () => {
      airdropped(h.svm, key.address, lamports(10_000_000_000n));
      const made = await run(["profile", "encryption-key", "new", "--out", "member.enc"], {}, device(key, []));
      expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
      const encryptionKey = String(made.json()["encryption_key"]);
      await send(key.signer, [await buildCreateProfile({ wallet: key.signer, skills: ["judge"], endpoint: "https://" + "judge.example", encryptionKey })]);
      return key.address;
    });
    const out = join(p.dir, "ledger.json");
    const voting = device(key, [...found(LEVELS, key), ...messageThen()]);
    const voted = await run(p.vote("usb://ledger", ["--encryption-keypair", "member.enc", "--out", out, "--yes"]), p.keys, voting);
    expect([voted.code, voted.err]).toEqual([EXIT_OK, ""]);
    voting.store.ensureQueueEmpty();
    expect(voting.signed.map((s) => [s.kind, hexOf(s.bytes)])).toEqual([[MESSAGE, voted.json()["envelope"]]]);
    const other = join(p.dir, "m1.json.vote");
    expect((await cli(p.vote("m1.json", ["--out", other, "--yes"]), p.keys)).code).toBe(EXIT_OK);
    const envelope = Buffer.from(voted.json()["envelope"] as string, "hex");
    const cosign = `${p.worker.address}:${hexOf(new Uint8Array(await signBytes(p.worker.keyPair.privateKey, envelope)))}`;
    const releasing = device(key, [...found(LEVELS, key), ...transactionThen(), ...transactionThen()]);
    const release = ["committee", "release", "--keypair", "usb://ledger", "--vote", out, "--vote", other, "--cosign", cosign, "--yes"];
    const sent = await run(release, p.keys, releasing);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    releasing.store.ensureQueueEmpty();
    expect(releasing.signed.map((s) => s.kind)).toEqual([SIGN, SIGN]);
    expect(sent.json()).toMatchObject({ sent: true, setup_signature: expect.any(String) });
    expect(p.status()).toBe(IntentStatus.Filled);
    expect([await p.paid(p.worker.address), await p.paid(p.m1.address)]).toEqual(SHARES);
  });
});

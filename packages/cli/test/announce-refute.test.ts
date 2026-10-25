import { createHash } from "node:crypto";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, getBase58Decoder, type KeyPairSigner, type TransactionPartialSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { delivery } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { loadAnnouncement } from "@intent-engine/client/internal";
import { svmTransport } from "@intent-engine/client/svm";
import { NOTHING_TO_RECLAIM } from "../src/announce-commands.js";
import { EXIT_OK, main, nodeRuntime } from "../src/main.js";
import { secretsPath } from "../src/worker-secrets.js";
import { keyed, nextSlot } from "./announce.js";
import { cli, DOMAIN, h, NOW, runtime, setNow, transport, type World, world } from "./harness.js";

const WORK = createHash("sha256").update("the work").digest("hex");
const url = (name: string) => "https://" + "example.org/" + name;

type Job = { w: World; judge: KeyPairSigner; intent: Address; through: Transport };

async function job(svm: boolean): Promise<Job> {
  const w = await world();
  const through = svm ? svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) }) : transport;
  h.through = through;
  const judge = await keyed("judge.json");
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(32).fill(3), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport: through }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  return { w, judge, intent, through };
}

async function deliver(path: string, j: Job, name: string, rt = runtime({})) {
  nextSlot();
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["deliver", "--keypair", path, "--intent", j.intent, "--sha256", WORK, "--work-url", url(name), "--yes"], rt, { out: (t) => out.push(t), err: (t) => err.push(t) });
  expect([code, err.join("\n")]).toEqual([EXIT_OK, ""]);
  return JSON.parse(out.join("\n")) as { announcement: Address; salt: string; seq: string };
}

async function payLater(j: Job, made: { announcement: Address; salt: string }): Promise<void> {
  await createClient({ url: "http://cluster", transport: j.through }).settleProof({
    judge: j.judge,
    payer: j.judge,
    intent: { owner: j.w.owner.address, nonce: 0n },
    announcement: made.announcement,
    opening: { sha256: WORK, salt: made.salt },
    result: 1n,
  });
}

describe("refute and reclaim from the command line", () => {
  it("refutes a release that paid a later worker, shows it substantiated in the paid worker's reputation, and reclaims the rent after the window", async () => {
    const j = await job(true);
    const earlier = await keyed("earlier.json");
    const later = await keyed("later.json");
    const first = await deliver("earlier.json", j, "first.tar");
    const second = await deliver("later.json", j, "second.tar");
    await payLater(j, second);
    const preview = await cli(["refute", "--keypair", "earlier.json", "--earlier", first.announcement, "--paid", second.announcement, "--work-url", url("first.tar")], {});
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ sent: false, earlier: first.announcement, paid: second.announcement, sha256: WORK });
    const refuted = await cli(["refute", "--keypair", "earlier.json", "--earlier", first.announcement, "--paid", second.announcement, "--work-url", url("first.tar"), "--yes"], {});
    expect([refuted.code, refuted.err]).toEqual([EXIT_OK, ""]);
    expect(refuted.json()).toMatchObject({ sent: true, refutation: expect.any(String) });
    const standing = await cli(["reputation", "--worker", later.address], {});
    expect([standing.code, standing.err]).toEqual([EXIT_OK, ""]);
    const record = (standing.json()["records"] as Record<string, unknown>[]).find((r) => r["announcement"] === second.announcement);
    expect(record).toMatchObject({
      role: "announcer",
      outcome: "paid",
      refutedBy: refuted.json()["refutation"],
      refutations: [{ earlier: first.announcement, earlierWorker: earlier.address, standing: "substantiated" }],
    });
    expect(standing.json()).toMatchObject({ refuted: 1, paid: 0 });
    const kept = await cli(["reclaim", "--keypair", "later.json"], {});
    expect(kept.json()).toMatchObject({ closed: [], kept: [second.announcement], next: NOTHING_TO_RECLAIM });
    setNow(NOW + 3_600n + delivery.REFUTE_WINDOW_SECS + 60n);
    const before = h.svm.getBalance(earlier.address) ?? 0n;
    const rent = (await loadAnnouncement(transport, first.announcement))?.lamports ?? 0n;
    const shown = await cli(["reclaim", "--keypair", "earlier.json"], {});
    expect(shown.json()).toMatchObject({ closed: [first.announcement], sent: false });
    const reclaimed = await cli(["reclaim", "--keypair", "earlier.json", "--yes"], {});
    expect([reclaimed.code, reclaimed.err]).toEqual([EXIT_OK, ""]);
    expect(reclaimed.json()).toMatchObject({ closed: [first.announcement], sent: true });
    expect(await loadAnnouncement(transport, first.announcement)).toBeNull();
    expect((h.svm.getBalance(earlier.address) ?? 0n) - before).toBeGreaterThan(rent / 2n);
  });

  it("keeps a worker's random secrets in an owner-only file when its signer cannot sign messages, and refutes from that file alone", async () => {
    const j = await job(false);
    const device = await keyed();
    const txOnly: TransactionPartialSigner = Object.freeze({ address: device.address, signTransactions: device.signTransactions });
    const home = await mkdtemp(join(tmpdir(), "worker-secrets-"));
    const node = nodeRuntime();
    const base = runtime({});
    const rt = { ...base, home, readText: node.readText, saveText: node.saveText, loadSigner: async (path: string) => (path === "device.json" ? (txOnly as KeyPairSigner) : base.loadSigner(path)) };
    await keyed("later.json");
    const made = await deliver("device.json", j, "device.tar", rt);
    const path = secretsPath(home, device.address, j.intent, WORK);
    expect(made).toMatchObject({ secrets: path });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    const again = await deliver("device.json", j, "device.tar", rt);
    expect(again).toMatchObject({ announcement: made.announcement, sent: false });
    const second = await deliver("later.json", j, "later.tar");
    await payLater(j, second);
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["refute", "--keypair", "device.json", "--earlier", made.announcement, "--paid", second.announcement, "--yes"], rt, { out: (t) => out.push(t), err: (t) => err.push(t) });
    expect([code, err.join("\n")]).toEqual([EXIT_OK, ""]);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ sent: true, earlier: made.announcement, paid: second.announcement });
  });
});

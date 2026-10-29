import { createHash } from "node:crypto";
import { type Address, type Base64EncodedWireTransaction, getBase58Decoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, type Instruction, type KeyPairSigner } from "@solana/kit";
import { COMPUTE_BUDGET_ADDRESS } from "@intent-engine/solver";
import { describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { delivery, sortMembers } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { svmTransport } from "@intent-engine/client/svm";
import { CLAIM_ONE, NOTHING_TO_RECLAIM } from "../src/announce-commands.js";
import { EXIT_OK } from "../src/main.js";
import { keyed, nextSlot } from "./announce.js";
import { ata22, HELD_SHARE, heldRelease, otherAccount22 } from "./held-kit.js";
import { cli, DOMAIN, funded, h, NOW, setNow, transport, world, type World } from "./harness.js";
import { formatAmount } from "@intent-engine/core";

const WORK = createHash("sha256").update("the work").digest("hex");
const HELD_WORK = "7e".repeat(32);
const url = (name: string) => "https://" + "example.org/" + name;

type Job = { w: World; judge: KeyPairSigner; intent: Address; through: Transport };

async function job(svm: boolean, attestor?: (judge: KeyPairSigner) => Promise<Address>): Promise<Job> {
  const w = await world();
  const through = svm ? svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) }) : transport;
  h.through = through;
  const judge = await keyed("judge.json");
  const params = {
    kind: Kind.AttestedResult,
    amountIn: 100n,
    minResult: 1n,
    maxResult: 1n,
    attestor: attestor === undefined ? judge.address : await attestor(judge),
    specHash: new Uint8Array(32).fill(3),
    judgeFee: 0n,
  } as const;
  const { intent } = await createClient({ url: "http://cluster", transport: through }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  return { w, judge, intent, through };
}

async function deliver(path: string, j: Job, name: string) {
  nextSlot();
  return cli(["deliver", "--keypair", path, "--intent", j.intent, "--sha256", WORK, "--work-url", url(name), "--yes"], {});
}

describe("reclaim summary", () => {
  it("names one transaction in the singular, and says nothing was sent when nothing can close", async () => {
    const j = await job(true);
    await keyed("earlier.json");
    await keyed("later.json");
    const first = (await deliver("earlier.json", j, "first.tar")).json() as { announcement: Address };
    const second = (await deliver("later.json", j, "second.tar")).json() as { announcement: Address; salt: string };
    await createClient({ url: "http://cluster", transport: j.through }).settleProof({
      judge: j.judge,
      payer: j.judge,
      intent: { owner: j.w.owner.address, nonce: 0n },
      announcement: second.announcement,
      opening: { sha256: WORK, salt: second.salt },
      result: 1n,
    });
    const nothing = await cli(["reclaim", "--keypair", "earlier.json"], {});
    expect(nothing.json()).toMatchObject({ closed: [], sent: false, next: NOTHING_TO_RECLAIM });
    setNow(NOW + 3_600n + delivery.REFUTE_WINDOW_SECS + 60n);
    const shown = await cli(["reclaim", "--keypair", "earlier.json"], {});
    expect(shown.json()["closed"]).toStrictEqual([first.announcement]);
    expect((shown.json()["summary"] as string[])[0]).toBe("Closes: 1 of this wallet's announcements, in 1 transaction; each one's rent returns to the wallet that paid it");
    expect(shown.json()["transactions"]).toBe(1);
  });
});

function engineInstructions(wire: Base64EncodedWireTransaction): Instruction[] {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes);
  const instructions = "instructions" in message ? message.instructions : [];
  return instructions
    .map((ix): Instruction => ({ programAddress: message.staticAccounts[ix.programAddressIndex] as Address, data: ix.data ?? new Uint8Array() }))
    .filter((ix) => ix.programAddress !== COMPUTE_BUDGET_ADDRESS);
}

describe("deliver to a committee", () => {
  async function committeeJob(): Promise<{ j: Job; seen: Instruction[][] }> {
    const seen: Instruction[][] = [];
    const j = await job(false, async () => {
      const members = [await funded(), await funded(), await funded()];
      const payer = await funded();
      const created = await cli(
        ["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", sortMembers(members.map(({ address }) => address)).join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"],
        { "payer.json": payer },
      );
      expect([created.code, created.err]).toStrictEqual([EXIT_OK, ""]);
      return created.json()["committee"] as Address;
    });
    h.through = {
      ...transport,
      simulate: async (wire: Base64EncodedWireTransaction) => {
        seen.push(engineInstructions(wire));
        return transport.simulate(wire);
      },
    };
    return { j, seen };
  }

  const kind = (instruction: Instruction | undefined) => `${instruction?.programAddress}:${Buffer.from(instruction?.data ?? []).subarray(0, 8).toString("hex")}`;

  it("previews the key snapshot sync while it is due, then the announcement, and reports the sync only when it happened", async () => {
    const { j, seen } = await committeeJob();
    await keyed("first.json");
    await keyed("second.json");
    const args = (path: string) => ["deliver", "--keypair", path, "--intent", j.intent, "--sha256", WORK, "--work-url", url(path)];
    seen.length = 0;
    nextSlot();
    const due = await cli(args("first.json"), {});
    expect([due.code, due.err, due.json()["sent"]]).toStrictEqual([EXIT_OK, "", false]);
    expect(due.json()["summary"]).toContainEqual(expect.stringContaining("Syncs first, in its own transaction"));
    const previewedDue = seen.at(-1) ?? [];
    expect(previewedDue).toHaveLength(1);
    nextSlot();
    const sent = await cli([...args("first.json"), "--yes"], {});
    expect([sent.code, sent.err, sent.json()["sent"]]).toStrictEqual([EXIT_OK, "", true]);
    expect(sent.json()).toHaveProperty("synced");
    seen.length = 0;
    nextSlot();
    const settled = await cli(args("second.json"), {});
    expect([settled.code, settled.err, settled.json()["sent"]]).toStrictEqual([EXIT_OK, "", false]);
    const previewedSettled = seen.at(-1) ?? [];
    expect(previewedSettled.length).toBeGreaterThan(0);
    expect(kind(previewedDue[0])).not.toBe(kind(previewedSettled[0]));
    nextSlot();
    const second = await cli([...args("second.json"), "--yes"], {});
    expect(second.json()["sent"]).toBe(true);
    expect(second.json()).not.toHaveProperty("synced");
  }, 60_000);
});

describe("held shares from the command line", () => {
  it("lists shares without a reasons key and previews a claim into an existing account without a creation line", async () => {
    await world();
    const through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    h.through = through;
    const coauthor = await keyed("coauthor.json");
    const made = await heldRelease(coauthor, HELD_WORK, through);
    const listed = await cli(["claim-held", "--keypair", "coauthor.json"], {});
    expect(Object.keys(listed.json()).sort()).toStrictEqual(["complete", "next", "shares", "wallet"]);
    expect(listed.json()["complete"]).toBe(true);
    expect(listed.json()["next"]).toBe(CLAIM_ONE);
    const to = await otherAccount22(made.payer, coauthor.address, made.mint);
    const preview = await cli(["claim-held", "--keypair", "coauthor.json", "--announcement", made.announcement, "--to", to], {});
    expect((preview.json()["summary"] as string[])[1]).toBe(`Pays into: ${to}, a token account of ${coauthor.address}`);
    expect(preview.json()["amount"]).toBe(formatAmount(HELD_SHARE, 6));
    expect(await ata22(coauthor.address, made.mint)).toBe(made.blocked);
  });
});

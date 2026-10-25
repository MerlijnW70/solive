import { type Address, getBase64Encoder, getTransactionDecoder, type KeyPairSigner, partiallySignTransaction } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { committeeFloorOf, findConfigPda, findIntentPda, getConfigDecoder, MAX_COMMITTEE_FLOORS, sortMembers } from "@intent-engine/core/internal";
import { floorsFull } from "../src/admin-commands.js";
import { AUTHORITY_NEXT } from "../src/commands.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { cli, funded, h, mint, type World, world } from "./harness.js";

type Json = Record<string, any>;

async function signAndSend(transaction: string, signer: KeyPairSigner): Promise<void> {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const result = h.svm.sendTransaction(await partiallySignTransaction([signer.keyPair], tx));
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(result.toString());
  }
}

const floorOf = async (mint: Address) => {
  const view = h.svm.getAccount((await findConfigPda())[0]);
  return view.exists ? committeeFloorOf(getConfigDecoder().decode(view.data), mint) : -1n;
};

const exists = async (owner: Address, nonce: bigint) => h.svm.getAccount((await findIntentPda({ owner, nonce }))[0]).exists;

describe("committee floor on the command line", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    w = await world();
    keys = { "owner.json": w.owner, "admin.json": w.authority };
  });

  const attested = (amount: string, attestor: Address, nonce: number) => [
    "create",
    "attested",
    "--keypair",
    "owner.json",
    "--input-mint",
    w.inputMint,
    "--output-mint",
    w.outputMint,
    "--expires-in",
    "3600",
    "--units",
    "raw",
    "--amount-in",
    amount,
    "--min-result",
    "1",
    "--max-result",
    "1",
    "--attestor",
    attestor,
    "--nonce",
    String(nonce),
    "--yes",
  ];

  const convene = async (threshold: number) => {
    const members = await Promise.all([0, 1, 2].map(() => funded()));
    const payer = await funded();
    const created = await cli(
      ["committee", "create", "--keypair", "payer.json", "--members", sortMembers(members.map((m) => m.address)).join(","), "--threshold", String(threshold), "--fee-wallet", payer.address, "--yes"],
      { "payer.json": payer },
    );
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
    return created.json()["committee"] as Address;
  };

  it("set committee floor prints unsigned instructions for a multisig authority and show config names the floor", async () => {
    const printed = (await cli(["set-committee-floor", "--authority", w.authority.address, "--mint", w.inputMint, "--floor", "500"], {})).json() as Json;
    const tx = printed["unsigned"];
    expect(tx["signers"]).toEqual([w.authority.address]);
    expect(tx["next"]).toBe(AUTHORITY_NEXT);
    expect(tx["instructions"]).toHaveLength(1);
    expect(tx["instructions"][0]["accounts"]).toContainEqual({ address: w.inputMint, signer: false, writable: false });
    expect(printed["summary"]).toEqual([
      `Committee floor of ${w.inputMint}: none -> 500 raw units`,
      "Proof escrows of 500 raw units or more of this token then need a committee of at least 2 judges as attestor",
    ]);
    expect(await floorOf(w.inputMint)).toBe(0n);
    expect(((await cli(["show", "config"], {})).json() as Json)["committeeFloors"]).toEqual([]);
    await signAndSend(tx["transaction"], w.authority);
    expect(await floorOf(w.inputMint)).toBe(500n);
    const shown = (await cli(["show", "config"], {})).json() as Json;
    expect(shown["committeeFloors"]).toEqual([{ mint: w.inputMint, floor: "500" }]);
    expect(shown).not.toHaveProperty("floorMints");
    expect(shown).not.toHaveProperty("floorAmounts");

    const lifted = (await cli(["set-committee-floor", "--keypair", "admin.json", "--mint", w.inputMint, "--floor", "0"], keys)).json() as Json;
    expect(lifted).toMatchObject({
      sent: false,
      summary: [`Committee floor of ${w.inputMint}: 500 raw units -> none`, "Any attestor may then judge proof escrows of this token"],
    });
    const usage = [
      ["set-committee-floor", "--keypair", "admin.json", "--mint", w.inputMint],
      ["set-committee-floor", "--keypair", "admin.json", "--floor", "5"],
      ["set-committee-floor", "--keypair", "admin.json", "--mint", w.inputMint, "--floor", "-1"],
      ["set-committee-floor", "extra", "--keypair", "admin.json", "--mint", w.inputMint, "--floor", "5"],
    ];
    for (const args of usage) {
      expect([args.join(" "), (await cli(args, keys)).code]).toEqual([args.join(" "), EXIT_USAGE]);
    }
  });

  it("refuses a new floor once every slot is taken, but still changes a held floor and accepts a zero floor", async () => {
    const floor = (m: Address, amount: string) => cli(["set-committee-floor", "--keypair", "admin.json", "--mint", m, "--floor", amount], keys);
    const held: Address[] = [];
    for (let i = 0; i < MAX_COMMITTEE_FLOORS; i++) {
      const m = await mint(w.authority);
      const set = await cli(["set-committee-floor", "--keypair", "admin.json", "--yes", "--mint", m, "--floor", String(100 + i)], keys);
      expect([set.code, set.err]).toEqual([EXIT_OK, ""]);
      held.push(m);
    }
    expect(((await cli(["show", "config"], {})).json() as Json)["committeeFloors"]).toHaveLength(MAX_COMMITTEE_FLOORS);
    const extra = await mint(w.authority);
    const full = await floor(extra, "5");
    expect([full.code, full.err]).toEqual([EXIT_FAILED, floorsFull(extra)]);
    const zero = await floor(extra, "0");
    expect([zero.code, zero.json()["sent"]]).toEqual([EXIT_OK, false]);
    const changed = await floor(held[0] ?? extra, "7");
    expect([changed.code, changed.json()["sent"]]).toEqual([EXIT_OK, false]);
    expect(changed.json()["summary"]).toContain(`Committee floor of ${held[0]}: 100 raw units -> 7 raw units`);
  });

  it("create attested refuses a single judge at the floor before sending and passes a two-of-n committee", async () => {
    expect((await cli(["set-committee-floor", "--keypair", "admin.json", "--yes", "--mint", w.inputMint, "--floor", "500"], keys)).code).toBe(EXIT_OK);
    const judge = (await funded()).address;
    const refused = await cli(attested("500", judge, 0), keys);
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain("CommitteeRequired");
    expect(refused.err).toContain(judge);
    expect(await exists(w.owner.address, 0n)).toBe(false);

    const below = await cli(attested("499", judge, 1), keys);
    expect([below.code, below.err]).toEqual([EXIT_OK, ""]);
    expect(await exists(w.owner.address, 1n)).toBe(true);

    const loose = await convene(1);
    expect((await cli(attested("500", loose, 2), keys)).err).toContain("CommitteeRequired");
    expect(await exists(w.owner.address, 2n)).toBe(false);

    const committee = await convene(2);
    const passed = await cli(attested("500", committee, 2), keys);
    expect([passed.code, passed.err]).toEqual([EXIT_OK, ""]);
    expect(passed.json()["summary"]).toContain(`Judged by: the committee ${committee}, passed with the create`);
    expect(await exists(w.owner.address, 2n)).toBe(true);
  });
});

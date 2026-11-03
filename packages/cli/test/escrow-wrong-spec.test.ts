import { createHash } from "node:crypto";
import type { Address } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { WRONG_SPEC_ALLOWED, WRONG_SPEC_SEND, wrongSpecRefused } from "../src/agent/wallet/escrow-terms.js";
import { ESCROW_CHANGED } from "../src/agent/wallet/escrow.js";
import { call, fresh, ok } from "./agent-wallet-kit.js";
import { approved } from "./approved.js";
import { h } from "./harness.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const SPEC_URL = "https://" + "example.org/jobs/wrong-spec.md";
const SPEC = "# A spec\n\nDeliver the parser.\n";
const WRONG = "7c".repeat(32);
const MISMATCH = `spec_url hashes to ${sha(SPEC)}, not spec_hash ${WRONG}; publish the exact bytes, or fix spec_hash`;

describe("an escrow whose spec_url does not hash to spec_hash", () => {
  let client: Client;
  let wallet: Address;

  beforeEach(async () => {
    client = await fresh();
    wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.specPages.set(SPEC_URL, new TextEncoder().encode(SPEC));
  });

  const sol = () => h.svm.getBalance(wallet) ?? 0n;

  it("wallet_escrow sends nothing, unless allow_wrong_spec is true", async () => {
    const terms = { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: WRONG, spec_url: SPEC_URL };
    expect((await ok(client, "wallet_escrow", terms))["warnings"]).toEqual(expect.arrayContaining([MISMATCH, WRONG_SPEC_SEND]));
    const [wires, before] = [h.wires.length, sol()];
    const refused = await call(client, "wallet_escrow", await approved(client, "wallet_escrow", terms));
    expect(refused).toMatchObject({ error: true, value: { code: "InvalidInput", issues: [{ path: "spec_url", message: wrongSpecRefused(MISMATCH) }] } });
    expect([h.wires.length, sol()]).toEqual([wires, before]);
    const sent = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { ...terms, allow_wrong_spec: true }));
    expect(sent).toMatchObject({ sent: true });
    expect(h.wires.length).toBeGreaterThan(wires);
  });

  it("binds allow_wrong_spec to the preview, which says plainly the escrow goes out despite the mismatch", async () => {
    const terms = { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: WRONG, spec_url: SPEC_URL };
    const plain = await ok(client, "wallet_escrow", terms);
    const allowed = await ok(client, "wallet_escrow", { ...terms, allow_wrong_spec: true });
    expect(allowed["warnings"]).toEqual(expect.arrayContaining([MISMATCH, WRONG_SPEC_ALLOWED]));
    expect(allowed["warnings"]).not.toContain(WRONG_SPEC_SEND);
    expect(allowed["approval"]).not.toBe(plain["approval"]);
    const [wires, before] = [h.wires.length, sol()];
    const changed = await call(client, "wallet_escrow", { ...terms, allow_wrong_spec: true, approval: plain["approval"], send: true });
    expect(changed).toMatchObject({ error: true, value: { code: "ReleaseChanged", hint: ESCROW_CHANGED } });
    const plan = { sell: "SOL", attestor: wallet, pieces: [{ name: "a", amount: "0.01", spec_hash: WRONG, spec_url: SPEC_URL }, { name: "b", amount: "0.01" }] };
    const shownPlan = await ok(client, "wallet_escrow_plan", plan);
    expect(shownPlan["warnings"]).toContain(`Piece 1 (a): ${WRONG_SPEC_SEND}`);
    const changedPlan = await call(client, "wallet_escrow_plan", { ...plan, allow_wrong_spec: true, approval: shownPlan["approval"], send: true });
    expect(changedPlan).toMatchObject({ error: true, value: { code: "ReleaseChanged", hint: ESCROW_CHANGED } });
    expect([h.wires.length, sol()]).toEqual([wires, before]);
  });

  it("wallet_escrow_plan sends no piece, unless allow_wrong_spec is true", async () => {
    const plan = { sell: "SOL", attestor: wallet, pieces: [{ name: "a", amount: "0.01", spec_hash: sha(SPEC), spec_url: SPEC_URL }, { name: "b", amount: "0.01", spec_hash: WRONG, spec_url: SPEC_URL }] };
    expect((await ok(client, "wallet_escrow_plan", plan))["warnings"]).toEqual(expect.arrayContaining([`Piece 2 (b): ${MISMATCH}`, `Piece 2 (b): ${WRONG_SPEC_SEND}`]));
    const [wires, before] = [h.wires.length, sol()];
    const refused = await call(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", plan));
    expect(refused).toMatchObject({ error: true, value: { code: "InvalidInput", issues: [{ path: "pieces.1.spec_url", message: wrongSpecRefused(`Piece 2 (b): ${MISMATCH}`) }] } });
    expect([h.wires.length, sol()]).toEqual([wires, before]);
    const sent = await ok(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", { ...plan, allow_wrong_spec: true }));
    expect(sent).toMatchObject({ sent: true });
    expect(sent["pieces"]).toHaveLength(2);
  });

  it("still only warns about a spec_url it cannot read", async () => {
    h.specPages.delete(SPEC_URL);
    const terms = { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: WRONG, spec_url: SPEC_URL };
    const preview = await ok(client, "wallet_escrow", terms);
    expect(preview["warnings"]).toContainEqual(expect.stringMatching(/^spec_url .+; publish it or workers cannot read the job$/));
    expect(preview["warnings"]).not.toContain(WRONG_SPEC_SEND);
    expect(await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", terms))).toMatchObject({ sent: true });
  });
});

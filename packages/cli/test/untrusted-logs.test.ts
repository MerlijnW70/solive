import { createHash } from "node:crypto";
import { type Address, type KeyPairSigner, signBytes } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saltMessage } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { swapOf } from "./agent-kit.js";
import { execute, grantOf, mandateServed, order } from "./agent-mandate-kit.js";
import { funded, NOW, setNow, transport, type World } from "./harness.js";
import { HOSTILE, heldTo, served } from "./untrusted-kit.js";

const WORK_URL = "https://" + "example.org/work.md";

describe("hostile simulation logs on every tool that prepares a transaction", () => {
  let w: World;
  let agent: KeyPairSigner;
  let client: Client;
  let real: Transport["simulate"];

  beforeEach(async () => {
    real = transport.simulate;
    transport.simulate = async (wire, watch) => {
      const simulated = await real(wire, watch);
      return { ...simulated, logs: [...simulated.logs, HOSTILE] };
    };
    ({ w, agent, client } = await mandateServed());
  });

  afterEach(() => {
    transport.simulate = real;
  });

  const prepared = async (name: string, args: object) => {
    const result = await served(client, name, args);
    expect(result.error, JSON.stringify(result.value)).toBe(false);
    return { value: result.value, held: [...new Set(heldTo(tool(name), result.value))].sort() };
  };

  it("keep the logs reduced in their logs field and out of every other field", async () => {
    const created = await prepared("prepare_create", swapOf(w));
    expect(created.held).toEqual(["prepared.logs[]"]);
    await execute(created.value["prepared"], w.owner);
    const cancel = await prepared("prepare_cancel", { owner: w.owner.address, nonce: created.value["nonce"] });
    expect(cancel.held).toEqual(["prepared.logs[]"]);
    const signed = await prepared("prepare_signed_intent", { ...swapOf(w), submit_within: 600 });
    expect(signed.held).toEqual(["setup.logs[]"]);
    const granted = await prepared("prepare_mandate", grantOf(w, agent));
    expect(granted.held).toEqual(["prepared.logs[]"]);
    await execute(granted.value["prepared"], w.owner);
    const made = await prepared("prepare_agent_create", { agent: agent.address, owner: w.owner.address, order: order("200", "100"), expires_in: 600 });
    expect(made.held).toEqual(["prepared.logs[]"]);
    await execute(made.value["prepared"], agent);
    const revoke = await prepared("prepare_revoke_mandate", { owner: w.owner.address, agent: agent.address });
    expect(revoke.held).toEqual(["cancels[].logs[]", "prepared.logs[]"]);
    setNow(NOW + 7_200n);
    const crank = await prepared("prepare_crank", { cranker: agent.address, owner: w.owner.address, nonce: created.value["nonce"] });
    expect(crank.held).toEqual(["prepared.logs[]"]);
  });

  it("keep the logs out of an unsigned announcement's fields", async () => {
    const spec = createHash("sha256").update("spec").digest("hex");
    const escrow = await prepared("prepare_create", {
      ...swapOf(w),
      order: { kind: "attested", amount_in: "100", min_result: "1", max_result: "1", attestor: w.authority.address, spec_hash: spec },
    });
    await execute(escrow.value["prepared"], w.owner);
    const intent = escrow.value["intent"] as Address;
    const worker = await funded();
    const work = "e7".repeat(32);
    const signature = Buffer.from(await signBytes(worker.keyPair.privateKey, saltMessage(intent, work))).toString("hex");
    const delivered = await prepared("prepare_deliver", { worker: worker.address, intent, sha256: work, url: WORK_URL, salt_signature: signature });
    expect(delivered.value).toMatchObject({ intent, attestor: w.authority.address, sha256: work, url: WORK_URL });
    expect(delivered.held).toEqual(["prepared.logs[]"]);
  });
});

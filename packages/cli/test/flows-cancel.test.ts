import {
  type Address,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
} from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { IntentStatus } from "@intent-engine/core";
import { findMandatePda, getIntentDecoder } from "@intent-engine/core/internal";
import { BlockhashExpired, FailedOnChain } from "@intent-engine/client";
import { failure } from "@intent-engine/client/internal";
import { CANCELS_FAILED, CANCELS_UNKNOWN } from "../src/flows.js";
import { EXIT_FAILED, EXIT_OK, EXIT_PARTIAL } from "../src/main.js";
import { cli, funded, h, transport, type World } from "./harness.js";
import { exists, flowWorld, type Json } from "./flows-kit.js";

describe("command line flows", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    ({ w, keys } = await flowWorld());
  });

  const twoAgentIntents = async () => {
    const agent = await funded();
    keys["agent.json"] = agent;
    const grant = [
      "mandate",
      "grant",
      "--keypair",
      "owner.json",
      "--agent",
      agent.address,
      "--input-mint",
      w.inputMint,
      "--output-mint",
      w.outputMint,
      "--kinds",
      "swap",
      "--per-intent",
      "200",
      "--total",
      "600",
      "--max-intents",
      "3",
      "--max-ttl",
      "3600",
      "--valid-for",
      "86400",
      "--floor-out",
      "1",
      "--floor-in",
      "2",
      "--agent-fee",
      "10",
      "--units",
      "raw",
      "--yes",
    ];
    expect((await cli(grant, keys)).json()).toMatchObject({ sent: true });
    const use = ["mandate", "use", "swap", "--keypair", "agent.json", "--owner", w.owner.address, "--expires-in", "600", "--units", "raw", "--amount-in", "190", "--min-out", "100", "--yes"];
    const opened: Address[] = [];
    for (let i = 0; i < 2; i++) {
      const used = (await cli(use, keys)).json() as Json;
      expect(used).toMatchObject({ sent: true });
      opened.push(used["intent"] as Address);
    }
    const preview = (await cli(["mandate", "revoke", "--keypair", "owner.json", "--agent", agent.address], keys)).json() as Json;
    const [first, second] = preview["cancelled"] as Address[];
    expect(new Set([first, second])).toEqual(new Set(opened));
    return { agent, first: first as Address, second: second as Address };
  };

  const statusOf = (intent: Address) => {
    const view = h.svm.getAccount(intent);
    return view.exists ? getIntentDecoder().decode(view.data).status : undefined;
  };

  it("cancel close uses the intent rent payer", async () => {
    const { agent, first } = await twoAgentIntents();
    const view = h.svm.getAccount(first);
    if (!view.exists) {
      throw new Error("the agent intent is missing");
    }
    const { nonce, rentPayer } = getIntentDecoder().decode(view.data);
    expect(rentPayer).toBe(agent.address);
    const cancel = ["cancel", "--keypair", "owner.json", "--nonce", nonce.toString(), "--close"];
    const preview = await cli(cancel, keys);
    expect(preview.code).toBe(EXIT_OK);
    expect((preview.json() as Json)["summary"]).toContain(
      `Closes the intent in the same transaction and returns its rent and bounty to ${agent.address}, who paid them; it can no longer be read afterwards`,
    );
    const held = h.svm.getBalance(agent.address) ?? 0n;
    const locked = h.svm.getBalance(first) ?? 0n;
    const sent = await cli([...cancel, "--yes"], keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ intent: first, sent: true });
    expect(exists(first)).toBe(false);
    expect((h.svm.getBalance(agent.address) ?? 0n) - held).toBeGreaterThanOrEqual(locked);
  });

  it("revoke exits non zero when a cancel failed", async () => {
    const { agent, first, second } = await twoAgentIntents();
    h.engineLog = [];
    h.sendFails = { error: new FailedOnChain("the cancel failed on chain", failure(testSignature("sent"), null)), landed: false, after: 1 };
    const revoked = await cli(["mandate", "revoke", "--keypair", "owner.json", "--agent", agent.address, "--yes"], keys);
    expect([revoked.code, revoked.err]).toEqual([EXIT_PARTIAL, ""]);
    expect(EXIT_PARTIAL).not.toBe(EXIT_FAILED);
    const shown = revoked.json() as Json;
    expect(shown).toMatchObject({ sent: true, cancelled: [second], failed: [{ intent: first, reason: "the cancel failed on chain" }], next: CANCELS_FAILED });
    expect(shown).not.toHaveProperty("unknown");
    expect(shown["signatures"]).toHaveLength(2);
    const [address] = await findMandatePda({ owner: w.owner.address, agent: agent.address, id: 0n });
    expect(exists(address)).toBe(false);
    expect([statusOf(first), statusOf(second)]).toEqual([IntentStatus.Open, IntentStatus.Cancelled]);
  });

  it("a cancel that may have landed is reported as unknown", async () => {
    const { agent, first, second } = await twoAgentIntents();
    h.engineLog = [];
    h.sendFails = { error: new Error("timed out"), landed: false, after: 1 };
    const revoked = await cli(["mandate", "revoke", "--keypair", "owner.json", "--agent", agent.address, "--yes"], keys);
    expect(revoked.code).toBe(EXIT_PARTIAL);
    const shown = revoked.json() as Json;
    expect(shown).toMatchObject({ sent: true, cancelled: [second], unknown: [{ intent: first, signature: expect.any(String), reason: "timed out" }], next: CANCELS_UNKNOWN });
    expect(shown).not.toHaveProperty("failed");
    expect(shown["signatures"]).toHaveLength(2);
    expect(statusOf(first)).toBe(IntentStatus.Open);
  });

  it("a cancel that landed despite an error is reported as cancelled", async () => {
    const { agent, first, second } = await twoAgentIntents();
    h.engineLog = [];
    h.sendFails = { error: new BlockhashExpired("expired"), landed: true, after: 1 };
    const revoked = await cli(["mandate", "revoke", "--keypair", "owner.json", "--agent", agent.address, "--yes"], keys);
    expect(revoked.code).toBe(EXIT_OK);
    const shown = revoked.json() as Json;
    expect(new Set(shown["cancelled"])).toEqual(new Set([first, second]));
    expect(shown).not.toHaveProperty("failed");
    expect(shown).not.toHaveProperty("unknown");
    expect(shown["signatures"]).toHaveLength(3);
    expect([statusOf(first), statusOf(second)]).toEqual([IntentStatus.Cancelled, IntentStatus.Cancelled]);
  });

  it("a cancel found failed in the intent's history is reported as failed", async () => {
    const { agent, first } = await twoAgentIntents();
    const unsigned = getTransactionDecoder();
    h.engineLog = [];
    const realSend = transport.sendWire;
    let dropped = testSignature("not dropped yet");
    h.sendFails = null;
    let sends = 0;
    transport.sendWire = async (wire, latest) => {
      sends += 1;
      if (sends === 2) {
        dropped = getSignatureFromTransaction(unsigned.decode(getBase64Encoder().encode(wire)));
        h.engineLog = [{ signature: dropped, slot: 9n, blockTime: null, failed: true, emitted: [] }];
        throw new Error("timed out");
      }
      return realSend(wire, latest);
    };
    try {
      const revoked = await cli(["mandate", "revoke", "--keypair", "owner.json", "--agent", agent.address, "--yes"], keys);
      expect(revoked.code).toBe(EXIT_PARTIAL);
      expect(revoked.json()).toMatchObject({ failed: [{ intent: first, reason: "timed out" }], next: CANCELS_FAILED });
      expect(dropped).not.toBe(testSignature("not dropped yet"));
    } finally {
      transport.sendWire = realSend;
      h.engineLog = [];
    }
  });
});

import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { announcementCommitment, buildAnnounceDelivery, sealDeliveryV4 } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { prepare } from "../src/agent/prepare.js";
import { ENGINE_PROBLEMS, problemOf, SERVER_PROBLEMS } from "../src/agent/problems.js";
import { CLAIM_CHANGED } from "../src/agent/work-claims.js";
import { PROFILE_CHANGED } from "../src/agent/profile.js";
import { FEEDBACK_CHANGED } from "../src/agent/reputation.js";
import { AGENT_KEY_IS_WALLET } from "../src/agent/mandate-agent.js";
import { RELAYER_KEY_IS_WALLET } from "../src/agent/signed-submit.js";
import { serverKeyNotWallet } from "../src/wallet.js";
import { keyed, nextSlot } from "./announce.js";
import { NOW, transport, world } from "./harness.js";

describe("catalog rows that fit every refusal using their code", () => {
  it("ReleaseChanged names the claim, profile and feedback previews that refuse with it", () => {
    const row = SERVER_PROBLEMS.ReleaseChanged.hint;
    for (const [refusal, named] of [
      [CLAIM_CHANGED, "a claim"],
      [PROFILE_CHANGED, "a profile"],
      [FEEDBACK_CHANGED, "feedback"],
    ] as const) {
      expect(refusal).toMatch(/differs from its preview/);
      expect(row, named).toContain(named);
    }
    expect(row).toMatch(/^what this call would sign differs from its preview/);
    expect(row).toContain("a release");
  });

  it("KeyInUse names only the Ledger encryption key, and KeyIsWallet the three keys apart from the wallet", () => {
    expect(SERVER_PROBLEMS.KeyInUse.hint).toMatch(/Ledger.*encryption key/);
    expect(SERVER_PROBLEMS.KeyInUse.hint).not.toMatch(/--agent|--relayer/);
    const row = SERVER_PROBLEMS.KeyIsWallet.hint;
    for (const named of ["--agent key", "--relayer key", "agent_create", "submit_signed_intent", "wallet_setup"]) {
      expect(row, named).toContain(named);
    }
    expect(AGENT_KEY_IS_WALLET).toContain("agent key is also its wallet's key");
    expect(RELAYER_KEY_IS_WALLET).toContain("relayer key is also its wallet's key");
    expect(serverKeyNotWallet("w.json")).toContain("--agent or --relayer key");
  });

  it("FeeAccountNotCanonical names the fee recipient wallet an announcement refuses it for", async () => {
    const w = await world();
    const judge = await keyed();
    const worker = await keyed();
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(32).fill(5), judgeFee: 0n } as const;
    const client = createClient({ url: "http://cluster", transport });
    const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    nextSlot();
    const blob = await sealDeliveryV4({ source: crypto.getRandomValues(new Uint8Array(32)), url: "https://" + "example.org/work", recipients: [judge.address] }, intent, worker.address);
    const commitment = await announcementCommitment(intent, worker.address, { delivered: new Uint8Array(32).fill(7), salt: crypto.getRandomValues(new Uint8Array(16)) });
    const elsewhere = (await generateKeyPairSigner()).address;
    const { instruction } = await buildAnnounceDelivery({ worker, intent, attestor: judge.address, committee: false, commitment, blob, feeRecipient: elsewhere });
    const failed = await prepare(transport, [instruction], worker.address).then(
      () => null,
      (error: unknown) => error,
    );
    const problem = problemOf(failed);
    expect(problem).toMatchObject({ code: "FeeAccountNotCanonical", programError: 6029, hint: ENGINE_PROBLEMS.FeeAccountNotCanonical.hint });
    expect(problem.hint).toContain("the config's fee recipient wallet itself at an announcement");
    expect(problem.hint).toContain("the canonical token account of the treasury, the agent or the judge at a fill");
  });
});

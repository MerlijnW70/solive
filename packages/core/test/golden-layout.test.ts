import { describe, expect, it } from "vitest";
import { IntentCoreError, type CoreErrorCode, splitFees } from "../src/index.js";
import {
  getAcceptAdminDiscriminatorBytes,
  getAdvanceEpochDiscriminatorBytes,
  getAdvanceNonceDiscriminatorBytes,
  getAdvanceNonceInstructionDataEncoder,
  getCancelIntentDiscriminatorBytes,
  getCloseIntentDiscriminatorBytes,
  getCreateIntentByAgentDiscriminatorBytes,
  getCreateMandateDiscriminatorBytes,
  getRevokeMandateDiscriminatorBytes,
  getSetCapsRequiredDiscriminatorBytes,
  getSetCommitteeFloorDiscriminatorBytes,
  getSetMintCapDiscriminatorBytes,
  getCreateIntentDiscriminatorBytes,
  getCreateIntentInstructionDataEncoder,
  getExpireIntentDiscriminatorBytes,
  getFillIntentDiscriminatorBytes,
  getFillIntentInstructionDataEncoder,
  getInitConfigDiscriminatorBytes,
  getInitUserDiscriminatorBytes,
  getProposeAdminDiscriminatorBytes,
  getRaisePauseDiscriminatorBytes,
  getRaisePauseInstructionDataEncoder,
  getUpdateConfigDiscriminatorBytes,
  checkFlags,
  partnerOf,
  nextFreeNonce,
  CONFIG_VERSION,
  ACCOUNT_LAYOUTS,
  OUTDATED_LAYOUTS,
  PAUSE_CREATE,
  PAUSE_FILL,
  INTENT_VERSION,
  USER_VERSION,
  validateExt,
} from "../src/internal.js";
import { bytes, hexOf, vectors } from "./golden-vectors.js";

describe("golden vectors emitted by the Rust implementation", () => {
  it("carry the account versions the program accepts", () => {
    const v = vectors as unknown as { versions: Record<"config" | "user" | "intent", number> };
    expect({ config: CONFIG_VERSION, user: USER_VERSION, intent: INTENT_VERSION }).toEqual(v.versions);
    const p = vectors as unknown as { pause: Record<"create" | "fill", number> };
    expect({ create: PAUSE_CREATE, fill: PAUSE_FILL }).toEqual(p.pause);
  });

  it("carry the version and payer offset of every account layout", () => {
    const v = vectors as unknown as { layouts: { discriminator: string; space: number; version_at: number; version: number; oldest: number; payer_at: number | null }[] };
    expect(
      ACCOUNT_LAYOUTS.map((l) => ({ discriminator: hexOf(l.discriminator), space: l.space, version_at: l.versionAt, version: l.version, oldest: l.oldest, payer_at: l.payerAt })),
    ).toEqual(v.layouts);
  });

  it("list every outdated layout the program migrates", () => {
    const v = vectors as unknown as { outdated: { discriminator: string; space: number; version: number }[] };
    expect(OUTDATED_LAYOUTS.map((o) => ({ discriminator: hexOf(o.discriminator), space: o.space, version: o.version }))).toEqual(v.outdated);
  });

  it("pick the next free nonce exactly as the program does", () => {
    const v = vectors as unknown as { next_free_nonce: { base: string; bits: string[]; next: string | null }[] };
    expect(v.next_free_nonce.length).toBeGreaterThan(8);
    for (const c of v.next_free_nonce) {
      const window = { nonceBase: BigInt(c.base), nonceBitmap: c.bits.map(BigInt) };
      expect(nextFreeNonce(window), JSON.stringify(c)).toBe(c.next === null ? null : BigInt(c.next));
    }
    expect(() => nextFreeNonce({ nonceBase: 0n, nonceBitmap: [0n, 0n, 0n] })).toThrow(
      "a nonce window has 4 words, got 3",
    );
  });

  it("split fees and read partners exactly as the program does", () => {
    const v = vectors as unknown as {
      split_fees: {
        amount: string;
        fee_bps: string;
        partner_bps: string;
        cut_bps: string;
        result: { protocol?: string; partner?: string; net?: string; err?: string };
      }[];
      partner_checks: { hex: string; outcome: { ok?: { key: string; bps: number } | null; err?: string } }[];
    };
    expect(v.split_fees.length).toBeGreaterThan(8);
    for (const c of v.split_fees) {
      const run = () => splitFees(BigInt(c.amount), Number(c.fee_bps), Number(c.partner_bps), Number(c.cut_bps));
      if (c.result.err === undefined) {
        expect(run(), c.amount).toEqual({
          protocol: BigInt(c.result.protocol ?? ""),
          partner: BigInt(c.result.partner ?? ""),
          net: BigInt(c.result.net ?? ""),
        });
      } else {
        expect(run, c.amount).toThrow(new IntentCoreError(c.result.err as CoreErrorCode));
      }
    }
    expect(v.partner_checks.length).toBeGreaterThan(8);
    for (const c of v.partner_checks) {
      const run = () => partnerOf(bytes(c.hex));
      if (c.outcome.err === undefined) {
        expect(run(), c.hex).toEqual(c.outcome.ok === null ? undefined : c.outcome.ok);
      } else {
        expect(run, c.hex).toThrow(new IntentCoreError(c.outcome.err as CoreErrorCode));
      }
    }
  });

  it("validate extensions and flags exactly as the program does", () => {
    const v = vectors as unknown as {
      ext_checks: { hex: string; known: number[]; outcome: { ok?: string; err?: string } }[];
      flag_checks: { flags: number; outcome: { ok?: string; err?: string } }[];
    };
    expect(v.ext_checks.length).toBeGreaterThan(10);
    for (const c of v.ext_checks) {
      const run = () => validateExt(bytes(c.hex), c.known);
      if (c.outcome.err === undefined) {
        expect(run, c.hex).not.toThrow();
      } else {
        expect(run, c.hex).toThrow(new IntentCoreError(c.outcome.err as CoreErrorCode));
      }
    }
    for (const c of v.flag_checks) {
      const run = () => checkFlags(c.flags);
      if (c.outcome.err === undefined) {
        expect(run(), String(c.flags)).toBe(c.flags);
      } else {
        expect(run, String(c.flags)).toThrow(new IntentCoreError(c.outcome.err as CoreErrorCode));
      }
    }
  });

  it("serialize instruction data the program expects", () => {
    const want = Object.fromEntries(vectors.instruction_data.map((d) => [d.name, d.hex]));
    const swap = vectors.decode[0];
    expect(swap).toBeDefined();
    expect(
      hexOf(
        getCreateIntentInstructionDataEncoder().encode({
          args: {
            nonce: 42n,
            kind: 1,
            flags: 3,
            params: bytes(swap?.hex ?? ""),
            expiresAt: 1_700_000_000n,
            ext: bytes("010200aabb"),
            maxCreateFee: 0x0102_0304,
            maxBounty: 0x0506_0708,
          },
        }),
      ),
    ).toBe(want["create_intent"]);
    expect(
      hexOf(
        getFillIntentInstructionDataEncoder().encode({
          amountIn: 1_000_000n,
          amountOut: 990_000n,
          maxFeeBps: 100,
          ext: bytes("010200aabb"),
        }),
      ),
    ).toBe(want["fill_intent"]);
    expect(hexOf(getAdvanceNonceInstructionDataEncoder().encode({ nonceBase: 300n }))).toBe(
      want["advance_nonce"],
    );
    expect(hexOf(getRaisePauseInstructionDataEncoder().encode({ flags: 1 }))).toBe(
      want["raise_pause"],
    );
  });

  it("agree on every instruction discriminator", () => {
    const ours: Record<string, ArrayLike<number>> = {
      init_config: getInitConfigDiscriminatorBytes(),
      update_config: getUpdateConfigDiscriminatorBytes(),
      propose_admin: getProposeAdminDiscriminatorBytes(),
      accept_admin: getAcceptAdminDiscriminatorBytes(),
      raise_pause: getRaisePauseDiscriminatorBytes(),
      init_user: getInitUserDiscriminatorBytes(),
      advance_nonce: getAdvanceNonceDiscriminatorBytes(),
      advance_epoch: getAdvanceEpochDiscriminatorBytes(),
      create_intent: getCreateIntentDiscriminatorBytes(),
      fill_intent: getFillIntentDiscriminatorBytes(),
      cancel_intent: getCancelIntentDiscriminatorBytes(),
      expire_intent: getExpireIntentDiscriminatorBytes(),
      close_intent: getCloseIntentDiscriminatorBytes(),
      create_mandate: getCreateMandateDiscriminatorBytes(),
      revoke_mandate: getRevokeMandateDiscriminatorBytes(),
      create_intent_by_agent: getCreateIntentByAgentDiscriminatorBytes(),
      set_mint_cap: getSetMintCapDiscriminatorBytes(),
      set_caps_required: getSetCapsRequiredDiscriminatorBytes(),
      set_committee_floor: getSetCommitteeFloorDiscriminatorBytes(),
    };
    expect(Object.keys(ours).sort()).toEqual(Object.keys(vectors.discriminators).sort());
    for (const [name, disc] of Object.entries(ours)) {
      expect(hexOf(disc), name).toBe(vectors.discriminators[name]);
    }
  });
});

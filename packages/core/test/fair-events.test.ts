import { generateKeyPairSigner, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  decodeEvent,
  EVENT_IX_TAG,
  getCancelRequestedEventEncoder,
  getClaimDroppedEventEncoder,
  getClaimsOpenedEventEncoder,
  getDeliveryRejectedEventEncoder,
  getReviewArmedEventEncoder,
  getReviewLapsedEventEncoder,
  GROWN_EVENTS,
} from "../src/internal.js";

const NONE = "11111111111111111111111111111111" as Address;

const tagged = (body: ArrayLike<number>): Uint8Array => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

const older = (body: ArrayLike<number>, cut: number): Uint8Array => tagged(Array.from(body).slice(0, -cut));

const key = async (): Promise<Address> => (await generateKeyPairSigner()).address;

describe("engine events from before and after fair closing", () => {
  it("decodes a ClaimDropped with its announcement, and one written before the field existed with no announcement", async () => {
    const [intent, worker, announcement] = await Promise.all([key(), key(), key()]);
    const body = getClaimDroppedEventEncoder().encode({ intent, worker, refunded: 7n, announcement });
    expect(decodeEvent(tagged(body))).toEqual({ name: "ClaimDropped", notable: false, fields: { intent, worker, refunded: 7n, announcement } });
    expect(decodeEvent(older(body, GROWN_EVENTS.ClaimDropped ?? 0))).toEqual({ name: "ClaimDropped", notable: false, fields: { intent, worker, refunded: 7n, announcement: NONE } });
  });

  it("decodes a ClaimsOpened with its review terms, and one written before them as having no review", async () => {
    const [intent, owner] = await Promise.all([key(), key()]);
    const body = getClaimsOpenedEventEncoder().encode({ intent, owner, maxSecs: 600, stake: 890_880n, reviewSecs: 86_400, killFee: 890_880n });
    expect(decodeEvent(tagged(body))?.fields).toEqual({ intent, owner, maxSecs: 600, stake: 890_880n, reviewSecs: 86_400, killFee: 890_880n });
    expect(decodeEvent(older(body, GROWN_EVENTS.ClaimsOpened ?? 0))?.fields).toEqual({ intent, owner, maxSecs: 600, stake: 890_880n, reviewSecs: 0, killFee: 0n });
  });

  it("refuses an event cut shorter than any layout it ever had", async () => {
    const [intent, worker, announcement] = await Promise.all([key(), key(), key()]);
    const body = getClaimDroppedEventEncoder().encode({ intent, worker, refunded: 7n, announcement });
    expect(decodeEvent(older(body, (GROWN_EVENTS.ClaimDropped ?? 0) + 1))).toBeNull();
  });

  it("decodes the new review, reject and notice events", async () => {
    const [intent, announcement, worker, attestor, owner] = await Promise.all([key(), key(), key(), key(), key()]);
    const events = [
      tagged(getReviewArmedEventEncoder().encode({ intent, announcement, worker, attestor, reviewUntil: 9n, killFee: 3n })),
      tagged(getDeliveryRejectedEventEncoder().encode({ intent, announcement, seq: 1n, worker, attestor, underReview: true, stakeReturned: 2n })),
      tagged(getReviewLapsedEventEncoder().encode({ intent, announcement, worker, attestor, killFee: 3n, stake: 2n })),
      tagged(getCancelRequestedEventEncoder().encode({ intent, owner, cancelAt: 5n })),
    ];
    expect(events.map((data) => decodeEvent(data)?.name)).toEqual(["ReviewArmed", "DeliveryRejected", "ReviewLapsed", "CancelRequested"]);
    expect(decodeEvent(events[0] ?? new Uint8Array())?.fields).toEqual({ intent, announcement, worker, attestor, reviewUntil: 9n, killFee: 3n });
  });
});

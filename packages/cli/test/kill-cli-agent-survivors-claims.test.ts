import { describe, expect, it } from "vitest";
import { setNow, NOW } from "./harness.js";
import { markFilled } from "./agent-wallet-kit.js";
import { call, job } from "./kill-cli-agent-survivors-kit.js";

describe("the line entries wallet_claim leaves", () => {
  it("names who stands by nowhere, guards another wallet's entry while the escrow is open and frees it afterwards", async () => {
    const j = await job();
    await j.as("holder", "take", 600);
    await j.as("third", "standby", 600);
    expect(await j.refused({ action: "leave" })).toMatchObject({
      code: "NotFound",
      hint: `this wallet ${j.wallet} stands by nowhere in the line of escrow ${j.intent}; nothing was sent`,
    });
    expect(await j.refused({ action: "leave", seq: 7 })).toMatchObject({
      code: "NotFound",
      hint: `entry 7 stands nowhere in the line of escrow ${j.intent}; nothing was sent`,
    });
    expect(await j.refused({ action: "leave", seq: 0 })).toMatchObject({
      code: "Unauthorized",
      hint: `escrow ${j.intent} is still open, so only ${j.third.address} can take entry 0 out of its line; nothing was sent`,
    });
    const longest = await j.ok("wallet_claim", { ...j.escrow, action: "standby", secs: 3600 });
    expect(longest["summary"][0]).toContain("it holds the claim for 3600 seconds");
    await j.sent({ action: "standby", secs: 600 });
    const leaving = await j.ok("wallet_claim", { ...j.escrow, action: "leave", seq: 1 });
    expect(leaving["summary"][0]).toBe(`Leaves: entry 1 in the line of escrow ${j.intent}`);
    setNow(NOW + 600n);
    const two = await j.ok("get_claims", j.escrow);
    expect(two["waiting"]).toBe(2);
    expect(two["next"]).toMatch(/^2 workers stand by, so the job goes to them in line order; /);
    setNow(NOW + 3_600n);
    const freed = await j.ok("wallet_claim", { ...j.escrow, action: "leave", seq: 0 });
    expect(freed["summary"][0]).toBe(`Leaves: entry 0 in the line of escrow ${j.intent}`);
    expect(freed["summary"][1]).toContain(`to ${j.third.address}`);
  });
});

describe("the line a lapsed claim leaves behind", () => {
  it("counts one waiting worker in the singular", async () => {
    const j = await job();
    await j.as("holder", "take", 600);
    await j.as("third", "standby", 600);
    setNow(NOW + 600n);
    const one = await j.ok("get_claims", j.escrow);
    expect(one["waiting"]).toBe(1);
    expect(one["next"]).toMatch(/^1 worker stands by, so the job goes to them in line order; /);
  });
});

describe("the claims wallet_claim takes and drops", () => {
  it("takes for the longest claim, refuses a longer one, and lists a lapsed claim only when there is one", async () => {
    const j = await job();
    const free = await j.ok("wallet_claim", { ...j.escrow, action: "take", secs: 3600 });
    expect(free["summary"]).toHaveLength(2);
    expect(free["summary"][0]).toContain("3600 seconds from now");
    expect(await j.refused({ action: "take", secs: 3601 })).toMatchObject({ code: "InvalidInput", issues: [{ path: "secs", message: "this escrow allows at most 3600 seconds" }] });
    await j.as("holder", "take", 600);
    setNow(NOW + 600n);
    const lapsed = await j.ok("wallet_claim", { ...j.escrow, action: "take", secs: 60 });
    expect(lapsed["summary"]).toHaveLength(3);
    expect(lapsed["summary"][2]).toBe(`Ends: the lapsed claim of ${j.holder.address}, whose stake goes to the owner ${j.owner}`);
  });

  it("holds back only the wallet that dropped its claim", async () => {
    const j = await job();
    await j.as("holder", "take", 600);
    await j.as("holder", "drop");
    const other = await j.ok("wallet_claim", { ...j.escrow, action: "take", secs: 60 });
    expect(other["summary"]).toHaveLength(2);
    await j.sent({ action: "take", secs: 600 });
    await j.sent({ action: "drop" });
    expect(await j.refused({ action: "take", secs: 60 })).toMatchObject({ code: "ClaimCooldown" });
  });

  it("refuses a claim at the moment the escrow expires, once it is cancelled, and once it is released", async () => {
    const closed = "is no longer open, so its job cannot be claimed";
    const expired = await job();
    setNow(NOW + 3_600n);
    expect(await expired.refused({ action: "take", secs: 60 })).toMatchObject({ code: "InvalidTransition", hint: `escrow ${expired.intent} ${closed}` });
    const cancelled = await job();
    await cancelled.run(["cancel", "--keypair", "owner.json", "--nonce", "0", "--yes"]);
    expect(await cancelled.refused({ action: "take", secs: 60 })).toMatchObject({ code: "InvalidTransition", hint: `escrow ${cancelled.intent} ${closed}` });
    const released = await job();
    markFilled(released.intent);
    expect(await released.refused({ action: "take", secs: 60 })).toMatchObject({ code: "InvalidTransition", hint: `escrow ${released.intent} ${closed}` });
  });

  it("drops only a live claim of this wallet", async () => {
    const j = await job();
    await j.as("holder", "take", 600);
    const none = { code: "NotClaimant", hint: `this wallet ${j.wallet} holds no claim on escrow ${j.intent}` };
    expect(await j.refused({ action: "drop" })).toMatchObject(none);
    setNow(NOW + 600n);
    await j.sent({ action: "take", secs: 600 });
    setNow(NOW + 1_200n);
    expect((await call(j.client, "get_claims", j.escrow)).value).toMatchObject({ state: "lapsed", worker: j.wallet });
    expect(await j.refused({ action: "drop" })).toMatchObject(none);
  });
});

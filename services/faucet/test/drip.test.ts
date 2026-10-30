import { generateKeyPairSigner, type Address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM } from "../src/chain.js";
import { drip, REASONS } from "../src/drip.js";
import { CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS, DRIP_LAMPORTS, DRIP_WINDOW_SECS, FLOOR_LAMPORTS, FUNDED_LAMPORTS } from "../src/limits.js";
import { BAD_ADDRESS, NOT_JSON } from "../src/request.js";
import { harness, newFaucet, post, START_MS, type Faucet } from "./fake-node.js";

const SEND_METHODS = ["getLatestBlockhash", "sendTransaction"];
let faucet: Faucet;
let recipient: Address;
const nowSecs = Math.floor(START_MS / 1000);

beforeAll(async () => {
  faucet = await newFaucet();
  recipient = (await generateKeyPairSigner()).address;
});

function transferData(lamports: bigint): Uint8Array {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  return data;
}

const nothingSent = (methods: string[]) => expect(methods.filter((m) => SEND_METHODS.includes(m))).toEqual([]);

describe("200 sent and confirmed", () => {
  it("sends exactly 0.5 SOL from the faucet to the address and returns the signature", async () => {
    const h = harness(faucet);
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(200);
    expect(h.node.sent).toHaveLength(1);
    const sent = h.node.sent[0];
    expect(sent?.from).toBe(faucet.address);
    expect(sent?.to).toBe(recipient);
    expect(sent?.program).toBe(SYSTEM_PROGRAM);
    expect(sent?.data).toEqual(transferData(500000000n));
    expect(response.body).toEqual({ signature: sent?.signature, lamports: "500000000" });
    expect(DRIP_LAMPORTS).toBe(500000000n);
  });

  it("checks the genesis hash before it reads the key or sends", async () => {
    const h = harness(faucet);
    await drip(post(recipient), h.deps);
    const methods = h.node.methods();
    expect(methods[0]).toBe("getGenesisHash");
    expect(methods.indexOf("sendTransaction")).toBeGreaterThan(methods.indexOf("getGenesisHash"));
  });

  it("answers only after the node reports the transfer confirmed", async () => {
    const h = harness(faucet);
    h.node.statuses = (polls) => (polls < 3 ? null : polls < 4 ? { confirmationStatus: "processed" } : { confirmationStatus: "confirmed" });
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(200);
    expect(h.node.polls).toBe(4);
    expect(h.clock.slept).toEqual([CONFIRM_POLL_MS, CONFIRM_POLL_MS, CONFIRM_POLL_MS]);
  });

  it("accepts finalized as confirmed", async () => {
    const h = harness(faucet);
    h.node.statuses = () => ({ confirmationStatus: "finalized" });
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
  });
});

describe("405 any method other than POST", () => {
  for (const method of ["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", undefined]) {
    it(`refuses ${method ?? "a missing method"} without touching the node`, async () => {
      const h = harness(faucet);
      const response = await drip({ method, headers: {}, body: JSON.stringify({ address: recipient }) }, h.deps);
      expect(response.status).toBe(405);
      expect(response.body).toEqual({ error: REASONS.method });
      expect(response.headers).toEqual({ allow: "POST" });
      expect(h.node.calls).toEqual([]);
    });
  }
});

describe("400 missing or malformed address, or a body that is not that JSON", () => {
  const notJson = [undefined, "", "   ", "{", "address=abc", "[]", "null", "42", '"text"', '{"address": "x", "extra": 1}', '{"wallet": "abc"}'];
  for (const body of notJson) {
    it(`refuses body ${JSON.stringify(body)}`, async () => {
      const h = harness(faucet);
      const response = await drip({ method: "POST", headers: {}, body }, h.deps);
      expect(response).toEqual({ status: 400, body: { error: NOT_JSON } });
      expect(h.node.calls).toEqual([]);
    });
  }
  const malformed = [null, 7, "", "abc", "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl", "1111111111111111111111111111111111111111111111", ["x"]];
  for (const address of malformed) {
    it(`refuses address ${JSON.stringify(address)}`, async () => {
      const h = harness(faucet);
      const response = await drip(post(address), h.deps);
      expect(response).toEqual({ status: 400, body: { error: BAD_ADDRESS } });
      expect(h.node.calls).toEqual([]);
    });
  }
  it("refuses an empty object as a missing address", async () => {
    const h = harness(faucet);
    expect(await drip({ method: "POST", headers: {}, body: "{}" }, h.deps)).toEqual({ status: 400, body: { error: BAD_ADDRESS } });
  });
});

describe("429 the address is over its limit", () => {
  it("refuses an address that holds 0.25 SOL and sends nothing", async () => {
    const h = harness(faucet);
    h.node.balances.set(recipient, FUNDED_LAMPORTS);
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error: REASONS.funded, retry_after: DRIP_WINDOW_SECS });
    nothingSent(h.node.methods());
  });

  it("drips to an address one lamport below 0.25 SOL", async () => {
    const h = harness(faucet);
    h.node.balances.set(recipient, FUNDED_LAMPORTS - 1n);
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
  });

  it("finds a drip from this faucet on chain within the window, in a fresh instance", async () => {
    const h = harness(faucet);
    h.node.listed.set(recipient, [
      { signature: "other1", blockTime: nowSecs - 60 },
      { signature: "drip1", blockTime: nowSecs - 3600 },
    ]);
    h.node.landed.set("other1", { feePayer: recipient });
    h.node.landed.set("drip1", { feePayer: faucet.address });
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error: REASONS.recent, retry_after: DRIP_WINDOW_SECS - 3600 });
    expect(response.headers).toEqual({ "retry-after": String(DRIP_WINDOW_SECS - 3600) });
    nothingSent(h.node.methods());
  });

  it("finds an earlier drip on a later page of signatures", async () => {
    const h = harness(faucet);
    const page = Array.from({ length: 100 }, (_, i) => ({ signature: `noise${i}`, blockTime: nowSecs - 10, err: { fail: i } }));
    h.node.listed.set(recipient, [...page, { signature: "drip2", blockTime: nowSecs - 20 }]);
    h.node.landed.set("drip2", { feePayer: faucet.address });
    expect((await drip(post(recipient), h.deps)).status).toBe(429);
    expect(h.node.methods().filter((m) => m === "getSignaturesForAddress")).toHaveLength(2);
  });

  it("treats a drip without a block time as recent", async () => {
    const h = harness(faucet);
    h.node.listed.set(recipient, [{ signature: "drip3", blockTime: null }]);
    h.node.landed.set("drip3", { feePayer: faucet.address });
    expect(await drip(post(recipient), h.deps)).toMatchObject({ status: 429, body: { retry_after: DRIP_WINDOW_SECS } });
  });

  it("drips again once the earlier drip is older than the window", async () => {
    const h = harness(faucet);
    h.node.listed.set(recipient, [{ signature: "old", blockTime: nowSecs - DRIP_WINDOW_SECS }]);
    h.node.landed.set("old", { feePayer: faucet.address });
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
    expect(h.node.methods()).not.toContain("getTransaction");
  });

  it("ignores a failed faucet transaction and transactions paid by others", async () => {
    const h = harness(faucet);
    h.node.listed.set(recipient, [
      { signature: "failedListed", blockTime: nowSecs - 5, err: { InstructionError: [0, "Custom"] } },
      { signature: "failedMeta", blockTime: nowSecs - 6 },
      { signature: "theirs", blockTime: nowSecs - 7 },
    ]);
    h.node.landed.set("failedListed", { feePayer: faucet.address });
    h.node.landed.set("failedMeta", { feePayer: faucet.address, err: { InstructionError: [0, "Custom"] } });
    h.node.landed.set("theirs", { feePayer: recipient });
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
  });

  it("refuses an address with too much recent activity to check", async () => {
    const h = harness(faucet);
    const listed = Array.from({ length: 250 }, (_, i) => ({ signature: `busy${i}`, blockTime: nowSecs - 1 }));
    h.node.listed.set(recipient, listed);
    for (const entry of listed) h.node.landed.set(entry.signature, { feePayer: recipient });
    const response = await drip(post(recipient), h.deps);
    expect(response).toMatchObject({ status: 429, body: { error: REASONS.busy, retry_after: DRIP_WINDOW_SECS } });
    nothingSent(h.node.methods());
  });

  it("answers 503 when a listed transaction cannot be read", async () => {
    const h = harness(faucet);
    h.node.listed.set(recipient, [{ signature: "missing", blockTime: nowSecs - 1 }]);
    h.node.landed.set("missing", null);
    expect(await drip(post(recipient), h.deps)).toEqual({ status: 503, body: { error: REASONS.node } });
    nothingSent(h.node.methods());
  });
});

describe("503 wrong cluster", () => {
  for (const genesis of ["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY", ""]) {
    it(`sends nothing and never reads the key on genesis ${genesis || "empty"}`, async () => {
      const h = harness(faucet);
      h.node.genesis = genesis;
      const response = await drip(post(recipient), h.deps);
      expect(response).toEqual({ status: 503, body: { error: REASONS.cluster } });
      expect(h.node.methods()).toEqual(["getGenesisHash"]);
      expect(h.secretReads).toBe(0);
      expect(h.node.sent).toEqual([]);
    });
  }
});

describe("503 the faucet holds too little", () => {
  it("sends nothing one lamport below 2 SOL plus the drip", async () => {
    const h = harness(faucet);
    h.node.balances.set(faucet.address, FLOOR_LAMPORTS - 1n);
    expect(await drip(post(recipient), h.deps)).toEqual({ status: 503, body: { error: REASONS.floor } });
    nothingSent(h.node.methods());
    expect(FLOOR_LAMPORTS).toBe(2_500_000_000n);
  });

  it("sends at exactly 2 SOL plus the drip", async () => {
    const h = harness(faucet);
    h.node.balances.set(faucet.address, FLOOR_LAMPORTS);
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
  });
});

describe("503 the node fails", () => {
  for (const method of ["getGenesisHash", "getBalance", "getSignaturesForAddress", "getTransaction", "getLatestBlockhash"]) {
    it(`answers 503 and sends nothing when ${method} fails`, async () => {
      const h = harness(faucet);
      h.node.listed.set(recipient, [{ signature: "seen", blockTime: nowSecs - 1 }]);
      h.node.landed.set("seen", { feePayer: recipient });
      h.node.failing.add(method);
      expect(await drip(post(recipient), h.deps)).toEqual({ status: 503, body: { error: REASONS.node } });
      expect(h.node.sent).toEqual([]);
    });
  }

  it("names the signature when the send fails", async () => {
    const h = harness(faucet);
    h.node.failing.add("sendTransaction");
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(503);
    const error = (response.body as { error: string }).error;
    const signature = error.split(" ")[2] ?? "";
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(error).toBe(`The transfer ${signature} failed, so no SOL arrived and you can try again in a minute.`);
  });

  it("names the signature when the transfer lands with an error", async () => {
    const h = harness(faucet);
    h.node.statuses = () => ({ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } });
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(503);
    expect((response.body as { error: string }).error).toContain(h.node.sent[0]?.signature);
  });

  it("gives up after the confirm timeout and names the signature", async () => {
    const h = harness(faucet);
    h.node.statuses = () => null;
    const response = await drip(post(recipient), h.deps);
    const signature = h.node.sent[0]?.signature ?? "";
    expect(response).toEqual({
      status: 503,
      body: { error: `The transfer ${signature} did not confirm within 30 seconds, so check it in a devnet explorer before you ask again.` },
    });
    expect(h.clock.at - START_MS).toBe(CONFIRM_TIMEOUT_MS);
    expect(CONFIRM_TIMEOUT_MS).toBe(30000);
  });

  it("keeps polling through status errors until the timeout", async () => {
    const h = harness(faucet);
    h.node.failing.add("getSignatureStatuses");
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(503);
    expect((response.body as { error: string }).error).toContain("did not confirm");
    expect(h.clock.at - START_MS).toBe(CONFIRM_TIMEOUT_MS);
  });

  it("confirms on the last poll inside the timeout", async () => {
    const h = harness(faucet);
    const polls = CONFIRM_TIMEOUT_MS / CONFIRM_POLL_MS;
    h.node.statuses = (n) => (n < polls ? null : { confirmationStatus: "confirmed" });
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
  });
});

describe("503 the faucet key is missing or malformed", () => {
  for (const secret of [undefined, "", "not json", "[1,2,3]", JSON.stringify(Array(64).fill(256)), JSON.stringify(Array(64).fill(1.5)), JSON.stringify(Array(64).fill(7))]) {
    it(`sends nothing for secret ${JSON.stringify(secret)?.slice(0, 20)}`, async () => {
      const h = harness(faucet, { secret });
      expect(await drip(post(recipient), h.deps)).toEqual({ status: 503, body: { error: REASONS.config } });
      nothingSent(h.node.methods());
    });
  }
});

describe("every error reason is one plain sentence", () => {
  it("starts with a capital, ends with a full stop and holds no second sentence", () => {
    const reasons = [...Object.values(REASONS), NOT_JSON, BAD_ADDRESS];
    for (const reason of reasons) {
      expect(reason).toMatch(/^[A-Z][^\n]*\.$/);
      expect(reason.slice(0, -1)).not.toMatch(/[.!?]\s/);
    }
  });
});

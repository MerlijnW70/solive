import type { Address, Blockhash, Signature } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { isTransactionSignature, type Transport } from "@intent-engine/client";
import { type RpcLike, rpcTransport } from "@intent-engine/client/internal";
import { testSignature } from "@intent-engine/client/testing";
import { tool } from "../src/agent/names.js";
import type { Problem } from "../src/agent/problems.js";
import { sourceOf } from "../src/agent/untrusted-fields.js";
import { connect, fresh } from "./agent-wallet-kit.js";
import { approved } from "./approved.js";
import { h, NOW, transport } from "./harness.js";
import { CANARY, carrying, HOSTILE, heldTo, refusalHeld, served } from "./untrusted-kit.js";

type Place = "listed" | "read back" | "sent";

const LISTED = testSignature("listed by the node");

const FROM_NODE = ["engineTransactions", "signaturesOf", "transactionsOf", "transactionOf", "signatureStatuses", "sendStatus", "send", "sendWire", "submitWire", "airdrop"] as const;

function hostileNode(place: Place): RpcLike {
  const listed = place === "listed" ? HOSTILE : LISTED;
  return {
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: h.svm.latestBlockhash() as Blockhash, lastValidBlockHeight: 1_000n } }) }),
    sendTransaction: () => ({ send: async () => (place === "sent" ? HOSTILE : LISTED) }),
    requestAirdrop: () => ({ send: async () => (place === "sent" ? HOSTILE : LISTED) }),
    getSignatureStatuses: (signatures: readonly Signature[]) => ({ send: async () => ({ context: { slot: 1n }, value: signatures.map(() => null) }) }),
    getEpochInfo: () => ({ send: async () => ({ blockHeight: 0n, absoluteSlot: 0n }) }),
    getSignaturesForAddress: () => ({ send: async () => (place === "sent" ? [] : [{ signature: listed, slot: 9n, blockTime: NOW, err: null, memo: null }]) }),
    getTransaction: () => ({
      send: async () => ({ slot: 9n, blockTime: NOW, transaction: { signatures: [HOSTILE], message: { accountKeys: [], instructions: [] } }, meta: { err: null } }),
    }),
  } as unknown as RpcLike;
}

function through(place: Place): Transport {
  const node = rpcTransport(hostileNode(place), async () => undefined);
  return { ...transport, ...Object.fromEntries(FROM_NODE.map((name) => [name, node[name]])) };
}

async function hostile(place: Place): Promise<Client> {
  h.through = through(place);
  return connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
}

function checked(name: string, value: unknown, path = "", out: [string, unknown][] = []): [string, unknown][] {
  const source = sourceOf(name, path);
  if (typeof source === "object" && source.rule === "checked") {
    out.push([path, value]);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      checked(name, item, `${path}[]`, out);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      checked(name, item, path === "" ? key : `${path}.${key}`, out);
    }
  }
  return out;
}

async function shownWithout(client: Client, name: string, args: object = {}) {
  const shown = await served(client, name, args);
  expect(carrying(shown.value, CANARY), `${name} ${JSON.stringify(shown.value)}`).toEqual([]);
  expect(heldTo(tool(name), shown.value)).toEqual([]);
  if (shown.error) {
    expect(refusalHeld(shown.value as unknown as Problem)).toEqual([]);
  }
  for (const [path, value] of checked(tool(name), shown.value)) {
    expect(value === null || isTransactionSignature(value), `${name} ${path}`).toBe(true);
  }
  return shown;
}

async function escrowed(client: Client, hint: string) {
  const wallet = (await served(client, "wallet_setup")).value["address"] as Address;
  h.watched.push(wallet);
  h.engineLog = [];
  const escrow = await served(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: hint.repeat(32) }));
  expect(escrow.error, JSON.stringify(escrow.value)).toBe(false);
  return { wallet, nonce: escrow.value["nonce"] as string, signature: escrow.value["signature"] };
}

afterEach(() => {
  h.through = null;
  h.engineLog = [];
});

describe("transaction signatures the RPC node reports, through the wallet server", () => {
  it("a listed signature that is not one fails each read that lists, and no tool shows its text", async () => {
    const { wallet, nonce } = await escrowed(await fresh(), "a1");
    const client = await hostile("listed");
    const history = await shownWithout(client, "wallet_history");
    expect(history.value).toMatchObject({ code: "Failed" });
    expect(String(history.value["untrustedDetail"])).toContain("answered getSignaturesForAddress with a value that is not a transaction signature");
    for (const [name, args] of [
      ["wallet_receipt", { nonce }],
      ["get_receipt", { owner: wallet, nonce }],
      ["wallet_estimate", { sell: "SOL", buy: "TEST", amount: "0.05" }],
      ["find_jobs", {}],
      ["wallet_intents", {}],
    ] as const) {
      const shown = await shownWithout(client, name, args);
      expect(shown.value["complete"], name).not.toBe(true);
    }
  });

  it("a transaction read back under another signature stays unread, so a named release is never taken from it", async () => {
    const { nonce } = await escrowed(await fresh(), "b2");
    const client = await hostile("read back");
    const named = await shownWithout(client, "wallet_receipt", { nonce, release: LISTED });
    expect(named.value).toMatchObject({ code: "ReleaseUnread" });
    const scanned = await shownWithout(client, "wallet_receipt", { nonce });
    expect(scanned.value).toMatchObject({ released: false, complete: false });
    await shownWithout(client, "wallet_history");
  });

  it("a send the node answers with a non-signature is refused as maybe sent, under the transaction's own signature", async () => {
    const owner = await fresh();
    const { wallet } = await escrowed(owner, "c3");
    const client = await hostile("sent");
    const sent = await shownWithout(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: "c4".repeat(32) }));
    expect(sent.value).toMatchObject({ code: "MaybeSent" });
    expect(isTransactionSignature(sent.value["signature"])).toBe(true);
    expect(String(sent.value["hint"])).toContain(String(sent.value["signature"]));
  });

  it("an airdrop the node answers with a non-signature counts as refused, and setup shows no signature from it", async () => {
    await fresh();
    const client = await hostile("sent");
    const setup = await shownWithout(client, "wallet_setup");
    expect(setup.error).toBe(false);
    expect(setup.value).not.toHaveProperty("airdrop");
  });

  it("every field the inventory files as checked holds a transaction signature from an honest node", async () => {
    const client = await fresh();
    const { wallet, nonce, signature } = await escrowed(client, "d4");
    expect(isTransactionSignature(signature)).toBe(true);
    for (const [name, args] of [
      ["wallet_history", {}],
      ["wallet_receipt", { nonce }],
      ["get_receipt", { owner: wallet, nonce }],
      ["wallet_intents", {}],
    ] as const) {
      expect((await shownWithout(client, name, args)).error, name).toBe(false);
    }
  });
});

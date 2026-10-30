import { createHash } from "node:crypto";
import { type Address, getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { type DeliveryOpener } from "@intent-engine/core";
import { seal, specMemo } from "@intent-engine/core/internal";
import type { AccountView, Transport } from "../src/index.js";
import { FetchFailed } from "../src/fetch-failed.js";
import { MAINNET_GENESIS_HASH, MAX_SPEC_BYTES, plainHttpOnPublic, readSpec, SPEC_FETCH_FAILED, SPEC_REDIRECTS, type SpecFetch, SpecSealed, SpecUnreadable, specUrlOf } from "../src/job-specs.js";
import { testWallet } from "../src/testing.js";
import { createdEvent, engineView, intentBytes, key, OWNER, proofIntent, tx } from "./kill-client-jobs-ledger-kit.js";

const INTENT = key(81);
const OTHER = key(82);
const STRANGER = key(83);
const URL_TEXT = "https://" + "example.org/spec.md";
const PRIVATE_GENESIS = getBase58Decoder().decode(new Uint8Array(32).fill(7));
const sha = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

type Chain = { account?: AccountView | null; emitted?: Uint8Array[]; signer?: Address; genesis?: string; reads?: Address[] };

function chain({ account = null, emitted = [createdEvent(INTENT, OWNER)], signer = OWNER, genesis = PRIVATE_GENESIS, reads }: Chain): Transport {
  return {
    getAccount: async (address: Address) => {
      if (reads === undefined) {
        throw new Error(`the intent account ${address} was read`);
      }
      reads.push(address);
      return address === INTENT ? account : null;
    },
    engineTransactions: async () => [tx("made", { emitted, memos: [specMemo(URL_TEXT)], memoSigners: [[signer]] })],
    genesisHash: async () => genesis,
  } as unknown as Transport;
}

describe("a plain http spec url on a public cluster", () => {
  it("is never a text that is not a url, and is a plain http url on mainnet", async () => {
    const mainnet = chain({ genesis: MAINNET_GENESIS_HASH });
    expect(await plainHttpOnPublic(mainnet, "not a url")).toBe(false);
    expect(await plainHttpOnPublic(mainnet, "http://" + "example.org/spec.md")).toBe(true);
  });
});

describe("the spec url an intent was created with", () => {
  it("takes the creator from the IntentCreated event for that intent when the account is gone", async () => {
    const transport = chain({ emitted: [createdEvent(OTHER, STRANGER), createdEvent(INTENT, OWNER)], reads: [] });
    expect(await specUrlOf(transport, INTENT, 0n)).toBe(URL_TEXT);
  });

  it("reads no account when the creation time and the owner are given", async () => {
    expect(await specUrlOf(chain({}), INTENT, 0n, OWNER)).toBe(URL_TEXT);
  });

  it("trusts the owner the intent account holds over the one in the event, when only the creation time is given", async () => {
    const reads: Address[] = [];
    const transport = chain({ account: engineView(intentBytes(proofIntent())), emitted: [createdEvent(INTENT, STRANGER)], reads });
    expect(await specUrlOf(transport, INTENT, 0n)).toBe(URL_TEXT);
    expect(reads).toStrictEqual([INTENT]);
  });
});

function served(body: Uint8Array | string, headers: Record<string, string> = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const transport = chain({ account: engineView(intentBytes(proofIntent({}, { specHash: sha(bytes) }))), reads: [] });
  const get: SpecFetch = async () => new Response(Uint8Array.from(bytes), { headers });
  return { transport, get };
}

const read = async ({ transport, get }: { transport: Transport; get: SpecFetch }, keypair?: DeliveryOpener | readonly DeliveryOpener[]) => readSpec(transport, get, INTENT, keypair, null);

const failing = (error: unknown) => {
  const { transport } = served("spec");
  const get: SpecFetch = async () => {
    throw error;
  };
  return { transport, get };
};

const refusal = async (spec: Promise<unknown>) => {
  const error = await spec.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  return error instanceof SpecUnreadable ? error.message : error;
};

describe("a spec read over http", () => {
  it("reads a spec whose declared size is the limit, and refuses one declared above it", async () => {
    expect((await read(served("small", { "content-length": String(MAX_SPEC_BYTES) })))?.text).toBe("small");
    expect(await refusal(read(served("small", { "content-length": String(MAX_SPEC_BYTES + 1) })))).toBe(`the spec at ${URL_TEXT} is larger than ${MAX_SPEC_BYTES} bytes`);
  });

  it("reads a spec of exactly the limit, and refuses one a byte longer", async () => {
    const full = await read(served(new Uint8Array(MAX_SPEC_BYTES).fill(0x61)));
    expect([full?.bytes.length, full?.matches]).toStrictEqual([MAX_SPEC_BYTES, true]);
    expect(await refusal(read(served(new Uint8Array(MAX_SPEC_BYTES + 1).fill(0x61))))).toBe(`the spec at ${URL_TEXT} is larger than ${MAX_SPEC_BYTES} bytes`);
  });

  it("names a redirect as a redirect, and any other failed fetch with its reason", async () => {
    expect(await refusal(read(failing(new FetchFailed(URL_TEXT, "redirect", "moved"))))).toBe(`the spec at ${URL_TEXT} ${SPEC_REDIRECTS}`);
    expect(await refusal(read(failing(new FetchFailed(URL_TEXT, "network", "reset"))))).toBe(`the spec at ${URL_TEXT} ${SPEC_FETCH_FAILED} (fetch failed: reset)`);
  });

  it("names an error with its cause, and one without a cause by its message alone", async () => {
    expect(await refusal(read(failing(new Error("boom"))))).toBe(`the spec at ${URL_TEXT} ${SPEC_FETCH_FAILED} (boom)`);
    expect(await refusal(read(failing(new Error("boom", { cause: new Error("deep") }))))).toBe(`the spec at ${URL_TEXT} ${SPEC_FETCH_FAILED} (boom: deep)`);
  });

  it("keeps a byte order mark at the start of the text", async () => {
    const spec = await read(served("﻿spec"));
    expect([spec?.text, spec?.matches]).toStrictEqual(["﻿spec", true]);
  });
});

describe("a sealed spec read over http", () => {
  it("asks for an invited key when none is given, or an empty list, and says when the given key is not invited", async () => {
    const [worker, outsider] = [await testWallet(), await testWallet()];
    const sealed = await seal(new TextEncoder().encode("sealed spec"), [worker.address]);
    const outcome = async (keypair?: DeliveryOpener | readonly DeliveryOpener[]) => {
      const error = await read(served(sealed), keypair).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      return error instanceof SpecSealed ? { keyed: error.keyed, to: error.to } : error;
    };
    expect(await outcome()).toStrictEqual({ keyed: false, to: [worker.address] });
    expect(await outcome([])).toStrictEqual({ keyed: false, to: [worker.address] });
    expect(await outcome([outsider.keypair])).toStrictEqual({ keyed: true, to: [worker.address] });
    expect((await read(served(sealed), [worker.keypair]))?.text).toBe("sealed spec");
  });
});

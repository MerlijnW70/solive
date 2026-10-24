import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, type KeyPairSigner, type MessagePartialSigner, type TransactionPartialSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  attestedResult,
  type AttestedResultParams,
  dutchAuction,
  type DutchAuctionParams,
  encodeParams,
  type IntentParams,
  Kind,
  limitOrder,
  type LimitOrderParams,
  swapExactIn,
  type SwapExactInParams,
} from "@intent-engine/core";
import {
  type AnnounceInput,
  type CancelInput,
  type ClusterChoice,
  clusterUrl,
  connect,
  type ConnectOptions,
  type CreateIntentInput,
  type DeliveredWork,
  type DeliverSend,
  type DeviceSigner,
  InvalidInput,
  isSaltSigner,
  NoMessageSigner,
  type Outcome,
  type Preview,
  type RefuteInput,
  RELEASE_NEEDS_KEY_PAIR,
  type ReleaseSend,
  secretInputOf,
  type Sent,
  type SignerCannot,
  type SimpleClient,
} from "../src/index.js";
import { clientRoot, returnFindings } from "./exported-surface.js";
import { world } from "./svm.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const same = <A, B>(holds: Equal<A, B>): boolean => holds;

const HERE = dirname(fileURLToPath(import.meta.url));
const SHA = "ab".repeat(32);
const WORK_URL = "https://" + "example.org/work.tar";
const swap = { sell: "SOL", amount: "0.05", buy: "TEST", minReceive: "5" };
const limit = { sell: "SOL", amount: "0.05", buy: "TEST", price: "200" };

export function outcomes(flag: boolean): boolean[] {
  return [
    same<Outcome<{ preview: true }>, Preview>(true),
    same<Outcome<{ preview: false }>, Sent>(true),
    same<Outcome<{ escrow: Address }>, Sent>(true),
    same<Outcome<{ preview: boolean }>, Preview | Sent>(true),
    same<Outcome<{ preview?: boolean }>, Preview | Sent>(true),
    same<Outcome<{ preview: boolean }, DeliveredWork>, Preview | DeliveredWork>(true),
    same<Outcome<{ preview: typeof flag }>, Preview | Sent>(true),
  ];
}

export async function previews(solive: SimpleClient<KeyPairSigner>, flag: boolean, escrow: Address, judge: Address): Promise<boolean[]> {
  const pay = { amount: "0.01", judge, specHash: SHA };
  const release = { escrow, deliveredSha256: SHA };
  const deliver = { escrow, sha256: SHA, url: WORK_URL };
  const r0 = await solive.swap(swap);
  const r1 = await solive.swap({ ...swap, preview: true });
  const r2 = await solive.swap({ ...swap, preview: false });
  const r3 = await solive.swap({ ...swap, preview: flag });
  const r4 = await solive.limit(limit);
  const r5 = await solive.limit({ ...limit, preview: true });
  const r6 = await solive.limit({ ...limit, preview: flag });
  const r7 = await solive.payForWork(pay);
  const r8 = await solive.payForWork({ ...pay, preview: true });
  const r9 = await solive.payForWork({ ...pay, preview: flag });
  const r10 = await solive.release(release);
  const r11 = await solive.release({ ...release, preview: true });
  const r12 = await solive.release({ ...release, preview: flag });
  const r13 = await solive.cancel({ escrow });
  const r14 = await solive.cancel({ intent: escrow, preview: true });
  const r15 = await solive.cancel({ escrow, preview: flag });
  const r16 = await solive.deliver(deliver);
  const r17 = await solive.deliver({ ...deliver, preview: false });
  const r18 = await solive.deliver({ ...deliver, preview: true });
  const r19 = await solive.deliver({ ...deliver, preview: flag });
  return [
    same<typeof r0, Sent>(true),
    same<typeof r1, Preview>(true),
    same<typeof r2, Sent>(true),
    same<typeof r3, Preview | Sent>(true),
    same<typeof r4, Sent>(true),
    same<typeof r5, Preview>(true),
    same<typeof r6, Preview | Sent>(true),
    same<typeof r7, Sent>(true),
    same<typeof r8, Preview>(true),
    same<typeof r9, Preview | Sent>(true),
    same<typeof r10, Sent>(true),
    same<typeof r11, Preview>(true),
    same<typeof r12, Preview | Sent>(true),
    same<typeof r13, Sent>(true),
    same<typeof r14, Preview>(true),
    same<typeof r15, Preview | Sent>(true),
    same<typeof r16, DeliveredWork>(true),
    same<typeof r17, DeliveredWork>(true),
    same<typeof r18, Preview>(true),
    same<typeof r19, Preview | DeliveredWork>(true),
  ];
}

export function constructors(attestor: Address): boolean[] {
  const made = {
    swap: swapExactIn({ amountIn: 1n, minOut: 1n }),
    limit: limitOrder({ makeAmount: 1n, takeAmount: 1n }),
    auction: dutchAuction({ amountIn: 1n, startOut: 2n, endOut: 1n, startTs: 0n, endTs: 1n }),
    proof: attestedResult({ amountIn: 1n, minResult: 1n, maxResult: 1n, attestor, specHash: new Uint8Array(32), judgeFee: 0n }),
  };
  return [
    same<typeof made.swap, SwapExactInParams>(true),
    same<typeof made.limit, LimitOrderParams>(true),
    same<typeof made.auction, DutchAuctionParams>(true),
    same<typeof made.proof, AttestedResultParams>(true),
  ];
}

type Accepts<T, V> = [V] extends [T] ? true : false;

const refuses = <T, V>(refused: Accepts<T, V> extends false ? true : false): boolean => refused;

type Work = { intent: Address; sha256: string; url: string };
type Refuting = { earlier: Address; paid: Address; sha256: string; url: string };
type Order = { signer: KeyPairSigner; inputMint: Address; outputMint: Address };

export function refusedInputs(): boolean[] {
  return [
    refuses<ConnectOptions<KeyPairSigner>, { cluster: "devnet"; url: string; signer: KeyPairSigner }>(true),
    refuses<ConnectOptions<KeyPairSigner>, { signer: KeyPairSigner }>(true),
    refuses<ClusterChoice, { cluster: "devnet"; url: string }>(true),
    refuses<ClusterChoice, {}>(true),
    refuses<Parameters<typeof clusterUrl>[0], { cluster: "devnet"; url: string }>(true),
    refuses<CancelInput, { escrow: Address; intent: Address }>(true),
    refuses<CancelInput, {}>(true),
    refuses<AnnounceInput, Work & { worker: TransactionPartialSigner }>(true),
    refuses<AnnounceInput, Work & { worker: DeviceSigner }>(true),
    refuses<RefuteInput, Refuting & { worker: TransactionPartialSigner }>(true),
    refuses<RefuteInput, Refuting & { worker: DeviceSigner }>(true),
    refuses<CreateIntentInput, Order & { params: SwapExactInParams; specUrl: string }>(true),
    refuses<CreateIntentInput, Order & { params: LimitOrderParams; specUrl: string }>(true),
    refuses<CreateIntentInput, Order & { params: DutchAuctionParams; specUrl: string }>(true),
    same<SimpleClient<TransactionPartialSigner>["release"], SignerCannot>(true),
    same<SimpleClient<TransactionPartialSigner>["deliver"], SignerCannot>(true),
    same<SimpleClient<DeviceSigner>["deliver"], SignerCannot>(true),
    same<SimpleClient["release"], SignerCannot>(true),
  ];
}

export function acceptedInputs(): boolean[] {
  return [
    same<Accepts<ConnectOptions<KeyPairSigner>, { cluster: "devnet"; signer: KeyPairSigner }>, true>(true),
    same<Accepts<ConnectOptions<KeyPairSigner>, { url: string; signer: KeyPairSigner }>, true>(true),
    same<Accepts<CancelInput, { escrow: Address }>, true>(true),
    same<Accepts<CancelInput, { intent: Address; preview: true }>, true>(true),
    same<Accepts<AnnounceInput, Work & { worker: KeyPairSigner }>, true>(true),
    same<Accepts<AnnounceInput, Work & { worker: TransactionPartialSigner; secret: Uint8Array }>, true>(true),
    same<Accepts<AnnounceInput, Work & { worker: DeviceSigner; saltSignature: Uint8Array }>, true>(true),
    same<Accepts<AnnounceInput, Work & { worker: TransactionPartialSigner; secret: Uint8Array; saltSignature: Uint8Array }>, true>(true),
    same<Accepts<RefuteInput, Refuting & { worker: TransactionPartialSigner; secret: Uint8Array }>, true>(true),
    same<Accepts<RefuteInput, Refuting & { worker: KeyPairSigner }>, true>(true),
    same<Accepts<AnnounceInput, Work & { worker: TransactionPartialSigner & MessagePartialSigner }>, true>(true),
    same<Accepts<CreateIntentInput, Order & { params: AttestedResultParams; specUrl: string }>, true>(true),
    same<Accepts<CreateIntentInput, Order & { params: IntentParams }>, true>(true),
    same<SimpleClient<KeyPairSigner>["release"], ReleaseSend>(true),
    same<SimpleClient<DeviceSigner>["release"], ReleaseSend>(true),
    same<SimpleClient<KeyPairSigner>["deliver"], DeliverSend>(true),
  ];
}

const transactionOnly = (signer: KeyPairSigner): TransactionPartialSigner => ({ address: signer.address, signTransactions: (txs) => signer.signTransactions(txs) });

const asDevice = (signer: KeyPairSigner): DeviceSigner => ({
  address: signer.address,
  device: "usb://ledger",
  signTransactions: (txs) => signer.signTransactions(txs),
  signMessages: (messages) => signer.signMessages(messages),
});

describe("the params constructors", () => {
  it("tag each kind's fields with its kind and encode as the literal params do", async () => {
    const attestor = (await generateKeyPairSigner()).address;
    const specHash = new Uint8Array(32).fill(7);
    const pairs = [
      [swapExactIn({ amountIn: 5n, minOut: 3n }), { kind: Kind.SwapExactIn, amountIn: 5n, minOut: 3n }],
      [limitOrder({ makeAmount: 5n, takeAmount: 3n }), { kind: Kind.LimitOrder, makeAmount: 5n, takeAmount: 3n }],
      [
        dutchAuction({ amountIn: 5n, startOut: 9n, endOut: 3n, startTs: 10n, endTs: 20n }),
        { kind: Kind.DutchAuction, amountIn: 5n, startOut: 9n, endOut: 3n, startTs: 10n, endTs: 20n },
      ],
      [
        attestedResult({ amountIn: 5n, minResult: 1n, maxResult: 2n, attestor, specHash, judgeFee: 1n }),
        { kind: Kind.AttestedResult, amountIn: 5n, minResult: 1n, maxResult: 2n, attestor, specHash, judgeFee: 1n },
      ],
    ] as const;
    for (const [made, literal] of pairs) {
      expect(made).toEqual(literal);
      expect(encodeParams(made)).toEqual(encodeParams(literal));
    }
  });

  it("keep only the kind's own fields", () => {
    const extra = { amountIn: 5n, minOut: 3n, takeAmount: 9n };
    expect(swapExactIn(extra)).toEqual({ kind: Kind.SwapExactIn, amountIn: 5n, minOut: 3n });
  });
});

describe("the runtime checks behind the stricter input types", () => {
  it("still refuse a cluster and a url together, or neither", () => {
    expect(() => clusterUrl({ cluster: "devnet", url: WORK_URL } as unknown as Parameters<typeof clusterUrl>[0])).toThrow(InvalidInput);
    expect(() => clusterUrl({} as unknown as Parameters<typeof clusterUrl>[0])).toThrow(InvalidInput);
  });

  it("build a secret input only from a secret, a salt signature or a signer that signs messages and is no device", async () => {
    const keyed = await generateKeyPairSigner();
    const plain = transactionOnly(keyed);
    const device = asDevice(keyed);
    const secret = new Uint8Array(32).fill(1);
    const saltSignature = new Uint8Array(64).fill(2);
    expect(isSaltSigner(keyed)).toBe(true);
    expect(isSaltSigner(plain)).toBe(false);
    expect(isSaltSigner(device)).toBe(false);
    expect(secretInputOf(keyed)).toEqual({ worker: keyed });
    expect(secretInputOf(plain, { secret })).toEqual({ worker: plain, secret, saltSignature: undefined });
    expect(secretInputOf(device, { saltSignature })).toEqual({ worker: device, saltSignature });
    expect(() => secretInputOf(plain)).toThrow(NoMessageSigner);
    expect(() => secretInputOf(device, {})).toThrow(NoMessageSigner);
  });

  it("still refuse release and deliver for a signer that cannot sign what they need", async () => {
    const w = await world();
    const keyed = await generateKeyPairSigner();
    const plain = await connect({ cluster: "devnet", signer: transactionOnly(keyed), transport: w.chain.transport });
    const device = await connect({ cluster: "devnet", signer: asDevice(keyed), transport: w.chain.transport });
    const escrow = (await generateKeyPairSigner()).address;
    const loose = plain as unknown as SimpleClient<KeyPairSigner>;
    const looseDevice = device as unknown as SimpleClient<KeyPairSigner>;
    await expect(loose.release({ escrow, deliveredSha256: SHA })).rejects.toThrow(RELEASE_NEEDS_KEY_PAIR);
    await expect(loose.deliver({ escrow, sha256: SHA, url: WORK_URL })).rejects.toThrow(NoMessageSigner);
    await expect(looseDevice.deliver({ escrow, sha256: SHA, url: WORK_URL, preview: true })).rejects.toThrow(NoMessageSigner);
  });
});

describe("the client root's return types", () => {
  it("are named and exported for every function, method and class it exports", () => {
    const { entry, packages } = clientRoot(HERE);
    expect(returnFindings(entry, packages)).toEqual([]);
  });

  it("are reported when missing, anonymous or not exported", () => {
    const root = mkdtempSync(join(tmpdir(), "return-types-"));
    try {
      writeFileSync(join(root, "index.ts"), 'export * from "./made.js";\nexport { Named } from "./made.js";\n');
      writeFileSync(
        join(root, "made.ts"),
        [
          "type Hidden = { a: number };",
          "export type Named = { a: number };",
          "export function bare(a: number) {",
          "  return { a };",
          "}",
          "export async function shaped(a: number): Promise<{ a: number }> {",
          "  return { a };",
          "}",
          "export const hidden = (a: number): Hidden => ({ a });",
          "export const maker = (a: number): (() => number) => () => a;",
          "export function named(a: number): Named {",
          "  return { a };",
          "}",
          "export class Box {",
          "  open(a: number) {",
          "    return a;",
          "  }",
          "  shut(a: number): Named {",
          "    return { a };",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      const found = returnFindings(join(root, "index.ts"), {}).map(({ name, problem }) => [name, problem]);
      expect(found).toEqual([
        ["bare", "has no return type annotation"],
        ["shaped", "returns an anonymous object type"],
        ["hidden", "returns Hidden, which is not exported"],
        ["maker", "returns an anonymous function type"],
        ["Box.open", "has no return type annotation"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

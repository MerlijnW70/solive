import { type Address, generateKeyPairSigner } from "@solana/kit";
import { AccountState, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createExt,
  encodeParams,
  getIntentDecoder,
  getIntentSize,
  type Intent,
  Kind,
  type SignedIntentFields,
} from "@intent-engine/core";
import { sameTerms } from "../src/agent/signed.js";
import { refundable, TOKEN_ACCOUNT_BYTES } from "../src/crank.js";

const RUNS = Number(process.env["PROPERTY_RUNS"] ?? 300);
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

let keys: Address[] = [];

beforeAll(async () => {
  keys = await Promise.all(Array.from({ length: 8 }, async () => (await generateKeyPairSigner()).address));
});

describe("matching an intent on chain to the terms an owner signed", () => {
  const signed = (): SignedIntentFields => ({
    domain: new Uint8Array(32),
    owner: keys[0] as Address,
    ownerInput: keys[1] as Address,
    inputMint: keys[2] as Address,
    outputMint: keys[3] as Address,
    receiver: keys[4] as Address,
    nonce: 9n,
    expiresAt: 1_700_000_600n,
    submitBy: 1_700_000_100n,
    kind: Kind.SwapExactIn,
    params: encodeParams({ kind: Kind.SwapExactIn, amountIn: 400n, minOut: 300n }),
    epoch: 3n,
    relayerFee: 25n,
    flags: 0,
    ext: createExt({ partner: { key: keys[5] as Address, bps: 30 } }),
  });
  const stored = (f: SignedIntentFields): Intent => ({
    ...getIntentDecoder().decode(new Uint8Array(getIntentSize())),
    owner: f.owner,
    inputMint: f.inputMint,
    outputMint: f.outputMint,
    receiver: f.receiver,
    expiresAt: f.expiresAt,
    kind: f.kind,
    flags: f.flags ?? 0,
    params: Uint8Array.from(f.params),
    partner: keys[5] as Address,
    partnerBps: 30,
  });

  it("agrees on identical terms whatever the fields it deliberately leaves out", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), fc.bigInt({ min: 0n, max: 2n ** 63n }), fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), (epoch, submitBy, fee) => {
        const f = signed();
        expect(sameTerms(stored(f), { ...f, epoch, submitBy, relayerFee: fee })).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("refuses an intent that differs in any term the owner signed", () => {
    const edits: ((s: Intent) => Intent)[] = [
      (s) => ({ ...s, inputMint: keys[6] as Address }),
      (s) => ({ ...s, outputMint: keys[6] as Address }),
      (s) => ({ ...s, receiver: keys[6] as Address }),
      (s) => ({ ...s, expiresAt: s.expiresAt + 1n }),
      (s) => ({ ...s, kind: Kind.LimitOrder }),
      (s) => ({ ...s, flags: 1 }),
      (s) => ({ ...s, partnerBps: 31 }),
      (s) => ({ ...s, partner: keys[6] as Address }),
    ];
    for (const edit of edits) {
      expect(sameTerms(edit(stored(signed())), signed())).toBe(false);
    }
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 127 }), fc.integer({ min: 1, max: 255 }), (at, flip) => {
        const s = stored(signed());
        const params = Uint8Array.from(s.params);
        params[at] = (params[at] ?? 0) ^ flip;
        expect(sameTerms({ ...s, params }, signed())).toBe(false);
      }),
      { numRuns: RUNS },
    );
    const bare = { ...signed(), ext: new Uint8Array() };
    expect(sameTerms({ ...stored(bare), partner: keys[0] as Address, partnerBps: 0 }, bare)).toBe(true);
    expect(sameTerms({ ...stored(bare), partnerBps: 0 }, signed())).toBe(false);
  });
});

describe("choosing a token account to refund a cranked intent into", () => {
  const sound = () => ({
    mint: keys[2] as Address,
    owner: keys[0] as Address,
    amount: 0n,
    delegate: null as Address | null,
    state: AccountState.Initialized,
    isNative: null,
    delegatedAmount: 0n,
    closeAuthority: null as Address | null,
  });
  const bytes = (token: ReturnType<typeof sound>) => Uint8Array.from(getTokenEncoder().encode(token));
  const accept = (data: Uint8Array, program: Address = TOKEN_PROGRAM_ADDRESS) =>
    refundable({ owner: program, data, lamports: 0n }, keys[0] as Address, keys[2] as Address, program, keys[7] as Address);

  it("takes only an initialized account of this mint and owner that no one else can move or close", () => {
    expect(accept(bytes(sound()))).toBe(true);
    expect(accept(bytes({ ...sound(), delegate: keys[7] as Address }))).toBe(true);
    expect(accept(bytes({ ...sound(), closeAuthority: keys[0] as Address }))).toBe(true);
    for (const bad of [
      { ...sound(), mint: keys[6] as Address },
      { ...sound(), owner: keys[6] as Address },
      { ...sound(), state: AccountState.Frozen },
      { ...sound(), state: AccountState.Uninitialized },
      { ...sound(), delegate: keys[6] as Address },
      { ...sound(), closeAuthority: keys[6] as Address },
    ]) {
      expect(accept(bytes(bad))).toBe(false);
    }
    expect(refundable({ owner: keys[6] as Address, data: bytes(sound()), lamports: 0n }, keys[0] as Address, keys[2] as Address, TOKEN_PROGRAM_ADDRESS, keys[7] as Address)).toBe(false);
    expect(accept(bytes(sound()).subarray(0, TOKEN_ACCOUNT_BYTES - 1))).toBe(false);
  });

  it("refuses any token-2022 account carrying an extension other than an immutable owner", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 4 }), (types) => {
        const tlv = types.flatMap((t) => [t, 0, 0, 0]);
        const data = new Uint8Array(TOKEN_ACCOUNT_BYTES + 1 + tlv.length);
        data.set(bytes(sound()));
        data[TOKEN_ACCOUNT_BYTES] = 2;
        data.set(tlv, TOKEN_ACCOUNT_BYTES + 1);
        expect(accept(data, T22)).toBe(types.every((t) => t === 7));
      }),
      { numRuns: RUNS },
    );
  });
});

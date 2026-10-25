import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, type ReadonlyUint8Array } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { AccountVersionError } from "../src/index.js";
import * as internal from "../src/internal.js";
import {
  ACCOUNT_LAYOUTS,
  type AccountLayout,
  decodeConfigAccount,
  decodeIntentAccount,
  getIntentEncoder,
  getIntentSize,
  INTENT_VERSION,
  type Intent,
  IntentStatus,
  readAccounts,
  readIntentAccounts,
} from "../src/internal.js";
import { NotAnEngineAccount } from "../src/errors.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const ACCOUNTS = join(ROOT, "packages/core/generated/client/accounts");

const GENERATED = readdirSync(ACCOUNTS)
  .filter((file) => file.endsWith(".ts") && file !== "index.ts")
  .map((file) => `${file.charAt(0).toUpperCase()}${file.slice(1, -3)}`)
  .sort();

const TYPE_OF: Record<string, string> = {
  config: "Config",
  user: "UserState",
  intent: "Intent",
  mandate: "Mandate",
  "mint cap": "MintCap",
  committee: "Committee",
  "claim board": "ClaimBoard",
  "stand-by entry": "Standby",
  profile: "Profile",
  "claim list": "ClaimList",
  "delivery book": "DeliveryBook",
  announcement: "Announcement",
  refutation: "Refutation",
};

type Decode = (data: ReadonlyUint8Array) => unknown;

const decoderOf = (type: string): Decode => (internal as unknown as Record<string, Decode>)[`decode${type}Account`] as Decode;

function account(layout: AccountLayout, version: number, size = layout.space): Uint8Array {
  const data = new Uint8Array(size);
  data.set(layout.discriminator, 0);
  data[8 + layout.versionAt] = version;
  return data;
}

async function intentBytes(version: number, change: Partial<Intent> = {}): Promise<Uint8Array> {
  const owner = (await generateKeyPairSigner()).address;
  const intent: Intent = {
    ...internal.getIntentDecoder().decode(account(layoutOf("intent"), INTENT_VERSION)),
    owner,
    receiver: owner,
    rentPayer: owner,
    status: IntentStatus.Open,
    escrowed: 7n,
    ...change,
    version,
  };
  return Uint8Array.from(getIntentEncoder().encode(intent));
}

function layoutOf(name: string): AccountLayout {
  const layout = ACCOUNT_LAYOUTS.find((l) => l.name === name);
  if (layout === undefined) {
    throw new Error(`no layout ${name}`);
  }
  return layout;
}

describe("engine account decode functions", () => {
  it("cover every account in the generated client, one function each", () => {
    expect(Object.values(TYPE_OF).sort()).toEqual(GENERATED);
    expect(ACCOUNT_LAYOUTS.map((layout) => TYPE_OF[layout.name]).sort()).toEqual(GENERATED);
    for (const type of GENERATED) {
      expect(typeof decoderOf(type), type).toBe("function");
    }
  });

  it.each(ACCOUNT_LAYOUTS.map((layout) => [layout.name, layout] as const))("check the %s layout version before decoding", (_, layout) => {
    const decode = decoderOf(TYPE_OF[layout.name] as string);
    expect(decode(account(layout, layout.version))).toBeTypeOf("object");
    expect(decode(account(layout, layout.oldest))).toBeTypeOf("object");
    expect(() => decode(account(layout, layout.version + 1))).toThrow(AccountVersionError);
    expect(() => decode(account(layout, layout.oldest - 1))).toThrow(AccountVersionError);
    expect(() => decode(account(layout, layout.version, layout.space + 1))).toThrow(AccountVersionError);
    expect(() => decode(new Uint8Array(layout.space))).toThrow(NotAnEngineAccount);
  });

  it.each(ACCOUNT_LAYOUTS.map((layout) => [layout.name, layout] as const))("refuse a %s account handed to another type's function", (_, layout) => {
    const other = ACCOUNT_LAYOUTS.find((l) => l.name !== layout.name) as AccountLayout;
    const decode = decoderOf(TYPE_OF[other.name] as string);
    expect(() => decode(account(layout, layout.version))).toThrow(NotAnEngineAccount);
  });

  it("decode a current intent to the fields it holds", async () => {
    const data = await intentBytes(INTENT_VERSION);
    expect(data.length).toBe(getIntentSize());
    expect(decodeIntentAccount(data)).toMatchObject({ version: INTENT_VERSION, escrowed: 7n, status: IntentStatus.Open });
  });

  it("refuse an intent whose stored version is one above the newest", async () => {
    const data = await intentBytes(INTENT_VERSION + 1);
    expect(() => decodeIntentAccount(data)).toThrow(AccountVersionError);
    expect(() => decodeIntentAccount(data)).toThrow(`of version ${INTENT_VERSION + 1}`);
  });

  it("refuse a config read as an intent", () => {
    const config = account(layoutOf("config"), layoutOf("config").version);
    expect(decodeConfigAccount(config)).toBeTypeOf("object");
    expect(() => decodeIntentAccount(config)).toThrow(NotAnEngineAccount);
  });
});

describe("engine account scans", () => {
  it("skip an intent of an unknown layout, name it with the reason, and keep the valid ones", async () => {
    const [good, newer, other] = (await Promise.all([1, 2, 3].map(() => generateKeyPairSigner()))).map((s) => s.address as Address);
    const entries = [
      { address: good as Address, data: await intentBytes(INTENT_VERSION) },
      { address: newer as Address, data: await intentBytes(INTENT_VERSION + 1) },
      { address: other as Address, data: new Uint8Array(getIntentSize()) },
    ];
    const { intents, unreadable } = readIntentAccounts(entries);
    expect(intents.map(({ address }) => address)).toEqual([good]);
    expect(unreadable).toEqual([
      { address: newer, reason: expect.stringContaining(`of version ${INTENT_VERSION + 1}`) },
      { address: other, reason: "the data is not an engine intent account" },
    ]);
  });

  it("pass on errors that are not about the account layout", () => {
    const broken = new RangeError("broken decoder");
    const decode = () => {
      throw broken;
    };
    expect(() => readAccounts([{ address: "11111111111111111111111111111111" as Address, data: new Uint8Array(1) }], decode)).toThrow(broken);
  });
});

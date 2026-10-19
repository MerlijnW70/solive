import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT as TEST_TOKEN, NATIVE_MINT, sortMembers } from "@intent-engine/core";
import { committeeNeeded } from "../src/agent/create.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { pieceUnsettled } from "../src/agent/wallet/escrow.js";
import { EXIT_OK } from "../src/main.js";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { cli, funded, h, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const FLOOR = LAMPORTS_PER_SOL / 20n;
const FLOOR_LINE = "Committee floor: escrows of 0.05 or more of this token need a committee of at least 2 judges as attestor";

function preset(at: Address): void {
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function connect(argv: string[]): Promise<Client> {
  h.served.length = 0;
  const started = await cli(argv, {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const server = h.served[0];
  if (server === undefined) {
    throw new Error("no server was started");
  }
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

async function convene(threshold: number): Promise<Address> {
  const members = await Promise.all([0, 1, 2].map(async () => (await generateKeyPairSigner()).address));
  const payer = await funded();
  const created = await cli(
    ["committee", "create", "--keypair", "payer.json", "--members", sortMembers(members).join(","), "--threshold", String(threshold), "--fee-wallet", payer.address, "--yes"],
    { "payer.json": payer },
  );
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  return created.json()["committee"] as Address;
}

describe("the wallet escrow tools under a committee floor", () => {
  let client: Client;

  beforeEach(async () => {
    const w = await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    preset(NATIVE_MINT);
    preset(TEST_TOKEN);
    const set = await cli(["set-committee-floor", "--keypair", "admin.json", "--yes", "--url", "devnet", "--mint", NATIVE_MINT, "--floor", String(FLOOR)], { "admin.json": w.authority });
    expect([set.code, set.err]).toEqual([EXIT_OK, ""]);
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
  });

  it("names the floor and refuses a single judge at the floor before sending", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const below = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.04", attestor: owner });
    expect(below["summary"]).toContain(FLOOR_LINE);
    const refused = await call(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, send: true });
    expect(refused.value).toMatchObject({ code: "CommitteeRequired", retryable: false, hint: committeeNeeded("0.05", "0.05", owner) });
    expect((await ok(client, "wallet_intents"))["intents"]).toHaveLength(0);

    const loose = await convene(1);
    expect((await call(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: loose })).value).toMatchObject({ code: "CommitteeRequired" });

    const committee = await convene(2);
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: committee, send: true });
    expect(escrow["summary"]).toEqual(expect.arrayContaining([FLOOR_LINE, `Judged by: the committee ${committee}, passed with the create`]));
    expect(h.svm.getAccount(escrow["intent"] as Address).exists).toBe(true);
  });

  it("refuses a plan before sending any piece when one piece needs a committee", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const pieces = [
      { name: "small", amount: "0.01" },
      { name: "large", amount: "0.05" },
    ];
    const refused = await call(client, "wallet_escrow_plan", { sell: "SOL", attestor: owner, pieces, send: true });
    expect(refused.value).toMatchObject({ code: "CommitteeRequired", hint: `${pieceUnsettled(2, "large")}${committeeNeeded("0.05", "0.05", owner)}` });
    expect((await ok(client, "wallet_intents"))["intents"]).toHaveLength(0);
    const committee = await convene(2);
    const plan = await ok(client, "wallet_escrow_plan", { sell: "SOL", attestor: owner, pieces: [pieces[0], { ...pieces[1], attestor: committee }] });
    expect(plan["sent"]).toBe(false);
  });
});

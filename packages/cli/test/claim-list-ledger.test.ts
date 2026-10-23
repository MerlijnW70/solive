import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT, seal } from "@intent-engine/core";
import { claimsTooLarge } from "../src/agent/create.js";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK, main } from "../src/main.js";
import { h, runtime, world } from "./harness.js";
import { device, deviceKey, found } from "./ledger-device.js";

type Json = Record<string, unknown>;

const PATH = "usb://ledger?key=8";
const LEVELS = [44, 501, 8];
const SPEC = "# Listed job\n\nDeliver the report as one text file.\n";
const SPEC_URL = "https://" + "example.org/jobs/ledger-listed.sealed";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function address(): Address {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return getAddressDecoder().decode(Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url")));
}

function preset(at: Address): void {
  if (h.svm.getAccount(at).exists) {
    return;
  }
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

describe("a claim list from a Ledger wallet", () => {
  it("refuses a list too long to fit beside the escrow, since the device signs only the one transaction it previewed", async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const key = await deviceKey();
    h.svm.airdrop(key.address, lamports(10_000_000_000n));
    h.env[ENV_KEYPAIR] = PATH;
    h.specPages.set(SPEC_URL, await seal(new TextEncoder().encode(SPEC), [key.address, ...Array.from({ length: 30 }, () => address())]));
    h.served.length = 0;
    const err: string[] = [];
    const code = await main(["mcp", "--url", "devnet", "--wallet", "--all-tools"], { ...runtime({}), ledger: device(key, found(LEVELS, key)).open }, { out: () => undefined, err: (t) => err.push(t) });
    expect([code, err.join("\n")]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
    const [near, far] = InMemoryTransport.createLinkedPair();
    await h.served[0]?.connect(near);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(far);
    const terms = { sell: "SOL", amount: "0.05", attestor: address(), spec_hash: sha(SPEC), spec_url: SPEC_URL, claim_stake: "0.01", claim_secs: 600 };
    const result = await client.callTool({ name: tool("wallet_escrow"), arguments: terms });
    const value = result.structuredContent as Json;
    expect(result.isError, JSON.stringify(value)).toBe(true);
    expect(value["code"]).toBe("ClaimListTooLarge");
    const size = Number(/build a (\d+)-byte/.exec(String(value["hint"]))?.[1]);
    expect(value["hint"]).toBe(claimsTooLarge(size));
  });
});

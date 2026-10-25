import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { seal } from "@intent-engine/core/internal";
import { sealedLimits } from "../../src/agent/wallet/escrow-claims.js";
import { h } from "../harness.js";
import { fresh, type Json } from "../agent-wallet-kit.js";

const SPEC = "# Listed job\n\nDeliver the report as one text file.\n";
const SPEC_URL = "https://" + "example.org/jobs/px-listed.sealed";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function address(): Address {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return getAddressDecoder().decode(Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url")));
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

describe("PX-2 the claim list an escrow previews and the one it sends", () => {
  it("PX-2 sends an escrow whose claims are limited to a wallet its preview never listed, without refusing", async () => {
    const client = await fresh();
    const wallet = (await call(client, "wallet_setup")).value["address"] as Address;
    h.watched.push(wallet);
    const [judge, worker, intruder] = [address(), address(), address()];
    const terms = { sell: "SOL", amount: "0.05", attestor: judge, spec_hash: sha(SPEC), spec_url: SPEC_URL, claim_stake: "0.01", claim_secs: 600 };
    h.specPages.set(SPEC_URL, await seal(new TextEncoder().encode(SPEC), [wallet, judge, worker]));
    const preview = await call(client, "wallet_escrow", terms);
    expect(preview.error, JSON.stringify(preview.value)).toBe(false);
    expect(preview.value["summary"]).toContain(sealedLimits([worker]));

    h.specPages.set(SPEC_URL, await seal(new TextEncoder().encode(SPEC), [wallet, judge, intruder]));
    const made = await call(client, "wallet_escrow", { ...terms, send: true });
    const listed = made.error ? [] : (((await call(client, "get_claims", { owner: wallet, nonce: made.value["nonce"] })).value["claim_list"]?.["workers"] as Address[] | undefined) ?? []);

    expect({ refused: made.error, unpreviewed: listed.filter((w) => w !== worker) }).toEqual({ refused: made.error, unpreviewed: [] });
  });
});

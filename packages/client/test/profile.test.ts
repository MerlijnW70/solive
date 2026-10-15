import { generateKeyPairSigner, lamports } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { buildCloseProfile, buildCreateProfile, buildUpdateProfile } from "@intent-engine/core";
import { createClient } from "../src/index.js";
import { svmTransport } from "../src/svm.js";
import { world } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";

describe("profiles", () => {
  it("client.profile reads a published profile and returns null for a wallet without one", async () => {
    const w = await world();
    const client = createClient({ url: LOCAL, transport: svmTransport(w.chain.svm) });
    const wallet = await generateKeyPairSigner();
    w.chain.svm.airdrop(wallet.address, lamports(1_000_000_000n));
    expect(await client.profile(wallet.address)).toBeNull();
    const published = { skills: ["rust", "anchor"], endpoint: "https://worker.example/jobs", docUrl: "https://worker.example/about", docSha256: "cd".repeat(32) };
    await client.send([await buildCreateProfile({ wallet, ...published })], wallet);
    const now = await client.chainTime();
    expect(await client.profile(wallet.address)).toEqual({ wallet: wallet.address, ...published, updatedAt: now });
    await client.send([await buildUpdateProfile({ wallet, skills: ["rust"], endpoint: "https://worker.example/v2" })], wallet);
    expect(await client.profile(wallet.address)).toMatchObject({ skills: ["rust"], endpoint: "https://worker.example/v2", docUrl: null, docSha256: null });
    expect(await client.profile(w.owner.address)).toBeNull();
    await client.send([await buildCloseProfile({ wallet })], wallet);
    expect(await client.profile(wallet.address)).toBeNull();
  });
});

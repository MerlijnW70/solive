import { type Address, lamports } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { CLUSTERS } from "../src/args.js";
import { AIRDROP, airdropRefused, airdropper, CLI_SMALL_START, CLI_START, ENOUGH_TO_START, heldRefused, holdsEnough, LAMPORTS_PER_SOL, refusedEnough, smallerAirdrop, whyAirdrop } from "../src/wallet.js";
import { DEVNET_URL } from "../src/tokens.js";
import { cli, h, transport, world } from "./harness.js";

const CUSTOM = "https://" + "rpc.example.org";

const OFF_DEVNET: readonly [string, string, string][] = [
  ["localnet", CLUSTERS["localnet"] ?? "", "localnet"],
  ["testnet", CLUSTERS["testnet"] ?? "", "testnet"],
  [CUSTOM, CUSTOM, "the node"],
];

const sending = (most: bigint) => {
  h.through = {
    ...transport,
    airdrop: async (address, amount) => {
      h.airdrops.push({ address, lamports: amount });
      if (amount > most) {
        throw new Error("429 Too Many Requests");
      }
      h.svm.airdrop(address, lamports(amount));
      return testSignature(`airdrop ${address} ${amount}`);
    },
  };
};

const setupOn = async (url: string) => (await cli(["setup", "--url", url], {})).json();

describe("setup names the cluster that refused the airdrop", () => {
  beforeEach(async () => {
    await world();
  });

  it("names devnet only on devnet", () => {
    expect(airdropper(DEVNET_URL)).toBe("devnet");
    expect(whyAirdrop(DEVNET_URL)).toBe("devnet refused the airdrop");
    for (const [, url, name] of OFF_DEVNET) {
      expect(airdropper(url)).toBe(name);
      expect(whyAirdrop(url)).toBe(`${name} refused the airdrop`);
    }
  });

  it.each(OFF_DEVNET)("an empty wallet on %s is told who refused, never devnet", async (flag, url, name) => {
    h.airdropRefused = true;
    const made = await setupOn(flag);
    const address = made["address"] as Address;
    expect(made).toMatchObject({ sol: "0", next: airdropRefused(address, url), why: `${name} refused the airdrop` });
    expect(made["next"]).toMatch(new RegExp(`^your wallet holds no SOL yet and ${name} refused the airdrop; `));
    expect(made["next"]).not.toMatch(/devnet/i);
    expect(made["why"]).not.toMatch(/devnet/i);
  });

  it.each(OFF_DEVNET)("a wallet holding too little on %s is told who refused to add more, never devnet", async (flag, url, name) => {
    h.airdropRefused = true;
    const address = (await setupOn(flag))["address"] as Address;
    h.svm.airdrop(address, lamports(LAMPORTS_PER_SOL / 50n));
    const held = await setupOn(flag);
    expect(held).toMatchObject({ sol: "0.02", next: heldRefused("0.02", address, url) });
    expect(held["next"]).toContain(`and ${name} refused to add more; `);
    expect(held["next"]).not.toMatch(/devnet/i);
  });

  it.each(OFF_DEVNET)("a wallet holding enough on %s is told who refused more, never devnet", async (flag, url, name) => {
    h.airdropRefused = true;
    const address = (await setupOn(flag))["address"] as Address;
    h.svm.airdrop(address, lamports(ENOUGH_TO_START));
    const held = await setupOn(flag);
    expect(held["next"]).toBe(refusedEnough("0.06", CLI_SMALL_START, url));
    expect(held["next"]).toMatch(new RegExp(`^${name} refused more free SOL, but your wallet holds 0\\.06 SOL`));
    expect(held["next"]).not.toMatch(/devnet/i);
  });

  it.each(OFF_DEVNET)("a smaller airdrop on %s names who refused the larger one, never devnet", async (flag, url, name) => {
    sending(AIRDROP / 4n);
    const made = await setupOn(flag);
    expect(made).toMatchObject({ sol: "0.25", airdrop: "0.25", next: smallerAirdrop(AIRDROP / 4n, url) + holdsEnough("0.25", CLI_START) });
    expect(made["next"]).toMatch(new RegExp(`^${name} refused 1 SOL and sent 0\\.25 SOL; `));
    expect(made["next"]).not.toMatch(/devnet/i);
  });
});

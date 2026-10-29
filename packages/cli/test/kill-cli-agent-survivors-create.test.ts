import { type Address, generateKeyPairSigner, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { PACKET_DATA_SIZE } from "@intent-engine/client/internal";
import type { Transport } from "@intent-engine/client";
import { createIntent, prepareCreate, WARN_SCALED } from "../src/agent/create.js";
import { callOf, claimsOf } from "../src/agent/claims.js";
import { AgentRefusal } from "../src/agent/problems.js";
import { ESCROW, h, transport, type World, world } from "./harness.js";

const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

const padding =
  (bytes: number) =>
  async (): Promise<Instruction[]> => [{ programAddress: MEMO, accounts: [], data: new Uint8Array(bytes) }];

const contextOf = (through: Transport) => ({ transport: through, relay: undefined, agent: undefined, claims: claimsOf(), skipSimulation: true as const, url: "http://cluster" });

const inputOf = (w: World, over: object = {}) =>
  prepareCreate.input.read(
    { owner: w.owner.address, input_mint: w.inputMint, output_mint: w.outputMint, order: { kind: "swap", amount_in: ESCROW.toString(), min_out: "300" }, expires_in: 3_600, ...over },
    "input",
  );

async function scaledMint(w: World): Promise<Address> {
  const template = h.svm.getAccount(w.inputMint);
  if (!template.exists) {
    throw new Error("mint missing");
  }
  const data = new Uint8Array(178);
  data.set(new Uint8Array(template.data));
  data[165] = 1;
  data.set([18, 0, 4, 0, 0, 0, 0, 0, 10, 0, 0, 0], 166);
  const address = (await generateKeyPairSigner()).address;
  h.svm.setAccount({ ...template, address, data, programAddress: T22, space: BigInt(data.length) });
  return address;
}

describe("createIntent with instructions to follow", () => {
  it("accepts a transaction of exactly the packet size and refuses one byte more", async () => {
    const w = await world();
    const refusal = async (bytes: number) => {
      const error = await createIntent(contextOf(transport), inputOf(w), callOf(), padding(bytes)).then(
        () => null,
        (failure: unknown) => failure,
      );
      return error instanceof AgentRefusal ? error : null;
    };
    const probe = await refusal(1_500);
    expect(probe).not.toBeNull();
    const size = Number(/a (\d+)-byte transaction/.exec(probe?.message ?? "")?.[1]);
    expect(size).toBeGreaterThan(PACKET_DATA_SIZE);
    const fits = 1_500 - (size - PACKET_DATA_SIZE);
    expect(await refusal(fits)).toBeNull();
    const over = await refusal(fits + 1);
    expect(over?.problem.code).toBe("ClaimListTooLarge");
    expect(over?.message).toContain(`a ${PACKET_DATA_SIZE + 1}-byte transaction, over the ${PACKET_DATA_SIZE}-byte limit`);
  });

  it("measures the size only when instructions follow", async () => {
    const w = await world();
    let blockhashes = 0;
    const counting: Transport = {
      ...transport,
      latestBlockhash: async () => {
        blockhashes++;
        return transport.latestBlockhash();
      },
    };
    await createIntent(contextOf(counting), inputOf(w), callOf());
    const alone = blockhashes;
    blockhashes = 0;
    await createIntent(contextOf(counting), inputOf(w), callOf(), async () => []);
    expect(blockhashes).toBe(alone);
    blockhashes = 0;
    await createIntent(contextOf(counting), inputOf(w), callOf(), padding(10));
    expect(blockhashes).toBe(alone + 1);
  });
});

describe("createIntent on a token that scales amounts", () => {
  it("warns when only the token sold, only the token received, or neither of them scales", async () => {
    const w = await world();
    const scaled = await scaledMint(w);
    const warnings = async (over: object) => (await createIntent(contextOf(transport), inputOf(w, over), callOf()))["warnings"];
    expect(await warnings({ input_mint: scaled })).toContain(WARN_SCALED);
    expect(await warnings({ output_mint: scaled })).toContain(WARN_SCALED);
    expect(await warnings({})).not.toContain(WARN_SCALED);
  });
});

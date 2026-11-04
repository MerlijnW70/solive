import { generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { buildClaimJob, claimListAddress } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { ENGINE_ERROR_BASE, ENGINE_ERROR_NAMES } from "../src/agent/problems.js";
import { heldBy, notOpen, noClaims } from "../src/claim-commands.js";
import { listExists, limitsLine } from "../src/claim-lists.js";
import { noOrder } from "../src/flows.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { cli, funded, h, NOW, send, setNow, transport, type World, world } from "./harness.js";

type Json = Record<string, any>;

const onChain = (name: string) => new RegExp(`code: ${ENGINE_ERROR_BASE + ENGINE_ERROR_NAMES.indexOf(name as never)}\\b`);

function address(): Address {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return getAddressDecoder().decode(Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url")));
}

const EXPIRES = NOW + 3_600n;

describe("claims list on the command line", () => {
  let w: World;
  let keys: Record<string, any>;
  let intent: Address;

  beforeEach(async () => {
    w = await world();
    keys = { "owner.json": w.owner };
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: (await funded()).address, specHash: new Uint8Array(32).fill(7), judgeFee: 0n } as const;
    ({ intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: EXPIRES }));
  });

  const opened = () => cli(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--yes"], keys);
  const list = (workers: readonly Address[], ...rest: string[]) => cli(["claims", "list", "--keypair", "owner.json", "--nonce", "0", "--workers", workers.join(","), ...rest], keys);
  const shown = async () => ((await cli(["claims", "show", "--owner", w.owner.address, "--nonce", "0"], {})).json() as Json)["claim_list"];

  it("previews, then sends list_claimants for claims opened without a list, and the program then refuses an unlisted claimant", async () => {
    expect((await opened()).code).toBe(EXIT_OK);
    expect(await shown()).toBeNull();
    const [worker, stranger] = [await funded(), await funded()];
    const preview = await list([worker.address]);
    expect(preview.code).toBe(EXIT_OK);
    expect(preview.json()).toMatchObject({ sent: false, intent, claim_list: await claimListAddress(intent) });
    expect(preview.json()["summary"]).toEqual([
      `Lists: 1 wallet on the claims of escrow ${intent}, added after they opened`,
      limitsLine([worker.address]),
      `Pays rent: ${w.owner.address}, for the claim list ${await claimListAddress(intent)}`,
    ]);
    expect(await shown()).toBeNull();
    const sent = await list([worker.address], "--yes");
    expect(sent.code).toBe(EXIT_OK);
    expect(sent.json()).toMatchObject({ sent: true });
    expect(await shown()).toEqual({ address: await claimListAddress(intent), size: 1, workers: [worker.address], complete: true });
    const claimList = await claimListAddress(intent);
    const claim = (who: typeof worker) => buildClaimJob({ worker: who, intent, owner: w.owner.address, secs: 600, claimList });
    await expect(send(stranger, [await claim(stranger)])).rejects.toThrow(onChain("NotListed"));
    await send(worker, [await claim(worker)]);
  });

  it("sends a long list in parts and leaves it complete", async () => {
    await opened();
    const workers = Array.from({ length: 30 }, () => address());
    const preview = await list(workers);
    expect(preview.json()["summary"]).toContain("Sends: 2 transactions, the list in parts; the escrow takes no claim until the last lands");
    const sent = await list(workers, "--yes");
    expect(sent.json()["signatures"]).toHaveLength(2);
    expect(await shown()).toEqual({ address: await claimListAddress(intent), size: 30, workers, complete: true });
  });

  it("refuses when claims are not open on the escrow", async () => {
    const refused = await list([address()], "--yes");
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, noClaims(intent)]);
    expect(h.svm.getAccount(await claimListAddress(intent)).exists).toBe(false);
  });

  it("refuses an escrow it does not own", async () => {
    const other = await funded();
    const refused = await cli(["claims", "list", "--keypair", "other.json", "--nonce", "0", "--workers", address(), "--yes"], { "other.json": other });
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, noOrder(other.address, 0n)]);
  });

  it("refuses a second list and keeps the first", async () => {
    await opened();
    const worker = await funded();
    expect((await list([worker.address], "--yes")).code).toBe(EXIT_OK);
    const again = await list([address()], "--yes");
    expect([again.code, again.err]).toEqual([EXIT_FAILED, listExists(intent)]);
    expect(await shown()).toMatchObject({ workers: [worker.address] });
  });

  it("refuses while a worker holds the claim on an unlisted escrow", async () => {
    await opened();
    const worker = await funded();
    await send(worker, [await buildClaimJob({ worker, intent, owner: w.owner.address, secs: 600 })]);
    const held = await cli(["claims", "show", "--owner", w.owner.address, "--nonce", "0"], {});
    const refused = await list([address()], "--yes");
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, heldBy(intent, worker.address, BigInt((held.json() as Json)["seconds_left"]))]);
  });

  it("refuses once the escrow has expired", async () => {
    await opened();
    setNow(EXPIRES + 1n);
    const refused = await list([address()], "--yes");
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, notOpen(intent)]);
  });

  it("refuses a missing, empty, repeated or oversized worker list as a usage error", async () => {
    const usage = [
      ["claims", "list", "--keypair", "owner.json", "--nonce", "0"],
      ["claims", "list", "--keypair", "owner.json", "--nonce", "0", "--workers", ""],
      ["claims", "list", "--keypair", "owner.json", "--workers", address()],
      ["claims", "list", "--keypair", "owner.json", "--nonce", "0", "--workers", Array.from({ length: 33 }, () => address()).join(",")],
    ];
    for (const args of usage) {
      expect([args.join(" ").slice(0, 60), (await cli(args, keys)).code]).toEqual([args.join(" ").slice(0, 60), EXIT_USAGE]);
    }
  });
});

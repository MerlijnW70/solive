import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type Address,
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type KeyPairSigner,
  lamports,
  none,
  some,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintEncoder,
  getMintSize,
  getSyncNativeInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind } from "@intent-engine/core";
import { type ClientOptions, createClient, type Transport } from "../src/index.js";
import { FEE_BPS, world, type World } from "./svm.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");
const PAGE = read("docs/sdk.md");
const WSOL = address("So11111111111111111111111111111111111111112");
const TEST = address("ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88");
const DEVNET = "https://api.devnet.solana.com";
const WALLET = "solive-wallet.json";
const WRAPPED = 1_000_000_000n;

const fenced = (lang: string) => [...PAGE.matchAll(new RegExp(`^\`\`\`${lang}\\n([\\s\\S]*?)^\`\`\`$`, "gm"))].map((m) => m[1] ?? "");
const blocks = fenced("ts");
const shell = fenced("sh").join("").trimEnd().split("\n");
const claims = [...PAGE.matchAll(/\bprints ([^.]*)\./g)].flatMap((m) => [...(m[1] ?? "").matchAll(/`([^`]+)`/g)].map((c) => c[1] ?? ""));

const injected = vi.hoisted(() => ({ transport: undefined as Transport | undefined, urls: [] as string[] }));

vi.mock("@intent-engine/client", async () => {
  const real = await import("../src/index.js");
  return {
    ...real,
    createClient: (options: ClientOptions) => {
      injected.urls.push(options.url);
      if (injected.transport === undefined) {
        throw new Error("no transport injected");
      }
      return real.createClient({ ...options, transport: injected.transport, pollMs: 5 });
    },
  };
});

function preset(w: World, at: Address, mintAuthority: Address | null): void {
  const space = BigInt(getMintSize());
  w.chain.svm.setAccount({
    address: at,
    data: Uint8Array.from(
      getMintEncoder().encode({
        mintAuthority: mintAuthority === null ? none() : some(mintAuthority),
        supply: 0n,
        decimals: 9,
        isInitialized: true,
        freezeAuthority: none(),
      }),
    ),
    executable: false,
    lamports: lamports(w.chain.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

const ata = (owner: Address, mint: Address) => findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

async function wallet(w: World): Promise<{ signer: KeyPairSigner; secret: number[] }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  w.chain.svm.airdrop(signer.address, lamports(10_000_000_000n));
  w.chain.owners.add(signer.address);
  const wrapped = await ata(signer.address, WSOL);
  await w.chain.transport.send(
    [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner: signer.address, mint: WSOL }),
      getTransferSolInstruction({ source: signer, destination: wrapped, amount: WRAPPED }),
      getSyncNativeInstruction({ account: wrapped }),
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner: signer.address, mint: TEST }),
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner: w.feeRecipient.address, mint: WSOL }),
    ],
    signer,
  );
  return { signer, secret: [...seed, ...getAddressEncoder().encode(signer.address)] };
}

const tokens = (w: World, account: Address) => {
  const found = w.chain.svm.getAccount(account);
  return found.exists ? new DataView(found.data.buffer, found.data.byteOffset).getBigUint64(64, true) : null;
};

describe("the sdk page", () => {
  const home = mkdtempSync(join(tmpdir(), "sdk-page-"));
  const pageModule = fileURLToPath(new URL(`./.sdk-page-${process.pid}.ts`, import.meta.url));
  const before = process.env["HOME"];

  beforeAll(() => {
    process.env["HOME"] = home;
  });

  afterAll(() => {
    process.env["HOME"] = before;
    rmSync(home, { recursive: true, force: true });
    rmSync(pageModule, { force: true });
  });

  it("installs the three packages on the Node version they declare", () => {
    const engines = (JSON.parse(read("packages/client/package.json")) as { engines: { node: string } }).engines.node;
    const [, major, minor] = /^>=(\d+)\.(\d+)\.0$/.exec(engines) ?? [];
    expect(PAGE).toContain(`Node.js ${major}.${minor} or later.`);
    expect(shell[0]).toBe("npm install @intent-engine/core @intent-engine/client @solana/kit");
    expect(shell.slice(1)).toEqual([
      `solana-keygen new --no-bip39-passphrase -o ~/${WALLET}`,
      `solana config set --url devnet --keypair ~/${WALLET}`,
      "solana airdrop 1",
      "spl-token wrap 0.2",
      `spl-token create-account ${TEST}`,
    ]);
    expect(blocks.length).toBeGreaterThanOrEqual(6);
    expect(claims).toEqual(["Open", "Cancelled", "ExpiryNotInFuture", "Filled"]);
  });

  it("runs every ts block in order against the engine and prints what it says", { timeout: 120_000 }, async () => {
    const w = await world();
    preset(w, WSOL, null);
    preset(w, TEST, w.authority.address);
    const { signer, secret } = await wallet(w);
    writeFileSync(join(home, WALLET), JSON.stringify(secret));
    injected.transport = w.chain.transport;
    const wrapped = await ata(signer.address, WSOL);
    const held = tokens(w, wrapped);

    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    writeFileSync(pageModule, blocks.join("\n"));
    try {
      await import(pathToFileURL(pageModule).href);
    } finally {
      log.mockRestore();
      rmSync(pageModule, { force: true });
    }

    expect(injected.urls).toEqual([DEVNET]);
    for (const claim of claims) {
      expect(printed).toContain(claim);
    }
    expect(printed.indexOf("Open")).toBeLessThan(printed.indexOf("Cancelled"));

    const client = createClient({ url: DEVNET, transport: w.chain.transport });
    const mine = await client.intents({ owner: signer.address });
    expect(mine.map(({ intent }) => [intent.nonce, intent.kind, intent.status])).toEqual([
      [0n, Kind.SwapExactIn, IntentStatus.Cancelled],
      [1n, Kind.AttestedResult, IntentStatus.Filled],
    ]);
    const pay = 10_000_000n;
    const fee = ((pay - pay / 10n) * BigInt(FEE_BPS)) / 10_000n;
    expect(tokens(w, wrapped)).toBe((held ?? 0n) - fee);
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type Address,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type KeyPairSigner,
  lamports,
  none,
  some,
} from "@solana/kit";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEVNET_TEST_MINT as TEST,
  findAssociatedTokenAddress,
  IntentStatus,
  Kind,
  NATIVE_MINT as WSOL,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { type ClientOptions, createClient, type Transport } from "../src/index.js";
import { FEE_BPS, world, type World } from "./svm.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");
const PAGE = read("docs/sdk.md");
const DEVNET = "https://api.devnet.solana.com";
const WALLET = "solive-wallet.json";
const LAMPORTS = 10_000_000_000n;

const fenced = (lang: string) => [...PAGE.matchAll(new RegExp(`^\`\`\`${lang}\\n([\\s\\S]*?)^\`\`\`$`, "gm"))].map((m) => m[1] ?? "");
const blocks = fenced("ts");
const shell = fenced("sh").join("").trimEnd().split("\n");
const claims = [...PAGE.matchAll(/\bprints ([^.]*)\./g)].flatMap((m) => [...(m[1] ?? "").matchAll(/`([^`]+)`/g)].map((c) => c[1] ?? ""));

const injected = vi.hoisted(() => ({ transport: undefined as Transport | undefined, urls: [] as string[], generated: [] as KeyPairSigner[] }));

vi.mock("@solana/kit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@solana/kit")>();
  return {
    ...real,
    generateKeyPairSigner: async () => {
      const signer = await real.generateKeyPairSigner();
      injected.generated.push(signer);
      return signer;
    },
  };
});

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
  w.chain.svm.airdrop(signer.address, lamports(LAMPORTS));
  return { signer, secret: [...seed, ...getAddressEncoder().encode(signer.address)] };
}

const tokens = (w: World, account: Address) => {
  const found = w.chain.svm.getAccount(account);
  return found.exists ? new DataView(found.data.buffer, found.data.byteOffset).getBigUint64(64, true) : null;
};

describe("the sdk page", () => {
  const home = mkdtempSync(join(tmpdir(), "sdk-page-"));
  const pageModule = fileURLToPath(new URL(`./.sdk-page-${process.pid}.ts`, import.meta.url));
  const homeVars = ["HOME", "USERPROFILE"] as const;
  const before = homeVars.map((name) => [name, process.env[name]] as const);

  beforeAll(() => {
    for (const name of homeVars) {
      process.env[name] = home;
    }
  });

  afterAll(() => {
    for (const [name, value] of before) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
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
    expect(tokens(w, wrapped)).toBeNull();
    expect(tokens(w, await ata(signer.address, TEST))).toBeNull();
    expect(tokens(w, await ata(w.feeRecipient.address, WSOL))).toBeNull();
    injected.generated.length = 0;

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
    const [judge, worker] = injected.generated;
    expect(injected.generated).toHaveLength(2);
    expect(judge?.address).not.toBe(signer.address);
    const pay = 10_000_000n;
    const judgeFee = pay / 10n;
    const fee = ((pay - judgeFee) * BigInt(FEE_BPS)) / 10_000n;
    const paid = [
      tokens(w, await ata(worker?.address ?? signer.address, WSOL)),
      tokens(w, await ata(judge?.address ?? signer.address, WSOL)),
      tokens(w, await ata(w.feeRecipient.address, WSOL)),
    ];
    expect(paid).toEqual([pay - judgeFee - fee, judgeFee, fee]);
    expect(tokens(w, wrapped)).toBe(50_000_000n - pay);
    expect(tokens(w, await ata(signer.address, TEST))).toBe(0n);
  });
});

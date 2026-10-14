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
import { getCreateAssociatedTokenIdempotentInstructionAsync, getMintEncoder, getMintSize, getMintToInstruction } from "@solana-program/token";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildFlashFill,
  buildUpdateEconomics,
  DEVNET_TEST_MINT as TEST,
  feeBpsFor,
  findAssociatedTokenAddress,
  findIntentPda,
  formatAmount,
  getIntentDecoder,
  getIntentSize,
  IntentStatus,
  Kind,
  NATIVE_MINT as WSOL,
  splitFee,
  splitFees,
  termsOf,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import {
  chainTime,
  CLOCK_SYSVAR,
  type ClientOptions,
  createClient,
  DELIVERY_PAGES,
  JOBS_LIMIT,
  loadUser,
  MAX_SPEC_BYTES,
  SIGNATURE_PAGE,
  type Transport,
} from "../src/index.js";
import { FEE_BPS, world, type World } from "./svm.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");
const PAGE = read("docs/sdk.md");
const DEVNET = "https://api.devnet.solana.com";
const WALLET = "solive-wallet.json";
const LAMPORTS = 10_000_000_000n;
const CREATE_FEE = 30_000;
const BOUNTY = 20_000;

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

const FILLER = read("scripts/filler.sh");
const SPEC_URL = /^https:\/\/raw\.githubusercontent\.com\/MerlijnW70\/solive\/[0-9a-f]{40}\/([A-Z]+\.md)$/;
const TEST_PER_SOL = /=(\d+)\/1"/.exec(FILLER)?.[1] ?? "";
const CLOCK_STEP = 5n;

function later(w: World, seconds: bigint): void {
  const clock = w.chain.svm.getClock();
  clock.unixTimestamp += seconds;
  w.chain.svm.setClock(clock);
}

async function devnetFiller(w: World): Promise<void> {
  const inner = w.chain.transport;
  const settings = await createClient({ url: DEVNET, transport: inner }).config();
  const filler = w.authority;
  for (const { data } of await inner.intents()) {
    const intent = getIntentDecoder().decode(data);
    if (intent.status !== IntentStatus.Open || intent.outputMint !== TEST || intent.kind === Kind.AttestedResult) {
      continue;
    }
    const required = termsOf(intent, await chainTime(inner)).receivesAtLeast ?? 0n;
    const feeBps = feeBpsFor(settings, intent.kind);
    const { net } = splitFees(intent.escrowed, feeBps, intent.partnerBps, intent.partnerCutBps);
    if (net * BigInt(TEST_PER_SOL) - required < 1n) {
      continue;
    }
    later(w, CLOCK_STEP);
    const accounts = [
      [filler.address, WSOL],
      [filler.address, TEST],
      [w.feeRecipient.address, WSOL],
    ] as const;
    const solverOutput = await ata(filler.address, TEST);
    const flash = await buildFlashFill({
      solver: filler,
      owner: intent.owner,
      nonce: intent.nonce,
      inputMint: WSOL,
      outputMint: TEST,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      receiver: intent.receiver,
      solverInput: await ata(filler.address, WSOL),
      solverOutput,
      feeRecipient: w.feeRecipient.address,
      mandate: intent.mandate,
      amountIn: intent.escrowed,
      amountOut: required,
      maxFeeBps: feeBps,
      prefix: await Promise.all(accounts.map(([owner, mint]) => getCreateAssociatedTokenIdempotentInstructionAsync({ payer: filler, owner, mint }))),
      route: [getMintToInstruction({ mint: TEST, token: solverOutput, mintAuthority: filler, amount: required })],
    });
    await inner.send(flash, filler);
  }
}

function devnetLike(w: World): Transport {
  const inner = w.chain.transport;
  return {
    ...inner,
    getAccount: async (address) => {
      if (address === CLOCK_SYSVAR) {
        later(w, CLOCK_STEP);
      }
      return inner.getAccount(address);
    },
    send: async (instructions, payer) => {
      const signature = await inner.send(instructions, payer);
      await devnetFiller(w);
      return signature;
    },
  };
}

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
    expect(claims).toEqual(["SwapExactIn Open", "Open", "Cancelled", "ExpiryNotInFuture", "Filled", "IntentAttested", "Cancelled NotSettleable", "null", "true true"]);
  });

  it("states that the devnet filler expires and closes overdue intents in paused passes, and its price", () => {
    expect(FILLER).toContain('    "${cli[@]}" crank --url "$url" --keypair "$keypair"\n    sleep 30\n');
    expect(PAGE).toContain("The devnet filler also expires and closes overdue intents, in passes with a pause between them");
    expect(TEST_PER_SOL).toBe("200");
    expect(PAGE).toContain("The devnet filler prices test tokens at 200 per wrapped SOL");
  });

  it("states the bounds jobs, spec and deliveries read within", () => {
    expect(PAGE).toContain(`\`jobs\` lists up to ${JOBS_LIMIT} open, unexpired proof escrows, those with the most time left first`);
    expect(PAGE).toContain(`following no redirect and reading at most ${MAX_SPEC_BYTES} bytes`);
    expect(PAGE).toContain(`at most ${DELIVERY_PAGES} pages of ${SIGNATURE_PAGE} transactions`);
  });

  it("runs every ts block in order against the engine and prints what it says", { timeout: 120_000 }, async () => {
    const w = await world();
    preset(w, WSOL, null);
    preset(w, TEST, w.authority.address);
    const { signer, secret } = await wallet(w);
    writeFileSync(join(home, WALLET), JSON.stringify(secret));
    injected.transport = devnetLike(w);
    const admin = createClient({ url: DEVNET, transport: w.chain.transport });
    const settings = await admin.config();
    const [a = 0, b = 0, c = 0, d = 0] = settings.kindFeeBps;
    await admin.send(
      [
        await buildUpdateEconomics({
          admin: w.authority,
          economics: { kindFeeMask: settings.kindFeeMask, kindFeeBps: [a, b, c, d], partnerCutBps: settings.partnerCutBps, crankBounty: BOUNTY, createFee: CREATE_FEE },
        }),
      ],
      w.authority,
    );
    const treasury = w.chain.svm.getBalance(w.feeRecipient.address) ?? 0n;
    const wrapped = await ata(signer.address, WSOL);
    expect(tokens(w, wrapped)).toBeNull();
    expect(tokens(w, await ata(signer.address, TEST))).toBeNull();
    expect(tokens(w, await ata(w.feeRecipient.address, WSOL))).toBeNull();
    injected.generated.length = 0;

    const printed: string[] = [];
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      const path = SPEC_URL.exec(url)?.[1];
      return path === undefined ? new Response("missing", { status: 404 }) : new Response(readFileSync(`${ROOT}/${path}`));
    });
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    writeFileSync(pageModule, blocks.join("\n"));
    try {
      await import(pathToFileURL(pageModule).href);
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
      rmSync(pageModule, { force: true });
    }

    expect(injected.urls).toEqual([DEVNET]);
    for (const claim of claims) {
      expect(printed).toContain(claim);
    }
    expect(printed.indexOf("Open")).toBeLessThan(printed.indexOf("Cancelled"));
    expect(printed[printed.indexOf("SwapExactIn Open") + 1]).toBe("0.05 50");
    expect(printed[0]).toBe("false false SwapExactIn true true 5,LimitOrder true true 5,DutchAuction true true 5,AttestedResult true true 5");

    const client = createClient({ url: DEVNET, transport: w.chain.transport });
    const mine = await client.intents({ owner: signer.address });
    expect(mine.map(({ intent }) => [intent.nonce, intent.kind, intent.status])).toEqual([
      [0n, Kind.SwapExactIn, IntentStatus.Cancelled],
      [1n, Kind.LimitOrder, IntentStatus.Filled],
      [2n, Kind.DutchAuction, IntentStatus.Filled],
      [3n, Kind.AttestedResult, IntentStatus.Filled],
      [4n, Kind.AttestedResult, IntentStatus.Cancelled],
      [6n, Kind.AttestedResult, IntentStatus.Filled],
    ]);
    const rent = w.chain.svm.minimumBalanceForRentExemption(BigInt(getIntentSize()));
    expect(mine.map(({ address }) => w.chain.svm.getBalance(address))).toEqual(mine.map(() => rent + BigInt(BOUNTY)));
    const [limit, auction] = await Promise.all([1n, 2n].map(async (n) => client.fillOf((await client.intent(signer.address, n))?.address ?? signer.address)));
    expect(limit).toMatchObject({ steps: 2, solver: w.authority.address, delivered: 1_500_000_000n, required: 1_500_000_000n });
    const at = printed.indexOf("LimitOrder 1.5 TEST");
    expect(printed[at + 1]).toBe("2 1.5 1.5");
    expect(printed[at + 2]).toMatch(/^DutchAuction 1\.8\d+ TEST$/);
    expect(auction?.steps).toBe(2);
    expect(auction?.delivered).toBeGreaterThan(auction?.required ?? 0n);
    expect(auction?.required).toBeGreaterThan(1_000_000_000n);
    expect(printed[at + 3]).toBe(`2 ${formatAmount(auction?.delivered ?? 0n, 9)} ${formatAmount(auction?.required ?? 0n, 9)}`);
    expect(printed[printed.indexOf("Cancelled NotSettleable") + 1]).toBe("null");
    expect(await client.intent(signer.address, 5n)).toBeNull();
    expect((await client.history((await findIntentPda({ owner: signer.address, nonce: 5n }))[0])).map(({ name }) => name).slice(0, 2)).toEqual(["IntentClosed", "IntentExpired"]);
    const fillFees = 2n * splitFee(10_000_000n, FEE_BPS).fee;
    expect(await loadUser(client.transport, signer.address)).not.toBeNull();
    const [judge, worker] = injected.generated;
    expect(injected.generated).toHaveLength(2);
    expect(judge?.address).not.toBe(signer.address);
    const pay = 10_000_000n;
    const judgeFee = pay / 10n;
    const fee = ((pay - judgeFee) * BigInt(FEE_BPS)) / 10_000n;
    const split = splitFees(pay - judgeFee, feeBpsFor(await client.config(), Kind.AttestedResult), 0, 0);
    expect([split.net, split.protocol, split.partner]).toEqual([pay - judgeFee - fee, fee, 0n]);
    expect(split.net + judgeFee + split.protocol).toBe(pay);
    expect(printed[printed.indexOf("IntentAttested") + 1]).toBe(formatAmount(split.net, 9));
    expect(printed[printed.indexOf("IntentAttested") + 2]).toBe([split.net, judgeFee, split.protocol].map((amount) => formatAmount(amount, 9)).join(" "));
    const paid = [
      tokens(w, await ata(worker?.address ?? signer.address, WSOL)),
      tokens(w, await ata(judge?.address ?? signer.address, WSOL)),
      tokens(w, await ata(w.feeRecipient.address, WSOL)),
    ];
    expect(paid).toEqual([split.net, 2n * judgeFee, 2n * split.protocol + fillFees]);
    expect(fetched).toHaveLength(2);
    expect(new Set(fetched).size).toBe(1);
    expect(printed.filter((line) => line === "true true")).toHaveLength(2);
    const posted = (await findIntentPda({ owner: signer.address, nonce: 6n }))[0];
    expect(await client.deliveries({ judge: judge?.address ?? signer.address, intent: posted })).toMatchObject([{ intent: posted, worker: signer.address }]);
    expect(await client.deliveries({ judge: judge?.address ?? signer.address })).toEqual([]);
    const delivered = (await client.history(posted)).find(({ name }) => name === "IntentAttested");
    expect(delivered?.fields).toMatchObject({ payee: wrapped, net: split.net });
    expect(printed.at(-1)).toBe(`${formatAmount(BigInt(CREATE_FEE), 9)} ${formatAmount(BigInt(BOUNTY), 9)}`);
    expect((w.chain.svm.getBalance(w.feeRecipient.address) ?? 0n) - treasury).toBe(7n * BigInt(CREATE_FEE));
    expect(tokens(w, wrapped)).toBeNull();
    expect(tokens(w, await ata(signer.address, TEST))).toBe((limit?.delivered ?? 0n) + (auction?.delivered ?? 0n));
  });
});

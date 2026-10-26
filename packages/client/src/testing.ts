import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  type KeyPairSigner,
  lamports,
  none,
  type Signature,
  signature,
  some,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintEncoder,
  getMintSize,
  getMintToInstruction,
  getSyncNativeInstruction,
} from "@solana-program/token";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, NATIVE_MINT, parseAmount, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { ALL_KINDS_MASK, buildInitConfig, buildUpdateEconomics, findProgramDataAddress, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { LiteSVM } from "litesvm";
import { MissingAccount } from "./accounts.js";
import { createClient } from "./node.js";
import type { Client } from "./client-types.js";
import type { ClientHooks, DebugLog } from "./observe.js";
import { DEVNET_GENESIS_HASH } from "./job-specs.js";
import { CLUSTER_URLS } from "./simple-tokens.js";
import { svmTransport } from "./svm.js";
import type { Transport } from "./transport.js";

export type TestFees = {
  feeBps: number;
  kindFeeMask: number;
  kindFeeBps: readonly [number, number, number, number];
  partnerCutBps: number;
  crankBounty: number;
  createFee: number;
};

export const DEVNET_FEES: TestFees = { feeBps: 5, kindFeeMask: 30, kindFeeBps: [5, 10, 5, 300], partnerCutBps: 2000, crankBounty: 100_000, createFee: 0 };

export const ECONOMICS_UNSET: Omit<TestFees, "feeBps"> = { kindFeeMask: 0, kindFeeBps: [0, 0, 0, 0], partnerCutBps: 0, crankBounty: 0, createFee: 0 };

export const DEVNET_ENABLED_KINDS = ALL_KINDS_MASK;

export const DEVNET_DOMAIN: Uint8Array = Uint8Array.from(getBase58Encoder().encode(DEVNET_GENESIS_HASH));

export const ENGINE_PROGRAM_FILE = "program/intent_engine.so";

export const TEST_WALLET_SOL = "10";

export const TEST_MINT_DECIMALS = 9;

export type TestWorldOptions = {
  start?: bigint;
  fees?: Partial<TestFees>;
  program?: Uint8Array;
  domain?: Uint8Array;
  url?: string;
  devnetMints?: boolean;
  hooks?: ClientHooks;
  debug?: DebugLog;
};

export type TestWallet = KeyPairSigner & { keypair: Uint8Array };

export type TestWorld = {
  svm: LiteSVM;
  transport: Transport;
  client: Client;
  admin: TestWallet;
  feeRecipient: TestWallet;
  fees: TestFees;
  wallet(sol?: string | number): Promise<TestWallet>;
  mint(decimals?: number): Promise<Address>;
  tokens(owner: Address, mint: Address, amount: bigint): Promise<Address>;
  tokenBalance(owner: Address, mint: Address): Promise<bigint>;
  now(): bigint;
  warp(seconds: bigint | number): bigint;
};

export function shippedProgramPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) {
    dir = dirname(dir);
  }
  return join(dir, ENGINE_PROGRAM_FILE);
}

export function shippedProgram(): Uint8Array {
  return new Uint8Array(readFileSync(shippedProgramPath()));
}

export function testSignature(seed: string | number): Signature {
  return signature(getBase58Decoder().decode(createHash("sha512").update(String(seed)).digest()));
}

export async function testWallet(): Promise<TestWallet> {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  return { ...(await createKeyPairSignerFromBytes(keypair)), keypair };
}

const UPGRADE_AUTHORITY_FLAG = 12;
const UPGRADE_AUTHORITY_AT = 13;
const TOKEN_AMOUNT_AT = 64;

function presetMint(svm: LiteSVM, address: Address, decimals: number, mintAuthority: Address | null): void {
  const space = BigInt(getMintSize());
  svm.setAccount({
    address,
    data: Uint8Array.from(
      getMintEncoder().encode({ mintAuthority: mintAuthority === null ? none() : some(mintAuthority), supply: 0n, decimals, isInitialized: true, freezeAuthority: none() }),
    ),
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function handUpgradeAuthority(svm: LiteSVM, to: Address): Promise<void> {
  const programData = await findProgramDataAddress();
  const account = svm.getAccount(programData);
  if (!account.exists) {
    throw new MissingAccount("program data", programData);
  }
  const data = new Uint8Array(account.data);
  data[UPGRADE_AUTHORITY_FLAG] = 1;
  data.set(getAddressEncoder().encode(to), UPGRADE_AUTHORITY_AT);
  svm.setAccount({ ...account, data });
}

const unset = (fees: TestFees): boolean =>
  fees.kindFeeMask === ECONOMICS_UNSET.kindFeeMask &&
  fees.kindFeeBps.every((bps, kind) => bps === ECONOMICS_UNSET.kindFeeBps[kind]) &&
  fees.partnerCutBps === ECONOMICS_UNSET.partnerCutBps &&
  fees.crankBounty === ECONOMICS_UNSET.crankBounty &&
  fees.createFee === ECONOMICS_UNSET.createFee;

export async function createTestWorld(options: TestWorldOptions = {}): Promise<TestWorld> {
  const fees: TestFees = { ...DEVNET_FEES, ...options.fees };
  const domain = options.domain ?? DEVNET_DOMAIN;
  const devnetMints = options.devnetMints ?? true;
  const svm = devnetMints ? new LiteSVM().withPrecompiles().withNativeMints() : new LiteSVM().withPrecompiles();
  svm.addProgram(INTENT_ENGINE_PROGRAM_ADDRESS, options.program ?? shippedProgram());
  const clock = svm.getClock();
  clock.unixTimestamp = options.start ?? BigInt(Math.floor(Date.now() / 1000));
  svm.setClock(clock);
  const transport = svmTransport(svm, { genesisHash: getBase58Decoder().decode(domain), offline: true });
  const wallet = async (sol: string | number = TEST_WALLET_SOL): Promise<TestWallet> => {
    const made = await testWallet();
    const amount = parseAmount(String(sol), TEST_MINT_DECIMALS);
    if (amount > 0n) {
      svm.airdrop(made.address, lamports(amount));
    }
    return made;
  };
  const admin = await wallet();
  const feeRecipient = await wallet();
  await handUpgradeAuthority(svm, admin.address);
  await transport.send(
    [
      await buildInitConfig({
        authority: admin,
        domain,
        guardian: admin.address,
        feeRecipient: feeRecipient.address,
        enabledKinds: DEVNET_ENABLED_KINDS,
        feeBps: fees.feeBps,
        paused: 0,
      }),
    ],
    admin,
  );
  if (!unset(fees)) {
    await transport.send([await buildUpdateEconomics({ admin, economics: fees })], admin);
  }
  if (devnetMints) {
    presetMint(svm, DEVNET_TEST_MINT, TEST_MINT_DECIMALS, admin.address);
  }
  const mint = async (decimals = TEST_MINT_DECIMALS): Promise<Address> => {
    const created = await generateKeyPairSigner();
    const space = BigInt(getMintSize());
    await transport.send(
      [
        getCreateAccountInstruction({ payer: admin, newAccount: created, lamports: svm.minimumBalanceForRentExemption(space), space, programAddress: TOKEN_PROGRAM_ADDRESS }),
        getInitializeMint2Instruction({ mint: created.address, decimals, mintAuthority: admin.address }),
      ],
      admin,
    );
    return created.address;
  };
  const tokenAccount = (owner: Address, of: Address) => findAssociatedTokenAddress({ owner, mint: of, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const tokens = async (owner: Address, of: Address, amount: bigint): Promise<Address> => {
    const account = await tokenAccount(owner, of);
    const create = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: admin, owner, mint: of });
    if (of !== NATIVE_MINT) {
      await transport.send([create, ...(amount > 0n ? [getMintToInstruction({ mint: of, token: account, mintAuthority: admin, amount })] : [])], admin);
      return account;
    }
    await transport.send([create], admin);
    if (amount > 0n) {
      svm.airdrop(account, lamports(amount));
      await transport.send([getSyncNativeInstruction({ account })], admin);
    }
    return account;
  };
  const tokenBalance = async (owner: Address, of: Address): Promise<bigint> => {
    const found = await transport.getAccount(await tokenAccount(owner, of));
    return found === null || found.data.length < TOKEN_AMOUNT_AT + 8
      ? 0n
      : new DataView(found.data.buffer, found.data.byteOffset).getBigUint64(TOKEN_AMOUNT_AT, true);
  };
  const now = (): bigint => svm.getClock().unixTimestamp;
  const warp = (seconds: bigint | number): bigint => {
    const moved = svm.getClock();
    moved.unixTimestamp += BigInt(seconds);
    svm.setClock(moved);
    return moved.unixTimestamp;
  };
  const client = createClient({
    url: options.url ?? CLUSTER_URLS.devnet,
    transport,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.debug === undefined ? {} : { debug: options.debug }),
  });
  return { svm, transport, client, admin, feeRecipient, fees, wallet, mint, tokens, tokenBalance, now, warp };
}

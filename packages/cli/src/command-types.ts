import type { App } from "./add-to.js";
import type { Priority } from "./compute.js";
import type { Sandbox } from "./sandbox.js";
import type { Tokens } from "./arg-options.js";
import type { Address } from "@solana/kit";
import type { EconomicsSpec, ProfileInput } from "@intent-engine/core";

export type Env = Readonly<Record<string, string | undefined>>;

export type Remote = { url: string; priority: Priority };

export type RelaySpec = {
  keypair: string;
  maxLamports: bigint;
  maxTtl: bigint;
  perHour: number;
  hourlyLamports: bigint;
  fees: ReadonlyMap<Address, bigint>;
};

export type AgentSpec = { keypair: string; hourlyLamports: bigint; owners: Address[] };

export type IssueSpec = { inputMint: Address; outputMint: Address; out: bigint; in: bigint };

export type Keyed = Remote & { keypair: string };

export type Authority = { keypair: string; yes: boolean } | { authority: Address };

export type Administered = Remote & { by: Authority };

export type FlowName = "create" | "mandate-grant" | "mandate-revoke" | "mandate-use" | "approve" | "revoke-approval";

export type LookupName = "list" | "mandate-show";

export type ToolInput = Record<string, unknown>;

export type ConfigChange = {
  guardian: Address | undefined;
  feeRecipient: Address | undefined;
  feeBps: number | undefined;
  enabledKinds: bigint | undefined;
  fillDisabledKinds: bigint | undefined;
};

export type Command =
  | { name: "pda"; owner: Address; nonce: bigint }
  | { name: "hash"; artifact: string }
  | (Remote & { name: "seal"; file: string; to: Address[]; out: string })
  | { name: "unseal"; file: string; keypair: string | undefined; out: string; encryptionKeypairs?: string[] | undefined }
  | (Remote & { name: "spec"; intent: Address; keypair: string | undefined; out: string | undefined })
  | (Remote & { name: "show-config" })
  | (Remote & { name: "domain" })
  | (Remote & { name: "setup"; keypair: string | undefined; confirmUrl?: string | undefined; faucet: boolean })
  | (Remote & { name: "balance"; keypair: string | undefined; owner: Address | undefined; mints: Address[] | null })
  | (Remote & { name: "mcp"; relay: RelaySpec | undefined; agent: AgentSpec | undefined; wallet: WalletLimits | null; allTools: boolean; feePayer?: string | undefined; encryptionKeypairs?: string[] | undefined; confirmUrl?: string | undefined })
  | (Remote & { name: "show-intent"; owner: Address; nonce: bigint })
  | (Remote & { name: "quote"; owner: Address; nonce: bigint; at: bigint | undefined })
  | (Keyed & { name: "cancel"; yes: boolean; nonce: bigint; close: boolean })
  | (Keyed & { name: "expire"; yes: boolean; owner: Address; nonce: bigint })
  | (Keyed & { name: "close"; yes: boolean; owner: Address; nonce: bigint })
  | (Keyed & { name: "close-legacy"; yes: boolean; address: Address })
  | (Keyed & { name: "migrate"; yes: boolean; address: Address | null })
  | (Keyed & { name: "advance-nonce"; base: bigint; yes: boolean })
  | (Keyed & { name: "advance-epoch" })
  | (Administered & {
      name: "init-config";
      guardian: Address;
      feeRecipient: Address;
      feeBps: number;
      enabledKinds: bigint;
      paused: number;
    })
  | (Administered & { name: "raise-pause" | "lower-pause"; flags: number })
  | (Administered & { name: "set-economics"; economics: EconomicsSpec })
  | (Administered & { name: "update-config"; change: ConfigChange })
  | (Administered & { name: "propose-admin"; pendingAdmin: Address })
  | (Administered & { name: "accept-admin" })
  | (Administered & { name: "set-mint-cap"; mint: Address; maxPerOrder: bigint; windowCap: bigint; windowSecs: number; totalLimit?: bigint })
  | (Administered & { name: "set-caps-required"; required: boolean })
  | (Administered & { name: "set-committee-floor"; mint: Address; floor: bigint })
  | (Remote & { name: "show-mint-cap"; mint: Address })
  | (Keyed & {
      name: "solve";
      jupiter: string | undefined;
      issue: IssueSpec[];
      inventory?: IssueSpec[];
      inventoryOwner?: Address;
      jito: string | undefined;
      tipLamports: bigint;
      bundleSize?: number;
      minProfit: ReadonlyMap<Address, bigint>;
      target?: ReadonlyMap<Address, bigint>;
      patience?: number;
      solValue?: ReadonlyMap<Address, { raw: bigint; lamports: bigint }>;
      maxFeeBps: number;
      maxSolCost: bigint;
      maxRent: bigint;
      slippageBps: number;
      routeProgram: Address | undefined;
      lookupTables: Address[];
      concurrency: number;
      watch: number | null;
      quoteTtl?: number;
      stats?: boolean;
      confirmUrl?: string | undefined;
    })
  | (Keyed & { name: "crank"; dryRun: boolean; fundAccounts: boolean })
  | (Remote & { name: "events"; limit: number })
  | (Remote & { name: "jobs"; attestor: Address | undefined; mint: Address | undefined; minPay: string | undefined; unclaimed: boolean })
  | (Keyed & { name: "deliver"; yes: boolean; intent: Address; workUrl: string } & ({ sha256: string } | { artifact: string }))
  | (Remote & { name: "deliveries"; attestor: Address; intent: Address; maxPages: number; judgeKeypair: string | undefined; encryptionKeypairs?: string[] | undefined })
  | (Remote & { name: "receipt"; owner: Address; nonce: bigint; sha256: string | undefined; release?: string })
  | (Keyed & { name: "record-delivery"; yes: boolean; owner: Address; nonce: bigint; sha256: string; release?: string })
  | (Keyed & {
      name: "judge";
      yes: boolean;
      owner: Address;
      nonce: bigint;
      spec: string;
      artifact: string;
      watch: number | null;
      run: string | undefined;
      payTo: Address | undefined;
      result: bigint | undefined;
      timeout: number;
      verdict: string | undefined;
      maxPages: number;
      check: string | undefined;
      sandbox: Sandbox;
      feePayer?: string | undefined;
      encryptionKeypairs?: string[] | undefined;
      confirmUrl?: string | undefined;
    })
  | (Remote & { name: "judge-digest"; owner: Address; nonce: bigint; payTo: Address; result: bigint | undefined })
  | (Keyed & { name: "flow"; flow: FlowName; yes: boolean; input: ToolInput })
  | (Remote & { name: "lookup"; lookup: LookupName; keypair: string | undefined; input: ToolInput })
  | (Keyed & { name: "signed-prepare"; yes: boolean; out: string; input: ToolInput })
  | (Keyed & { name: "signed-submit"; yes: boolean; file: string })
  | { name: "help"; verb: string | undefined }
  | { name: "version" }
  | { name: "add-to"; app: App; limits: string[] }
  | (Remote & { name: "follow"; limit: number; interval: number })
  | (Remote & { name: "treasury"; mints: Address[] | null; create: boolean; keypair: string | undefined; yes: boolean })
  | (Remote & { name: "solver-table"; solver: Address; mints: Address[] })
  | (Keyed & { name: "solver-float"; yes: boolean; delegate: Address; mint: Address; amount: string | Tokens })
  | (Remote & { name: "solver-float-show"; owner: Address; delegate: Address; mints: Address[] | null })
  | (Keyed & { name: "solver-float-revoke"; yes: boolean; mint: Address })
  | (Remote & { name: "monitor"; baseline: string; watch: MonitorSpec | null })
  | (Keyed & { name: "committee-create"; yes: boolean; members: Address[]; threshold: number; feeWallet: Address })
  | (Remote & { name: "committee-show"; committee: Address })
  | (Keyed & {
      name: "committee-vote";
      yes: boolean;
      owner: Address;
      nonce: bigint;
      payTo: Address;
      result: bigint;
      out: string | undefined;
    })
  | (Keyed & { name: "committee-release"; yes: boolean; votes: string[]; sha256: string | undefined; confirmUrl?: string | undefined })
  | (Remote & { name: "claims-show"; owner: Address; nonce: bigint })
  | (Keyed & { name: "claims-open"; yes: boolean; nonce: bigint; maxSecs: number; stake: bigint; workers: Address[] | undefined })
  | (Keyed & { name: "claims-take"; yes: boolean; owner: Address; nonce: bigint; secs: number })
  | (Keyed & { name: "claims-drop"; yes: boolean; owner: Address; nonce: bigint })
  | (Keyed & { name: "claims-settle"; yes: boolean; owner: Address; nonce: bigint })
  | (Keyed & { name: "claims-standby"; yes: boolean; owner: Address; nonce: bigint; secs: number })
  | (Keyed & { name: "claims-leave"; yes: boolean; owner: Address; nonce: bigint; seq: number | undefined })
  | (Keyed & { name: "claims-advance"; yes: boolean; owner: Address; nonce: bigint })
  | (Remote & { name: "profile-show"; wallet: Address })
  | (Keyed & { name: "profile-set"; yes: boolean; profile: ProfileInput; encryptionKey?: string | null | undefined })
  | { name: "profile-encryption-key"; out: string }
  | (Keyed & { name: "profile-close"; yes: boolean })
  | (Remote & { name: "reputation"; worker: Address; maxPages: number; reader?: Address; seeds: Address[] })
  | (Keyed & { name: "feedback"; yes: boolean; intent: Address; score: number; note: string | undefined });

export type MonitorSpec = {
  interval: number;
  since: number;
  maxFill: ReadonlyMap<Address, bigint>;
  maxFills: number | null;
  webhook: string | null;
  once: boolean;
};

export type WalletLimits = { perTrade: ReadonlyMap<Address, string>; perHour: ReadonlyMap<Address, string> };

import type { Priority } from "./compute.js";
import type { Sandbox } from "./sandbox.js";
import type { Address } from "@solana/kit";
import type { EconomicsSpec } from "@intent-engine/core";

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
  | (Remote & { name: "show-config" })
  | (Remote & { name: "domain" })
  | (Remote & { name: "setup"; keypair: string | undefined })
  | (Remote & { name: "balance"; keypair: string | undefined; owner: Address | undefined; mints: Address[] | null })
  | (Remote & { name: "mcp"; relay: RelaySpec | undefined; agent: AgentSpec | undefined; wallet: WalletLimits | null })
  | (Remote & { name: "show-intent"; owner: Address; nonce: bigint })
  | (Remote & { name: "quote"; owner: Address; nonce: bigint; at: bigint | undefined })
  | (Keyed & { name: "cancel"; yes: boolean; nonce: bigint; close: boolean })
  | (Keyed & { name: "expire"; yes: boolean; owner: Address; nonce: bigint })
  | (Keyed & { name: "close"; yes: boolean; owner: Address; nonce: bigint })
  | (Keyed & { name: "advance-nonce"; base: bigint })
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
  | (Administered & { name: "set-mint-cap"; mint: Address; maxPerOrder: bigint; windowCap: bigint; windowSecs: number })
  | (Administered & { name: "set-caps-required"; required: boolean })
  | (Remote & { name: "show-mint-cap"; mint: Address })
  | (Keyed & {
      name: "solve";
      jupiter: string | undefined;
      issue: IssueSpec[];
      jito: string | undefined;
      tipLamports: bigint;
      minProfit: ReadonlyMap<Address, bigint>;
      maxFeeBps: number;
      maxSolCost: bigint;
      maxRent: bigint;
      slippageBps: number;
      routeProgram: Address | undefined;
      lookupTables: Address[];
      watch: number | null;
    })
  | (Keyed & { name: "crank"; dryRun: boolean; fundAccounts: boolean })
  | (Remote & { name: "events"; limit: number })
  | (Remote & { name: "jobs"; attestor: Address | undefined })
  | (Keyed & { name: "deliver"; yes: boolean; intent: Address; workUrl: string } & ({ sha256: string } | { artifact: string }))
  | (Remote & { name: "deliveries"; attestor: Address; intent: Address; maxPages: number })
  | (Remote & { name: "receipt"; owner: Address; nonce: bigint; sha256: string | undefined; release?: string })
  | (Keyed & { name: "record-delivery"; yes: boolean; owner: Address; nonce: bigint; sha256: string; release?: string })
  | (Keyed & {
      name: "judge";
      yes: boolean;
      owner: Address;
      nonce: bigint;
      spec: string;
      artifact: string;
      run: string | undefined;
      payTo: Address | undefined;
      result: bigint | undefined;
      timeout: number;
      verdict: string | undefined;
      maxPages: number;
      check: string | undefined;
      sandbox: Sandbox;
    })
  | (Keyed & { name: "flow"; flow: FlowName; yes: boolean; input: ToolInput })
  | (Remote & { name: "lookup"; lookup: LookupName; keypair: string | undefined; input: ToolInput })
  | (Keyed & { name: "signed-prepare"; yes: boolean; out: string; input: ToolInput })
  | (Keyed & { name: "signed-submit"; yes: boolean; file: string })
  | { name: "help"; verb: string | undefined }
  | { name: "version" }
  | (Remote & { name: "follow"; limit: number; interval: number })
  | (Remote & { name: "treasury"; mints: Address[] | null; create: boolean; keypair: string | undefined; yes: boolean })
  | (Remote & { name: "solver-table"; solver: Address; mints: Address[] })
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
  | (Keyed & { name: "committee-release"; yes: boolean; votes: string[]; sha256: string | undefined })
  | (Remote & { name: "reputation"; worker: Address; maxPages: number })
  | (Keyed & { name: "feedback"; yes: boolean; intent: Address; score: number; note: string | undefined });

export type MonitorSpec = {
  interval: number;
  maxFill: ReadonlyMap<Address, bigint>;
  maxFills: number | null;
  webhook: string | null;
  once: boolean;
};

export type WalletLimits = { perTrade: ReadonlyMap<Address, string>; perHour: ReadonlyMap<Address, string> };

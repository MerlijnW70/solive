import type { Address, Instruction } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { buildClaimsWithList, buildOpenClaims, buildOpenClaimsListed, claimantChunks, isSealed, sealedTo } from "@intent-engine/core/internal";
import { pinnedFetch } from "@intent-engine/client/node";
import { loadCommittee, MAX_SPEC_BYTES } from "@intent-engine/client/internal";
import { fetchBytes } from "../../delivery-fetch.js";
import { priorityLamports } from "../../compute.js";
import { execute } from "../../flows.js";
import { type AgentContext, lookupOf } from "../actions.js";
import type { Call } from "../claims.js";
import type { AfterCreate } from "../create.js";
import { prepare } from "../prepare.js";
import { AgentRefusal, problemOf } from "../problems.js";
import { preparedView } from "../shapes.js";
import { networkFee } from "./costs.js";
import type { WalletSigner } from "./guard.js";
import { offered } from "./offer.js";

export const claimsUnread = (problem: string): string =>
  `spec_url ${problem}, so the wallets its spec invites cannot be read to limit who may claim; nothing was sent; publish the spec first, or escrow without claim_stake and claim_secs`;

export const NO_LISTED_WORKER =
  "the spec at spec_url is sealed to no wallet besides the owner and the attestor, so nobody could claim the job; seal it to the workers you invite, or escrow without claim_stake and claim_secs";

export type ClaimTerms = { maxSecs: number; stake: bigint; floor?: bigint };

export type Claimants = Address[] | undefined;

export type SpecRead = { bytes: Uint8Array } | { problem: string };

export type SpecReader = (specUrl: string) => Promise<SpecRead>;

export function specReader(ctx: AgentContext): SpecReader {
  const read = new Map<string, Promise<SpecRead>>();
  return (specUrl) => {
    const known = read.get(specUrl) ?? fetchBytes(ctx.fetch ?? pinnedFetch, ctx.transport, specUrl, lookupOf(ctx), MAX_SPEC_BYTES);
    read.set(specUrl, known);
    return known;
  };
}

export async function claimants(ctx: AgentContext, found: SpecRead, owner: Address, attestor: Address): Promise<Claimants> {
  if ("problem" in found) {
    throw new AgentRefusal("SpecUnreadable", claimsUnread(found.problem));
  }
  if (!isSealed(found.bytes)) {
    return undefined;
  }
  const committee = await loadCommittee(ctx.transport, attestor);
  const judges = new Set<Address>([owner, attestor, ...(committee?.members ?? [])]);
  const workers = [...new Set(sealedTo(found.bytes))].filter((reader) => !judges.has(reader));
  if (workers.length === 0) {
    throw new AgentRefusal("ClaimListInvalid", NO_LISTED_WORKER);
  }
  return workers;
}

export function claimantsOf(ctx: AgentContext, owner: Address, spec: SpecReader = specReader(ctx)): (specUrl: string, attestor: Address) => Promise<Claimants> {
  const read = new Map<string, Promise<Claimants>>();
  return (specUrl, attestor) => {
    const key = `${attestor} ${specUrl}`;
    const known = read.get(key) ?? spec(specUrl).then((found) => claimants(ctx, found, owner, attestor));
    read.set(key, known);
    return known;
  };
}

export const opener =
  (terms: ClaimTerms, workers: Claimants): AfterCreate =>
  async (owner, intent) => [
    workers === undefined ? await buildOpenClaims({ owner, intent, ...terms }) : await buildOpenClaimsListed({ owner, intent, ...terms, size: workers.length, workers }),
  ];

export const sealedLimits = (workers: readonly Address[]): string =>
  `Limits: claims to the ${workers.length === 1 ? "1 wallet" : `${workers.length} wallets`} the sealed spec invites, leaving out the owner and the attestor: ${workers.join(", ")}; the program refuses a claim or stand-by from any other`;

export const listedLines = (workers: Claimants): string[] => (workers === undefined ? [] : [sealedLimits(workers)]);

export const claimsAfter = (sends: number): string =>
  `Sends: the claims and their list in ${sends === 1 ? "1 more transaction" : `${sends} more transactions`} once the escrow lands, since they do not fit beside it; the escrow takes no claim until they land`;

export const claimsUnopened = (nonce: unknown, terms: ClaimTerms, workers: readonly Address[], problem: string): string =>
  `the escrow is live, but its claims did not all open (${problem}); open or finish them with intent-engine claims open --keypair <this wallet's key file> --nonce ${String(nonce)} --max-secs ${terms.maxSecs} --stake ${formatAmount(terms.stake, 9)} --workers ${workers.join(",")}`;

type Offer = Parameters<typeof offered>;

export type Priced = (lamports: bigint, sends: number) => void;

type Input = Omit<Offer[2], "priced"> & { priced?: Priced | undefined };

const single = (input: Input): Offer[2] => {
  const { priced, ...rest } = input;
  return { ...rest, priced: priced === undefined ? undefined : (lamports) => priced(lamports, 1) };
};

export async function offeredWithClaims(
  ctx: AgentContext,
  call: Call,
  input: Input,
  terms: Offer[3],
  done: string | undefined,
  claims: { terms: ClaimTerms; workers: Claimants } | undefined,
  signer: WalletSigner,
): Promise<Record<string, unknown>> {
  const after = claims === undefined ? undefined : opener(claims.terms, claims.workers);
  try {
    return (await offered(ctx, call, { ...single(input), after }, terms, done)) as Record<string, unknown>;
  } catch (error) {
    const split = claims?.workers !== undefined && signer.device === undefined && error instanceof AgentRefusal && error.problem.code === "ClaimListTooLarge";
    if (!split || claims?.workers === undefined) {
      throw error;
    }
    for (const undo of call.undo.splice(0)) {
      undo();
    }
    return followedByClaims(ctx, call, input, terms, done, claims.terms, claims.workers, signer);
  }
}

const paidBy = (signer: WalletSigner, priority: bigint): bigint => networkFee({ signers: [signer.address], priority_fee_lamports: priority });

export async function previewFees(
  ctx: AgentContext,
  call: Call,
  input: Input,
  pieces: readonly { terms: Offer[3]; claims: { terms: ClaimTerms; workers: Claimants } | undefined }[],
  signer: WalletSigner,
): Promise<{ lamports: bigint; sends: number }[]> {
  const fees: { lamports: bigint; sends: number }[] = [];
  for (const piece of pieces) {
    let fee = { lamports: 0n, sends: 1 };
    const priced: Priced = (lamports, sends) => {
      fee = { lamports, sends };
    };
    await offeredWithClaims(ctx, call, { ...input, send: false, approval: undefined, priced }, piece.terms, undefined, piece.claims, signer);
    fees.push(fee);
  }
  return fees;
}

async function followUpFees(ctx: AgentContext, follow: readonly (readonly Instruction[])[], signer: WalletSigner): Promise<bigint> {
  let total = 0n;
  for (const instructions of follow) {
    total += paidBy(signer, priorityLamports(await ctx.transport.budget(instructions, signer.address)));
  }
  return total;
}

async function followedByClaims(
  ctx: AgentContext,
  call: Call,
  input: Input,
  terms: Offer[3],
  done: string | undefined,
  claims: ClaimTerms,
  workers: readonly Address[],
  signer: WalletSigner,
): Promise<Record<string, unknown>> {
  let first = 0n;
  const made = (await offered(ctx, call, { ...single({ ...input, priced: (lamports) => {
        first = lamports;
      } }), after: undefined }, terms, done)) as Record<string, unknown>;
  const sends = claimantChunks(workers).length;
  const priced = (fees: bigint) => input.priced?.(first + fees, 1 + sends);
  const summary = [...((made["summary"] as string[]) ?? []), claimsAfter(sends)];
  const build = () => buildClaimsWithList({ owner: signer, intent: made["intent"] as Address, ...claims, workers });
  if (made["sent"] !== true) {
    priced(await followUpFees(ctx, await build(), signer));
    return { ...made, summary };
  }
  let fees = 0n;
  try {
    for (const instructions of await build()) {
      const prepared = preparedView(await prepare(ctx.transport, instructions, signer.address));
      await execute(ctx.transport, prepared, signer);
      fees += paidBy(signer, prepared.priority_fee_lamports);
    }
  } catch (error) {
    priced(fees);
    const problem = problemOf(error);
    return { ...made, summary, warnings: [...((made["warnings"] as string[]) ?? []), claimsUnopened(made["nonce"], claims, workers, `${problem.code}: ${problem.hint}`)] };
  }
  priced(fees);
  return { ...made, summary };
}

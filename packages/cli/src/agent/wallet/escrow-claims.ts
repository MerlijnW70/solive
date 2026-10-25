import type { Address } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { buildClaimsWithList, buildOpenClaims, buildOpenClaimsListed, claimantChunks, isSealed, sealedTo } from "@intent-engine/core/internal";
import { pinnedFetch } from "@intent-engine/client/node";
import { loadCommittee, MAX_SPEC_BYTES } from "@intent-engine/client/internal";
import { fetchBytes } from "../../delivery-fetch.js";
import { systemLookup } from "../../public-address.js";
import { execute } from "../../flows.js";
import type { AgentContext } from "../actions.js";
import type { Call } from "../claims.js";
import type { AfterCreate } from "../create.js";
import { prepare } from "../prepare.js";
import { AgentRefusal, problemOf } from "../problems.js";
import { preparedView } from "../shapes.js";
import type { WalletSigner } from "./guard.js";
import { offered } from "./offer.js";

export const claimsUnread = (problem: string): string =>
  `spec_url ${problem}, so the wallets its spec invites cannot be read to limit who may claim; nothing was sent; publish the spec first, or escrow without claim_stake and claim_secs`;

export const NO_LISTED_WORKER =
  "the spec at spec_url is sealed to no wallet besides the owner and the attestor, so nobody could claim the job; seal it to the workers you invite, or escrow without claim_stake and claim_secs";

export type ClaimTerms = { maxSecs: number; stake: bigint };

export type Claimants = Address[] | undefined;

export async function claimants(ctx: AgentContext, specUrl: string, owner: Address, attestor: Address): Promise<Claimants> {
  const found = await fetchBytes(ctx.fetch ?? pinnedFetch, ctx.transport, specUrl, systemLookup, MAX_SPEC_BYTES);
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

export function claimantsOf(ctx: AgentContext, owner: Address): (specUrl: string, attestor: Address) => Promise<Claimants> {
  const read = new Map<string, Promise<Claimants>>();
  return (specUrl, attestor) => {
    const key = `${attestor} ${specUrl}`;
    const known = read.get(key) ?? claimants(ctx, specUrl, owner, attestor);
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

export async function offeredWithClaims(
  ctx: AgentContext,
  call: Call,
  input: Offer[2],
  terms: Offer[3],
  done: string | undefined,
  claims: { terms: ClaimTerms; workers: Claimants } | undefined,
  signer: WalletSigner,
): Promise<Record<string, unknown>> {
  const after = claims === undefined ? undefined : opener(claims.terms, claims.workers);
  try {
    return (await offered(ctx, call, { ...input, after }, terms, done)) as Record<string, unknown>;
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

async function followedByClaims(
  ctx: AgentContext,
  call: Call,
  input: Offer[2],
  terms: Offer[3],
  done: string | undefined,
  claims: ClaimTerms,
  workers: readonly Address[],
  signer: WalletSigner,
): Promise<Record<string, unknown>> {
  const made = (await offered(ctx, call, { ...input, after: undefined }, terms, done)) as Record<string, unknown>;
  const summary = [...((made["summary"] as string[]) ?? []), claimsAfter(claimantChunks(workers).length)];
  if (made["sent"] !== true) {
    return { ...made, summary };
  }
  try {
    for (const instructions of await buildClaimsWithList({ owner: signer, intent: made["intent"] as Address, ...claims, workers })) {
      await execute(ctx.transport, preparedView(await prepare(ctx.transport, instructions, signer.address)), signer);
    }
  } catch (error) {
    const problem = problemOf(error);
    return { ...made, summary, warnings: [...((made["warnings"] as string[]) ?? []), claimsUnopened(made["nonce"], claims, workers, `${problem.code}: ${problem.hint}`)] };
  }
  return { ...made, summary };
}

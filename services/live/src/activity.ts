import type { EngineTransaction } from "@intent-engine/client";
import { type EngineEvent, Kind, NATIVE_MINT } from "@intent-engine/core";
import {
  CREATE_INTENT_BY_AGENT_DISCRIMINATOR,
  CREATE_INTENT_DISCRIMINATOR,
  CREATE_INTENT_SIGNED_DISCRIMINATOR,
  decodeEvent,
  decodeParams,
  getCreateIntentByAgentInstructionDataDecoder,
  getCreateIntentInstructionDataDecoder,
  getCreateIntentSignedInstructionDataDecoder,
} from "@intent-engine/core/internal";
import type { FeedKind, Job } from "./shapes.js";

export type Activity = {
  kind: FeedKind;
  intent: string;
  who: string;
  raw: bigint | null;
  mint: string | null;
  owner: string | null;
  payee?: string;
  attestor?: string;
  signers?: number;
  specHash?: string | null;
  refund?: "cancelled" | "expired";
};

type CreateArgs = { nonce: bigint; kind: number; params: Uint8Array };

const CREATE_DECODERS: readonly { tag: Uint8Array; decode: (data: Uint8Array) => CreateArgs }[] = [
  { tag: Uint8Array.from(CREATE_INTENT_DISCRIMINATOR), decode: (data) => plainArgs(getCreateIntentInstructionDataDecoder().decode(data).args) },
  { tag: Uint8Array.from(CREATE_INTENT_BY_AGENT_DISCRIMINATOR), decode: (data) => plainArgs(getCreateIntentByAgentInstructionDataDecoder().decode(data).args) },
  { tag: Uint8Array.from(CREATE_INTENT_SIGNED_DISCRIMINATOR), decode: (data) => plainArgs(getCreateIntentSignedInstructionDataDecoder().decode(data).args) },
];

function plainArgs(args: { nonce: bigint; kind: number; params: ArrayLike<number> }): CreateArgs {
  return { nonce: args.nonce, kind: args.kind, params: Uint8Array.from(args.params) };
}

export const hexOf = (bytes: ArrayLike<number>): string => Buffer.from(Uint8Array.from(bytes)).toString("hex");

const startsWith = (data: Uint8Array, tag: Uint8Array): boolean => data.length >= tag.length && tag.every((b, i) => data[i] === b);

export function eventsOf(tx: EngineTransaction): EngineEvent[] {
  return tx.emitted.map((data) => decodeEvent(data) as EngineEvent | null).filter((event): event is EngineEvent => event !== null);
}

export type CreatedTerms = { attestor: string; specHash: string };

export function createdTerms(tx: EngineTransaction, intent: string, nonce: bigint): CreatedTerms | null {
  for (const [i, data] of (tx.called ?? []).entries()) {
    if (!(tx.calledAccounts?.[i] ?? []).includes(intent as never)) {
      continue;
    }
    const decoder = CREATE_DECODERS.find(({ tag }) => startsWith(data, tag));
    if (decoder === undefined) {
      continue;
    }
    try {
      const args = decoder.decode(data);
      if (args.nonce !== nonce || args.kind !== Kind.AttestedResult) {
        continue;
      }
      const params = decodeParams(args.kind, args.params);
      if (params.kind === Kind.AttestedResult) {
        return { attestor: params.attestor, specHash: hexOf(params.specHash) };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function soleMint(tx: EngineTransaction): string | null {
  const mints = new Set((tx.tokens ?? []).map(({ mint }) => mint as string));
  return mints.size === 1 ? ([...mints][0] ?? null) : null;
}

type Release = {
  attested?: Extract<EngineEvent, { name: "IntentAttested" }>["fields"];
  split?: Extract<EngineEvent, { name: "IntentSplit" }>["fields"];
  released?: Extract<EngineEvent, { name: "DeliveryReleased" }>["fields"];
  committee?: Extract<EngineEvent, { name: "CommitteeAttested" }>["fields"];
};

function releaseOf(intent: string, release: Release, job: Job | undefined, mint: string | null): Activity | null {
  const { attested, split, released, committee } = release;
  const paid = attested ?? split;
  if (paid === undefined) {
    return null;
  }
  const judge = committee?.committee ?? paid.attestor;
  const payee = attested?.payee ?? released?.worker ?? paid.solver;
  return {
    kind: "release",
    intent,
    who: judge,
    raw: paid.net,
    mint,
    owner: paid.owner ?? job?.owner ?? null,
    payee,
    attestor: judge,
    ...(committee === undefined ? {} : { signers: committee.signers.length }),
  };
}

export function activitiesOf(tx: EngineTransaction, jobs: Readonly<Record<string, Job>>): Activity[] {
  const found: Activity[] = [];
  const releases = new Map<string, Release>();
  const known = (intent: string): string | null => jobs[intent]?.mint ?? soleMint(tx);
  const releaseFor = (intent: string): Release => {
    const existing = releases.get(intent);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: Release = {};
    releases.set(intent, fresh);
    found.push({ kind: "release", intent, who: "", raw: null, mint: null, owner: null });
    return fresh;
  };
  for (const event of eventsOf(tx)) {
    switch (event.name) {
      case "IntentCreated": {
        const { intent, owner, kind, inputMint, escrowed, nonce } = event.fields;
        if (kind !== Kind.AttestedResult) {
          break;
        }
        const terms = createdTerms(tx, intent, nonce);
        const attestor = terms?.attestor ?? jobs[intent]?.attestor;
        found.push({
          kind: "escrow",
          intent,
          who: owner,
          raw: escrowed,
          mint: inputMint,
          owner,
          specHash: terms?.specHash ?? jobs[intent]?.spec_hash ?? null,
          ...(attestor === undefined ? {} : { attestor }),
        });
        break;
      }
      case "JobClaimed":
        found.push({ kind: "claim", intent: event.fields.intent, who: event.fields.worker, raw: event.fields.stake, mint: NATIVE_MINT, owner: jobs[event.fields.intent]?.owner ?? null });
        break;
      case "DeliveryAnnounced":
        found.push({
          kind: "delivery",
          intent: event.fields.intent,
          who: event.fields.worker,
          raw: null,
          mint: null,
          owner: jobs[event.fields.intent]?.owner ?? null,
          attestor: event.fields.attestor,
        });
        break;
      case "IntentAttested":
        releaseFor(event.fields.intent).attested = event.fields;
        break;
      case "IntentSplit":
        releaseFor(event.fields.intent).split = event.fields;
        break;
      case "DeliveryReleased":
        releaseFor(event.fields.intent).released = event.fields;
        break;
      case "CommitteeAttested":
        releaseFor(event.fields.intent).committee = event.fields;
        break;
      case "IntentCancelled":
        found.push({ kind: "refund", intent: event.fields.intent, who: event.fields.owner, raw: event.fields.refunded, mint: known(event.fields.intent), owner: event.fields.owner, refund: "cancelled" });
        break;
      case "IntentExpired":
        found.push({ kind: "refund", intent: event.fields.intent, who: event.fields.refundTo, raw: event.fields.refunded, mint: known(event.fields.intent), owner: event.fields.owner, refund: "expired" });
        break;
      case "IntentFilled":
        found.push({ kind: "swap", intent: event.fields.intent, who: event.fields.solver, raw: event.fields.amountIn, mint: known(event.fields.intent), owner: event.fields.owner });
        break;
      default:
        break;
    }
  }
  return found.flatMap((activity) => {
    if (activity.kind !== "release" || activity.who !== "") {
      return [activity];
    }
    const made = releaseOf(activity.intent, releases.get(activity.intent) ?? {}, jobs[activity.intent], known(activity.intent));
    return made === null ? [] : [made];
  });
}

export function createdJobs(tx: EngineTransaction): { intent: string; owner: string; mint: string; kind: number }[] {
  return eventsOf(tx).flatMap((event) =>
    event.name === "IntentCreated" ? [{ intent: event.fields.intent, owner: event.fields.owner, mint: event.fields.inputMint, kind: event.fields.kind }] : [],
  );
}

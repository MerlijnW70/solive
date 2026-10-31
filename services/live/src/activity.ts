import { type EngineTransaction, escrowTermsIn } from "@intent-engine/client";
import { decodeEvent, type EngineEvent, Kind, NATIVE_MINT } from "@intent-engine/core";
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

export const hexOf = (bytes: ArrayLike<number>): string => Buffer.from(Uint8Array.from(bytes)).toString("hex");

export function eventsOf(tx: EngineTransaction): EngineEvent[] {
  return tx.emitted.map(decodeEvent).filter((event): event is EngineEvent => event !== null);
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
        const { intent, owner, kind, inputMint, escrowed } = event.fields;
        if (kind !== Kind.AttestedResult) {
          break;
        }
        const terms = escrowTermsIn(tx, intent);
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

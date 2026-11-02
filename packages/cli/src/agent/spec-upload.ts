import { createHash } from "node:crypto";
import { isSealed } from "@intent-engine/core/internal";
import { pinnedFetch } from "@intent-engine/client/node";
import { MAX_SPEC_BYTES, MIRROR_OFF, mirrorProblem, PUBLISH_SEALED, publishSpec, specMirror } from "@intent-engine/client/internal";
import { type AgentContext, lookupOf, specReach } from "./actions.js";
import { flag, optional, text } from "./schema.js";

type Read = { bytes: Uint8Array } | { problem: string };

export type UploadTerms = { specHash: string; specText?: string | undefined; found?: Read | undefined; publish?: boolean | undefined };

export type UploadPlan = { bytes: Uint8Array; mirror: string } | { reason: string };

export type UploadFields = { spec_published: boolean; spec_mirror_url?: string; spec_not_published?: string };

export const UPLOAD_OFF = "publish_spec is false";
export const NO_SPEC_BYTES = "no spec_url or spec_text gives the spec's bytes";
export const CLUSTER_UNKNOWN = "the node did not say which cluster this is, so the mirror is not used";
export const SEALED_SIBLING = "another piece's spec_url holds this spec_hash sealed, and a sealed spec is never uploaded";
export const UNREAD_SIBLING = "another piece's spec_url with this spec_hash could not be read, so it could not be checked for sealing";
export const SPEC_OVERSIZE = `the spec is larger than ${MAX_SPEC_BYTES} bytes`;
export const UPLOAD_PUBLIC = "Spec uploads are public and permanent.";
export const UNREAD_NOT_UPLOADED = "so it could not be checked for sealing, and the spec is not uploaded";
export const NOT_ON_MIRROR = "this path does not upload the spec to the mirror, so workers depend on its url; publishSpec in the SDK uploads it";

export const uploadInputs = {
  spec_text: optional(text("the spec's exact text; its sha256 must equal spec_hash. It is uploaded to the public mirror after the send, publicly and for good, so workers can read it when spec_url fails")),
  publish_spec: optional(flag("false keeps the spec off the public mirror; default true")),
};

export const uploadOutputs = {
  spec_published: optional(flag("whether the spec reached the public mirror")),
  spec_mirror_url: optional(text("where the mirror serves the spec")),
  spec_not_published: optional(text("why the spec is not on the mirror")),
};

export const sha256OfText = (specText: string): string => createHash("sha256").update(specText, "utf8").digest("hex");

export const specTextWrong = (sha256: string, specHash: string): string => `hashes to ${sha256}, not spec_hash ${specHash}; nothing was sent; give the exact text, or fix spec_hash`;

export const specTextProblem = (specText: string, specHash: string): string | undefined => {
  const sha256 = sha256OfText(specText);
  return sha256 === specHash.toLowerCase() ? undefined : specTextWrong(sha256, specHash);
};

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function bytesToUpload({ specHash, specText, found }: UploadTerms): Uint8Array | { reason: string } {
  if (found !== undefined && !("problem" in found) && isSealed(found.bytes)) {
    return { reason: PUBLISH_SEALED };
  }
  const given = specText === undefined ? undefined : new TextEncoder().encode(specText);
  if (given !== undefined && isSealed(given)) {
    return { reason: PUBLISH_SEALED };
  }
  if (found !== undefined && "problem" in found) {
    return { reason: `spec_url ${found.problem}${given === undefined ? "" : `, ${UNREAD_NOT_UPLOADED}`}` };
  }
  if (given !== undefined) {
    return given.length > MAX_SPEC_BYTES ? { reason: SPEC_OVERSIZE } : given;
  }
  if (found === undefined) {
    return { reason: NO_SPEC_BYTES };
  }
  const sha256 = sha256Of(found.bytes);
  if (found.bytes.length > MAX_SPEC_BYTES) {
    return { reason: SPEC_OVERSIZE };
  }
  return sha256 === specHash.toLowerCase() ? found.bytes : { reason: `spec_url hashes to ${sha256}, not spec_hash ${specHash}` };
}

export async function uploadPlan(ctx: AgentContext, terms: UploadTerms): Promise<UploadPlan> {
  if (terms.publish === false) {
    return { reason: UPLOAD_OFF };
  }
  const bytes = bytesToUpload(terms);
  if (!(bytes instanceof Uint8Array)) {
    return bytes;
  }
  const mirror = specMirror();
  if (mirror === null) {
    return { reason: MIRROR_OFF };
  }
  const problem = await mirrorProblem(ctx.transport, mirror).catch(() => CLUSTER_UNKNOWN);
  return problem === null ? { bytes, mirror } : { reason: problem };
}

const holdsSealed = (found: Read | undefined): boolean => found !== undefined && !("problem" in found) && isSealed(found.bytes);

export async function pieceUploadPlans(ctx: AgentContext, terms: readonly (UploadTerms | undefined)[]): Promise<(UploadPlan | undefined)[]> {
  return Promise.all(
    terms.map(async (term) => {
      if (term === undefined) {
        return undefined;
      }
      const plan = await uploadPlan(ctx, term);
      const same = terms.filter((other) => other?.specHash.toLowerCase() === term.specHash.toLowerCase());
      if (!("mirror" in plan)) {
        return plan;
      }
      if (same.some((other) => holdsSealed(other?.found))) {
        return { reason: SEALED_SIBLING };
      }
      return term.specText !== undefined && same.some((other) => other?.found !== undefined && "problem" in other.found) ? { reason: UNREAD_SIBLING } : plan;
    }),
  );
}

export const uploadBound = (plan: UploadPlan | undefined): string | null => (plan !== undefined && "mirror" in plan ? plan.mirror : null);

export const uploadLine = (plan: UploadPlan, off = "publish_spec: false"): string =>
  "mirror" in plan ? `Mirror: after the send, the spec goes to the public mirror ${plan.mirror}, where anyone can read it for good; ${off} keeps it off` : `Mirror: the spec is not uploaded: ${plan.reason}`;

export function planLines(plans: readonly (UploadPlan | undefined)[], off = "publish_spec: false"): string[] {
  const pieces = (wanted: (plan: UploadPlan) => boolean) => plans.flatMap((plan, i) => (plan !== undefined && wanted(plan) ? [i + 1] : []));
  const going = pieces((plan) => "mirror" in plan);
  const first = plans.find((plan) => plan !== undefined && "mirror" in plan) as { mirror: string } | undefined;
  const skipped = plans.flatMap((plan, i) => (plan !== undefined && "reason" in plan ? [`piece ${i + 1}: ${plan.reason}`] : []));
  return [
    ...(first === undefined
      ? []
      : [
          going.length === 1
            ? `Mirror: after the send, the spec of piece ${going[0]} goes to the public mirror ${first.mirror}, where anyone can read it for good; ${off} keeps it off`
            : `Mirror: after the send, the specs of pieces ${going.join(", ")} go to the public mirror ${first.mirror}, where anyone can read them for good; ${off} keeps them off`,
        ]),
    ...(skipped.length === 0 ? [] : [`Mirror: not uploaded: ${skipped.join("; ")}`]),
  ];
}

async function sentToMirror(ctx: AgentContext, plan: { bytes: Uint8Array; mirror: string }): Promise<UploadFields & { failed: boolean }> {
  const { rpcUrl } = specReach(ctx);
  try {
    const done = await publishSpec(plan.bytes, { transport: ctx.transport, fetch: ctx.fetch ?? pinnedFetch, lookup: lookupOf(ctx), mirror: plan.mirror, ...(rpcUrl === undefined ? {} : { rpcUrl }) });
    return done.published ? { spec_published: true, spec_mirror_url: done.url, failed: false } : { spec_published: false, spec_not_published: done.reason, failed: true };
  } catch (error) {
    return { spec_published: false, spec_not_published: error instanceof Error ? error.message : String(error), failed: true };
  }
}

export async function uploadsAfterSend(ctx: AgentContext, plans: readonly (UploadPlan | undefined)[]): Promise<{ fields: (UploadFields | undefined)[]; failed: boolean }> {
  const once = new Map<string, Promise<UploadFields & { failed: boolean }>>();
  const results = plans.map((plan) => {
    if (plan === undefined) {
      return undefined;
    }
    if ("reason" in plan) {
      return Promise.resolve({ spec_published: false, spec_not_published: plan.reason, failed: false });
    }
    const key = sha256Of(plan.bytes);
    const known = once.get(key) ?? sentToMirror(ctx, plan);
    once.set(key, known);
    return known;
  });
  const settled = await Promise.all(results);
  return {
    fields: settled.map((result) => {
      if (result === undefined) {
        return undefined;
      }
      const { failed: _, ...fields } = result;
      return fields;
    }),
    failed: settled.some((result) => result?.failed === true),
  };
}

export const uploadFailed = (hasUrl: boolean): string => `the spec is not on the mirror (see spec_not_published), so ${hasUrl ? "workers read it only from spec_url; keep that url online" : "workers cannot read it until you give them the spec"}`;

export const withUploadHint = (next: unknown, hint: string): string => (typeof next === "string" ? `${next}; ${hint}` : hint);

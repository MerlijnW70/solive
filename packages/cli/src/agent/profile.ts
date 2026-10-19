import { createHash } from "node:crypto";
import {
  buildCloseProfile,
  buildCreateProfile,
  buildUpdateProfile,
  checkProfile,
  IntentCoreError,
  PROFILE_MAX_SKILLS,
  type ProfileInput,
  profileAddress,
} from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { type AgentContext, define } from "./actions.js";
import type { Call } from "./claims.js";
import { tool } from "./names.js";
import { AgentRefusal, ENGINE_PROBLEMS } from "./problems.js";
import { account, choice, flag, hex32, InvalidInput, list, nullable, object, optional, text, time } from "./schema.js";
import { preparedView } from "./shapes.js";
import { prepare } from "./prepare.js";
import { deviceOutput, PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, signerOf, sent } from "./wallet/guard.js";

export const PROFILE_CHANGED =
  "this profile differs from its preview: its skills, endpoint or document changed, or no approval was given; preview it again and show the user";

export const NO_PROFILE_TO_CLOSE = "this server's wallet has published no profile, so there is nothing to close";

const clientOf = (ctx: AgentContext) => createClient({ url: ctx.url ?? "", transport: ctx.transport });

export const getProfile = define({
  name: tool("get_profile"),
  title: "A worker's published profile",
  description: `Read the profile a wallet published on chain: the skills it offers, the https endpoint where it takes work, and an optional document with its sha256. The wallet wrote it itself, so check its track record with ${tool("get_reputation")} before trusting it.`,
  effect: "read",
  input: object({ wallet: account("the wallet whose profile to read") }),
  output: object({
    wallet: account(),
    profile: account("the profile account's address"),
    published: flag("false means the wallet has no profile"),
    skills: optional(list(text(), PROFILE_MAX_SKILLS)),
    endpoint: optional(text()),
    doc_url: optional(nullable(text())),
    doc_sha256: optional(nullable(text("the document's sha256 as 64 hex digits"))),
    updated_at: optional(time()),
  }),
  run: async (ctx, input) => {
    const profile = await profileAddress(input.wallet);
    const found = await clientOf(ctx).profile(input.wallet);
    if (found === null) {
      return { wallet: input.wallet, profile, published: false };
    }
    return {
      wallet: input.wallet,
      profile,
      published: true,
      skills: found.skills,
      endpoint: found.endpoint,
      doc_url: found.docUrl,
      doc_sha256: found.docSha256,
      updated_at: found.updatedAt,
    };
  },
});

function profileOf(input: { skills?: string[] | undefined; endpoint?: string | undefined; doc_url?: string | undefined; doc_sha256?: string | undefined }): ProfileInput {
  if (input.skills === undefined || input.endpoint === undefined) {
    throw new InvalidInput([{ path: input.skills === undefined ? "skills" : "endpoint", message: "give skills and endpoint, or close: true" }]);
  }
  try {
    return checkProfile({
      skills: input.skills,
      endpoint: input.endpoint,
      ...(input.doc_url === undefined ? {} : { docUrl: input.doc_url }),
      ...(input.doc_sha256 === undefined ? {} : { docSha256: input.doc_sha256 }),
    });
  } catch (error) {
    throw error instanceof IntentCoreError ? new AgentRefusal("ProfileInvalid", ENGINE_PROBLEMS.ProfileInvalid.hint) : error;
  }
}

export const walletProfile = define({
  name: tool("wallet_profile"),
  title: "Publish this wallet's profile",
  description: `Tells payers what work the user takes and where: publishes, updates or closes this wallet's public profile (1 to 8 skill tags, an https endpoint, an optional document url), which ${tool("get_profile")} reads. Publishing pays a rent deposit; close: true returns it. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  input: object({
    skills: optional(list(text("a tag of 1 to 16 of a-z, 0-9 and -, not starting or ending with -"), PROFILE_MAX_SKILLS, "distinct skill tags", 1)),
    endpoint: optional(text("an https url of at most 128 printable characters where this wallet takes work")),
    doc_url: optional(text("an https url of a document describing this wallet's work; needs doc_sha256")),
    doc_sha256: optional(hex32("the document's sha256; needs doc_url")),
    close: optional(flag("true closes the profile instead")),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true sends the change; leave out to preview")),
  }),
  output: object({
    wallet: account(),
    profile: account(),
    action: choice(["create", "update", "close"] as const),
    approval: text(),
    summary: list(text(), 6),
    ...deviceOutput,
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const profile = await profileAddress(signer.address);
    const existing = await clientOf(ctx).profile(signer.address);
    let instruction;
    let action: "create" | "update" | "close";
    let summary: string[];
    if (input.close === true) {
      if (existing === null) {
        throw new AgentRefusal("NotFound", NO_PROFILE_TO_CLOSE);
      }
      instruction = await buildCloseProfile({ wallet: signer });
      action = "close";
      summary = [`Closes: the profile of this wallet ${signer.address} and returns its rent`];
    } else {
      const fields = profileOf(input);
      action = existing === null ? "create" : "update";
      instruction = existing === null ? await buildCreateProfile({ wallet: signer, ...fields }) : await buildUpdateProfile({ wallet: signer, ...fields });
      summary = [
        `${existing === null ? "Creates" : "Updates"}: the profile of this wallet ${signer.address}`,
        `Skills: ${fields.skills.join(", ")}`,
        `Endpoint: ${fields.endpoint}`,
        fields.docUrl === undefined ? "Document: none" : `Document: ${fields.docUrl} with sha256 ${fields.docSha256}`,
      ];
    }
    const approval = createHash("sha256").update(JSON.stringify({ action, summary })).digest("hex").slice(0, 16);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", PROFILE_CHANGED);
    }
    const shown = {
      wallet: signer.address,
      profile,
      action,
      approval,
      summary,
      prepared: input.send === true || signer.device !== undefined ? preparedView(await prepare(ctx.transport, [instruction], signer.address)) : undefined,
    };
    return sent(ctx, signer, shown, input.send, call, {
      preview: PREVIEW_APPROVAL_NEXT,
      done: `profile live; ${tool("get_profile")} reads it`,
    });
  },
});

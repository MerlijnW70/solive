import { type Transport } from "@intent-engine/client";
import { loadConfig } from "@intent-engine/client/internal";
import { escrowReceipt } from "./agent/wallet.js";
import type { Command } from "./command-types.js";
import type { Runtime } from "./runtime.js";
import { freezeFields, pricedJobs } from "./job-filters.js";

type JobCommand = Extract<Command, { name: "jobs" | "receipt" }>;

export const NO_JOB_OPEN =
  "no job is open right now; run intent-engine jobs again in a few minutes to wait for one, or post one yourself with intent-engine create attested, as the first paid job guide shows";

export const NO_JOB_MATCHES =
  "no open job matches these options right now; run intent-engine jobs without them to see every open job, run it again in a few minutes to wait for one, or post one yourself with intent-engine create attested, as the first paid job guide shows";

export async function jobCommand(command: JobCommand, _runtime: Runtime, transport: Transport): Promise<object> {
  switch (command.name) {
    case "jobs": {
      const { jobs, unreadable } = await pricedJobs(transport, command, (await loadConfig(transport)).config);
      const filtered = command.attestor !== undefined || command.mint !== undefined || command.minPay !== undefined || command.unclaimed === true;
      return {
        jobs: jobs.map(
          ({ netPay, payable, takesClaims, claimedBy, claimEnds, waiting, freezeAuthority, pays, ...job }) => ({
            ...job,
            net_pay: netPay,
            payable,
            takes_claims: takesClaims,
            claimed_by: claimedBy,
            claim_ends: claimEnds,
            waiting,
            ...freezeFields(freezeAuthority, job.owner),
          }),
        ),
        ...(unreadable.length === 0 ? {} : { unreadable: unreadable.map(({ address, reason }) => ({ intent: address, skipped: reason })) }),
        ...(jobs.length > 0 ? {} : { next: filtered ? NO_JOB_MATCHES : NO_JOB_OPEN }),
      };
    }
    case "receipt":
      return escrowReceipt(transport, command.owner, command.nonce, command.sha256, command.release);
  }
}

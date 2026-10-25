import { type Transport } from "@intent-engine/client";
import { loadConfig } from "@intent-engine/client/internal";
import { escrowReceipt } from "./agent/wallet.js";
import type { Command } from "./command-types.js";
import type { Runtime } from "./runtime.js";
import { freezeFields, pricedJobs } from "./job-filters.js";

type JobCommand = Extract<Command, { name: "jobs" | "receipt" }>;

export async function jobCommand(command: JobCommand, _runtime: Runtime, transport: Transport): Promise<object> {
  switch (command.name) {
    case "jobs": {
      const { jobs, unreadable } = await pricedJobs(transport, command, (await loadConfig(transport)).config);
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
      };
    }
    case "receipt":
      return escrowReceipt(transport, command.owner, command.nonce, command.sha256, command.release);
  }
}

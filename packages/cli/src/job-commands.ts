import { loadConfig, type Transport } from "@intent-engine/client";
import { escrowReceipt } from "./agent/wallet.js";
import type { Command } from "./command-types.js";
import type { Runtime } from "./runtime.js";
import { freezeFields, pricedJobs } from "./job-filters.js";

type JobCommand = Extract<Command, { name: "jobs" | "receipt" }>;

export async function jobCommand(command: JobCommand, _runtime: Runtime, transport: Transport): Promise<object> {
  switch (command.name) {
    case "jobs":
      return {
        jobs: (await pricedJobs(transport, command, (await loadConfig(transport)).config)).map(
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
      };
    case "receipt":
      return escrowReceipt(transport, command.owner, command.nonce, command.sha256, command.release);
  }
}

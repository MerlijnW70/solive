import { createClient, feedbackInstructions, type Transport } from "@intent-engine/client";
import { previewed } from "./admin-commands.js";
import type { Command } from "./command-types.js";
import type { Runtime } from "./runtime.js";

type ReputationCommand = Extract<Command, { name: "reputation" | "feedback" }>;

export async function reputationCommand(command: ReputationCommand, runtime: Runtime, transport: Transport): Promise<object> {
  switch (command.name) {
    case "reputation":
      return createClient({ url: command.url, transport }).reputation(command.worker, { pages: command.maxPages });
    case "feedback": {
      const owner = await runtime.loadSigner(command.keypair);
      const input = { owner, intent: command.intent, score: command.score, ...(command.note === undefined ? {} : { note: command.note }) };
      const instructions = await feedbackInstructions(transport, input);
      const summary = [
        `Rates: the work released by escrow ${command.intent} ${command.score} out of 100, signed by its owner ${owner.address}`,
        ...(command.note === undefined ? [] : [`Links: the note with sha256 ${command.note}`]),
        "Counts: once; the owner's first feedback on an escrow is the one that counts",
      ];
      return previewed(transport, instructions, owner, { intent: command.intent, score: command.score, summary }, command.yes);
    }
  }
}

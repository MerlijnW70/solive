import type { Address, TransactionSigner } from "@solana/kit";
import { U64_MAX } from "@intent-engine/core";
import { memoized, PLAIN_HTTP_ON_PUBLIC, plainHttpOnPublic, type Transport } from "@intent-engine/client";
import { claimsOf } from "./agent/claims.js";
import { relayOf } from "./agent/relay.js";
import type { Command } from "./command-types.js";
import { messageSigner, transactionSigner } from "./ledger-keys.js";
import type { Runtime } from "./runtime.js";
import type { AgentContext } from "./agent/actions.js";
import { prepareCreate } from "./agent/create.js";
import { getMandate, loadMandate, prepareAgentCreate, prepareMandate, prepareRevokeMandate } from "./agent/mandate.js";
import { listIntents } from "./agent/read.js";
import { prepareSignedIntent, previewSignedIntent, submitSignedIntent } from "./agent/signed.js";
import { approval, ask, finish, FlowRefused, hasTokens, inRaw, NOT_SENT, perform, signMessage } from "./flows.js";
import { RELAY_MAX_TTL } from "./command-builders.js";

const SIGNED_FILE_VERSION = 1;

function relayAnything(signer: TransactionSigner, mint: Address) {
  return relayOf(signer, {
    maxLamports: U64_MAX,
    maxTtl: BigInt(RELAY_MAX_TTL),
    perHour: Number.MAX_SAFE_INTEGER,
    hourlyLamports: U64_MAX,
    fees: new Map([[mint, 0n]]),
  });
}

async function rawFlowInput(
  transport: Transport,
  flow: string,
  input: Record<string, unknown>,
  signer: Address,
): Promise<Record<string, unknown>> {
  if (flow === "approve" || flow === "revoke-approval") {
    const mint = input["mint"] as Address;
    return inRaw(transport, input, mint, mint);
  }
  if (flow === "mandate-use") {
    if (!hasTokens(input)) {
      return input;
    }
    const owner = input["owner"] as Address;
    const id = input["id"] === undefined ? 0n : BigInt(input["id"] as string);
    const { mandate } = await loadMandate(transport, owner, signer, id);
    return inRaw(transport, input, mandate.inputMint, mandate.outputMint);
  }
  if (flow === "mandate-revoke") {
    return input;
  }
  return inRaw(transport, input, input["input_mint"] as Address, input["output_mint"] as Address);
}

function context(transport: Transport, relay: AgentContext["relay"] = undefined): AgentContext {
  return { transport, relay, agent: undefined, claims: claimsOf() };
}

type FlowCommand = Extract<Command, { name: "flow" | "lookup" | "signed-prepare" | "signed-submit" }>;

export async function flowCommand(command: FlowCommand, runtime: Runtime, transport: Transport): Promise<object> {
  switch (command.name) {
    case "flow": {
      const signer = await transactionSigner(runtime, command.keypair);
      const reading = memoized(transport);
      const ctx = context(reading);
      const raw = await rawFlowInput(reading, command.flow, command.input, signer.address);
      switch (command.flow) {
        case "create": {
          const specUrl = raw["spec_url"];
          if (typeof specUrl === "string" && (await plainHttpOnPublic(reading, specUrl))) {
            throw new FlowRefused(`--spec-url ${specUrl} ${PLAIN_HTTP_ON_PUBLIC}`);
          }
          return perform(prepareCreate, ctx, { owner: signer.address, ...raw }, signer, command.yes);
        }
        case "mandate-grant":
          return perform(prepareMandate, ctx, { owner: signer.address, ...raw }, signer, command.yes);
        case "mandate-revoke":
          return perform(prepareRevokeMandate, ctx, { owner: signer.address, ...raw }, signer, command.yes);
        case "mandate-use":
          return perform(prepareAgentCreate, ctx, { agent: signer.address, ...raw }, signer, command.yes);
        case "approve":
        case "revoke-approval": {
          const input = raw as { mint: Address; amount?: string };
          return approval(
            transport,
            signer,
            input.mint,
            input.amount === undefined ? undefined : BigInt(input.amount),
            command.yes,
          );
        }
      }
      throw new FlowRefused(`unknown flow ${String(command.flow)}`);
    }
    case "lookup": {
      const owner =
        (command.input["owner"] as Address | undefined) ??
        (command.keypair === undefined ? undefined : (await runtime.loadSigner(command.keypair)).address);
      if (owner === undefined) {
        throw new FlowRefused("name the owner with --owner or --keypair");
      }
      const action = command.lookup === "list" ? listIntents : getMandate;
      return ask(action, context(transport), { ...command.input, owner });
    }
    case "signed-prepare": {
      const owner = await messageSigner(runtime, command.keypair);
      const input = await inRaw(
        transport,
        command.input,
        command.input["input_mint"] as Address,
        command.input["output_mint"] as Address,
      );
      if (command.yes && (await runtime.readText(command.out).then(() => true, () => false))) {
        throw new FlowRefused(`${command.out} already exists; choose another --out`);
      }
      const value = await ask(prepareSignedIntent, context(transport), { owner: owner.address, ...input });
      if (!command.yes) {
        return finish(transport, value, owner, false);
      }
      const signature = await signMessage(owner, value["message"] as string);
      const shown = await finish(transport, value, owner, true);
      await runtime.writeText(
        command.out,
        `${JSON.stringify({ version: SIGNED_FILE_VERSION, submit: value["submit"], signature }, null, 2)}\n`,
      );
      return { ...shown, saved: command.out };
    }
    case "signed-submit": {
      const relayer = await runtime.loadSigner(command.keypair);
      let saved: { version?: unknown; submit?: Record<string, unknown>; signature?: unknown };
      try {
        saved = JSON.parse(await runtime.readText(command.file)) as typeof saved;
      } catch {
        throw new FlowRefused(`${command.file} is not a signed intent file`);
      }
      if (saved.version !== SIGNED_FILE_VERSION || saved.submit === undefined || typeof saved.signature !== "string") {
        throw new FlowRefused(`${command.file} is not a signed intent file`);
      }
      const signed = { ...saved.submit, signature: saved.signature };
      if (!command.yes) {
        return { ...(await ask(previewSignedIntent, context(transport), signed)), sent: false, next: NOT_SENT };
      }
      return { ...(await ask(submitSignedIntent, context(transport, relayAnything(relayer, String(saved.submit["input_mint"]) as Address)), signed)), sent: true };
    }
  }
}

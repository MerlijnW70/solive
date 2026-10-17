import type { TransactionPartialSigner } from "@solana/kit";
import { isLedgerPath, LedgerPathError, ledgerSigner, openUsb, parseLedgerPath } from "@intent-engine/client";
import { UsageError } from "./arg-values.js";
import type { Command } from "./command-types.js";
import type { Runtime } from "./runtime.js";

export const LEDGER_COMMANDS = [
  "create",
  "cancel",
  "expire",
  "close",
  "approve",
  "revoke-approval",
  "deliver",
  "advance-nonce",
  "advance-epoch",
  "claims take",
  "claims drop",
  "mandate grant",
  "mandate revoke",
];

const DEVICE_COMMANDS = new Set(LEDGER_COMMANDS);

const SPACED = /^(claims|committee|mandate|profile|signed)-/;

export function commandName(command: Command): string {
  const name = command.name === "flow" ? command.flow : command.name === "lookup" ? command.lookup : command.name;
  return name.replace(SPACED, "$1 ");
}

function keyPaths(command: Command): string[] {
  const found = command as { keypair?: unknown; relay?: { keypair?: unknown }; agent?: { keypair?: unknown }; by?: { keypair?: unknown } };
  return [found.keypair, found.relay?.keypair, found.agent?.keypair, found.by?.keypair].filter((path): path is string => typeof path === "string");
}

export const needsKeyFile = (name: string, path: string) =>
  `${name} needs a key file, not the Ledger ${path}, because it also signs messages; pass --keypair with a JSON key file`;

export const signsOnDevice = (command: Command): boolean => DEVICE_COMMANDS.has(commandName(command));

export function checkLedgerPaths(command: Command): void {
  const devices = keyPaths(command).filter(isLedgerPath);
  if (devices.length === 0) {
    return;
  }
  const name = commandName(command);
  if (!signsOnDevice(command)) {
    throw new UsageError(needsKeyFile(name, devices[0] ?? ""));
  }
  for (const path of devices) {
    try {
      parseLedgerPath(path);
    } catch (error) {
      throw new UsageError(`--keypair ${error instanceof LedgerPathError ? error.message : String(error)}`);
    }
  }
}

export const transactionSigner = async (runtime: Runtime, path: string): Promise<TransactionPartialSigner> =>
  isLedgerPath(path) ? ledgerSigner(path, runtime.ledger ?? openUsb) : runtime.loadSigner(path);

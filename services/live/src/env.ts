import { type Address, isAddress } from "@solana/kit";
import { DEFAULT_RPC_URL } from "./limits.js";

export type FeedConfig = {
  readonly rpcUrl: string;
  readonly house: ReadonlySet<string>;
  readonly faucet: Address | null;
  readonly demoWorker: Address | null;
  readonly filler: Address | null;
};

export type Env = Readonly<Record<string, string | undefined>>;

function addressOf(text: string | undefined): Address | null {
  const trimmed = text?.trim() ?? "";
  return trimmed !== "" && isAddress(trimmed) ? trimmed : null;
}

export function houseOf(text: string | undefined): ReadonlySet<string> {
  return new Set(
    (text ?? "")
      .split(",")
      .map((part) => addressOf(part))
      .filter((address): address is Address => address !== null),
  );
}

export function configFrom(env: Env): FeedConfig {
  const url = env["FEED_RPC_URL"]?.trim();
  return {
    rpcUrl: url === undefined || url === "" ? DEFAULT_RPC_URL : url,
    house: houseOf(env["FEED_HOUSE"]),
    faucet: addressOf(env["FEED_FAUCET"]),
    demoWorker: addressOf(env["FEED_DEMO_WORKER"]),
    filler: addressOf(env["FEED_FILLER"]),
  };
}

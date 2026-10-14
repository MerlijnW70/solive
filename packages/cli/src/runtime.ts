import type { KeyPairSigner } from "@solana/kit";
import type { Fetch } from "@intent-engine/solver";
import type { McpServer } from "@modelcontextprotocol/server";
import type { IntentChanges, Transport } from "@intent-engine/client";
import type { SaleBook } from "./agent/sales.js";
import type { Env } from "./command-types.js";

export type Runtime = {
  transport(url: string): Transport;
  intentChanges(url: string): IntentChanges;
  loadSigner(path: string): Promise<KeyPairSigner>;
  readText(path: string): Promise<string>;
  sleep(seconds: number): Promise<boolean>;
  env: Env;
  writeText(path: string, text: string): Promise<void>;
  saveText(path: string, text: string, secret: boolean): Promise<void>;
  home: string;
  now(): bigint;
  fetch: Fetch;
  entropy(): number;
  serve(server: McpServer): Promise<void>;
  saleBook?: SaleBook;
};

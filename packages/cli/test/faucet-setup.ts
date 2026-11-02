import { afterEach } from "vitest";
import { assertNoFaucetHits, FAUCET_ENV, guardedFetch } from "./faucet-guard.js";

process.env[FAUCET_ENV] = "off";
globalThis.fetch = guardedFetch(globalThis.fetch);

afterEach(assertNoFaucetHits);

import type { AnyAction } from "./actions.js";
import { prepareCreate } from "./create.js";
import { agentCreate, getMandate, prepareAgentCreate, prepareMandate, prepareRevokeMandate } from "./mandate.js";
import { findJobs, getBalances, getConfig, getIntent, listIntents, quote } from "./read.js";
import { findCrankWork, prepareCancel, prepareCrank } from "./settle.js";
import { prepareSignedIntent, submitSignedIntent } from "./signed.js";

export const ACTIONS: readonly AnyAction[] = [
  getConfig,
  getIntent,
  listIntents,
  getBalances,
  quote,
  prepareCreate,
  prepareCancel,
  findCrankWork,
  findJobs,
  prepareCrank,
  prepareSignedIntent,
  submitSignedIntent,
  prepareMandate,
  getMandate,
  prepareRevokeMandate,
  prepareAgentCreate,
  agentCreate,
];

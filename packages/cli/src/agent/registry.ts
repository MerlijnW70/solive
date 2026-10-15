import type { AnyAction } from "./actions.js";
import { prepareCreate } from "./create.js";
import { agentCreate, getMandate, prepareAgentCreate, prepareMandate, prepareRevokeMandate } from "./mandate.js";
import { findJobs, getBalances, getConfig, getIntent, listIntents, quote } from "./read.js";
import { getReputation } from "./reputation.js";
import { getClaims } from "./work-claims.js";
import { getProfile } from "./profile.js";
import { findCrankWork, prepareCancel, prepareCrank } from "./settle.js";
import { prepareSignedIntent, previewSignedIntent, submitSignedIntent } from "./signed.js";
import { checkDelivery, getReceipt, prepareDeliver } from "./wallet.js";

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
  prepareDeliver,
  checkDelivery,
  getReceipt,
  getReputation,
  getClaims,
  getProfile,
  prepareCrank,
  prepareSignedIntent,
  previewSignedIntent,
  submitSignedIntent,
  prepareMandate,
  getMandate,
  prepareRevokeMandate,
  prepareAgentCreate,
  agentCreate,
];

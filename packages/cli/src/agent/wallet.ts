import type { AnyAction } from "./actions.js";
import { walletSetup, walletBalance, walletIntents, walletCancel } from "./wallet/account.js";
import { walletEstimate, walletSwap, walletAuction, walletRecurring } from "./wallet/trade.js";
import { walletEscrow, walletEscrowPlan } from "./wallet/escrow.js";
import { walletAttest } from "./wallet/attest.js";
import { walletDeliver, walletCheckDelivery } from "./wallet/delivery.js";
import { walletAttestSplit } from "./wallet/split.js";
import { walletCommitteeRelease, walletCommitteeVote } from "./wallet/committee.js";
import { walletFeedback } from "./reputation.js";
import { walletClaim } from "./work-claims.js";
import { walletProfile } from "./profile.js";
import { walletRecordDelivery } from "./wallet/record.js";
import { walletWait } from "./wallet/wait.js";
import { walletReceipt } from "./wallet/receipt.js";

export {
  walletGuard,
  SALE_WINDOW,
  ESTIMATE_SCAN,
  ESTIMATE_FILLS,
  WAIT_DEFAULT,
  WAIT_MAX,
  WAIT_SCAN,
  DEFAULT_EXPIRES_IN,
  LANDING_SECONDS,
  MAINNET_GENESIS,
  WALLET_NOTICE,
  walletEmpty,
  NO_WALLET,
  WALLET_OFF,
  PREVIEW_ONLY,
  limitLines,
  rpcRefused,
} from "./wallet/guard.js";
export type { WalletGuard, WalletAccess } from "./wallet/guard.js";
export { walletBalance } from "./wallet/account.js";
export { nonceTaken } from "./wallet/offer.js";
export { SWAP_HEADROOM_BPS, SWAP_BLIND_BPS, SWAP_CAP_BPS } from "./wallet/fills.js";
export {
  SWAP_FALLS_OVER,
  PAY_TO,
  MAX_RECURRING,
  mayHaveLanded,
  partlySent,
  WARN_EARLY,
  NO_FALL,
  MAX_EVERY,
  ESTIMATE_NEXT,
  NO_FILLS,
} from "./wallet/trade.js";
export { ESCROW_EXPIRES_IN, RECORD_MINT_NEEDED, MAX_PIECES, piecesPartlySent, piecesMayHaveLanded } from "./wallet/escrow.js";
export { PAYEE_MOVED, RELEASE_CHANGED, approvalOf } from "./wallet/attest.js";
export { NOT_A_MEMBER, VOTE_CHANGED } from "./wallet/committee.js";
export {
  notEarliest,
  notInSplit,
  DELIVERY_LIST,
  DELIVERED_NEEDED,
  ATTEST_PAGES,
  MAX_ATTEST_PAGES,
  HISTORY_TOO_LONG,
  checkDelivery,
  prepareDeliver,
  notAttestor,
} from "./wallet/delivery.js";
export {
  SPLIT_FITS,
  SPLIT_FITS_WITH_TABLE,
  splitTooLarge,
  RECORDS_SPLIT,
  followUpFailed,
  SPLIT_WEIGHTS_WRONG,
  SPLIT_SIG_NEEDED,
  SIGNATURE_PATTERN,
  WARN_COAUTHORS,
} from "./wallet/split.js";
export {
  RELEASE_INPUT,
  RELEASE_SIGNATURE,
  releaseOf,
  notReleasedYet,
  alreadyRecorded,
  releasedBy,
  escrowGone,
  creationUnread,
  notAProofEscrow,
  neverAnnounced,
  paidOther,
  splitPaidOthers,
  recipientsUnread,
  followUpsUnknown,
  historyLagging,
  otherLifecycle,
  COVERAGE_UNPROVABLE,
  coverageOf,
  recordingOf,
} from "./wallet/record.js";
export type { Recording } from "./wallet/record.js";
export {
  releaseNotOf,
  releaseUnread,
  HISTORY_PAGES,
  escrowHistory,
  RELEASE_PAGES,
  RELEASE_UNKNOWN,
  LIFECYCLE_FETCHES,
  outlives,
  releaseLookup,
  aroundRelease,
  namedRelease,
  releasedMint,
  SPLIT_INTENT_ACCOUNT,
  splitRecipients,
} from "./wallet/releases.js";
export type { ReleaseLookup, AroundRelease } from "./wallet/releases.js";
export { WAIT_STATUS, UNREAD, FILL_UNKNOWN, stillWaiting } from "./wallet/wait.js";
export { NOT_RELEASED, RECEIPT_PARTIAL, getReceipt, escrowReceipt } from "./wallet/receipt.js";
export { PACKET_DATA_SIZE } from "@intent-engine/client";

export const WALLET_ACTIONS: readonly AnyAction[] = [
  walletSetup,
  walletBalance,
  walletEstimate,
  walletSwap,
  walletAuction,
  walletRecurring,
  walletEscrow,
  walletEscrowPlan,
  walletAttest,
  walletAttestSplit,
  walletCommitteeVote,
  walletCommitteeRelease,
  walletFeedback,
  walletClaim,
  walletProfile,
  walletRecordDelivery,
  walletDeliver,
  walletCheckDelivery,
  walletWait,
  walletReceipt,
  walletIntents,
  walletCancel,
];

import type { AnyAction } from "./actions.js";
import { walletSetup, walletBalance, walletIntents, walletCancel } from "./wallet/account.js";
import { walletHistory } from "./wallet/history.js";
import { walletEstimate, walletSwap, walletAuction, walletRecurring } from "./wallet/trade.js";
import { walletEscrow, walletEscrowPlan } from "./wallet/escrow.js";
import { walletAttest } from "./wallet/attest.js";
import { walletDeliver, walletCheckDelivery } from "./wallet/delivery.js";
import { walletAttestSplit } from "./wallet/split.js";
import { walletCommitteeCreate, walletCommitteeRelease, walletCommitteeVote } from "./wallet/committee.js";
import { walletFeedback } from "./reputation.js";
import { walletClaim } from "./work-claims.js";
import { walletProfile } from "./profile.js";
import { walletWait } from "./wallet/wait.js";
import { walletReceipt } from "./wallet/receipt.js";
import { walletUnwrap } from "./wallet/unwrap.js";
import { walletSealSpec } from "./wallet/seal.js";
import { walletFetchWork } from "./wallet/work.js";
import { walletJudgeWork } from "./wallet/judge-work.js";
import { walletReclaim, walletRefute } from "./wallet/refute.js";
import { walletClaimHeld } from "./wallet/held.js";

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
  PREVIEW_APPROVAL_NEXT,
  limitLines,
  rpcRefused,
} from "./wallet/guard.js";
export type { Clock, WalletGuard, WalletAccess } from "./wallet/guard.js";
export { walletBalance } from "./wallet/account.js";
export { NOTHING_WRAPPED } from "./wallet/unwrap.js";
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
export { PAYEE_MOVED, RELEASE_CHANGED, approvalOf, notEarliest, PAY_TO_NEEDED } from "./wallet/attest.js";
export { COMMITTEE_CHANGED, COMMITTEE_EXISTS, COMMITTEE_LIVE, NOT_A_MEMBER, VOTE_CHANGED } from "./wallet/committee.js";
export { ALREADY_ANNOUNCED, DELIVERED_NEEDED, checkDelivery, prepareDeliver, notAttestor, SECOND_NODE_UNREAD, SYNC_FIRST } from "./wallet/delivery.js";
export { SPLIT_FITS, SPLIT_FITS_WITH_TABLE, splitTooLarge, SPLIT_WEIGHTS_WRONG, SPLIT_SIG_NEEDED, SIGNATURE_PATTERN, WARN_COAUTHORS, notInSplit } from "./wallet/split.js";
export { RELEASE_INPUT, RELEASE_SIGNATURE, releaseOf, otherLifecycle, COVERAGE_UNPROVABLE, coverageOf } from "./wallet/receipt.js";
export { NOT_ANNOUNCEMENT, RECLAIM_MORE } from "./wallet/refute.js";
export { CLAIM_HELD_CHANGED, NOTHING_HELD } from "./wallet/held.js";
export { KEY_ON_DEVICE } from "./wallet/openings.js";
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
export { NOT_RELEASED, NO_CLOCK, PAID_WRAPPED, RECEIPT_PARTIAL, getReceipt, escrowReceipt, stillUnreleased } from "./wallet/receipt.js";
export { PACKET_DATA_SIZE } from "@intent-engine/client/internal";

export const WALLET_ACTIONS: readonly AnyAction[] = [
  walletSetup,
  walletBalance,
  walletEstimate,
  walletSwap,
  walletAuction,
  walletRecurring,
  walletEscrow,
  walletEscrowPlan,
  walletSealSpec,
  walletAttest,
  walletAttestSplit,
  walletCommitteeCreate,
  walletCommitteeVote,
  walletCommitteeRelease,
  walletFeedback,
  walletClaim,
  walletProfile,
  walletDeliver,
  walletCheckDelivery,
  walletFetchWork,
  walletJudgeWork,
  walletRefute,
  walletReclaim,
  walletClaimHeld,
  walletWait,
  walletReceipt,
  walletIntents,
  walletHistory,
  walletCancel,
  walletUnwrap,
];

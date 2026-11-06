use super::*;
use intent_engine::state::ClaimBoard;

pub const FAIR_DAY: i64 = 86_400;
pub const FAIR_STAKE: u64 = 50_000_000;
pub const FAIR_KILL: u64 = 20_000_000;
pub const FAIR_HOLD: u32 = 3_600;
pub const FAIR_REVIEW: u32 = 172_800;
pub const FAIR_EXPIRY: i64 = START_TS + 10 * FAIR_DAY;
pub const FAIR_TERMS: ReleaseTerms = ReleaseTerms {
    funded: 1_000_000,
    escrow: 100_000,
    judge_fee: 0,
    spec: [0x6d; 32],
    weights: [6_000, 4_000],
    partner_bps: 0,
};

pub struct Fair {
    pub world: ClaimWorld,
    pub holder: Keypair,
    pub delivery: Delivery,
}

pub struct Purse {
    pub owner: u64,
    pub holder: u64,
    pub board: u64,
    pub vault: u64,
}

impl Fair {
    pub fn claimed(
        path: ReleasePath,
        review_secs: u32,
        kill_fee: u64,
    ) -> TestResult<(ClaimWorld, Keypair)> {
        let mut world = ClaimWorld::expiring(path, FAIR_TERMS, FAIR_EXPIRY)?;
        world
            .open_review(FAIR_REVIEW, FAIR_STAKE, review_secs, kill_fee)
            .map_err(|e| format!("open: {e:?}"))?;
        let holder = world.release.workers[0].insecure_clone();
        world
            .claim(&holder, FAIR_HOLD)
            .map_err(|e| format!("claim: {e:?}"))?;
        Ok((world, holder))
    }

    pub fn armed(path: ReleasePath) -> TestResult<Self> {
        Self::armed_with(path, FAIR_REVIEW, FAIR_KILL)
    }

    pub fn armed_with(path: ReleasePath, review_secs: u32, kill_fee: u64) -> TestResult<Self> {
        let (mut world, holder) = Self::claimed(path, review_secs, kill_fee)?;
        let delivery = world.announce(&holder)?;
        let board = world.board()?;
        if board.review_ann != delivery.announcement {
            return Err("the holder's first announcement did not arm a review".into());
        }
        Ok(Self {
            world,
            holder,
            delivery,
        })
    }

    pub fn board(&self) -> TestResult<ClaimBoard> {
        self.world.board()
    }

    pub fn review_until(&self) -> TestResult<i64> {
        Ok(self.board()?.review_until)
    }

    pub fn purse(&self) -> TestResult<Purse> {
        let w = &self.world;
        Ok(Purse {
            owner: w.lamports(&w.owner()),
            holder: w.lamports(&self.holder.pubkey()),
            board: w.lamports(&w.board_key()),
            vault: w.release.env.balance(&w.release.vault())?,
        })
    }

    pub fn cancel_now(&mut self) -> Result<TransactionMetadata, TransactionError> {
        let holder = self.holder.pubkey();
        self.world.cancel(Some(&holder))
    }

    pub fn release_holder(&mut self) -> TestResult<Result<TransactionMetadata, TransactionError>> {
        let holder = self.holder.pubkey();
        self.world.delivery = Some(self.delivery);
        let path = if self.world.release.panel.is_some() {
            ReleasePath::Committee
        } else {
            ReleasePath::Attested
        };
        self.world.release_to(path, Some(&holder))
    }
}

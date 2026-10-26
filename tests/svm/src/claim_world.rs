use super::*;
use intent_engine::state::{ClaimBoard, ClaimList, Standby};

pub const LINE_WINDOW: u32 = 4;
pub const ENTRY_SCAN: u32 = 8;

pub struct ClaimWorld {
    pub release: ReleaseWorld,
    pub payer: Keypair,
    pub cranker: Keypair,
    pub listed: bool,
    pub delivery: Option<Delivery>,
}

impl ClaimWorld {
    pub fn new(path: ReleasePath, terms: ReleaseTerms) -> TestResult<Self> {
        let mut release = ReleaseWorld::new(&[], path, terms)?;
        let payer = release.env.funded()?;
        let cranker = release.env.funded()?;
        Ok(Self {
            release,
            payer,
            cranker,
            listed: false,
            delivery: None,
        })
    }

    pub fn funded(&mut self) -> TestResult<Keypair> {
        self.release.env.funded()
    }

    pub fn owner(&self) -> Pubkey {
        self.release.owner()
    }

    pub fn intent(&self) -> Pubkey {
        self.release.intent()
    }

    pub fn board_key(&self) -> Pubkey {
        claims_pda(&self.intent())
    }

    pub fn list_key(&self) -> Pubkey {
        claim_list_pda(&self.intent())
    }

    pub fn list(&self) -> Option<Pubkey> {
        self.listed.then(|| self.list_key())
    }

    pub fn entry_key(&self, seq: u32) -> Pubkey {
        standby_pda(&self.intent(), seq)
    }

    pub fn now(&self) -> i64 {
        self.release.env.now()
    }

    pub fn set_now(&mut self, ts: i64) {
        self.release.env.set_now(ts);
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.release.env.lamports(key)
    }

    pub fn exists(&self, key: &Pubkey) -> bool {
        self.release.env.exists(key)
    }

    pub fn expires_at(&self) -> TestResult<i64> {
        Ok(self.release.env.intent(&self.owner(), 0)?.expires_at)
    }

    pub fn escrow_open(&self) -> TestResult<bool> {
        if !self.exists(&self.intent()) {
            return Ok(false);
        }
        let intent = self.release.env.intent(&self.owner(), 0)?;
        Ok(intent.status == intent_core::lifecycle::Status::Open as u8
            && self.now() < intent.expires_at)
    }

    pub fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, TransactionError> {
        let payer = self.payer.insecure_clone();
        self.release.env.send(&payer, ixs, signers)
    }

    pub fn open(
        &mut self,
        max_secs: u32,
        stake: u64,
        listed: Option<&[Pubkey]>,
    ) -> Result<TransactionMetadata, TransactionError> {
        let owner = self.release.trader.key.insecure_clone();
        let ix = match listed {
            Some(workers) => {
                let size = u8::try_from(workers.len()).unwrap_or(u8::MAX);
                open_claims_listed_ix(
                    &self.owner(),
                    &self.intent(),
                    max_secs,
                    stake,
                    size,
                    workers,
                )
            }
            None => open_claims_ix(&self.owner(), &self.intent(), max_secs, stake),
        };
        self.listed = listed.is_some();
        self.send(&[ix], &[&owner])
    }

    pub fn announce(&mut self, worker: &Keypair) -> TestResult<Delivery> {
        let intent = self.intent();
        let delivery = self.release.env.announce_for(worker, &intent)?;
        self.delivery = Some(delivery);
        Ok(delivery)
    }

    pub fn board(&self) -> TestResult<ClaimBoard> {
        load(&self.release.env.svm, &self.board_key())
    }

    pub fn entry(&self, seq: u32) -> Option<Standby> {
        let key = self.entry_key(seq);
        let owned = self
            .release
            .env
            .svm
            .get_account(&key)
            .is_some_and(|a| a.owner == intent_engine::ID);
        owned
            .then(|| load::<Standby>(&self.release.env.svm, &key).ok())
            .flatten()
    }

    pub fn board_rent(&self) -> u64 {
        self.release
            .env
            .svm
            .minimum_balance_for_rent_exemption(ClaimBoard::SPACE)
    }

    pub fn list_rent(&self) -> u64 {
        if self.listed {
            self.release
                .env
                .svm
                .minimum_balance_for_rent_exemption(ClaimList::SPACE)
        } else {
            0
        }
    }

    pub fn entry_rent(&self) -> u64 {
        self.release
            .env
            .svm
            .minimum_balance_for_rent_exemption(Standby::SPACE)
    }

    pub fn window(&self) -> TestResult<Vec<u32>> {
        let board = self.board()?;
        let end = board.tail.min(board.head.saturating_add(LINE_WINDOW));
        Ok((board.head..end).collect())
    }

    pub fn front(&self) -> TestResult<Option<Pubkey>> {
        Ok(self
            .window()?
            .into_iter()
            .find_map(|seq| self.entry(seq))
            .map(|e| e.worker))
    }

    pub fn claim(
        &mut self,
        who: &Keypair,
        secs: u32,
    ) -> Result<TransactionMetadata, TransactionError> {
        let ix = claim_job_listed_ix(
            &who.pubkey(),
            &self.intent(),
            &self.owner(),
            secs,
            self.list(),
        );
        self.send(&[ix], &[who])
    }

    pub fn stand_by(
        &mut self,
        who: &Keypair,
        secs: u32,
    ) -> TestResult<Result<TransactionMetadata, TransactionError>> {
        let seq = self.board()?.tail;
        let ix = stand_by_listed_ix(&who.pubkey(), &self.intent(), seq, secs, self.list());
        Ok(self.send(&[ix], &[who]))
    }

    pub fn leave(
        &mut self,
        caller: &Keypair,
        seq: u32,
        worker: &Pubkey,
    ) -> Result<TransactionMetadata, TransactionError> {
        let ix = leave_ix(&caller.pubkey(), &self.intent(), seq, worker);
        self.send(&[ix], &[caller])
    }

    fn line_accounts(&self) -> TestResult<(Vec<Pubkey>, Option<Pubkey>)> {
        let seqs = self.window()?;
        let next = self.front()?;
        let entries = if seqs.is_empty() {
            vec![self.entry_key(self.board()?.head)]
        } else {
            seqs.into_iter().map(|seq| self.entry_key(seq)).collect()
        };
        Ok((entries, next))
    }

    pub fn advance(&mut self) -> TestResult<Result<TransactionMetadata, TransactionError>> {
        let (entries, next) = self.line_accounts()?;
        let ix = advance_ix(&self.intent(), &self.owner(), &entries, next.as_ref());
        Ok(self.send(&[ix], &[]))
    }

    pub fn drop_claim(
        &mut self,
        who: &Keypair,
    ) -> TestResult<Result<TransactionMetadata, TransactionError>> {
        let (entries, next) = self.line_accounts()?;
        let ix = drop_claim_line_ix(&who.pubkey(), &self.intent(), &entries, next.as_ref());
        Ok(self.send(&[ix], &[who]))
    }

    pub fn drop_with(
        &mut self,
        who: &Keypair,
        seqs: &[u32],
        next: Option<&Pubkey>,
    ) -> Result<TransactionMetadata, TransactionError> {
        let entries: Vec<Pubkey> = seqs.iter().map(|seq| self.entry_key(*seq)).collect();
        let ix = drop_claim_line_ix(&who.pubkey(), &self.intent(), &entries, next);
        self.send(&[ix], &[who])
    }

    pub fn settle(&mut self) -> TestResult<Result<TransactionMetadata, TransactionError>> {
        let worker = self.board()?.worker;
        let worker = (worker != Pubkey::default()).then_some(worker);
        let ix =
            settle_claims_listed_ix(&self.intent(), &self.owner(), worker.as_ref(), self.list());
        Ok(self.send(&[ix], &[]))
    }

    pub fn cancel(
        &mut self,
        stake_to: Option<&Pubkey>,
    ) -> Result<TransactionMetadata, TransactionError> {
        let owner = self.release.trader.key.insecure_clone();
        self.release.env.claims = Some(self.board_key());
        self.release.env.stake_to = stake_to.copied();
        let ix = self.release.env.cancel_ix(
            &owner.pubkey(),
            &self.release.market,
            0,
            &self.release.trader.input,
        );
        self.release.env.claims = None;
        self.release.env.stake_to = None;
        self.send(&[ix], &[&owner])
    }

    pub fn expire(&mut self) -> Result<TransactionMetadata, TransactionError> {
        let cranker = self.cranker.insecure_clone();
        let ix = self.release.env.expire_ix(
            &cranker.pubkey(),
            &self.owner(),
            &self.release.market,
            0,
            &self.release.trader.input,
        );
        self.send(&[ix], &[&cranker])
    }

    pub fn close(&mut self) -> Result<TransactionMetadata, TransactionError> {
        let cranker = self.cranker.insecure_clone();
        let ix = self.release.env.close_ix_by(
            &cranker.pubkey(),
            &self.owner(),
            &self.release.market,
            0,
            &self.release.trader.input,
        );
        self.send(&[ix], &[&cranker])
    }

    pub fn release_to(
        &mut self,
        path: ReleasePath,
        stake_to: Option<&Pubkey>,
    ) -> TestResult<Result<TransactionMetadata, TransactionError>> {
        let delivery = self.delivery.ok_or("nothing announced")?;
        self.release.env.claims = Some(self.board_key());
        self.release.env.stake_to = stake_to.copied();
        let payee = self.release.atas[0];
        let sent = self.release.release_to(path, &delivery, &payee);
        self.release.env.claims = None;
        self.release.env.stake_to = None;
        sent
    }

    pub fn check_holdings(&self, stake: u64) -> TestResult {
        if !self.exists(&self.board_key()) {
            return Ok(());
        }
        let board = self.board()?;
        let expected = self
            .board_rent()
            .checked_add(board.held)
            .ok_or("board overflow")?;
        if self.lamports(&self.board_key()) != expected {
            return Err(format!(
                "board holds {} lamports, rent plus held is {expected}",
                self.lamports(&self.board_key())
            )
            .into());
        }
        if self.listed && self.lamports(&self.list_key()) != self.list_rent() {
            return Err("the list holds more or less than its rent".into());
        }
        let entry = self
            .entry_rent()
            .checked_add(stake)
            .ok_or("entry overflow")?;
        for seq in 0..board.tail {
            let held = self.lamports(&self.entry_key(seq));
            if self.entry(seq).is_some() && held != entry {
                return Err(format!("entry {seq} holds {held}, rent plus stake is {entry}").into());
            }
            if self.entry(seq).is_none() && held != 0 {
                return Err(format!("closed entry {seq} still holds {held}").into());
            }
        }
        Ok(())
    }

    pub fn wind_up(&mut self) -> TestResult {
        if self.escrow_open()? {
            let expires_at = self.expires_at()?;
            self.set_now(expires_at);
        }
        let tail = if self.exists(&self.board_key()) {
            let tail = self.board()?.tail;
            self.settle()?
                .map_err(|e| format!("settling after the end: {e:?}"))?;
            tail
        } else {
            ENTRY_SCAN
        };
        let cranker = self.cranker.insecure_clone();
        for seq in 0..tail {
            if let Some(entry) = self.entry(seq) {
                self.leave(&cranker, seq, &entry.worker)
                    .map_err(|e| format!("leaving entry {seq} after the end: {e:?}"))?;
            }
        }
        let left: Vec<u32> = (0..tail)
            .filter(|seq| self.exists(&self.entry_key(*seq)))
            .collect();
        if self.exists(&self.board_key()) || self.exists(&self.list_key()) || !left.is_empty() {
            return Err(format!("accounts left open after the end: entries {left:?}").into());
        }
        Ok(())
    }
}

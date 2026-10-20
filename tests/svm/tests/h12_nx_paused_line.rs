use anchor_lang::prelude::Pubkey;
use core::mem::offset_of;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::state::{ClaimBoard, Intent, Standby, PAUSE_ALL, PAUSE_FILL};
use intent_engine::ConfigUpdate;
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    advance_ix, claim_job_ix, claims_pda, close_legacy_full_ix, drop_claim_line_ix, engine_error,
    intent_pda, leave_ix, load, open_claims_ix, settle_claims_ix, stand_by_ix, standby_pda,
    swap_spec, Env, IntentSpec, LegacyClose, Market, TestResult, Trader,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SPEC: [u8; 32] = [0x6b; 32];
const STAKE: u64 = 50_000_000;
const HOUR: u32 = 3_600;
const HEAD: usize = 8;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    payer: Keypair,
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: Keypair::new().pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let payer = env.funded()?;
    let mut w = World {
        env,
        market,
        trader,
        payer,
    };
    let ix = open_claims_ix(&w.owner(), &w.intent(), HOUR, STAKE);
    let owner = w.trader.key.insecure_clone();
    w.env.send(&owner, &[ix], &[])?;
    Ok(w)
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn intent(&self) -> Pubkey {
        intent_pda(&self.owner(), 0)
    }

    fn entry(&self, seq: u32) -> Pubkey {
        standby_pda(&self.intent(), seq)
    }

    fn run(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, TransactionError> {
        let payer = self.payer.insecure_clone();
        self.env.send(&payer, ixs, signers)
    }

    fn board(&self) -> TestResult<ClaimBoard> {
        load(&self.env.svm, &claims_pda(&self.intent()))
    }

    fn hold(&mut self) -> TestResult<Keypair> {
        let holder = self.env.funded()?;
        let ix = claim_job_ix(&holder.pubkey(), &self.intent(), &self.owner(), 600);
        self.run(&[ix], &[&holder])?;
        Ok(holder)
    }

    fn join(&mut self, waiter: &Keypair) -> Result<TransactionMetadata, TransactionError> {
        self.join_at(waiter, 0)
    }

    fn join_at(
        &mut self,
        waiter: &Keypair,
        seq: u32,
    ) -> Result<TransactionMetadata, TransactionError> {
        let ix = stand_by_ix(&waiter.pubkey(), &self.intent(), seq, 600);
        self.run(&[ix], &[waiter])
    }

    fn claim(&mut self, worker: &Keypair) -> Result<TransactionMetadata, TransactionError> {
        let ix = claim_job_ix(&worker.pubkey(), &self.intent(), &self.owner(), 600);
        self.run(&[ix], &[worker])
    }

    fn pause(&mut self, flags: u8) -> TestResult {
        let guardian = self.env.guardian.insecure_clone();
        let pause = self.env.raise_pause_ix(&guardian.pubkey(), flags);
        self.env.send(&guardian, &[pause], &[])?;
        assert_eq!(self.env.config()?.paused & flags, flags);
        Ok(())
    }

    fn disable_fills(&mut self) -> TestResult {
        let s = self.env.settings();
        let admin = self.env.authority.insecure_clone();
        let disable = self.env.update_ix(
            &admin.pubkey(),
            ConfigUpdate {
                guardian: s.guardian,
                fee_recipient: s.fee_recipient,
                enabled_kinds: s.enabled_kinds,
                fee_bps: s.fee_bps,
                fill_disabled_kinds: Kind::AttestedResult.bit(),
            },
        );
        self.env.send(&admin, &[disable], &[])?;
        assert_eq!(
            self.env.config()?.fill_disabled_kinds,
            Kind::AttestedResult.bit()
        );
        Ok(())
    }

    fn outdate(&mut self, address: &Pubkey, at: usize, version: u8) -> TestResult {
        let mut account = self.env.svm.get_account(address).ok_or("missing")?;
        *account
            .data
            .get_mut(HEAD.saturating_add(at))
            .ok_or("short")? = version;
        self.env.svm.set_account(*address, account)?;
        Ok(())
    }

    fn close_legacy(
        &mut self,
        account: &Pubkey,
        payee: &Pubkey,
    ) -> Result<TransactionMetadata, TransactionError> {
        let ix = close_legacy_full_ix(&LegacyClose {
            account: *account,
            payee: *payee,
            with_config: false,
            vault: None,
            stake_to: None,
            intent: Some(self.intent()),
            fee_to: None,
        });
        self.run(&[ix], &[])
    }
}

#[test]
fn nx2_no_worker_joins_the_stand_by_line_while_the_guardian_has_paused_the_program() -> TestResult {
    let mut w = world()?;
    w.hold()?;
    w.pause(PAUSE_ALL)?;
    let waiter = w.env.funded()?;
    let before = w.env.lamports(&waiter.pubkey());
    let joined = w.join(&waiter);
    let entry = standby_pda(&w.intent(), 0);
    let tail = w.board()?.tail;
    let staked = before.saturating_sub(w.env.lamports(&waiter.pubkey()));
    assert_eq!(
        (joined.err(), tail, w.env.exists(&entry)),
        (Some(engine_error(EngineError::FillPaused)), 0, false),
        "with every pause raised a stand-by join must be refused, yet the line grew to {tail} and the waiter locked {staked} lamports"
    );
    Ok(())
}

#[test]
fn nx2_no_worker_joins_the_stand_by_line_of_an_escrow_whose_kind_is_disabled() -> TestResult {
    let mut w = world()?;
    w.hold()?;
    w.disable_fills()?;
    let waiter = w.env.funded()?;
    let joined = w.join(&waiter);
    let entry = standby_pda(&w.intent(), 0);
    let tail = w.board()?.tail;
    assert_eq!(
        (joined.err(), tail, w.env.exists(&entry)),
        (Some(engine_error(EngineError::FillKindDisabled)), 0, false),
        "with the escrow's kind disabled a stand-by join must be refused, yet the line grew to {tail}"
    );
    Ok(())
}

#[test]
fn nx2_no_worker_claims_a_job_while_fills_are_paused_or_its_kind_is_disabled() -> TestResult {
    let mut w = world()?;
    let worker = w.env.funded()?;
    w.pause(PAUSE_FILL)?;
    assert_eq!(
        w.claim(&worker).err(),
        Some(engine_error(EngineError::FillPaused))
    );
    assert_eq!(w.board()?.worker, Pubkey::default());
    let mut w = world()?;
    w.disable_fills()?;
    let worker = w.env.funded()?;
    assert_eq!(
        w.claim(&worker).err(),
        Some(engine_error(EngineError::FillKindDisabled))
    );
    assert_eq!(w.board()?.worker, Pubkey::default());
    Ok(())
}

#[test]
fn nx2_every_exit_from_the_line_works_while_the_program_is_paused() -> TestResult {
    let mut w = world()?;
    let holder = w.hold()?;
    let [a, b, c] = [w.env.funded()?, w.env.funded()?, w.env.funded()?];
    w.join_at(&a, 0)?;
    w.join_at(&b, 1)?;
    w.join_at(&c, 2)?;
    w.pause(PAUSE_ALL)?;
    let intent = w.intent();
    let owner = w.owner();

    let ix = leave_ix(&c.pubkey(), &intent, 2, &c.pubkey());
    w.run(&[ix], &[&c])?;
    assert!(!w.env.exists(&w.entry(2)));

    let entries = [w.entry(0)];
    let ix = drop_claim_line_ix(&holder.pubkey(), &intent, &entries, Some(&a.pubkey()));
    w.run(&[ix], &[&holder])?;
    assert_eq!(w.board()?.worker, a.pubkey());

    let now = w.env.now();
    w.env.set_now(now.saturating_add(600));
    let entries = [w.entry(1)];
    let ix = advance_ix(&intent, &owner, &entries, Some(&b.pubkey()));
    w.run(&[ix], &[])?;
    assert_eq!(w.board()?.worker, b.pubkey());

    w.env.claims = Some(claims_pda(&intent));
    w.env.stake_to = Some(b.pubkey());
    let cancel = w.env.cancel_ix(&owner, &w.market, 0, &w.trader.input);
    w.env.claims = None;
    w.env.stake_to = None;
    let trader = w.trader.key.insecure_clone();
    let tokens = w.env.balance(&w.trader.input)?;
    w.env.send(&trader, &[cancel], &[])?;
    assert_eq!(
        Some(w.env.balance(&w.trader.input)?),
        tokens.checked_add(ESCROW)
    );
    w.run(&[settle_claims_ix(&intent, &owner, None)], &[])?;
    assert!(!w.env.exists(&claims_pda(&intent)));

    let mut w = world()?;
    w.hold()?;
    let waiter = w.env.funded()?;
    w.join(&waiter)?;
    w.pause(PAUSE_ALL)?;
    let intent = w.intent();
    let owner = w.owner();
    let expires = load::<Intent>(&w.env.svm, &intent)?.expires_at;
    w.env.set_now(expires);
    let cranker = w.payer.pubkey();
    let expire = w
        .env
        .expire_ix(&cranker, &owner, &w.market, 0, &w.trader.input);
    let tokens = w.env.balance(&w.trader.input)?;
    w.run(&[expire], &[])?;
    assert_eq!(
        Some(w.env.balance(&w.trader.input)?),
        tokens.checked_add(ESCROW)
    );
    w.outdate(&w.entry(0), offset_of!(Standby, version), 0)?;
    let held = w.env.lamports(&w.entry(0));
    let before = w.env.lamports(&waiter.pubkey());
    w.close_legacy(&w.entry(0), &waiter.pubkey())?;
    assert_eq!(
        Some(w.env.lamports(&waiter.pubkey())),
        before.checked_add(held)
    );
    Ok(())
}

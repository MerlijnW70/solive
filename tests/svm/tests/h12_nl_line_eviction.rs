use anchor_lang::prelude::Pubkey;
use core::mem::offset_of;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::state::{ClaimBoard, Intent, Standby};
use intent_engine::versions::is_current;
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    advance_ix, claim_job_ix, claims_pda, close_legacy_full_ix, close_legacy_ix, config_pda,
    drop_claim_line_ix, engine_error, intent_pda, load, migrate_ix, open_claims_ix, put,
    stand_by_ix, standby_pda, swap_spec, Env, IntentSpec, LegacyClose, Market, Saved, TestResult,
    Trader,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SPEC: [u8; 32] = [0x5a; 32];
const STAKE: u64 = 50_000_000;
const HOUR: u32 = 3_600;
const HEAD: usize = 8;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    payer: Keypair,
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

    fn as_stand_by_line_wrote(
        &mut self,
        address: &Pubkey,
        writes: &[(usize, &[u8])],
    ) -> TestResult {
        let account = self.env.svm.get_account(address).ok_or("missing")?;
        let mut data = account.data.clone();
        for (at, bytes) in writes {
            data.get_mut(*at..at.saturating_add(bytes.len()))
                .ok_or("short")?
                .copy_from_slice(bytes);
        }
        put(
            &mut self.env.svm,
            &Saved {
                address: *address,
                owner: account.owner,
                lamports: account.lamports,
                data,
            },
        )
    }

    fn close_line(
        &mut self,
        caller: &Keypair,
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
        self.env.send(caller, &[ix], &[])
    }

    fn outdate_escrow(&mut self) -> TestResult {
        let intent = self.intent();
        let intent_version = HEAD.saturating_add(offset_of!(Intent, version));
        let intent_fee = HEAD.saturating_add(offset_of!(Intent, fee_bps));
        self.as_stand_by_line_wrote(&intent, &[(intent_version, &[1]), (intent_fee, &[0, 0])])?;
        let board = claims_pda(&intent);
        self.as_stand_by_line_wrote(
            &board,
            &[(HEAD.saturating_add(offset_of!(ClaimBoard, version)), &[1])],
        )
    }

    fn outdate_entry(&mut self, seq: u32) -> TestResult {
        let entry_version = HEAD.saturating_add(offset_of!(Standby, version));
        self.as_stand_by_line_wrote(&self.entry(seq), &[(entry_version, &[0])])
    }
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

#[test]
fn nl3_a_later_waiter_cannot_close_an_earlier_unmigrated_entry_to_take_the_job_ahead_of_it(
) -> TestResult {
    let mut w = world()?;
    let holder = w.env.funded()?;
    let first = w.env.funded()?;
    let second = w.env.funded()?;
    let intent = w.intent();
    let owner = w.owner();
    let board = claims_pda(&intent);

    let claim = claim_job_ix(&holder.pubkey(), &intent, &owner, 600);
    w.run(&[claim], &[&holder])?;
    let join = stand_by_ix(&first.pubkey(), &intent, 0, 600);
    w.run(&[join], &[&first])?;
    let join = stand_by_ix(&second.pubkey(), &intent, 1, 600);
    w.run(&[join], &[&second])?;

    w.outdate_escrow()?;
    w.outdate_entry(0)?;
    w.outdate_entry(1)?;

    let upgrade = [
        migrate_ix(&second.pubkey(), &intent, Some(config_pda())),
        migrate_ix(&second.pubkey(), &board, Some(config_pda())),
        migrate_ix(&second.pubkey(), &w.entry(1), Some(config_pda())),
    ];
    w.run(&upgrade, &[&second])?;
    for migrated in [intent, board, w.entry(1)] {
        let data = w.env.svm.get_account(&migrated).ok_or("missing")?.data;
        assert!(is_current(&data));
    }
    let evict = close_legacy_ix(&w.entry(0), &first.pubkey(), false);
    assert_eq!(
        w.env.send(&second, &[evict], &[]).err(),
        Some(engine_error(EngineError::ClaimsMissing)),
        "an outdated entry closes only against its escrow"
    );
    assert_eq!(
        w.close_line(&second, &w.entry(0), &first.pubkey()).err(),
        Some(engine_error(EngineError::LegacyLineOpen)),
        "an outdated entry of an open escrow is migrated, never closed"
    );
    assert!(w.env.exists(&w.entry(0)));
    let own = migrate_ix(&first.pubkey(), &w.entry(0), Some(config_pda()));
    w.run(&[own], &[&first])?;

    let now = w.env.now();
    w.env.set_now(now.saturating_add(600));
    let entries = [w.entry(0), w.entry(1)];
    let advance = advance_ix(&intent, &owner, &entries, Some(&first.pubkey()));
    w.run(&[advance], &[])?;

    let served: ClaimBoard = load(&w.env.svm, &board)?;
    assert_eq!(
        served.worker,
        first.pubkey(),
        "the line serves the worker that stood by first, not a later waiter that closed its entry"
    );
    Ok(())
}

#[test]
fn nl3_an_outdated_board_of_an_open_escrow_migrates_and_keeps_its_line() -> TestResult {
    let mut w = world()?;
    let holder = w.env.funded()?;
    let first = w.env.funded()?;
    let second = w.env.funded()?;
    let intent = w.intent();
    let owner = w.owner();
    let board = claims_pda(&intent);
    let claim = claim_job_ix(&holder.pubkey(), &intent, &owner, 600);
    w.run(&[claim], &[&holder])?;
    let join = stand_by_ix(&first.pubkey(), &intent, 0, 600);
    w.run(&[join], &[&first])?;
    let join = stand_by_ix(&second.pubkey(), &intent, 1, 600);
    w.run(&[join], &[&second])?;
    w.outdate_escrow()?;
    let migrate = migrate_ix(&second.pubkey(), &intent, Some(config_pda()));
    w.run(&[migrate], &[&second])?;

    assert_eq!(
        w.close_line(&second, &board, &owner).err(),
        Some(engine_error(EngineError::LegacyLineOpen)),
        "an outdated board of an open escrow is migrated, never closed"
    );
    let before: ClaimBoard = load(&w.env.svm, &board)?;
    let migrate = migrate_ix(&second.pubkey(), &board, Some(config_pda()));
    w.run(&[migrate], &[&second])?;
    let after: ClaimBoard = load(&w.env.svm, &board)?;
    assert_eq!(
        (after.worker, after.held, after.head, after.tail),
        (before.worker, before.held, before.head, before.tail)
    );

    let entries = [w.entry(0)];
    let handed = drop_claim_line_ix(&holder.pubkey(), &intent, &entries, Some(&first.pubkey()));
    w.run(&[handed], &[&holder])?;
    let served: ClaimBoard = load(&w.env.svm, &board)?;
    assert_eq!((served.worker, served.head), (first.pubkey(), 1));
    Ok(())
}

#[test]
fn nl3_once_the_escrow_ends_close_legacy_returns_an_outdated_entry_and_board() -> TestResult {
    let mut w = world()?;
    let holder = w.env.funded()?;
    let waiter = w.env.funded()?;
    let intent = w.intent();
    let owner = w.owner();
    let board = claims_pda(&intent);
    let claim = claim_job_ix(&holder.pubkey(), &intent, &owner, 600);
    w.run(&[claim], &[&holder])?;
    let join = stand_by_ix(&waiter.pubkey(), &intent, 0, 600);
    w.run(&[join], &[&waiter])?;
    w.env.claims = Some(board);
    w.env.stake_to = Some(holder.pubkey());
    let cancel = w.env.cancel_ix(&owner, &w.market, 0, &w.trader.input);
    w.env.claims = None;
    w.env.stake_to = None;
    let trader = w.trader.key.insecure_clone();
    w.env.send(&trader, &[cancel], &[])?;

    w.outdate_entry(0)?;
    w.as_stand_by_line_wrote(
        &board,
        &[(HEAD.saturating_add(offset_of!(ClaimBoard, version)), &[1])],
    )?;
    let held = w.env.lamports(&w.entry(0));
    let before = w.env.lamports(&waiter.pubkey());
    w.close_line(&holder, &w.entry(0), &waiter.pubkey())?;
    assert_eq!(
        Some(w.env.lamports(&waiter.pubkey())),
        before.checked_add(held)
    );
    let rent = w.env.lamports(&board);
    let before = w.env.lamports(&owner);
    w.close_line(&holder, &board, &owner)?;
    assert_eq!(Some(w.env.lamports(&owner)), before.checked_add(rent));
    assert!(!w.env.exists(&board) && !w.env.exists(&w.entry(0)));
    Ok(())
}

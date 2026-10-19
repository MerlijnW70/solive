use anchor_lang::prelude::Pubkey;
use intent_core::fee::{release_settles, split_fees, Fees};
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::{FillBegun, IntentAttested, IntentFilled};
use intent_engine::state::{BPS, MAX_ATTESTED_FEE_BPS, MAX_FEE_BPS};
use intent_engine::Economics;
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    ed25519_ix, empty_ext_hash, engine_error, events, intent_pda, partner_ext, swap_spec,
    vault_pda, Env, IntentSpec, Market, Solver, TestResult, Trader, DOMAIN,
};

const FUNDED: u64 = 1_000_000;
const LARGE: u64 = 100_000;
const OUT: u64 = 400;
const JUDGE_FEE: u64 = 1_000;
const PARTNER_BPS: u16 = 50;
const SPEC: [u8; 32] = [0x7a; 32];
const BOUND: u16 = MAX_ATTESTED_FEE_BPS + PARTNER_BPS;
const TIGHT: u64 = 400;
const TIGHT_JUDGE_FEE: u64 = TIGHT - 1;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    fee_to: Pubkey,
    partner: Pubkey,
    partner_to: Pubkey,
    attestor: Keypair,
    judge_to: Pubkey,
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let solver = env.solver(&market, FUNDED)?;
    let fee_to = env.fee_account(&market)?;
    let partner = Pubkey::new_unique();
    let partner_to = env.create_ata(&partner, &market.input_mint, market.input_program)?;
    let attestor = Keypair::new();
    let judge_to = env.create_ata(&attestor.pubkey(), &market.input_mint, market.input_program)?;
    env.partner_to = Some(partner_to);
    env.judge_to = Some(judge_to);
    env.max_fee_bps = BOUND;
    Ok(World {
        env,
        market,
        trader,
        solver,
        fee_to,
        partner,
        partner_to,
        attestor,
        judge_to,
    })
}

fn kinds(list: &[Kind]) -> TestResult<u8> {
    Ok(u8::try_from(list.iter().fold(0, |mask, k| mask | k.bit()))?)
}

fn terms(mask: u8, kind_fee_bps: [u16; 4], partner_cut_bps: u16) -> Economics {
    Economics {
        kind_fee_mask: mask,
        kind_fee_bps,
        partner_cut_bps,
        crank_bounty: 0,
        create_fee: 0,
    }
}

fn fees(amount: u64, fee_bps: u16, cut_bps: u16) -> TestResult<Fees> {
    Ok(split_fees(amount, fee_bps, PARTNER_BPS, cut_bps).map_err(|e| format!("{e:?}"))?)
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn set(&mut self, e: Economics) -> TestResult {
        let admin = self.env.authority.insecure_clone();
        let ix = self.env.economics_ix(&admin.pubkey(), e);
        self.env.send(&admin, &[ix], &[])?;
        Ok(())
    }

    fn set_default_fee(&mut self, fee_bps: u16) -> TestResult {
        let admin = self.env.authority.insecure_clone();
        let mut settings = self.env.settings();
        settings.fee_bps = fee_bps;
        let ix = self.env.update_config_ix(&admin.pubkey(), settings);
        self.env.send(&admin, &[ix], &[])?;
        Ok(())
    }

    fn proof_spec(&self, nonce: u64, amount: u64, judge_fee: u64) -> TestResult<IntentSpec> {
        Ok(IntentSpec {
            kind: Kind::AttestedResult as u8,
            params: attested_result::Params {
                amount_in: amount,
                min_result: 1,
                max_result: 1,
                attestor: self.attestor.pubkey().to_bytes(),
                spec_hash: SPEC,
                judge_fee,
            }
            .encode()
            .map_err(|e| format!("{e:?}"))?,
            ext: partner_ext(&self.partner, PARTNER_BPS),
            ..swap_spec(nonce, amount)?
        })
    }

    fn swap(&mut self, nonce: u64) -> TestResult {
        let spec = IntentSpec {
            ext: partner_ext(&self.partner, PARTNER_BPS),
            ..swap_spec(nonce, LARGE)?
        };
        self.env.create_intent(&self.trader, &self.market, &spec)?;
        Ok(())
    }

    fn open(&mut self, nonce: u64, amount: u64, judge_fee: u64) -> TestResult {
        let spec = self.proof_spec(nonce, amount, judge_fee)?;
        self.env.create_intent(&self.trader, &self.market, &spec)?;
        Ok(())
    }

    fn as_solver(&mut self, ixs: &[Instruction]) -> TestResult<TransactionMetadata> {
        let solver = self.solver.key.insecure_clone();
        Ok(self.env.send(&solver, ixs, &[])?)
    }

    fn release(&mut self, nonce: u64, amount: u64) -> TestResult<TransactionMetadata> {
        let intent = intent_pda(&self.owner(), nonce);
        let payee = self.solver.input;
        let preimage = intent_core::sig::AttestedProof {
            program: intent_engine::ID.to_bytes(),
            domain: DOMAIN,
            intent: intent.to_bytes(),
            payee: payee.to_bytes(),
            amount_in: amount,
            result: 1,
            filled: 0,
            revision: 0,
            max_fee_bps: BOUND,
            ext_hash: empty_ext_hash(),
            spec_hash: SPEC,
        }
        .preimage();
        let digest = solana_sha256_hasher::hashv(&[&preimage]).to_bytes();
        let message =
            intent_core::sig::offchain_envelope(&self.attestor.pubkey().to_bytes(), &digest);
        let fill = self.env.fill_attested_ix(
            &self.solver.key.pubkey(),
            &self.owner(),
            &self.market,
            nonce,
            &payee,
            Some(&self.fee_to),
            1,
        );
        let signed = ed25519_ix(&self.attestor, &message);
        self.as_solver(&[signed, fill])
    }

    fn balances(&self) -> TestResult<[u64; 4]> {
        Ok([
            self.env.balance(&self.fee_to)?,
            self.env.balance(&self.partner_to)?,
            self.env.balance(&self.judge_to)?,
            self.env.balance(&self.solver.input)?,
        ])
    }

    fn released(&mut self, nonce: u64, amount: u64) -> TestResult<(IntentAttested, [u64; 4])> {
        let before = self.balances()?;
        let meta = self.release(nonce, amount)?;
        let after = self.balances()?;
        let moved: Vec<u64> = after
            .iter()
            .zip(before)
            .map(|(a, b)| a.checked_sub(b).ok_or("balance fell"))
            .collect::<Result<_, _>>()?;
        let moved: [u64; 4] = moved.try_into().map_err(|_| "four balances")?;
        assert_eq!(moved.iter().sum::<u64>(), amount);
        assert_eq!(
            self.env
                .balance(&vault_pda(&intent_pda(&self.owner(), nonce)))?,
            0
        );
        let e = events::<IntentAttested>(&meta).pop().ok_or("missing")?;
        Ok((e, moved))
    }
}

#[test]
fn an_escrow_keeps_the_fee_and_partner_cut_it_was_created_under() -> TestResult {
    let mut w = world()?;
    let attested = kinds(&[Kind::AttestedResult])?;
    w.set(terms(attested, [0, 0, 0, 100], 1_000))?;
    w.open(0, LARGE, JUDGE_FEE)?;
    let stored = w.env.intent(&w.owner(), 0)?;
    assert_eq!((stored.fee_bps, stored.partner_cut_bps), (100, 1_000));

    w.set(terms(attested, [0, 0, 0, MAX_ATTESTED_FEE_BPS], 5_000))?;
    w.set_default_fee(MAX_FEE_BPS)?;
    w.open(1, LARGE, JUDGE_FEE)?;
    let stored = w.env.intent(&w.owner(), 1)?;
    assert_eq!(
        (stored.fee_bps, stored.partner_cut_bps),
        (MAX_ATTESTED_FEE_BPS, 5_000)
    );

    let old = fees(LARGE - JUDGE_FEE, 100, 1_000)?;
    let (e, moved) = w.released(0, LARGE)?;
    assert_eq!(
        (e.fee, e.partner_fee, e.net),
        (old.protocol, old.partner, old.net)
    );
    assert_eq!(moved, [old.protocol, old.partner, JUDGE_FEE, old.net]);

    let new = fees(LARGE - JUDGE_FEE, MAX_ATTESTED_FEE_BPS, 5_000)?;
    assert_ne!(new, old);
    let (e, moved) = w.released(1, LARGE)?;
    assert_eq!(
        (e.fee, e.partner_fee, e.net),
        (new.protocol, new.partner, new.net)
    );
    assert_eq!(moved, [new.protocol, new.partner, JUDGE_FEE, new.net]);
    Ok(())
}

#[test]
fn a_swap_fill_after_a_fee_change_pays_the_terms_its_intent_recorded() -> TestResult {
    let mut w = world()?;
    w.swap(0)?;
    w.swap(1)?;
    let swaps = kinds(&[Kind::SwapExactIn, Kind::LimitOrder])?;
    w.set(terms(swaps, [MAX_FEE_BPS, MAX_FEE_BPS, 0, 0], BPS))?;
    w.set_default_fee(MAX_FEE_BPS)?;
    w.swap(2)?;

    let old = fees(LARGE, 5, 0)?;
    let fill = w.env.fill_ix(
        &w.solver,
        &w.owner(),
        &w.market,
        0,
        &w.trader.receiver,
        Some(&w.fee_to),
        OUT,
    );
    let meta = w.as_solver(&[fill])?;
    let e = events::<IntentFilled>(&meta).pop().ok_or("missing")?;
    assert_eq!(
        (e.fee, e.partner_fee, e.net),
        (old.protocol, old.partner, old.net)
    );

    let me = w.solver.key.pubkey();
    let flash = [
        w.env.begin_fill_ix(
            &me,
            &w.owner(),
            &w.market,
            1,
            &w.solver.input,
            Some(&w.fee_to),
            1,
        ),
        w.env.end_fill_ix(
            &me,
            &w.owner(),
            &w.market,
            1,
            &w.trader.receiver,
            &w.solver.output,
            OUT,
        ),
    ];
    let meta = w.as_solver(&flash)?;
    let e = events::<FillBegun>(&meta).pop().ok_or("missing")?;
    assert_eq!(
        (e.fee, e.partner_fee, e.net),
        (old.protocol, old.partner, old.net)
    );

    let new = fees(LARGE, MAX_FEE_BPS, BPS)?;
    assert_ne!(new, old);
    let fill = w.env.fill_ix(
        &w.solver,
        &w.owner(),
        &w.market,
        2,
        &w.trader.receiver,
        Some(&w.fee_to),
        OUT,
    );
    let meta = w.as_solver(&[fill])?;
    let e = events::<IntentFilled>(&meta).pop().ok_or("missing")?;
    assert_eq!(
        (e.fee, e.partner_fee, e.net),
        (new.protocol, new.partner, new.net)
    );
    Ok(())
}

#[test]
fn an_escrow_that_just_settled_at_create_still_settles_after_any_config_change() -> TestResult {
    let attested = kinds(&[Kind::AttestedResult])?;
    let free = terms(attested, [0; 4], 0);
    let changes: [(Economics, Option<u16>); 4] = [
        (terms(attested, [0, 0, 0, MAX_ATTESTED_FEE_BPS], 0), None),
        (terms(attested, [0; 4], BPS), None),
        (terms(0, [0; 4], BPS), Some(MAX_FEE_BPS)),
        (
            terms(attested, [0, 0, 0, MAX_ATTESTED_FEE_BPS], BPS),
            Some(MAX_FEE_BPS),
        ),
    ];
    for (change, default_fee) in changes {
        let mut w = world()?;
        w.set(free)?;
        assert!(release_settles(TIGHT, TIGHT_JUDGE_FEE, 0, PARTNER_BPS, 0));
        w.open(0, TIGHT, TIGHT_JUDGE_FEE)?;
        w.set(change)?;
        if let Some(fee_bps) = default_fee {
            w.set_default_fee(fee_bps)?;
        }
        let config = w.env.config()?;
        let now_bps = if config.kind_fee_mask == 0 {
            config.fee_bps
        } else {
            config.kind_fee_bps[3]
        };
        let twin = w.proof_spec(1, TIGHT, TIGHT_JUDGE_FEE)?;
        let refused = !release_settles(
            TIGHT,
            TIGHT_JUDGE_FEE,
            now_bps,
            PARTNER_BPS,
            config.partner_cut_bps,
        );
        assert_eq!(refused, now_bps > 0);
        if refused {
            assert_eq!(
                w.env.create_intent(&w.trader, &w.market, &twin).err(),
                Some(engine_error(EngineError::ReleaseCannotSettle))
            );
        }
        let (e, moved) = w.released(0, TIGHT)?;
        assert_eq!((e.fee, e.partner_fee, e.net), (0, 1, 0));
        assert_eq!(moved, [0, 1, TIGHT_JUDGE_FEE, 0]);
    }
    Ok(())
}

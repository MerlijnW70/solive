use anchor_lang::prelude::Pubkey;
use intent_core::bounty::split_n;
use intent_core::fee::{split_fees, Fees};
use intent_core::kinds::{attested_result, Kind};
use intent_core::sig::AttestedSplit;
use intent_engine::errors::EngineError;
use intent_engine::events::{FeeWithheld, IntentSplit, WITHHELD_PARTNER};
use intent_engine::Economics;
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    cosign_batch_ix, empty_ext_hash, engine_error, engine_error_at, events, intent_pda,
    partner_ext, split_commit, swap_spec, vault_pda, Env, IntentSpec, Market, MintExt, Solver,
    TestResult, Trader, DOMAIN, START_TS,
};

const FUNDED: u64 = 1_000_000;
const ESCROW: u64 = 100_000;
const SPEC: [u8; 32] = [0x7a; 32];
const FEE_BPS: u16 = 5;
const JUDGE_FEE: u64 = 1_234;
const PARTNER_BPS: u16 = 50;
const CUT_BPS: u16 = 2_000;
const WEIGHTS: [u16; 2] = [6_000, 4_000];
const FILL_AT: u8 = 1;

struct Terms {
    judge_fee: u64,
    partner: bool,
    freezable: bool,
}

const JUDGED: Terms = Terms {
    judge_fee: JUDGE_FEE,
    partner: false,
    freezable: false,
};

const PARTNERED: Terms = Terms {
    judge_fee: 0,
    partner: true,
    freezable: false,
};

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    fee_to: Pubkey,
    attestor: Keypair,
    coauthors: [Keypair; 2],
    atas: Vec<Pubkey>,
    partner: Pubkey,
    partner_to: Option<Pubkey>,
    judge_ata: Pubkey,
}

fn judged_spec(attestor: &Keypair, judge_fee: u64, ext: Vec<u8>) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ext,
        ..swap_spec(0, ESCROW)?
    })
}

fn world(terms: &Terms) -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let program = anchor_spl::token::ID;
    let exts: &[MintExt] = if terms.freezable {
        &[MintExt::Freezable]
    } else {
        &[]
    };
    let market = env.market(program, exts, program, &[])?;
    let admin = env.authority.insecure_clone();
    let economics = env.economics_ix(
        &admin.pubkey(),
        Economics {
            kind_fee_mask: 0,
            kind_fee_bps: [0; 4],
            partner_cut_bps: CUT_BPS,
            crank_bounty: 0,
            create_fee: 0,
        },
    );
    env.send(&admin, &[economics], &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let attestor = Keypair::new();
    let partner = Pubkey::new_unique();
    let (ext, partner_to) = if terms.partner {
        let to = env.create_ata(&partner, &market.input_mint, program)?;
        (partner_ext(&partner, PARTNER_BPS), Some(to))
    } else {
        (Vec::new(), None)
    };
    env.partner_to = partner_to;
    env.create_intent(
        &trader,
        &market,
        &judged_spec(&attestor, terms.judge_fee, ext)?,
    )?;
    let judge_ata = env.create_ata(&attestor.pubkey(), &market.input_mint, program)?;
    env.judge_to = Some(judge_ata);
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let coauthors = [Keypair::new(), Keypair::new()];
    let mut atas = Vec::new();
    for c in &coauthors {
        atas.push(env.create_ata(&c.pubkey(), &market.input_mint, program)?);
    }
    Ok(World {
        env,
        market,
        trader,
        solver,
        fee_to,
        attestor,
        coauthors,
        atas,
        partner,
        partner_to,
        judge_ata,
    })
}

fn digest(
    intent: &Pubkey,
    amount_in: u64,
    result: u64,
    max_fee_bps: u16,
    split_hash: [u8; 32],
) -> [u8; 32] {
    let preimage = AttestedSplit {
        program: intent_engine::ID.to_bytes(),
        domain: DOMAIN,
        intent: intent.to_bytes(),
        amount_in,
        result,
        filled: 0,
        revision: 0,
        max_fee_bps,
        ext_hash: empty_ext_hash(),
        spec_hash: SPEC,
        split_hash,
    }
    .preimage();
    solana_sha256_hasher::hashv(&[&preimage]).to_bytes()
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn intent(&self) -> Pubkey {
        intent_pda(&self.owner(), 0)
    }

    fn escrow(&self) -> TestResult<u64> {
        self.env.balance(&vault_pda(&self.intent()))
    }

    fn recipients(&self) -> Vec<Pubkey> {
        self.coauthors.iter().map(Signer::pubkey).collect()
    }

    fn fill_ix(&self, result: u64, fee_to: Option<&Pubkey>) -> Instruction {
        self.env.fill_attested_split_ix(
            &self.solver.key.pubkey(),
            &self.owner(),
            &self.market,
            0,
            &self.recipients(),
            &WEIGHTS,
            fee_to,
            result,
        )
    }

    fn cosign_ix(&self, result: u64) -> TestResult<Instruction> {
        let amount_in = self.env.fill_amount(&self.owner(), 0);
        let split_hash = split_commit(&self.recipients(), &WEIGHTS);
        let d = digest(
            &self.intent(),
            amount_in,
            result,
            self.env.max_fee_bps,
            split_hash,
        );
        let signers: Vec<&Keypair> = self
            .coauthors
            .iter()
            .chain(std::iter::once(&self.attestor))
            .collect();
        cosign_batch_ix(&signers, &d)
    }

    fn send(&mut self, ixs: &[Instruction]) -> Result<TransactionMetadata, TransactionError> {
        let solver = self.solver.key.insecure_clone();
        self.env.send(&solver, ixs, &[])
    }

    fn claim_with(
        &mut self,
        result: u64,
        fee_to: Option<Pubkey>,
    ) -> TestResult<Result<TransactionMetadata, TransactionError>> {
        let ixs = vec![
            self.cosign_ix(result)?,
            self.fill_ix(result, fee_to.as_ref()),
        ];
        Ok(self.send(&ixs))
    }

    fn claim(&mut self, result: u64) -> TestResult<Result<TransactionMetadata, TransactionError>> {
        let fee_to = Some(self.fee_to);
        self.claim_with(result, fee_to)
    }

    fn refused(&mut self, result: u64) -> TestResult<Option<TransactionError>> {
        Ok(self.claim(result)?.err())
    }

    fn paid(&self) -> TestResult<Vec<u64>> {
        self.atas.iter().map(|a| self.env.balance(a)).collect()
    }

    fn assert_split(&self, net: u64) -> TestResult {
        let plan = split_n(net, &WEIGHTS).map_err(|e| format!("{e:?}"))?;
        assert_eq!(
            self.paid()?.as_slice(),
            plan.as_slice(),
            "each co-author receives its weighted share of the net"
        );
        Ok(())
    }
}

fn expected(settle: u64, partner_bps: u16) -> TestResult<Fees> {
    split_fees(settle, FEE_BPS, partner_bps, CUT_BPS).map_err(|e| format!("{e:?}").into())
}

fn split_event(meta: &TransactionMetadata) -> TestResult<(u64, u64, u64, u64)> {
    let e = events::<IntentSplit>(meta).pop().ok_or("no split event")?;
    Ok((e.amount_in, e.fee, e.partner_fee, e.net))
}

#[test]
fn split_pays_a_receivable_judge_fee() -> TestResult {
    let mut w = world(&JUDGED)?;
    let fee_before = w.env.balance(&w.fee_to)?;
    let meta = w.claim(1)??;
    let fees = expected(ESCROW - JUDGE_FEE, 0)?;
    assert!(fees.protocol > 0 && fees.net > 0);
    assert_eq!(
        w.env.balance(&w.judge_ata)?,
        JUDGE_FEE,
        "the judge receives its fee"
    );
    assert_eq!(w.env.balance(&w.fee_to)? - fee_before, fees.protocol);
    w.assert_split(fees.net)?;
    assert_eq!(w.escrow()?, 0, "the vault is drained");
    assert!(events::<FeeWithheld>(&meta).is_empty());
    assert_eq!(split_event(&meta)?, (ESCROW, fees.protocol, 0, fees.net));
    let recipients: u64 = w.paid()?.iter().sum();
    assert_eq!(recipients + fees.protocol + JUDGE_FEE, ESCROW);
    Ok(())
}

#[test]
fn split_pays_a_partner_fee() -> TestResult {
    let mut w = world(&PARTNERED)?;
    let partner_to = w.partner_to.ok_or("no partner account")?;
    let fee_before = w.env.balance(&w.fee_to)?;
    let meta = w.claim(1)??;
    let fees = expected(ESCROW, PARTNER_BPS)?;
    assert_eq!((fees.protocol, fees.partner, fees.net), (150, 400, 99_450));
    assert_eq!(w.env.balance(&partner_to)?, fees.partner);
    assert_eq!(w.env.balance(&w.fee_to)? - fee_before, fees.protocol);
    w.assert_split(fees.net)?;
    assert_eq!(w.escrow()?, 0, "the vault is drained");
    assert!(events::<FeeWithheld>(&meta).is_empty());
    assert_eq!(
        split_event(&meta)?,
        (ESCROW, fees.protocol, fees.partner, fees.net)
    );
    Ok(())
}

#[test]
fn split_withholds_a_partner_fee_that_cannot_be_received() -> TestResult {
    let mut w = world(&Terms {
        freezable: true,
        ..PARTNERED
    })?;
    let partner_to = w.partner_to.ok_or("no partner account")?;
    let mint = w.market.input_mint;
    let program = w.market.input_program;
    w.env.set_frozen(&partner_to, &mint, program, true)?;
    let fee_before = w.env.balance(&w.fee_to)?;
    let meta = w.claim(1)??;
    let fees = expected(ESCROW, PARTNER_BPS)?;
    let withheld: Vec<_> = events::<FeeWithheld>(&meta)
        .into_iter()
        .map(|e| (e.intent, e.payee, e.account, e.fee, e.role))
        .collect();
    assert_eq!(
        withheld,
        [(
            w.intent(),
            w.partner,
            partner_to,
            fees.partner,
            WITHHELD_PARTNER
        )]
    );
    assert_eq!(w.env.balance(&partner_to)?, 0);
    assert_eq!(w.env.balance(&w.fee_to)? - fee_before, fees.protocol);
    w.assert_split(fees.net)?;
    assert_eq!(
        w.escrow()?,
        fees.partner,
        "the withheld partner fee stays in the vault"
    );
    assert_eq!(split_event(&meta)?, (ESCROW, fees.protocol, 0, fees.net));
    let owner = w.owner();
    let before = w.env.balance(&w.trader.input)?;
    let cranker = w.env.funded()?;
    let close = w
        .env
        .close_ix_by(&cranker.pubkey(), &owner, &w.market, 0, &w.trader.input);
    w.env.send(&cranker, &[close], &[])?;
    assert_eq!(
        w.env.balance(&w.trader.input)?,
        before + fees.partner,
        "the owner recovers the withheld partner fee on close"
    );
    Ok(())
}

#[test]
fn split_refuses_a_missing_judge_account() -> TestResult {
    let mut w = world(&JUDGED)?;
    let judge_ata = w.judge_ata;
    w.env.judge_to = None;
    assert_eq!(
        w.refused(1)?,
        Some(engine_error_at(FILL_AT, EngineError::FeeAccountMissing)),
        "a judge fee without a judge account"
    );
    w.env.judge_to = Some(judge_ata);
    assert_eq!(
        w.claim_with(1, None)?.err(),
        Some(engine_error_at(FILL_AT, EngineError::FeeAccountMissing)),
        "a protocol fee without a fee account"
    );
    assert_eq!(w.escrow()?, ESCROW);
    assert_eq!(w.env.balance(&judge_ata)?, 0);
    w.claim(1)??;
    assert_eq!(w.env.balance(&judge_ata)?, JUDGE_FEE);
    Ok(())
}

#[test]
fn split_refuses_a_non_canonical_judge_account() -> TestResult {
    let mut w = world(&JUDGED)?;
    let mint = w.market.input_mint;
    let program = w.market.input_program;
    let stranger = w.env.create_ata(&Pubkey::new_unique(), &mint, program)?;
    let side = w
        .env
        .create_token_account(&mint, &w.attestor.pubkey(), program)?;
    for to in [stranger, side] {
        w.env.judge_to = Some(to);
        assert_eq!(
            w.refused(1)?,
            Some(engine_error_at(
                FILL_AT,
                EngineError::FeeAccountNotCanonical
            ))
        );
        assert_eq!(w.env.balance(&to)?, 0);
    }
    assert_eq!(w.escrow()?, ESCROW);
    Ok(())
}

#[test]
fn split_refuses_a_missing_partner_account() -> TestResult {
    let mut w = world(&PARTNERED)?;
    let partner_to = w.partner_to.ok_or("no partner account")?;
    w.env.partner_to = None;
    assert_eq!(
        w.refused(1)?,
        Some(engine_error_at(FILL_AT, EngineError::PartnerAccountMissing))
    );
    assert_eq!(w.escrow()?, ESCROW);
    w.env.partner_to = Some(partner_to);
    w.claim(1)??;
    assert_eq!(w.escrow()?, 0);
    Ok(())
}

#[test]
fn split_refuses_a_fee_above_the_bound() -> TestResult {
    let mut w = world(&PARTNERED)?;
    w.env.max_fee_bps = FEE_BPS + PARTNER_BPS - 1;
    assert_eq!(
        w.refused(1)?,
        Some(engine_error_at(FILL_AT, EngineError::FeeAboveBound)),
        "a bound one below the protocol and partner fees together"
    );
    assert_eq!(w.escrow()?, ESCROW);
    w.env.max_fee_bps = FEE_BPS + PARTNER_BPS;
    w.claim(1)??;
    assert_eq!(w.escrow()?, 0, "a bound equal to the fees settles");
    Ok(())
}

#[test]
fn split_refuses_a_wrong_amount_in() -> TestResult {
    let mut w = world(&JUDGED)?;
    for amount_in in [0, ESCROW - 1, ESCROW + 1] {
        w.env.amount_in = Some(amount_in);
        assert_eq!(
            w.refused(1)?,
            Some(engine_error_at(FILL_AT, EngineError::AmountInMismatch)),
            "amount_in {amount_in}"
        );
    }
    assert_eq!(w.escrow()?, ESCROW);
    w.env.amount_in = None;
    w.claim(1)??;
    assert_eq!(w.escrow()?, 0);
    Ok(())
}

#[test]
fn split_refuses_an_expired_intent() -> TestResult {
    let mut w = world(&JUDGED)?;
    let expires_at = w.env.intent(&w.owner(), 0)?.expires_at;
    assert_eq!(expires_at, START_TS + 3_600);
    for now in [expires_at, expires_at + 1] {
        w.env.set_now(now);
        assert_eq!(
            w.refused(1)?,
            Some(engine_error_at(FILL_AT, EngineError::IntentExpired)),
            "now {now}"
        );
    }
    assert_eq!(w.escrow()?, ESCROW);
    w.env.set_now(expires_at - 1);
    w.claim(1)??;
    assert_eq!(w.escrow()?, 0);
    Ok(())
}

#[test]
fn split_refuses_a_result_out_of_bounds() -> TestResult {
    let mut w = world(&JUDGED)?;
    for result in [0, 2, u64::MAX] {
        assert_eq!(
            w.refused(result)?,
            Some(engine_error_at(FILL_AT, EngineError::ResultOutOfBounds)),
            "result {result}"
        );
    }
    assert_eq!(w.escrow()?, ESCROW);
    w.claim(1)??;
    assert_eq!(w.escrow()?, 0);
    Ok(())
}

#[test]
fn split_refuses_a_missing_signature_instruction() -> TestResult {
    let mut w = world(&JUDGED)?;
    let fee_to = Some(w.fee_to);
    let fill = w.fill_ix(1, fee_to.as_ref());
    assert_eq!(
        w.send(std::slice::from_ref(&fill)).err(),
        Some(engine_error(EngineError::SigMissing)),
        "a claim with no instruction before it"
    );
    let cosign = w.cosign_ix(1)?;
    assert_eq!(
        w.send(&[fill, cosign]).err(),
        Some(engine_error(EngineError::SigMissing)),
        "a claim whose signatures come after it"
    );
    assert_eq!(w.escrow()?, ESCROW);
    Ok(())
}

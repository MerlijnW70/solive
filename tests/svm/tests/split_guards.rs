use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::state::PAUSE_FILL;
use intent_engine::ConfigUpdate;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    cosign_batch_ix, engine_error, intent_pda, split_commit, split_digest, swap_spec, vault_pda,
    Delivery, Env, IntentSpec, Market, MintExt, Solver, TestResult, Trader, DOMAIN,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SPEC: [u8; 32] = [0x5e; 32];
const AGENT_FEE_AT: usize = 8 + 432;

struct Case {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    fee_to: Pubkey,
    attestor: Keypair,
    coauthors: Vec<Keypair>,
    delivery: Option<Delivery>,
}

impl Case {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn recipients(&self, n: usize) -> Vec<Pubkey> {
        self.coauthors.iter().take(n).map(Signer::pubkey).collect()
    }

    fn claim_ix(&self, recipients: &[Pubkey], weights: &[u16]) -> Instruction {
        self.env.fill_attested_split_ix(
            &self.solver.key.pubkey(),
            &self.owner(),
            &self.market,
            0,
            recipients,
            weights,
            Some(&self.fee_to),
            1,
        )
    }

    fn claim(&mut self, ix: Instruction) -> Option<TransactionError> {
        let solver = self.solver.key.insecure_clone();
        self.env.send(&solver, &[ix], &[]).err()
    }

    fn escrow(&self) -> TestResult<u64> {
        self.env.balance(&vault_pda(&intent_pda(&self.owner(), 0)))
    }
}

fn proof_spec(attestor: &Keypair, spec_hash: [u8; 32]) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    })
}

fn case_with(program: Pubkey, spec_hash: [u8; 32], coauthors: usize) -> TestResult<Case> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(program, &[], program, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let attestor = Keypair::new();
    env.create_intent(&trader, &market, &proof_spec(&attestor, spec_hash)?)?;
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let coauthors: Vec<Keypair> = (0..coauthors).map(|_| Keypair::new()).collect();
    for c in &coauthors {
        env.create_ata(&c.pubkey(), &market.input_mint, market.input_program)?;
    }
    let intent = intent_pda(&trader.key.pubkey(), 0);
    let delivery = match coauthors.first() {
        Some(first) if spec_hash != [0u8; 32] => Some(env.announce_as(first, &intent)?),
        _ => None,
    };
    Ok(Case {
        env,
        market,
        trader,
        solver,
        fee_to,
        attestor,
        coauthors,
        delivery,
    })
}

fn case() -> TestResult<Case> {
    case_with(anchor_spl::token::ID, SPEC, 3)
}

#[test]
fn the_fixture_settles_when_every_co_author_and_the_attestor_sign() -> TestResult {
    let mut c = case()?;
    let recipients = c.recipients(2);
    let weights = [6000u16, 4000];
    let intent = intent_pda(&c.owner(), 0);
    let digest = split_digest(
        DOMAIN,
        &intent,
        ESCROW,
        1,
        SPEC,
        split_commit(&recipients, &weights),
        &c.delivery.ok_or("no delivery")?,
    );
    let signers: Vec<&Keypair> = c
        .coauthors
        .iter()
        .take(2)
        .chain(std::iter::once(&c.attestor))
        .collect();
    let ixs = vec![
        cosign_batch_ix(&signers, &digest)?,
        c.claim_ix(&recipients, &weights),
    ];
    let solver = c.solver.key.insecure_clone();
    c.env.send(&solver, &ixs, &[])?;
    assert_eq!(c.escrow()?, 0, "the honest split drains the escrow");
    Ok(())
}

#[test]
fn a_split_with_an_unknown_extension_is_refused() -> TestResult {
    let mut c = case()?;
    c.env.ext = vec![2, 0, 0];
    let ix = c.claim_ix(&c.recipients(2), &[6000, 4000]);
    assert_eq!(c.claim(ix), Some(engine_error(EngineError::ExtUnknown)));
    assert_eq!(c.escrow()?, ESCROW);
    Ok(())
}

#[test]
fn a_split_with_no_recipients_is_refused() -> TestResult {
    let mut c = case()?;
    let ix = c.claim_ix(&[], &[]);
    assert_eq!(
        c.claim(ix),
        Some(engine_error(EngineError::SplitCountMismatch))
    );
    assert_eq!(c.escrow()?, ESCROW);
    Ok(())
}

#[test]
fn a_split_with_more_recipients_than_slots_is_refused() -> TestResult {
    let mut c = case_with(anchor_spl::token::ID, SPEC, 9)?;
    let recipients = c.recipients(9);
    let ix = c.claim_ix(&recipients, &[1000; 9]);
    assert_eq!(
        c.claim(ix),
        Some(engine_error(EngineError::SplitCountMismatch))
    );
    assert_eq!(c.escrow()?, ESCROW);
    Ok(())
}

#[test]
fn a_split_whose_weights_do_not_match_its_recipients_is_refused() -> TestResult {
    let mut c = case()?;
    let recipients = c.recipients(2);
    for weights in [&[10_000u16][..], &[5000, 3000, 2000][..]] {
        let ix = c.claim_ix(&recipients, weights);
        assert_eq!(
            c.claim(ix),
            Some(engine_error(EngineError::SplitCountMismatch)),
            "{} weights for 2 recipients",
            weights.len()
        );
    }
    assert_eq!(c.escrow()?, ESCROW);
    Ok(())
}

#[test]
fn a_split_whose_recipient_accounts_do_not_match_its_claim_is_refused() -> TestResult {
    let mut c = case()?;
    let claimed = c.claim_ix(&c.recipients(2), &[6000, 4000]);
    let mut extra = c.claim_ix(&c.recipients(3), &[4000, 3000, 3000]);
    extra.data.clone_from(&claimed.data);
    assert_eq!(
        c.claim(extra),
        Some(engine_error(EngineError::SplitCountMismatch)),
        "a third recipient account beyond a two-way claim"
    );
    let mut missing = c.claim_ix(&c.recipients(2), &[6000, 4000]);
    let three = c.claim_ix(&c.recipients(3), &[4000, 3000, 3000]);
    missing.data.clone_from(&three.data);
    assert_eq!(
        c.claim(missing),
        Some(engine_error(EngineError::SplitCountMismatch)),
        "a three-way claim with only two recipient accounts"
    );
    assert_eq!(c.escrow()?, ESCROW);
    Ok(())
}

#[test]
fn a_split_is_refused_while_fills_are_paused() -> TestResult {
    let mut c = case()?;
    let authority = c.env.authority.insecure_clone();
    let pause = c.env.raise_pause_ix(&authority.pubkey(), PAUSE_FILL);
    c.env.send(&authority, &[pause], &[])?;
    let ix = c.claim_ix(&c.recipients(2), &[6000, 4000]);
    assert_eq!(c.claim(ix), Some(engine_error(EngineError::FillPaused)));
    assert_eq!(c.escrow()?, ESCROW);
    Ok(())
}

#[test]
fn a_split_rechecks_the_input_mint_against_policy() -> TestResult {
    let t22 = anchor_spl::token_2022::ID;
    let mut c = case_with(t22, SPEC, 2)?;
    let hooked = c.env.create_mint(t22, &[MintExt::TransferHook])?;
    let forged = c.env.svm.get_account(&hooked).ok_or("mint missing")?;
    c.env.svm.set_account(c.market.input_mint, forged)?;
    let ix = c.claim_ix(&c.recipients(2), &[6000, 4000]);
    assert_eq!(c.claim(ix), Some(engine_error(EngineError::MintNotAllowed)));
    Ok(())
}

#[test]
fn a_split_is_refused_when_its_kind_is_disabled_for_fills() -> TestResult {
    let mut c = case()?;
    let authority = c.env.authority.insecure_clone();
    let s = c.env.settings();
    let update = c.env.update_ix(
        &authority.pubkey(),
        ConfigUpdate {
            guardian: s.guardian,
            fee_recipient: s.fee_recipient,
            enabled_kinds: s.enabled_kinds,
            fee_bps: s.fee_bps,
            fill_disabled_kinds: Kind::AttestedResult.bit(),
        },
    );
    c.env.send(&authority, &[update], &[])?;
    let ix = c.claim_ix(&c.recipients(2), &[6000, 4000]);
    assert_eq!(
        c.claim(ix),
        Some(engine_error(EngineError::FillKindDisabled))
    );
    assert_eq!(c.escrow()?, ESCROW);
    Ok(())
}

#[test]
fn a_split_is_refused_for_an_intent_that_owes_an_agent_fee() -> TestResult {
    let mut c = case()?;
    let intent = intent_pda(&c.owner(), 0);
    let mut account = c.env.svm.get_account(&intent).ok_or("intent missing")?;
    let end = AGENT_FEE_AT.checked_add(8).ok_or("overflow")?;
    account
        .data
        .get_mut(AGENT_FEE_AT..end)
        .ok_or("intent too short")?
        .copy_from_slice(&7u64.to_le_bytes());
    c.env.svm.set_account(intent, account)?;
    assert_eq!(c.env.intent(&c.owner(), 0)?.agent_fee, 7);
    let ix = c.claim_ix(&c.recipients(2), &[6000, 4000]);
    assert_eq!(
        c.claim(ix),
        Some(engine_error(EngineError::MandateMismatch))
    );
    assert_eq!(c.escrow()?, ESCROW);
    Ok(())
}

#[test]
fn a_split_is_refused_for_an_intent_without_a_pinned_spec() -> TestResult {
    let mut c = case_with(anchor_spl::token::ID, [0u8; 32], 3)?;
    let pinned = IntentSpec {
        nonce: 1,
        ..proof_spec(&c.attestor, SPEC)?
    };
    c.env.create_intent(&c.trader, &c.market, &pinned)?;
    let first = c.coauthors.first().ok_or("coauthor")?.insecure_clone();
    c.env.announce_as(&first, &intent_pda(&c.owner(), 1))?;
    let ix = c.claim_ix(&c.recipients(2), &[6000, 4000]);
    assert_eq!(c.claim(ix), Some(engine_error(EngineError::NotAProof)));
    assert_eq!(c.escrow()?, ESCROW);
    Ok(())
}

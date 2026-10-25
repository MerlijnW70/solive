use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::state::Intent;
use intent_engine::Economics;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    book_pda, claim_job_ix, claims_pda, intent_pda, load, open_claims_ix, stand_by_ix, standby_pda,
    swap_spec, vault_pda, Env, IntentSpec, TestResult,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SPEC: [u8; 32] = [0x4e; 32];
const STAKE: u64 = 30_000_000;
const BOUNTY: u32 = 7_000;
const HOUR: u32 = 3_600;

fn rent_exempt_beyond(env: &Env, key: &Pubkey, held: u64) -> TestResult<(u64, u64)> {
    let account = env.svm.get_account(key).ok_or("account missing")?;
    let floor = env
        .svm
        .minimum_balance_for_rent_exemption(account.data.len())
        .checked_add(held)
        .ok_or("floor overflow")?;
    Ok((account.lamports, floor))
}

#[test]
fn catalog_econ_every_account_an_escrow_opens_stays_rent_exempt_beyond_what_it_holds() -> TestResult
{
    let mut env = Env::new()?;
    env.init_config()?;
    let admin = env.authority.insecure_clone();
    let economics = env.economics_ix(
        &admin.pubkey(),
        Economics {
            kind_fee_mask: 0,
            kind_fee_bps: [0; 4],
            partner_cut_bps: 0,
            crank_bounty: BOUNTY,
            create_fee: 0,
        },
    );
    env.send(&admin, &[economics], &[])?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let owner = trader.key.pubkey();
    let judge = Keypair::new();
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: judge.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let intent = intent_pda(&owner, 0);
    let owner_key = trader.key.insecure_clone();
    env.send(
        &owner_key,
        &[open_claims_ix(&owner, &intent, HOUR, STAKE)],
        &[],
    )?;
    let holder = env.funded()?;
    let waiter = env.funded()?;
    env.send(
        &holder,
        &[claim_job_ix(&holder.pubkey(), &intent, &owner, HOUR)],
        &[],
    )?;
    env.send(
        &waiter,
        &[stand_by_ix(&waiter.pubkey(), &intent, 0, HOUR)],
        &[],
    )?;
    let delivery = env.announce_for(&holder, &intent)?;
    let bounty = u64::from(load::<Intent>(&env.svm, &intent)?.bounty);
    assert_eq!(
        bounty,
        u64::from(BOUNTY),
        "the intent escrows its crank bounty"
    );
    let accounts = [
        ("intent", intent, bounty),
        ("vault", vault_pda(&intent), 0),
        ("claims board", claims_pda(&intent), STAKE),
        ("stand-by entry", standby_pda(&intent, 0), STAKE),
        ("delivery book", book_pda(&intent), 0),
        ("announcement", delivery.announcement, 0),
    ];
    for (name, key, held) in accounts {
        let (lamports, floor) = rent_exempt_beyond(&env, &key, held)?;
        assert!(
            lamports >= floor,
            "{name} holds {lamports} lamports, below rent exemption plus the {held} it holds ({floor})"
        );
    }
    Ok(())
}

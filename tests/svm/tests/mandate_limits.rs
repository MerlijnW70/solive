use anchor_lang::prelude::Pubkey;
use intent_core::ext::MAX_PARTNER_BPS;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::MandateArgs;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    agent_lane, delegate_pda, dutch_at, engine_error, granted, granted_with, intent_pda, kit_spec,
    kit_terms, limit_at, partner_ext, swap_at, vault_pda, Granted, IntentSpec, Market, TestResult,
    Trader, KIT_FUNDED, START_TS,
};

const SPL: Pubkey = anchor_spl::token::ID;

fn refused<T>(e: EngineError) -> Result<T, TransactionError> {
    Err(engine_error(e))
}

fn lane(n: u64) -> u64 {
    agent_lane(1, n)
}

fn untouched(s: &Granted, nonce: u64) -> TestResult {
    assert_eq!(s.env.balance(&s.trader.input)?, KIT_FUNDED);
    assert!(!s.env.exists(&intent_pda(&s.owner(), nonce)));
    assert_eq!(s.usage()?, (0, 0));
    Ok(())
}

#[test]
fn per_intent_counts_the_agent_fee_and_admits_exactly_the_cap() -> TestResult {
    let mut s = granted(MandateArgs {
        agent_fee: 10,
        ..kit_terms()
    })?;
    assert_eq!(
        s.agent_creates(&swap_at(lane(0), 391, 1_000)?),
        refused(EngineError::MandateCap)
    );
    untouched(&s, lane(0))?;
    s.agent_creates(&swap_at(lane(0), 390, 200)?)?;
    let intent = intent_pda(&s.owner(), lane(0));
    assert_eq!(s.env.balance(&vault_pda(&intent))?, 400);
    assert_eq!(s.env.balance(&s.trader.input)?, KIT_FUNDED - 400);
    assert_eq!(s.usage()?, (400, 1));

    let mut plain = granted(kit_terms())?;
    assert_eq!(
        plain.agent_creates(&swap_at(lane(0), 401, 1_000)?),
        refused(EngineError::MandateCap)
    );
    untouched(&plain, lane(0))?;
    plain.agent_creates(&swap_at(lane(0), 400, 200)?)?;
    assert_eq!(plain.usage()?, (400, 1));
    Ok(())
}

#[test]
fn total_admits_the_last_unit_over_several_intents_and_refuses_one_more() -> TestResult {
    let mut s = granted(MandateArgs {
        agent_fee: 10,
        ..kit_terms()
    })?;
    s.agent_creates(&swap_at(lane(0), 390, 200)?)?;
    s.agent_creates(&swap_at(lane(1), 390, 200)?)?;
    assert_eq!(s.usage()?, (800, 2));
    assert_eq!(
        s.agent_creates(&swap_at(lane(2), 191, 101)?),
        refused(EngineError::MandateBudget)
    );
    assert_eq!(s.usage()?, (800, 2));
    s.agent_creates(&swap_at(lane(2), 190, 100)?)?;
    assert_eq!(s.usage()?, (1_000, 3));
    assert_eq!(
        s.agent_creates(&swap_at(lane(3), 1, 6)?),
        refused(EngineError::MandateBudget)
    );
    assert_eq!(s.usage()?, (1_000, 3));
    assert_eq!(s.env.balance(&s.trader.input)?, KIT_FUNDED - 1_000);
    Ok(())
}

#[test]
fn max_intents_admits_the_last_intent_and_refuses_the_next() -> TestResult {
    let mut s = granted(MandateArgs {
        max_intents: 3,
        ..kit_terms()
    })?;
    for n in 0..3 {
        s.agent_creates(&swap_at(lane(n), 10, 5)?)?;
    }
    assert_eq!(s.usage()?, (30, 3));
    assert_eq!(
        s.agent_creates(&swap_at(lane(3), 10, 5)?),
        refused(EngineError::MandateCount)
    );
    assert_eq!(s.usage()?, (30, 3));
    assert_eq!(s.env.balance(&s.trader.input)?, KIT_FUNDED - 30);
    Ok(())
}

#[test]
fn max_ttl_admits_an_expiry_at_the_limit_and_refuses_one_second_more() -> TestResult {
    let mut s = granted(kit_terms())?;
    let at = |nonce: u64, expires_at: i64| -> TestResult<IntentSpec> {
        Ok(IntentSpec {
            expires_at,
            ..swap_at(nonce, 10, 5)?
        })
    };
    assert_eq!(
        s.agent_creates(&at(lane(0), START_TS + 3_601)?),
        refused(EngineError::MandateTtl)
    );
    untouched(&s, lane(0))?;
    s.agent_creates(&at(lane(0), START_TS + 3_600)?)?;
    s.env.set_now(START_TS + 100);
    assert_eq!(
        s.agent_creates(&at(lane(1), START_TS + 3_701)?),
        refused(EngineError::MandateTtl)
    );
    s.agent_creates(&at(lane(1), START_TS + 3_700)?)?;
    assert_eq!(s.usage()?, (20, 2));

    let mut short = granted(MandateArgs {
        max_ttl: 1,
        ..kit_terms()
    })?;
    assert_eq!(
        short.agent_creates(&at(lane(0), START_TS + 2)?),
        refused(EngineError::MandateTtl)
    );
    short.agent_creates(&at(lane(0), START_TS + 1)?)?;

    let mut longest = granted(MandateArgs {
        max_ttl: i64::MAX,
        ..kit_terms()
    })?;
    longest.agent_creates(&at(lane(0), i64::MAX)?)?;
    assert_eq!(
        longest.env.intent(&longest.owner(), lane(0))?.expires_at,
        i64::MAX
    );
    Ok(())
}

#[test]
fn valid_until_admits_the_last_second_before_it_and_refuses_from_it_on() -> TestResult {
    let mut s = granted(MandateArgs {
        valid_until: START_TS + 100,
        ..kit_terms()
    })?;
    s.env.set_now(START_TS + 99);
    s.agent_creates(&swap_at(lane(0), 10, 5)?)?;
    s.env.set_now(START_TS + 100);
    assert_eq!(
        s.agent_creates(&swap_at(lane(1), 10, 5)?),
        refused(EngineError::MandateExpired)
    );
    assert_eq!(s.usage()?, (10, 1));
    Ok(())
}

fn attested(nonce: u64, attestor: Pubkey) -> TestResult<IntentSpec> {
    let params = attested_result::Params {
        amount_in: 10,
        min_result: 1,
        max_result: 2,
        attestor: attestor.to_bytes(),
        spec_hash: [0; 32],
        judge_fee: 0,
    }
    .encode()
    .map_err(|e| format!("{e:?}"))?;
    Ok(kit_spec(nonce, Kind::AttestedResult, params))
}

#[test]
fn every_kind_bit_admits_only_its_own_kind() -> TestResult {
    let swap = u8::try_from(Kind::SwapExactIn.bit())?;
    let limit = u8::try_from(Kind::LimitOrder.bit())?;
    let dutch = u8::try_from(Kind::DutchAuction.bit())?;
    for kinds in [
        swap,
        limit,
        dutch,
        swap | limit,
        swap | dutch,
        limit | dutch,
        swap | limit | dutch,
    ] {
        let mut s = granted(MandateArgs {
            kinds,
            ..kit_terms()
        })?;
        let specs = [
            (swap, swap_at(lane(0), 10, 5)?),
            (limit, limit_at(lane(1), 10, 5)?),
            (dutch, dutch_at(lane(2), 10, 5)?),
        ];
        for (bit, spec) in specs {
            let result = s.agent_creates(&spec).map(|_| ());
            if kinds & bit == 0 {
                assert_eq!(
                    result,
                    refused(EngineError::MandateKind),
                    "{kinds:#b} {bit:#b}"
                );
            } else {
                assert_eq!(result, Ok(()), "{kinds:#b} {bit:#b}");
            }
        }
        let agent = s.agent.pubkey();
        assert_eq!(
            s.agent_creates(&attested(lane(3), agent)?),
            refused(EngineError::MandateKind),
            "{kinds:#b}"
        );
    }
    let mut s = granted(kit_terms())?;
    let agent = s.agent.pubkey();
    for kinds in [
        0u8,
        0b1,
        u8::try_from(Kind::AttestedResult.bit())?,
        0b10_0000,
        0b1_1110,
    ] {
        let ix = s.env.create_mandate_ix(
            &s.trader,
            &s.market,
            MandateArgs {
                id: 1,
                agent,
                kinds,
                ..kit_terms()
            },
        );
        assert_eq!(
            s.owner_sends(&[ix]),
            refused(EngineError::MandateInvalid),
            "{kinds:#b}"
        );
    }
    Ok(())
}

#[test]
fn the_price_floor_admits_the_exact_ratio_for_every_kind_and_counts_the_fee() -> TestResult {
    let mut s = granted(MandateArgs {
        floor_out: 3,
        floor_in: 7,
        agent_fee: 2,
        max_intents: 6,
        ..kit_terms()
    })?;
    let below: [IntentSpec; 3] = [
        swap_at(lane(0), 5, 2)?,
        limit_at(lane(0), 5, 2)?,
        dutch_at(lane(0), 5, 2)?,
    ];
    for spec in &below {
        assert_eq!(
            s.agent_creates(spec),
            refused(EngineError::MandatePrice),
            "kind {}",
            spec.kind
        );
    }
    untouched(&s, lane(0))?;
    s.agent_creates(&swap_at(lane(0), 5, 3)?)?;
    s.agent_creates(&limit_at(lane(1), 5, 3)?)?;
    s.agent_creates(&dutch_at(lane(2), 5, 3)?)?;
    assert_eq!(s.usage()?, (21, 3));
    assert_eq!(s.env.balance(&s.trader.input)?, KIT_FUNDED - 21);
    Ok(())
}

#[test]
fn the_price_floor_holds_at_the_largest_values_the_types_allow() -> TestResult {
    let mut both = granted(MandateArgs {
        floor_out: u64::MAX,
        floor_in: u64::MAX,
        ..kit_terms()
    })?;
    assert_eq!(
        both.agent_creates(&swap_at(lane(0), 400, 399)?),
        refused(EngineError::MandatePrice)
    );
    both.agent_creates(&swap_at(lane(0), 400, 400)?)?;

    let mut steep = granted(MandateArgs {
        floor_out: u64::MAX,
        floor_in: 1,
        ..kit_terms()
    })?;
    for spec in [
        swap_at(lane(0), 1, u64::MAX - 1)?,
        swap_at(lane(0), 2, u64::MAX)?,
    ] {
        assert_eq!(
            steep.agent_creates(&spec),
            refused(EngineError::MandatePrice)
        );
    }
    steep.agent_creates(&swap_at(lane(0), 1, u64::MAX)?)?;
    assert_eq!(steep.usage()?, (1, 1));

    let mut flat = granted(MandateArgs {
        floor_out: 1,
        floor_in: u64::MAX,
        ..kit_terms()
    })?;
    assert_eq!(
        flat.agent_creates(&swap_at(lane(0), 400, 0)?),
        refused(EngineError::InvalidParams)
    );
    flat.agent_creates(&swap_at(lane(0), 400, 1)?)?;
    assert_eq!(flat.usage()?, (400, 1));
    Ok(())
}

#[test]
fn amounts_at_the_largest_values_overflow_into_the_cap_and_budget_refusals() -> TestResult {
    let mut s = granted_with(
        MandateArgs {
            per_intent: u64::MAX,
            total: u64::MAX,
            agent_fee: u64::MAX - 1,
            floor_out: 1,
            floor_in: 1,
            ..kit_terms()
        },
        u64::MAX,
    )?;
    assert_eq!(
        s.agent_creates(&swap_at(lane(0), 2, u64::MAX)?),
        refused(EngineError::MandateCap)
    );
    assert_eq!(
        s.agent_creates(&swap_at(lane(0), 1, u64::MAX - 1)?),
        refused(EngineError::MandatePrice)
    );
    s.agent_creates(&swap_at(lane(0), 1, u64::MAX)?)?;
    assert_eq!(s.usage()?, (u64::MAX, 1));
    let intent = intent_pda(&s.owner(), lane(0));
    assert_eq!(s.env.balance(&vault_pda(&intent))?, u64::MAX);
    assert_eq!(s.env.balance(&s.trader.input)?, 0);
    assert_eq!(
        s.agent_creates(&swap_at(lane(1), 1, u64::MAX)?),
        refused(EngineError::MandateBudget)
    );
    assert_eq!(s.usage()?, (u64::MAX, 1));
    Ok(())
}

#[test]
fn the_fixed_partner_and_its_bps_are_the_only_partner_terms_admitted() -> TestResult {
    let partner = Pubkey::new_unique();
    let other = Pubkey::new_unique();
    let mut s = granted(MandateArgs {
        partner,
        partner_bps: 30,
        ..kit_terms()
    })?;
    for ext in [
        Vec::new(),
        partner_ext(&partner, 29),
        partner_ext(&partner, 31),
        partner_ext(&other, 30),
    ] {
        let spec = IntentSpec {
            ext,
            ..swap_at(lane(0), 10, 5)?
        };
        assert_eq!(
            s.agent_creates(&spec),
            refused(EngineError::MandateMismatch)
        );
    }
    untouched(&s, lane(0))?;
    let spec = IntentSpec {
        ext: partner_ext(&partner, 30),
        ..swap_at(lane(0), 10, 5)?
    };
    s.agent_creates(&spec)?;
    let stored = s.env.intent(&s.owner(), lane(0))?;
    assert_eq!((stored.partner, stored.partner_bps), (partner, 30));

    let mut none = granted(kit_terms())?;
    let spec = IntentSpec {
        ext: partner_ext(&partner, 1),
        ..swap_at(lane(0), 10, 5)?
    };
    assert_eq!(
        none.agent_creates(&spec),
        refused(EngineError::MandateMismatch)
    );
    none.agent_creates(&swap_at(lane(0), 10, 5)?)?;

    let mut top = granted(MandateArgs {
        partner,
        partner_bps: MAX_PARTNER_BPS,
        ..kit_terms()
    })?;
    let spec = IntentSpec {
        ext: partner_ext(&partner, MAX_PARTNER_BPS),
        ..swap_at(lane(0), 10, 5)?
    };
    top.agent_creates(&spec)?;
    let agent = top.agent.pubkey();
    for (key, bps) in [
        (partner, MAX_PARTNER_BPS + 1),
        (partner, 0),
        (Pubkey::default(), 1),
    ] {
        let ix = top.env.create_mandate_ix(
            &top.trader,
            &top.market,
            MandateArgs {
                id: 1,
                agent,
                partner: key,
                partner_bps: bps,
                ..kit_terms()
            },
        );
        assert_eq!(
            top.owner_sends(&[ix]),
            refused(EngineError::MandateInvalid),
            "{bps}"
        );
    }
    Ok(())
}

#[test]
fn only_the_named_input_and_output_accounts_and_mints_are_admitted() -> TestResult {
    let mut s = granted(kit_terms())?;
    let owner = s.owner();
    let spec = swap_at(lane(0), 10, 5)?;
    let spare_input = s
        .env
        .create_token_account(&s.market.input_mint, &owner, SPL)?;
    s.env
        .mint_to(&s.market.input_mint, &spare_input, SPL, 100)?;
    let approve = anchor_spl::token_2022::spl_token_2022::instruction::approve(
        &SPL,
        &spare_input,
        &delegate_pda(&owner),
        &owner,
        &[],
        100,
    )?;
    s.owner_sends(&[approve])?;
    let spare_output = s
        .env
        .create_token_account(&s.market.output_mint, &owner, SPL)?;
    let other = s.env.market(SPL, &[], SPL, &[])?;
    let other_input = s.env.create_ata(&owner, &other.input_mint, SPL)?;
    s.env.mint_to(&other.input_mint, &other_input, SPL, 100)?;
    let other_output = s
        .env
        .create_token_account(&other.output_mint, &owner, SPL)?;
    let agent = s.agent.insecure_clone();
    let cases = [
        (spare_input, s.trader.receiver, Market { ..s.market }),
        (s.trader.input, spare_output, Market { ..s.market }),
        (
            other_input,
            s.trader.receiver,
            Market {
                input_mint: other.input_mint,
                ..s.market
            },
        ),
        (
            s.trader.input,
            other_output,
            Market {
                output_mint: other.output_mint,
                ..s.market
            },
        ),
    ];
    for (input, receiver, market) in cases {
        let named = Trader {
            key: s.trader.key.insecure_clone(),
            input,
            receiver,
            receiver_authority: owner,
        };
        let ix = s
            .env
            .agent_intent_ix(&agent.pubkey(), s.mandate, &named, &market, &spec);
        assert_eq!(
            s.env.send(&agent, &[ix], &[]),
            refused(EngineError::MandateMismatch)
        );
    }
    assert_eq!(s.env.balance(&spare_input)?, 100);
    assert_eq!(s.env.balance(&other_input)?, 100);
    untouched(&s, lane(0))?;
    s.agent_creates(&spec)?;
    let stored = s.env.intent(&owner, lane(0))?;
    assert_eq!(
        (stored.input_mint, stored.output_mint, stored.receiver),
        (s.market.input_mint, s.market.output_mint, s.trader.receiver)
    );
    assert_eq!(s.env.balance(&s.trader.input)?, KIT_FUNDED - 10);
    Ok(())
}

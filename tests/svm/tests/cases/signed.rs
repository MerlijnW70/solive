use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use intent_engine::events::{IntentCreated, RelayerPaid};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    anchor_error_at, bump_search_cost,
    cu_gate, ed25519_ix, engine_error_at, events, intent_pda, raw_ed25519_ix, signature_of,
    swap_spec, vault_pda, Env, IntentSpec, Market, SigEntry, TestResult, Trader, DOMAIN, START_TS,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SUBMIT_BY: i64 = START_TS + 600;

struct Setup {
    env: Env,
    market: Market,
    trader: Trader,
    relayer: Keypair,
    spec: IntentSpec,
}

fn setup(allowance: u64) -> TestResult<Setup> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    if allowance > 0 {
        env.approve_delegate(&trader, &market, allowance)?;
    }
    let relayer = env.funded()?;
    let spec = swap_spec(7, ESCROW)?;
    Ok(Setup {
        env,
        market,
        trader,
        relayer,
        spec,
    })
}

impl Setup {
    fn message(&self, spec: &IntentSpec) -> [u8; 114] {
        self.env
            .signed_message(&self.trader, &self.market, spec, DOMAIN, SUBMIT_BY)
    }

    fn create(&self, spec: &IntentSpec) -> anchor_lang::solana_program::instruction::Instruction {
        self.env.create_signed_ix(
            &self.relayer.pubkey(),
            &self.trader,
            &self.market,
            spec,
            SUBMIT_BY,
        )
    }

    fn submit(
        &mut self,
        ixs: &[anchor_lang::solana_program::instruction::Instruction],
    ) -> Result<litesvm::types::TransactionMetadata, TransactionError> {
        let relayer = self.relayer.insecure_clone();
        self.env.send(&relayer, ixs, &[])
    }

    fn owner_signed(&self) -> anchor_lang::solana_program::instruction::Instruction {
        ed25519_ix(&self.trader.key, &self.message(&self.spec))
    }
}

#[test]
fn relayer_creates_an_intent_the_owner_only_signed_offline() -> TestResult {
    let mut s = setup(ESCROW)?;
    let owner = s.trader.key.pubkey();
    let owner_lamports = s.env.lamports(&owner);
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    let meta = s.submit(&ixs)?;
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED - ESCROW);
    assert_eq!(s.env.balance(&vault_pda(&intent_pda(&owner, 7)))?, ESCROW);
    assert_eq!(s.env.lamports(&owner), owner_lamports);
    let intent = s.env.intent(&owner, 7)?;
    assert_eq!(intent.owner, owner);
    assert_eq!(intent.rent_payer, s.relayer.pubkey());
    assert_eq!(intent.escrowed, ESCROW);
    let created = events::<IntentCreated>(&meta).pop().ok_or("missing")?;
    assert_eq!(created.rent_payer, s.relayer.pubkey());
    assert_eq!(created.owner, owner);
    assert_eq!(s.env.user(&owner)?.nonce_bitmap, [1 << 7, 0, 0, 0]);
    Ok(())
}

#[test]
fn whoever_submits_a_signed_intent_first_collects_its_relayer_fee() -> TestResult {
    const FEE: u64 = 25;
    let mut s = setup(ESCROW + FEE)?;
    s.env.relayer_fee = FEE;
    let first = s.env.funded()?;
    let first_fee =
        s.env
            .create_token_account(&s.market.input_mint, &first.pubkey(), s.market.input_program)?;
    s.env.relayer_fee_to = Some(first_fee);
    let create = s
        .env
        .create_signed_ix(&first.pubkey(), &s.trader, &s.market, &s.spec, SUBMIT_BY);
    s.env.send(&first, &[s.owner_signed(), create], &[])?;
    assert_eq!(s.env.balance(&first_fee)?, FEE);
    let late_fee = s.env.create_token_account(
        &s.market.input_mint,
        &s.relayer.pubkey(),
        s.market.input_program,
    )?;
    s.env.relayer_fee_to = Some(late_fee);
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    assert!(s.submit(&ixs).is_err());
    assert_eq!(s.env.balance(&late_fee)?, 0);
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED - ESCROW - FEE);
    Ok(())
}

#[test]
fn the_relayer_collects_only_the_fee_the_owner_signed_for_in_the_input_token() -> TestResult {
    const FEE: u64 = 25;
    let mut s = setup(ESCROW + FEE)?;
    let owner = s.trader.key.pubkey();
    let relayer = s.relayer.pubkey();
    let fee_account =
        s.env
            .create_token_account(&s.market.input_mint, &relayer, s.market.input_program)?;
    s.env.relayer_fee = FEE;
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::FeeAccountMissing))
    );
    let foreign = s.env.create_token_account(
        &s.market.input_mint,
        &Pubkey::new_unique(),
        s.market.input_program,
    )?;
    s.env.relayer_fee_to = Some(foreign);
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(anchor_error_at(
            1,
            anchor_lang::error::ErrorCode::ConstraintTokenOwner
        ))
    );
    s.env.relayer_fee_to = Some(fee_account);
    let signed = s.owner_signed();
    s.env.relayer_fee = FEE + 1;
    let ixs = [signed, s.create(&s.spec)];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::SigMessage))
    );
    s.env.relayer_fee = FEE;
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    let meta = s.submit(&ixs)?;
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED - ESCROW - FEE);
    assert_eq!(s.env.balance(&fee_account)?, FEE);
    assert_eq!(s.env.balance(&vault_pda(&intent_pda(&owner, 7)))?, ESCROW);
    let paid = events::<RelayerPaid>(&meta).pop().ok_or("missing")?;
    assert_eq!(
        (paid.intent, paid.relayer, paid.account, paid.fee),
        (intent_pda(&owner, 7), relayer, fee_account, FEE)
    );
    Ok(())
}

#[test]
fn the_largest_relayed_create_fits_in_one_transaction() -> TestResult {
    const FEE: u64 = 25;
    let mut s = setup(ESCROW + FEE)?;
    let relayer = s.relayer.pubkey();
    s.env.relayer_fee = FEE;
    let fee_account = s.env.create_ata(&relayer, &s.market.input_mint, s.market.input_program)?;
    s.env.relayer_fee_to = Some(fee_account);
    let partner = Pubkey::new_unique();
    s.env.partner_to = Some(s.env.create_ata(&partner, &s.market.input_mint, s.market.input_program)?);
    let spec = IntentSpec {
        ext: svm_tests::partner_ext(&partner, 100),
        ..swap_spec(7, ESCROW)?
    };
    let ixs = [ed25519_ix(&s.trader.key, &s.message(&spec)), s.create(&spec)];
    let message = solana_message::Message::new(&ixs, Some(&relayer));
    let signatures = usize::from(message.header.num_required_signatures);
    let size = message
        .serialize()
        .len()
        .checked_add(1)
        .and_then(|n| n.checked_add(signatures.checked_mul(64)?))
        .ok_or("overflow")?;
    let budget = |data: Vec<u8>| anchor_lang::solana_program::instruction::Instruction {
        program_id: Pubkey::from_str_const("ComputeBudget111111111111111111111111111111"),
        accounts: Vec::new(),
        data,
    };
    let fee_ata = anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
        &relayer, &relayer, &s.market.input_mint, &s.market.input_program,
    );
    let mut sizes = Vec::new();
    for extra in [
        vec![budget(vec![2, 0, 0, 1, 0])],
        vec![budget(vec![2, 0, 0, 1, 0]), budget(vec![3, 1, 0, 0, 0, 0, 0, 0, 0])],
        vec![budget(vec![2, 0, 0, 1, 0]), fee_ata.clone()],
    ] {
        let all: Vec<anchor_lang::solana_program::instruction::Instruction> =
            extra.into_iter().chain(ixs.iter().cloned()).collect();
        let m = solana_message::Message::new(&all, Some(&relayer));
        let signed = usize::from(m.header.num_required_signatures)
            .checked_mul(64)
            .and_then(|n| n.checked_add(1))
            .and_then(|n| n.checked_add(m.serialize().len()))
            .ok_or("overflow")?;
        sizes.push(signed <= 1_232);
    }
    assert_eq!(sizes, [true, false, false], "with a unit limit it fits; a priority price or the relayer's own token account does not");
    assert!(size <= 1_232, "a relayed create with every option takes {size} bytes");
    s.submit(&ixs)?;
    assert_eq!(s.env.balance(&fee_account)?, FEE);
    Ok(())
}

#[test]
fn a_signature_without_a_fee_pays_the_relayer_nothing() -> TestResult {
    let mut s = setup(ESCROW)?;
    let relayer = s.relayer.pubkey();
    let fee_account =
        s.env
            .create_token_account(&s.market.input_mint, &relayer, s.market.input_program)?;
    s.env.relayer_fee_to = Some(fee_account);
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    let meta = s.submit(&ixs)?;
    assert_eq!(s.env.balance(&fee_account)?, 0);
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED - ESCROW);
    assert!(events::<RelayerPaid>(&meta).is_empty());
    let mut short = setup(ESCROW)?;
    let fee_account = short.env.create_token_account(
        &short.market.input_mint,
        &short.relayer.pubkey(),
        short.market.input_program,
    )?;
    short.env.relayer_fee_to = Some(fee_account);
    short.env.relayer_fee = 1;
    let ixs = [short.owner_signed(), short.create(&short.spec)];
    assert_eq!(short.submit(&ixs), Err(solana_transaction_error::TransactionError::InstructionError(1, solana_instruction_error::InstructionError::Custom(anchor_spl::token_2022::spl_token_2022::error::TokenError::OwnerMismatch as u32))));
    assert_eq!(short.env.balance(&short.trader.input)?, FUNDED);
    Ok(())
}

#[test]
fn closing_a_signed_intent_returns_rent_to_the_relayer() -> TestResult {
    let mut s = setup(ESCROW)?;
    let owner = s.trader.key.pubkey();
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    s.submit(&ixs)?;
    let intent = intent_pda(&owner, 7);
    let rent = s
        .env
        .lamports(&intent)
        .saturating_add(s.env.lamports(&vault_pda(&intent)));
    let cancel = s.env.cancel_ix(&owner, &s.market, 7, &s.trader.input);
    let key = s.trader.key.insecure_clone();
    s.env.send(&key, &[cancel], &[])?;
    let before = s.env.lamports(&s.relayer.pubkey());
    let cranker = s.env.funded()?;
    let close = s.env.close_ix_with(
        &cranker.pubkey(),
        &owner,
        &s.relayer.pubkey(),
        &s.market,
        7,
        &s.trader.input,
    );
    s.env.send(&cranker, &[close], &[])?;
    assert_eq!(
        s.env.lamports(&s.relayer.pubkey()),
        before.saturating_add(rent)
    );
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED);
    Ok(())
}

#[test]
fn rent_cannot_be_closed_to_anyone_but_the_payer() -> TestResult {
    let mut s = setup(ESCROW)?;
    let owner = s.trader.key.pubkey();
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    s.submit(&ixs)?;
    let cancel = s.env.cancel_ix(&owner, &s.market, 7, &s.trader.input);
    let key = s.trader.key.insecure_clone();
    s.env.send(&key, &[cancel], &[])?;
    let close = s
        .env
        .close_ix_by(&s.relayer.pubkey(), &owner, &s.market, 7, &s.trader.input);
    let relayer = s.relayer.insecure_clone();
    assert_eq!(
        s.env.send(&relayer, &[close], &[]).err(),
        Some(engine_error_at(0, EngineError::Unauthorized))
    );
    Ok(())
}

#[test]
fn a_submitted_signature_cannot_be_replayed_even_after_close() -> TestResult {
    let mut s = setup(ESCROW * 2)?;
    let owner = s.trader.key.pubkey();
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    s.submit(&ixs)?;
    assert_eq!(
        s.submit(&ixs).err(),
        Some(TransactionError::InstructionError(
            1,
            InstructionError::Custom(0)
        ))
    );
    let cancel = s.env.cancel_ix(&owner, &s.market, 7, &s.trader.input);
    let close = s.env.close_ix_with(
        &owner,
        &owner,
        &s.relayer.pubkey(),
        &s.market,
        7,
        &s.trader.input,
    );
    let key = s.trader.key.insecure_clone();
    s.env.send(&key, &[cancel, close], &[])?;
    assert!(!s.env.exists(&intent_pda(&owner, 7)));
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::NonceUsed))
    );
    Ok(())
}

#[test]
fn advancing_the_nonce_revokes_an_unsubmitted_signature() -> TestResult {
    let mut s = setup(ESCROW)?;
    let owner = s.trader.key.pubkey();
    let advance = s.env.advance_ix(&owner, 8);
    let key = s.trader.key.insecure_clone();
    s.env.send(&key, &[advance], &[])?;
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::NonceUsed))
    );
    Ok(())
}

#[test]
fn create_without_a_signature_instruction_is_rejected() -> TestResult {
    let mut s = setup(ESCROW)?;
    let ixs = [s.create(&s.spec)];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(0, EngineError::SigMissing))
    );
    Ok(())
}

#[test]
fn the_signature_must_sit_immediately_before_create() -> TestResult {
    let mut s = setup(ESCROW)?;
    let spacer =
        solana_system_interface::instruction::transfer(&s.relayer.pubkey(), &s.relayer.pubkey(), 0);
    let ixs = [s.owner_signed(), spacer, s.create(&s.spec)];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(2, EngineError::SigProgram))
    );
    Ok(())
}

#[test]
fn a_signature_by_anyone_but_the_owner_is_rejected() -> TestResult {
    let mut s = setup(ESCROW)?;
    let attacker = Keypair::new();
    let ixs = [
        ed25519_ix(&attacker, &s.message(&s.spec)),
        s.create(&s.spec),
    ];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::SigPubkey))
    );
    Ok(())
}

#[test]
fn a_signature_over_any_other_intent_is_rejected() -> TestResult {
    let mut s = setup(ESCROW)?;
    let mut other = swap_spec(8, ESCROW)?;
    other.expires_at = s.spec.expires_at;
    let wrong_nonce = ed25519_ix(&s.trader.key, &s.message(&other));
    let ixs = [wrong_nonce, s.create(&s.spec)];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::SigMessage))
    );
    let other_cluster = s
        .env
        .signed_message(&s.trader, &s.market, &s.spec, [0x22; 32], SUBMIT_BY);
    let ixs = [ed25519_ix(&s.trader.key, &other_cluster), s.create(&s.spec)];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::SigMessage))
    );
    let mut later = swap_spec(7, ESCROW)?;
    later.expires_at = s.spec.expires_at.saturating_add(1);
    let ixs = [
        ed25519_ix(&s.trader.key, &s.message(&later)),
        s.create(&s.spec),
    ];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::SigMessage))
    );
    Ok(())
}

#[test]
fn relay_style_offset_redirect_is_rejected() -> TestResult {
    let mut s = setup(ESCROW)?;
    let attacker = Keypair::new();
    let decoy_message = b"attacker signs something harmless".to_vec();
    let mut prefix = s.trader.key.pubkey().to_bytes().to_vec();
    prefix.extend_from_slice(&[0u8; 64]);
    prefix.extend_from_slice(&s.message(&s.spec));
    let forged = raw_ed25519_ix(
        &prefix,
        &[SigEntry {
            pubkey: attacker.pubkey().to_bytes(),
            signature: signature_of(&attacker, &decoy_message),
            message: decoy_message,
        }],
    )?;
    let ixs = [forged, s.create(&s.spec)];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::SigHeader))
    );
    assert!(!s.env.exists(&intent_pda(&s.trader.key.pubkey(), 7)));
    Ok(())
}

#[test]
fn a_second_verified_signature_in_the_instruction_is_rejected() -> TestResult {
    let mut s = setup(ESCROW)?;
    let message = s.message(&s.spec).to_vec();
    let other = Keypair::new();
    let forged = raw_ed25519_ix(
        &[],
        &[
            SigEntry {
                pubkey: s.trader.key.pubkey().to_bytes(),
                signature: signature_of(&s.trader.key, &message),
                message: message.clone(),
            },
            SigEntry {
                pubkey: other.pubkey().to_bytes(),
                signature: signature_of(&other, &message),
                message,
            },
        ],
    )?;
    let ixs = [forged, s.create(&s.spec)];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::SigHeader))
    );
    Ok(())
}

#[test]
fn a_forged_signature_never_reaches_the_program() -> TestResult {
    let mut s = setup(ESCROW)?;
    let mut forged = s.owner_signed();
    if let Some(b) = forged.data.get_mut(60) {
        *b ^= 1;
    }
    let ixs = [forged, s.create(&s.spec)];
    let err = s.submit(&ixs).err();
    assert!(
        matches!(err, Some(TransactionError::InstructionError(0, _))),
        "{err:?}"
    );
    assert!(!s.env.exists(&intent_pda(&s.trader.key.pubkey(), 7)));
    Ok(())
}

#[test]
fn only_the_real_instructions_sysvar_is_read() -> TestResult {
    let mut s = setup(ESCROW)?;
    let mut create = s.create(&s.spec);
    let fake = Pubkey::new_unique();
    let sysvar = solana_instructions_sysvar::ID;
    let meta = create
        .accounts
        .iter_mut()
        .find(|meta| meta.pubkey == sysvar)
        .ok_or("no instructions sysvar")?;
    meta.pubkey = fake;
    let ixs = [s.owner_signed(), create];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(TransactionError::InstructionError(
            1,
            InstructionError::UnsupportedSysvar
        ))
    );
    Ok(())
}

#[test]
fn escrow_moves_only_within_the_owners_allowance() -> TestResult {
    for allowance in [0, ESCROW - 1] {
        let mut s = setup(allowance)?;
        let ixs = [s.owner_signed(), s.create(&s.spec)];
        assert_eq!(s.submit(&ixs), if allowance == 0 { Err(solana_transaction_error::TransactionError::InstructionError(1, solana_instruction_error::InstructionError::Custom(anchor_spl::token_2022::spl_token_2022::error::TokenError::OwnerMismatch as u32))) } else { Err(solana_transaction_error::TransactionError::InstructionError(1, solana_instruction_error::InstructionError::Custom(anchor_spl::token_2022::spl_token_2022::error::TokenError::InsufficientFunds as u32))) }, "allowance {allowance}");
        assert!(!s.env.exists(&intent_pda(&s.trader.key.pubkey(), 7)));
        assert_eq!(s.env.balance(&s.trader.input)?, FUNDED);
    }
    let mut s = setup(ESCROW)?;
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    s.submit(&ixs)?;
    Ok(())
}

#[test]
fn an_agent_spending_the_shared_allowance_first_leaves_a_signed_intent_unrelayable_but_costs_the_owner_nothing() -> TestResult {
    let mut s = setup(ESCROW)?;
    let owner = s.trader.key.insecure_clone();
    let agent = s.env.funded()?;
    let grant = s.env.create_mandate_ix(
        &s.trader,
        &s.market,
        svm_tests::mandate_terms(agent.pubkey(), START_TS + 86_400),
    );
    s.env.send(&owner, &[grant], &[])?;
    let mandate = svm_tests::mandate_pda(&owner.pubkey(), &agent.pubkey(), 0);
    let drawn = IntentSpec {
        nonce: svm_tests::agent_lane(1, 0),
        params: intent_core::kinds::swap_exact_in::Params { amount_in: ESCROW, min_out: ESCROW / 2 }
            .encode()
            .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    let by_agent = s.env.agent_intent_ix(&agent.pubkey(), mandate, &s.trader, &s.market, &drawn);
    s.env.send(&agent, &[by_agent], &[])?;
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED - ESCROW);
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    assert_eq!(s.submit(&ixs), Err(solana_transaction_error::TransactionError::InstructionError(1, solana_instruction_error::InstructionError::Custom(anchor_spl::token_2022::spl_token_2022::error::TokenError::OwnerMismatch as u32))));
    assert!(!s.env.exists(&intent_pda(&owner.pubkey(), 7)));
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED - ESCROW);
    assert_eq!(s.env.intent(&owner.pubkey(), svm_tests::agent_lane(1, 0))?.owner, owner.pubkey());
    Ok(())
}

#[test]
fn a_signature_lapses_after_its_submit_by_time() -> TestResult {
    let mut s = setup(ESCROW)?;
    s.env.set_now(SUBMIT_BY);
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    s.submit(&ixs)?;
    let mut s = setup(ESCROW)?;
    s.env.set_now(SUBMIT_BY + 1);
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::SignatureExpired))
    );
    Ok(())
}

#[test]
fn a_relayer_cannot_extend_the_submit_by_time() -> TestResult {
    let mut s = setup(ESCROW)?;
    let create = s.env.create_signed_ix(
        &s.relayer.pubkey(),
        &s.trader,
        &s.market,
        &s.spec,
        SUBMIT_BY + 1,
    );
    let ixs = [s.owner_signed(), create];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::SigMessage))
    );
    Ok(())
}

#[test]
fn a_relayer_cannot_pick_another_owner_account_to_debit() -> TestResult {
    let mut s = setup(ESCROW)?;
    let owner = s.trader.key.pubkey();
    let second =
        s.env
            .create_token_account(&s.market.input_mint, &owner, s.market.input_program)?;
    s.env.mint_to(
        &s.market.input_mint,
        &second,
        s.market.input_program,
        ESCROW,
    )?;
    let other = Trader {
        key: s.trader.key.insecure_clone(),
        input: second,
        receiver: s.trader.receiver,
        receiver_authority: s.trader.receiver_authority,
    };
    s.env.approve_delegate(&other, &s.market, ESCROW)?;
    let create = s
        .env
        .create_signed_ix(&s.relayer.pubkey(), &other, &s.market, &s.spec, SUBMIT_BY);
    let ixs = [s.owner_signed(), create];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::SigMessage))
    );
    assert_eq!(s.env.balance(&second)?, ESCROW);
    Ok(())
}

#[test]
fn changing_any_signed_field_breaks_the_signature() -> TestResult {
    let s = setup(ESCROW)?;
    let owner = s.trader.key.pubkey().to_bytes();
    let base = intent_core::sig::SignedIntent {
        program: intent_engine::ID.to_bytes(),
        domain: DOMAIN,
        owner,
        owner_input: s.trader.input.to_bytes(),
        input_mint: s.market.input_mint.to_bytes(),
        output_mint: s.market.output_mint.to_bytes(),
        receiver: s.trader.receiver.to_bytes(),
        nonce: s.spec.nonce,
        expires_at: s.spec.expires_at,
        submit_by: SUBMIT_BY,
        kind: s.spec.kind,
        flags: s.spec.flags,
        params: &s.spec.params,
        epoch: 0,
        ext_hash: solana_sha256_hasher::hashv(&[&s.spec.ext]).to_bytes(),
        relayer_fee: 0,
    };
    let envelope = |p: intent_core::sig::SignedIntent| {
        let digest = solana_sha256_hasher::hashv(&[&p.preimage()]).to_bytes();
        intent_core::sig::offchain_envelope(&owner, &digest)
    };
    assert_eq!(envelope(base), s.message(&s.spec));
    let other_params = swap_spec(7, ESCROW + 1)?.params;
    let variants = [
        intent_core::sig::SignedIntent {
            program: [9; 32],
            ..base
        },
        intent_core::sig::SignedIntent {
            owner_input: [9; 32],
            ..base
        },
        intent_core::sig::SignedIntent {
            input_mint: [9; 32],
            ..base
        },
        intent_core::sig::SignedIntent {
            output_mint: [9; 32],
            ..base
        },
        intent_core::sig::SignedIntent {
            receiver: [9; 32],
            ..base
        },
        intent_core::sig::SignedIntent { kind: 2, ..base },
        intent_core::sig::SignedIntent {
            params: &other_params,
            ..base
        },
        intent_core::sig::SignedIntent { flags: 1, ..base },
        intent_core::sig::SignedIntent { epoch: 1, ..base },
        intent_core::sig::SignedIntent {
            ext_hash: [9; 32],
            ..base
        },
        intent_core::sig::SignedIntent {
            relayer_fee: 1,
            ..base
        },
    ];
    for (i, v) in variants.into_iter().enumerate() {
        let mut s = setup(ESCROW)?;
        let ixs = [ed25519_ix(&s.trader.key, &envelope(v)), s.create(&s.spec)];
        assert_eq!(
            s.submit(&ixs).err(),
            Some(engine_error_at(1, EngineError::SigMessage)),
            "variant {i}"
        );
    }
    Ok(())
}

#[test]
fn signed_create_compute_stays_within_its_measured_budget() -> TestResult {
    let mut s = setup(ESCROW)?;
    let ixs = [s.owner_signed(), s.create(&s.spec)];
    let meta = s.submit(&ixs)?;
    let owner = s.trader.key.pubkey();
    let intent = s.env.intent(&owner, 7)?;
    let delegate_bump =
        Pubkey::find_program_address(&[b"delegate", owner.as_ref()], &intent_engine::ID).1;
    let search = [intent.bump, intent.vault_bump, delegate_bump]
        .iter()
        .map(|b| bump_search_cost(*b))
        .fold(0u64, u64::saturating_add);
    let normalized = meta.compute_units_consumed.saturating_sub(search);
    cu_gate(&format!("signed_create{CU_SUFFIX}"), normalized)
}

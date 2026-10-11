use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{swap_exact_in, Kind};
use intent_core::lifecycle::Status;
use intent_engine::errors::EngineError;
use solana_signer::Signer;
use svm_tests::{
    agent_lane, canonical_refund, ed25519_ix, engine_error, intent_pda, mandate_pda, mandate_terms,
    swap_spec, vault_pda, AccountExt, Env, IntentSpec, Market, MintExt, Solver, TestResult, Trader,
    DOMAIN, START_TS,
};

const T22: Pubkey = anchor_spl::token_2022::ID;
const FUNDED: u64 = 1_000;
const ESCROW: u64 = 40;
const SOLVER_FUNDS: u64 = 10_000;
const ALLOWED: [[MintExt; 2]; 2] = [
    [MintExt::InterestBearing, MintExt::Freezable],
    [MintExt::ScaledUi, MintExt::Freezable],
];

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    fee_to: Pubkey,
}

fn error_of(result: TestResult) -> Option<String> {
    result.err().map(|e| e.to_string())
}

fn named(e: solana_transaction_error::TransactionError) -> Option<String> {
    Some(e.to_string())
}

fn world(input: &[MintExt], output: &[MintExt]) -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(T22, input, T22, output)?;
    let trader = env.trader(&market, FUNDED)?;
    let solver = env.solver(&market, SOLVER_FUNDS)?;
    let fee_to = env.fee_account(&market)?;
    Ok(World {
        env,
        market,
        trader,
        solver,
        fee_to,
    })
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn open(&mut self, nonce: u64) -> TestResult {
        self.env
            .create_intent(&self.trader, &self.market, &swap_spec(nonce, ESCROW)?)?;
        Ok(())
    }

    fn fill(&mut self, nonce: u64) -> TestResult {
        let owner = self.owner();
        let ix = self.env.fill_ix(
            &self.solver,
            &owner,
            &self.market,
            nonce,
            &self.trader.receiver,
            Some(&self.fee_to),
            1,
        );
        let solver = self.solver.key.insecure_clone();
        self.env.send(&solver, &[ix], &[])?;
        Ok(())
    }

    fn cancel(&mut self, nonce: u64, refund_to: &Pubkey) -> TestResult {
        let owner = self.owner();
        let ix = self.env.cancel_ix(&owner, &self.market, nonce, refund_to);
        let key = self.trader.key.insecure_clone();
        self.env.send(&key, &[ix], &[])?;
        Ok(())
    }

    fn expire(&mut self, nonce: u64, refund_to: &Pubkey) -> TestResult {
        let owner = self.owner();
        let cranker = self.solver.key.insecure_clone();
        let ix = self
            .env
            .expire_ix(&cranker.pubkey(), &owner, &self.market, nonce, refund_to);
        self.env.send(&cranker, &[ix], &[])?;
        Ok(())
    }

    fn close(&mut self, nonce: u64, refund_to: &Pubkey) -> TestResult {
        let owner = self.owner();
        let cranker = self.solver.key.insecure_clone();
        let ix = self
            .env
            .close_ix_by(&cranker.pubkey(), &owner, &self.market, nonce, refund_to);
        self.env.send(&cranker, &[ix], &[])?;
        Ok(())
    }

    fn status(&self, nonce: u64) -> TestResult<u8> {
        Ok(self.env.intent(&self.owner(), nonce)?.status)
    }

    fn vault(&self, nonce: u64) -> Pubkey {
        vault_pda(&intent_pda(&self.owner(), nonce))
    }

    fn freeze(&mut self, account: &Pubkey, input: bool, frozen: bool) -> TestResult {
        let mint = if input {
            self.market.input_mint
        } else {
            self.market.output_mint
        };
        self.env.set_frozen(account, &mint, T22, frozen)
    }

    fn balances(&self, nonce: u64) -> TestResult<[u64; 5]> {
        Ok([
            self.env.balance(&self.trader.input)?,
            self.env.balance(&self.trader.receiver)?,
            self.env.balance(&self.vault(nonce))?,
            self.env.balance(&self.solver.input)?,
            self.env.balance(&self.solver.output)?,
        ])
    }
}

fn thawed_trader(env: &mut Env, market: &Market) -> TestResult<Trader> {
    let key = env.funded()?;
    env.init_user(&key)?;
    let input = env.create_ata(&key.pubkey(), &market.input_mint, T22)?;
    let receiver = env.create_token_account(&market.output_mint, &key.pubkey(), T22)?;
    for (account, mint) in [(input, market.input_mint), (receiver, market.output_mint)] {
        let _ = env.set_frozen(&account, &mint, T22, false);
    }
    env.mint_to(&market.input_mint, &input, T22, FUNDED)?;
    Ok(Trader {
        receiver_authority: key.pubkey(),
        key,
        input,
        receiver,
    })
}

#[test]
fn every_extension_outside_the_allowlist_is_refused_on_either_side() -> TestResult {
    let refused = [
        MintExt::TransferFee,
        MintExt::DefaultFrozen,
        MintExt::NonTransferable,
        MintExt::Pausable,
        MintExt::PermanentDelegate,
        MintExt::TransferHook,
        MintExt::MintCloseAuthority,
    ];
    for ext in refused {
        for input_side in [true, false] {
            let (input, output): (&[MintExt], &[MintExt]) = if input_side {
                (&[ext], &[])
            } else {
                (&[], &[ext])
            };
            let mut env = Env::new()?;
            env.init_config()?;
            let market = env.market(T22, input, T22, output)?;
            let trader = thawed_trader(&mut env, &market)?;
            assert_eq!(
                env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)
                    .err(),
                Some(engine_error(EngineError::MintNotAllowed)),
                "{ext:?} on the {} side",
                if input_side { "input" } else { "output" }
            );
        }
    }
    Ok(())
}

#[test]
fn allowed_extensions_settle_every_path_in_raw_units() -> TestResult {
    for exts in ALLOWED {
        settles_every_path(&exts)?;
    }
    Ok(())
}

#[test]
fn every_allowed_extension_together_settles_every_path_in_raw_units() -> TestResult {
    settles_every_path(&[
        MintExt::InterestBearing,
        MintExt::MetadataPointer,
        MintExt::Freezable,
    ])?;
    settles_every_path(&[
        MintExt::ScaledUi,
        MintExt::MetadataPointer,
        MintExt::Freezable,
    ])
}

fn settles_every_path(exts: &[MintExt]) -> TestResult {
    let mut w = world(exts, exts)?;
    w.open(0)?;
    assert_eq!(
        w.balances(0)?,
        [FUNDED - ESCROW, 0, ESCROW, 0, SOLVER_FUNDS]
    );
    w.fill(0)?;
    assert_eq!(w.status(0)?, Status::Filled as u8);
    let fee = w.env.balance(&w.fee_to)?;
    assert_eq!(
        w.balances(0)?,
        [
            FUNDED - ESCROW,
            1,
            0,
            ESCROW.checked_sub(fee).ok_or("fee above escrow")?,
            SOLVER_FUNDS - 1
        ]
    );
    let input = w.trader.input;
    w.close(0, &input)?;
    assert!(!w.env.exists(&intent_pda(&w.owner(), 0)));

    w.open(1)?;
    w.cancel(1, &input)?;
    assert_eq!(w.env.balance(&input)?, FUNDED - ESCROW);
    w.close(1, &input)?;

    w.open(2)?;
    w.env.set_now(START_TS + 3_600);
    w.expire(2, &input)?;
    assert_eq!(w.env.balance(&input)?, FUNDED - ESCROW);
    w.close(2, &input)?;
    assert!(!w.env.exists(&w.vault(2)));
    Ok(())
}

#[test]
fn an_issuer_freezing_the_vault_blocks_every_path_but_moves_nothing() -> TestResult {
    let mut w = world(&[MintExt::Freezable], &[])?;
    w.open(0)?;
    let vault = w.vault(0);
    let input = w.trader.input;
    w.freeze(&vault, true, true)?;
    let before = w.balances(0)?;
    assert_eq!(
        error_of(w.fill(0)),
        named(
            solana_transaction_error::TransactionError::InstructionError(
                0,
                solana_instruction_error::InstructionError::Custom(
                    anchor_spl::token_2022::spl_token_2022::error::TokenError::AccountFrozen as u32
                )
            )
        )
    );
    assert_eq!(
        error_of(w.cancel(0, &input)),
        named(
            solana_transaction_error::TransactionError::InstructionError(
                0,
                solana_instruction_error::InstructionError::Custom(
                    anchor_spl::token_2022::spl_token_2022::error::TokenError::AccountFrozen as u32
                )
            )
        )
    );
    w.env.set_now(START_TS + 3_600);
    assert_eq!(
        error_of(w.expire(0, &input)),
        named(
            solana_transaction_error::TransactionError::InstructionError(
                0,
                solana_instruction_error::InstructionError::Custom(
                    anchor_spl::token_2022::spl_token_2022::error::TokenError::AccountFrozen as u32
                )
            )
        )
    );
    assert_eq!(w.balances(0)?, before);
    assert_eq!(w.status(0)?, Status::Open as u8);
    w.freeze(&vault, true, false)?;
    w.expire(0, &input)?;
    assert_eq!(w.env.balance(&input)?, FUNDED);
    w.close(0, &input)?;
    assert!(!w.env.exists(&vault));
    Ok(())
}

#[test]
fn an_issuer_freezing_the_receiver_stops_fills_and_the_owner_still_cancels() -> TestResult {
    let mut w = world(&[], &[MintExt::Freezable])?;
    w.open(0)?;
    let receiver = w.trader.receiver;
    w.freeze(&receiver, false, true)?;
    let before = w.balances(0)?;
    assert_eq!(
        error_of(w.fill(0)),
        named(
            solana_transaction_error::TransactionError::InstructionError(
                0,
                solana_instruction_error::InstructionError::Custom(
                    anchor_spl::token_2022::spl_token_2022::error::TokenError::AccountFrozen as u32
                )
            )
        )
    );
    assert_eq!(w.balances(0)?, before);
    let input = w.trader.input;
    w.cancel(0, &input)?;
    assert_eq!(w.env.balance(&input)?, FUNDED);
    Ok(())
}

#[test]
fn a_frozen_owner_account_sends_refunds_to_another_account_the_owner_holds() -> TestResult {
    let mut w = world(&[MintExt::Freezable], &[])?;
    w.open(0)?;
    w.open(1)?;
    let input = w.trader.input;
    let owner = w.owner();
    let spare = w
        .env
        .create_token_account(&w.market.input_mint, &owner, T22)?;
    w.freeze(&input, true, true)?;
    assert_eq!(
        error_of(w.cancel(0, &input)),
        named(
            solana_transaction_error::TransactionError::InstructionError(
                0,
                solana_instruction_error::InstructionError::Custom(
                    anchor_spl::token_2022::spl_token_2022::error::TokenError::AccountFrozen as u32
                )
            )
        )
    );
    w.cancel(0, &spare)?;
    assert_eq!(w.env.balance(&spare)?, ESCROW);
    w.env.set_now(START_TS + 3_600);
    assert_eq!(
        error_of(w.expire(1, &input)),
        named(engine_error(EngineError::RefundCannotReceive))
    );
    let stranger = w
        .env
        .create_token_account(&w.market.input_mint, &Pubkey::new_unique(), T22)?;
    assert_eq!(
        error_of(w.expire(1, &stranger)),
        named(engine_error(EngineError::RefundCannotReceive))
    );
    w.expire(1, &spare)?;
    assert_eq!(w.env.balance(&spare)?, 2 * ESCROW);
    assert_eq!(canonical_refund(&owner, &w.market), input);
    w.close(0, &spare)?;
    w.close(1, &spare)?;
    w.freeze(&input, true, false)?;
    assert_eq!(w.env.balance(&input)?, FUNDED - 2 * ESCROW);
    Ok(())
}

#[test]
fn a_cpi_guard_on_the_owner_account_blocks_owner_signed_creates_but_not_delegated_draws(
) -> TestResult {
    let mut w = world(&[], &[])?;
    let input = w.trader.input;
    let key = w.trader.key.insecure_clone();
    w.env
        .add_account_ext(&key, &input, T22, AccountExt::CpiGuard)?;
    assert_eq!(error_of(w.open(0)), named(solana_transaction_error::TransactionError::InstructionError(0, solana_instruction_error::InstructionError::Custom(anchor_spl::token_2022::spl_token_2022::error::TokenError::CpiGuardTransferBlocked as u32))));
    assert_eq!(w.env.balance(&input)?, FUNDED);

    w.env.approve_delegate(&w.trader, &w.market, ESCROW)?;
    let spec = swap_spec(1, ESCROW)?;
    let expires_at = START_TS + 3_600;
    let message = w
        .env
        .signed_message(&w.trader, &w.market, &spec, DOMAIN, expires_at);
    let relayer = w.env.funded()?;
    let ixs = [
        ed25519_ix(&key, &message),
        w.env
            .create_signed_ix(&relayer.pubkey(), &w.trader, &w.market, &spec, expires_at),
    ];
    w.env.send(&relayer, &ixs, &[])?;
    assert_eq!(w.env.balance(&input)?, FUNDED - ESCROW);

    let agent = w.env.funded()?;
    w.env.approve_delegate(&w.trader, &w.market, ESCROW)?;
    let args = intent_engine::MandateArgs {
        agent: agent.pubkey(),
        ..mandate_terms(agent.pubkey(), START_TS + 86_400)
    };
    let ix = w.env.create_mandate_ix(&w.trader, &w.market, args);
    w.env.send(&key, &[ix], &[])?;
    let mandate = mandate_pda(&w.owner(), &agent.pubkey(), args.id);
    let agent_spec = IntentSpec {
        nonce: agent_lane(1, 0),
        kind: Kind::SwapExactIn as u8,
        params: swap_exact_in::Params {
            amount_in: 10,
            min_out: 5,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        expires_at,
        flags: 0,
        ext: Vec::new(),
    };
    let ix = w
        .env
        .agent_intent_ix(&agent.pubkey(), mandate, &w.trader, &w.market, &agent_spec);
    w.env.send(&agent, &[ix], &[])?;
    assert_eq!(w.env.balance(&input)?, FUNDED - ESCROW - 10);
    w.cancel(1, &input)?;
    assert_eq!(w.env.balance(&input)?, FUNDED - 10);
    Ok(())
}

#[test]
fn a_receiver_that_demands_memos_only_hurts_its_own_owner() -> TestResult {
    let mut w = world(&[], &[])?;
    w.open(0)?;
    let receiver = w.trader.receiver;
    let key = w.trader.key.insecure_clone();
    w.env
        .add_account_ext(&key, &receiver, T22, AccountExt::MemoRequired)?;
    let before = w.balances(0)?;
    assert_eq!(
        error_of(w.fill(0)),
        named(
            solana_transaction_error::TransactionError::InstructionError(
                0,
                solana_instruction_error::InstructionError::Custom(
                    anchor_spl::token_2022::spl_token_2022::error::TokenError::NoMemo as u32
                )
            )
        )
    );
    assert_eq!(w.balances(0)?, before);
    let input = w.trader.input;
    w.cancel(0, &input)?;
    assert_eq!(w.env.balance(&input)?, FUNDED);
    assert_eq!(
        w.env
            .create_intent(&w.trader, &w.market, &swap_spec(1, ESCROW)?)
            .err(),
        Some(engine_error(EngineError::ReceiverCannotReceive))
    );
    Ok(())
}

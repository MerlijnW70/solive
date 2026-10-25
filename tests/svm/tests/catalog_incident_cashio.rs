use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use solana_instruction::Instruction;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    anchor_error, intent_pda, swap_spec, vault_pda, Env, Market, Solver, TestResult, Trader,
};

const PROGRAM: Pubkey = anchor_spl::token::ID;
const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    fee_to: Pubkey,
    counterfeit: Market,
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    let counterfeit = env.market(PROGRAM, &[], PROGRAM, &[])?;
    Ok(World {
        env,
        market,
        trader,
        solver,
        fee_to,
        counterfeit,
    })
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn vault(&self) -> Pubkey {
        vault_pda(&intent_pda(&self.owner(), 0))
    }

    fn fake_tokens(&mut self, mint: Pubkey, holder: &Pubkey) -> TestResult<Pubkey> {
        let account = self.env.create_token_account(&mint, holder, PROGRAM)?;
        self.env.mint_to(&mint, &account, PROGRAM, 10_000)?;
        Ok(account)
    }

    fn fill(&self, receiver: &Pubkey) -> Instruction {
        self.env.fill_ix(
            &self.solver,
            &self.owner(),
            &self.market,
            0,
            receiver,
            Some(&self.fee_to),
            ESCROW,
        )
    }

    fn swap_account(ix: &mut Instruction, from: &Pubkey, to: &Pubkey) {
        for meta in &mut ix.accounts {
            if meta.pubkey == *from {
                meta.pubkey = *to;
            }
        }
    }

    fn attempt(&mut self, ix: Instruction) -> Option<TransactionError> {
        let solver = self.solver.key.insecure_clone();
        self.env.send(&solver, &[ix], &[]).err()
    }

    fn untouched(&self) -> TestResult {
        assert_eq!(self.env.balance(&self.vault())?, ESCROW);
        assert_eq!(self.env.balance(&self.solver.input)?, 0);
        Ok(())
    }
}

#[test]
fn a_fill_paid_in_a_counterfeit_output_mint_is_refused() -> TestResult {
    let mut w = world()?;
    let fake_mint = w.counterfeit.output_mint;
    let solver_key = w.solver.key.pubkey();
    w.solver.output = w.fake_tokens(fake_mint, &solver_key)?;
    let mut ix = w.fill(&w.trader.receiver);
    World::swap_account(&mut ix, &w.market.output_mint, &fake_mint);
    let err = w.attempt(ix);
    assert_eq!(err, Some(anchor_error(ErrorCode::ConstraintHasOne)));
    w.untouched()?;
    assert_eq!(w.env.balance(&w.trader.receiver)?, 0);
    Ok(())
}

#[test]
fn a_fill_into_a_counterfeit_receiver_the_attacker_opened_for_the_owner_is_refused() -> TestResult {
    let mut w = world()?;
    let fake_mint = w.counterfeit.output_mint;
    let owner = w.owner();
    let solver_key = w.solver.key.pubkey();
    w.solver.output = w.fake_tokens(fake_mint, &solver_key)?;
    let decoy = w.env.create_token_account(&fake_mint, &owner, PROGRAM)?;
    let mut ix = w.fill(&decoy);
    World::swap_account(&mut ix, &w.market.output_mint, &fake_mint);
    let err = w.attempt(ix);
    assert_eq!(err, Some(anchor_error(ErrorCode::ConstraintHasOne)));
    w.untouched()?;
    assert_eq!(w.env.balance(&decoy)?, 0);
    Ok(())
}

#[test]
fn a_fill_naming_a_counterfeit_input_mint_takes_nothing_from_the_vault() -> TestResult {
    let mut w = world()?;
    let real_output_mint = w.market.output_mint;
    let solver_key = w.solver.key.pubkey();
    w.solver.output = w.fake_tokens(real_output_mint, &solver_key)?;
    let fake_mint = w.counterfeit.input_mint;
    let fake_input = w
        .env
        .create_token_account(&fake_mint, &solver_key, PROGRAM)?;
    let mut ix = w.fill(&w.trader.receiver);
    World::swap_account(&mut ix, &w.market.input_mint, &fake_mint);
    World::swap_account(&mut ix, &w.solver.input, &fake_input);
    let err = w.attempt(ix);
    assert_eq!(err, Some(anchor_error(ErrorCode::ConstraintHasOne)));
    w.untouched()?;
    assert_eq!(w.env.balance(&fake_input)?, 0);
    assert_eq!(w.env.balance(&w.trader.receiver)?, 0);
    Ok(())
}

#[test]
fn the_same_fill_with_the_real_mints_settles() -> TestResult {
    let mut w = world()?;
    let real_output_mint = w.market.output_mint;
    let solver_key = w.solver.key.pubkey();
    w.solver.output = w.fake_tokens(real_output_mint, &solver_key)?;
    let ix = w.fill(&w.trader.receiver);
    assert_eq!(w.attempt(ix), None);
    assert_eq!(w.env.balance(&w.trader.receiver)?, ESCROW);
    assert_eq!(w.env.balance(&w.vault())?, 0);
    Ok(())
}

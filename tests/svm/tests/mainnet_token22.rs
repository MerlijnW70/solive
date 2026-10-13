use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{swap_exact_in, Kind};
use intent_engine::errors::EngineError;
use solana_signer::Signer;
use svm_tests::{
    engine_error, Env, IntentSpec, Market, MintExt, Solver, TestResult, Trader, START_TS,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const MIN_OUT: u64 = 300;
const SOLVER_FUNDS: u64 = 10_000;

const HOSTILE: [MintExt; 6] = [
    MintExt::TransferFee,
    MintExt::PermanentDelegate,
    MintExt::Pausable,
    MintExt::DefaultFrozen,
    MintExt::NonTransferable,
    MintExt::MintCloseAuthority,
];

fn swap(nonce: u64, amount_in: u64, min_out: u64) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        nonce,
        kind: Kind::SwapExactIn as u8,
        params: swap_exact_in::Params { amount_in, min_out }
            .encode()
            .map_err(|e| format!("{e:?}"))?,
        expires_at: START_TS.saturating_add(3_600),
        flags: 0,
        ext: Vec::new(),
    })
}

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    fee_to: Pubkey,
}

fn world() -> TestResult<World> {
    let t22 = anchor_spl::token_2022::ID;
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(t22, &[], t22, &[])?;
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

    fn fill(
        &mut self,
        nonce: u64,
        amount_out: u64,
    ) -> Result<litesvm::types::TransactionMetadata, solana_transaction_error::TransactionError>
    {
        let ix = self.env.fill_ix(
            &self.solver,
            &self.owner(),
            &self.market,
            nonce,
            &self.trader.receiver,
            Some(&self.fee_to),
            amount_out,
        );
        let key = self.solver.key.insecure_clone();
        self.env.send(&key, &[ix], &[])
    }
}

#[test]
fn a_mint_swapped_to_a_hostile_extension_after_create_is_refused_at_fill() -> TestResult {
    let t22 = anchor_spl::token_2022::ID;
    for ext in HOSTILE {
        for side in [0usize, 1] {
            let mut w = world()?;
            w.env
                .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
            let hostile = w.env.create_mint(t22, &[ext])?;
            let forged = w.env.svm.get_account(&hostile).ok_or("mint missing")?;
            let target = if side == 0 {
                w.market.input_mint
            } else {
                w.market.output_mint
            };
            w.env.svm.set_account(target, forged)?;
            assert_eq!(
                w.fill(0, MIN_OUT).err(),
                Some(engine_error(EngineError::MintNotAllowed)),
                "{ext:?} on side {side}"
            );
        }
    }
    Ok(())
}

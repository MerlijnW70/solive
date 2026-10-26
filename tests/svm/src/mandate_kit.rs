use super::*;
use intent_core::kinds::{dutch_auction, limit_order, swap_exact_in, Kind};

pub const KIT_FUNDED: u64 = 1_000_000;
pub const KIT_VALID_UNTIL: i64 = START_TS + 86_400;
pub const USER_GRANTS_AT: usize = 8 + 32 + 8 + 32 + 1 + 1 + 6 + 8;

pub struct Granted {
    pub env: Env,
    pub market: Market,
    pub trader: Trader,
    pub agent: Keypair,
    pub mandate: Pubkey,
}

pub fn kit_terms() -> intent_engine::MandateArgs {
    mandate_terms(Pubkey::default(), KIT_VALID_UNTIL)
}

pub fn kit_spec(nonce: u64, kind: Kind, params: [u8; intent_core::PARAMS_LEN]) -> IntentSpec {
    IntentSpec {
        nonce,
        kind: kind as u8,
        params,
        expires_at: START_TS + 600,
        flags: 0,
        ext: Vec::new(),
    }
}

fn encoded<E: std::fmt::Debug>(
    params: Result<[u8; intent_core::PARAMS_LEN], E>,
) -> TestResult<[u8; intent_core::PARAMS_LEN]> {
    params.map_err(|e| format!("{e:?}").into())
}

pub fn swap_at(nonce: u64, amount_in: u64, min_out: u64) -> TestResult<IntentSpec> {
    let params = encoded(swap_exact_in::Params { amount_in, min_out }.encode())?;
    Ok(kit_spec(nonce, Kind::SwapExactIn, params))
}

pub fn limit_at(nonce: u64, make_amount: u64, take_amount: u64) -> TestResult<IntentSpec> {
    let params = encoded(
        limit_order::Params {
            make_amount,
            take_amount,
        }
        .encode(),
    )?;
    Ok(kit_spec(nonce, Kind::LimitOrder, params))
}

pub fn dutch_at(nonce: u64, amount_in: u64, end_out: u64) -> TestResult<IntentSpec> {
    let params = encoded(
        dutch_auction::Params {
            amount_in,
            start_out: end_out.saturating_mul(2),
            end_out,
            start_ts: START_TS,
            end_ts: START_TS + 60,
        }
        .encode(),
    )?;
    Ok(kit_spec(nonce, Kind::DutchAuction, params))
}

pub fn granted(terms: intent_engine::MandateArgs) -> TestResult<Granted> {
    granted_with(terms, KIT_FUNDED)
}

pub fn granted_with(terms: intent_engine::MandateArgs, funded: u64) -> TestResult<Granted> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, funded)?;
    env.approve_delegate(&trader, &market, funded)?;
    let agent = env.funded()?;
    let owner = trader.key.insecure_clone();
    let args = intent_engine::MandateArgs {
        agent: agent.pubkey(),
        ..terms
    };
    let ix = env.create_mandate_ix(&trader, &market, args);
    env.send(&owner, &[ix], &[])?;
    let mandate = mandate_pda(&owner.pubkey(), &agent.pubkey(), args.id);
    Ok(Granted {
        env,
        market,
        trader,
        agent,
        mandate,
    })
}

impl Granted {
    pub fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    pub fn serial(&self) -> TestResult<u64> {
        Ok(self.env.mandate(&self.mandate)?.serial)
    }

    pub fn lane(&self, n: u64) -> TestResult<u64> {
        Ok(agent_lane(self.serial()?, n))
    }

    pub fn agent_creates(
        &mut self,
        spec: &IntentSpec,
    ) -> Result<TransactionMetadata, TransactionError> {
        let agent = self.agent.insecure_clone();
        let mandate = self.mandate;
        self.creates_under(&agent, mandate, spec)
    }

    pub fn creates_under(
        &mut self,
        agent: &Keypair,
        mandate: Pubkey,
        spec: &IntentSpec,
    ) -> Result<TransactionMetadata, TransactionError> {
        let ix =
            self.env
                .agent_intent_ix(&agent.pubkey(), mandate, &self.trader, &self.market, spec);
        self.env.send(agent, &[ix], &[])
    }

    pub fn owner_sends(
        &mut self,
        ixs: &[Instruction],
    ) -> Result<TransactionMetadata, TransactionError> {
        let owner = self.trader.key.insecure_clone();
        self.env.send(&owner, ixs, &[])
    }

    pub fn grant(&mut self, terms: intent_engine::MandateArgs) -> TestResult<Pubkey> {
        let ix = self
            .env
            .create_mandate_ix(&self.trader, &self.market, terms);
        self.owner_sends(&[ix])?;
        Ok(mandate_pda(&self.owner(), &terms.agent, terms.id))
    }

    pub fn revoke(&mut self) -> TestResult {
        let ix = self.env.revoke_mandate_ix(&self.owner(), self.mandate);
        self.owner_sends(&[ix])?;
        Ok(())
    }

    pub fn advance_epoch(&mut self) -> TestResult {
        let owner = self.owner();
        let next = self.env.epoch(&owner).saturating_add(1);
        let ix = self.env.advance_epoch_ix(&owner, next);
        self.owner_sends(&[ix])?;
        Ok(())
    }

    pub fn set_grants(&mut self, grants: u64) -> TestResult {
        let user = user_pda(&self.owner());
        let mut account = self
            .env
            .svm
            .get_account(&user)
            .ok_or("user state missing")?;
        account
            .data
            .get_mut(USER_GRANTS_AT..USER_GRANTS_AT + 8)
            .ok_or("user state too short")?
            .copy_from_slice(&grants.to_le_bytes());
        self.env.svm.set_account(user, account)?;
        Ok(())
    }

    pub fn fill(
        &mut self,
        nonce: u64,
        amount_out: u64,
    ) -> TestResult<(
        Result<TransactionMetadata, TransactionError>,
        Solver,
        Pubkey,
    )> {
        let solver = self.env.solver(&self.market, amount_out)?;
        let fee_to = self.env.fee_account(&self.market)?;
        let owner = self.owner();
        let ix = self.env.fill_ix(
            &solver,
            &owner,
            &self.market,
            nonce,
            &self.trader.receiver,
            Some(&fee_to),
            amount_out,
        );
        let key = solver.key.insecure_clone();
        Ok((self.env.send(&key, &[ix], &[]), solver, fee_to))
    }

    pub fn cancel(&mut self, nonce: u64) -> Result<TransactionMetadata, TransactionError> {
        let ix = self
            .env
            .cancel_ix(&self.owner(), &self.market, nonce, &self.trader.input);
        self.owner_sends(&[ix])
    }

    pub fn expire(
        &mut self,
        cranker: &Keypair,
        nonce: u64,
    ) -> Result<TransactionMetadata, TransactionError> {
        let owner = self.owner();
        let refund = canonical_refund(&owner, &self.market);
        let ix = self
            .env
            .expire_ix(&cranker.pubkey(), &owner, &self.market, nonce, &refund);
        self.env.send(cranker, &[ix], &[])
    }

    pub fn agent_account(&mut self) -> TestResult<Pubkey> {
        let agent = self.agent.pubkey();
        self.env
            .create_ata(&agent, &self.market.input_mint, self.market.input_program)
    }

    pub fn usage(&self) -> TestResult<(u64, u32)> {
        let m = self.env.mandate(&self.mandate)?;
        Ok((m.spent, m.intents))
    }
}

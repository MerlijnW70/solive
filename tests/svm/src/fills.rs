use super::*;

pub struct Solver {
    pub key: Keypair,
    pub output: Pubkey,
    pub input: Pubkey,
}

impl Env {
    pub fn solver(&mut self, market: &Market, output_balance: u64) -> TestResult<Solver> {
        let key = self.funded()?;
        let output =
            self.create_token_account(&market.output_mint, &key.pubkey(), market.output_program)?;
        self.mint_to(
            &market.output_mint,
            &output,
            market.output_program,
            output_balance,
        )?;
        let input =
            self.create_token_account(&market.input_mint, &key.pubkey(), market.input_program)?;
        Ok(Solver { key, output, input })
    }

    pub fn fee_account(&mut self, market: &Market) -> TestResult<Pubkey> {
        let recipient = self.config()?.fee_recipient;
        self.create_ata(&recipient, &market.input_mint, market.input_program)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn fill_ix(
        &self,
        solver: &Solver,
        owner: &Pubkey,
        market: &Market,
        nonce: u64,
        receiver: &Pubkey,
        fee_to: Option<&Pubkey>,
        amount_out: u64,
    ) -> Instruction {
        let intent = intent_pda(owner, nonce);
        let (mandate, owner_state) = self.fill_mandate(owner, nonce);
        engine_ix(
            intent_engine::accounts::FillIntent {
                solver: solver.key.pubkey(),
                config: config_pda(),
                intent,
                vault: vault_pda(&intent),
                input_mint: market.input_mint,
                output_mint: market.output_mint,
                receiver: *receiver,
                solver_output: solver.output,
                solver_input: solver.input,
                fee_to: fee_to.copied(),
                partner_to: self.partner_to,
                input_token_program: market.input_program,
                output_token_program: market.output_program,
                mandate,
                owner_state,
                agent_to: self.fill_agent(owner, nonce, market),
                mint_cap: self.mint_cap,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::FillIntent {
                amount_in: self.fill_amount(owner, nonce),
                amount_out,
                max_fee_bps: self.max_fee_bps,
                ext: intent_engine::Ext(self.ext.clone()),
            },
        )
    }
}

impl Env {
    #[allow(clippy::too_many_arguments)]
    pub fn begin_fill_ix(
        &self,
        solver: &Pubkey,
        owner: &Pubkey,
        market: &Market,
        nonce: u64,
        solver_input: &Pubkey,
        fee_to: Option<&Pubkey>,
        end_index: u16,
    ) -> Instruction {
        let intent = intent_pda(owner, nonce);
        let (mandate, owner_state) = self.fill_mandate(owner, nonce);
        engine_ix(
            intent_engine::accounts::BeginFill {
                solver: *solver,
                config: config_pda(),
                intent,
                vault: vault_pda(&intent),
                input_mint: market.input_mint,
                solver_input: *solver_input,
                fee_to: fee_to.copied(),
                partner_to: self.partner_to,
                input_token_program: market.input_program,
                instructions: solana_instructions_sysvar::ID,
                mandate,
                owner_state,
                agent_to: self.fill_agent(owner, nonce, market),
                mint_cap: self.mint_cap,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::BeginFill {
                amount_in: self.fill_amount(owner, nonce),
                end_index,
                max_fee_bps: self.max_fee_bps,
                ext: intent_engine::Ext(self.ext.clone()),
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn end_fill_ix(
        &self,
        solver: &Pubkey,
        owner: &Pubkey,
        market: &Market,
        nonce: u64,
        receiver: &Pubkey,
        solver_output: &Pubkey,
        amount_out: u64,
    ) -> Instruction {
        engine_ix(
            intent_engine::accounts::EndFill {
                intent: intent_pda(owner, nonce),
                solver: *solver,
                output_mint: market.output_mint,
                receiver: *receiver,
                solver_output: *solver_output,
                output_token_program: market.output_program,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::EndFill {
                amount_out,
                ext: intent_engine::Ext(self.ext.clone()),
            },
        )
    }
}

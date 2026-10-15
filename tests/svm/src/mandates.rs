use super::*;

pub fn mandate_pda(owner: &Pubkey, agent: &Pubkey, id: u64) -> Pubkey {
    pda(&[
        MANDATE_SEED,
        owner.as_ref(),
        agent.as_ref(),
        &id.to_le_bytes(),
    ])
}

pub fn agent_lane(serial: u64, n: u64) -> u64 {
    intent_core::mandate::lane_of(serial).unwrap_or(0) | n
}

pub fn mandate_terms(agent: Pubkey, valid_until: i64) -> intent_engine::MandateArgs {
    intent_engine::MandateArgs {
        id: 0,
        agent,
        kinds: 0b1110,
        per_intent: 400,
        total: 1_000,
        max_intents: 4,
        max_ttl: 3_600,
        valid_until,
        floor_out: 1,
        floor_in: 2,
        partner: Pubkey::default(),
        partner_bps: 0,
        agent_fee: 0,
    }
}

impl Env {
    pub fn create_mandate_ix(
        &self,
        trader: &Trader,
        market: &Market,
        args: intent_engine::MandateArgs,
    ) -> Instruction {
        let owner = trader.key.pubkey();
        engine_ix(
            intent_engine::accounts::CreateMandate {
                owner,
                user_state: user_pda(&owner),
                mandate: mandate_pda(&owner, &args.agent, args.id),
                input_mint: market.input_mint,
                output_mint: market.output_mint,
                owner_input: trader.input,
                receiver: trader.receiver,
                input_token_program: market.input_program,
                output_token_program: market.output_program,
                system_program: anchor_lang::system_program::ID,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::CreateMandate { args },
        )
    }

    pub fn revoke_mandate_ix(&self, owner: &Pubkey, mandate: Pubkey) -> Instruction {
        engine_ix(
            intent_engine::accounts::RevokeMandate {
                owner: *owner,
                mandate,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::RevokeMandate {},
        )
    }

    pub fn agent_intent_ix(
        &self,
        agent: &Pubkey,
        mandate: Pubkey,
        trader: &Trader,
        market: &Market,
        spec: &IntentSpec,
    ) -> Instruction {
        let owner = trader.key.pubkey();
        let intent = intent_pda(&owner, spec.nonce);
        engine_ix(
            intent_engine::accounts::CreateIntentByAgent {
                agent: *agent,
                owner,
                mandate,
                config: config_pda(),
                user_state: user_pda(&owner),
                intent,
                input_mint: market.input_mint,
                output_mint: market.output_mint,
                owner_input: trader.input,
                receiver: trader.receiver,
                receiver_authority: trader.receiver_authority,
                vault: vault_pda(&intent),
                delegate: delegate_pda(&owner),
                input_token_program: market.input_program,
                output_token_program: market.output_program,
                treasury: self.fee_recipient,
                system_program: anchor_lang::system_program::ID,
                mint_cap: self.mint_cap,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::CreateIntentByAgent {
                args: intent_engine::CreateIntentArgs {
                    nonce: spec.nonce,
                    kind: spec.kind,
                    flags: spec.flags,
                    params: spec.params,
                    expires_at: spec.expires_at,
                    ext: intent_engine::Ext(spec.ext.clone()),
                    max_create_fee: self.max_create_fee,
                    max_bounty: self.max_bounty,
                },
            },
        )
    }

    pub fn mandate(&self, key: &Pubkey) -> TestResult<intent_engine::state::Mandate> {
        load(&self.svm, key)
    }
}

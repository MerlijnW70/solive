use super::*;

pub struct Market {
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub input_program: Pubkey,
    pub output_program: Pubkey,
}

pub struct Trader {
    pub key: Keypair,
    pub input: Pubkey,
    pub receiver: Pubkey,
    pub receiver_authority: Pubkey,
}

pub struct IntentSpec {
    pub nonce: u64,
    pub kind: u8,
    pub params: [u8; intent_core::PARAMS_LEN],
    pub expires_at: i64,
    pub flags: u16,
    pub ext: Vec<u8>,
}

pub fn partner_ext(partner: &Pubkey, bps: u16) -> Vec<u8> {
    let mut out = vec![intent_core::ext::PARTNER_TAG, 34, 0];
    out.extend_from_slice(partner.as_ref());
    out.extend_from_slice(&bps.to_le_bytes());
    out
}

pub fn swap_spec(nonce: u64, amount_in: u64) -> TestResult<IntentSpec> {
    let params = intent_core::kinds::swap_exact_in::Params {
        amount_in,
        min_out: 1,
    }
    .encode()
    .map_err(|e| format!("{e:?}"))?;
    Ok(IntentSpec {
        nonce,
        kind: intent_core::kinds::Kind::SwapExactIn as u8,
        params,
        expires_at: START_TS.saturating_add(3_600),
        flags: 0,
        ext: Vec::new(),
    })
}

impl Env {
    pub fn market(
        &mut self,
        input_program: Pubkey,
        input_exts: &[MintExt],
        output_program: Pubkey,
        output_exts: &[MintExt],
    ) -> TestResult<Market> {
        Ok(Market {
            input_mint: self.create_mint(input_program, input_exts)?,
            output_mint: self.create_mint_with_decimals(output_program, output_exts, 9)?,
            input_program,
            output_program,
        })
    }

    pub fn trader(&mut self, market: &Market, amount: u64) -> TestResult<Trader> {
        let key = self.funded()?;
        self.init_user(&key)?;
        let input = self.create_ata(&key.pubkey(), &market.input_mint, market.input_program)?;
        self.mint_to(&market.input_mint, &input, market.input_program, amount)?;
        let receiver =
            self.create_token_account(&market.output_mint, &key.pubkey(), market.output_program)?;
        Ok(Trader {
            receiver_authority: key.pubkey(),
            key,
            input,
            receiver,
        })
    }

    pub fn create_intent_ix(
        &self,
        trader: &Trader,
        market: &Market,
        spec: &IntentSpec,
    ) -> Instruction {
        let owner = trader.key.pubkey();
        let intent = intent_pda(&owner, spec.nonce);
        engine_ix(
            intent_engine::accounts::CreateIntent {
                owner,
                config: config_pda(),
                user_state: user_pda(&owner),
                intent,
                input_mint: market.input_mint,
                output_mint: market.output_mint,
                owner_input: trader.input,
                receiver: trader.receiver,
                receiver_authority: trader.receiver_authority,
                vault: vault_pda(&intent),
                input_token_program: market.input_program,
                output_token_program: market.output_program,
                treasury: self.fee_recipient,
                system_program: anchor_lang::system_program::ID,
                mint_cap: self.mint_cap,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::CreateIntent {
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

    pub fn create_intent(
        &mut self,
        trader: &Trader,
        market: &Market,
        spec: &IntentSpec,
    ) -> Result<TransactionMetadata, TransactionError> {
        let ix = self.create_intent_ix(trader, market, spec);
        let key = trader.key.insecure_clone();
        self.send(&key, &[ix], &[])
    }

    pub fn cancel_ix(
        &self,
        owner: &Pubkey,
        market: &Market,
        nonce: u64,
        refund_to: &Pubkey,
    ) -> Instruction {
        let intent = intent_pda(owner, nonce);
        engine_ix(
            intent_engine::accounts::CancelIntent {
                owner: *owner,
                intent,
                vault: vault_pda(&intent),
                input_mint: market.input_mint,
                refund_to: *refund_to,
                token_program: market.input_program,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::CancelIntent {
                ext: intent_engine::Ext(self.ext.clone()),
            },
        )
    }

    pub fn expire_ix(
        &self,
        cranker: &Pubkey,
        owner: &Pubkey,
        market: &Market,
        nonce: u64,
        refund_to: &Pubkey,
    ) -> Instruction {
        let intent = intent_pda(owner, nonce);
        engine_ix(
            intent_engine::accounts::ExpireIntent {
                cranker: *cranker,
                intent,
                vault: vault_pda(&intent),
                input_mint: market.input_mint,
                refund_to: *refund_to,
                canonical_refund: canonical_refund(owner, market),
                token_program: market.input_program,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::ExpireIntent {
                ext: intent_engine::Ext(self.ext.clone()),
            },
        )
    }

    pub fn close_ix(
        &self,
        owner: &Pubkey,
        market: &Market,
        nonce: u64,
        refund_to: &Pubkey,
    ) -> Instruction {
        self.close_ix_by(owner, owner, market, nonce, refund_to)
    }

    pub fn close_ix_by(
        &self,
        cranker: &Pubkey,
        owner: &Pubkey,
        market: &Market,
        nonce: u64,
        refund_to: &Pubkey,
    ) -> Instruction {
        self.close_ix_with(cranker, owner, owner, market, nonce, refund_to)
    }

    pub fn close_ix_with(
        &self,
        cranker: &Pubkey,
        owner: &Pubkey,
        rent_payer: &Pubkey,
        market: &Market,
        nonce: u64,
        refund_to: &Pubkey,
    ) -> Instruction {
        let intent = intent_pda(owner, nonce);
        engine_ix(
            intent_engine::accounts::CloseIntent {
                cranker: *cranker,
                intent,
                vault: vault_pda(&intent),
                input_mint: market.input_mint,
                refund_to: *refund_to,
                canonical_refund: canonical_refund(owner, market),
                owner: *owner,
                rent_payer: *rent_payer,
                token_program: market.input_program,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::CloseIntent {
                ext: intent_engine::Ext(self.ext.clone()),
            },
        )
    }

    pub fn advance_ix(&self, owner: &Pubkey, nonce_base: u64) -> Instruction {
        engine_ix(
            intent_engine::accounts::AdvanceNonce {
                owner: *owner,
                user_state: user_pda(owner),
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::AdvanceNonce { nonce_base },
        )
    }

    pub fn update_config_ix(&self, admin: &Pubkey, settings: ConfigSettings) -> Instruction {
        self.update_ix(
            admin,
            ConfigUpdate {
                guardian: settings.guardian,
                fee_recipient: settings.fee_recipient,
                enabled_kinds: settings.enabled_kinds,
                fee_bps: settings.fee_bps,
                fill_disabled_kinds: 0,
            },
        )
    }

    pub fn economics_ix(&self, admin: &Pubkey, args: intent_engine::Economics) -> Instruction {
        engine_ix(
            intent_engine::accounts::UpdateEconomics {
                admin: *admin,
                config: config_pda(),
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::UpdateEconomics { args },
        )
    }

    pub fn update_ix(&self, admin: &Pubkey, args: ConfigUpdate) -> Instruction {
        engine_ix(
            intent_engine::accounts::UpdateConfig {
                admin: *admin,
                config: config_pda(),
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::UpdateConfig { args },
        )
    }

    pub fn lower_pause_ix(&self, admin: &Pubkey, flags: u8) -> Instruction {
        engine_ix(
            intent_engine::accounts::LowerPause {
                admin: *admin,
                config: config_pda(),
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::LowerPause { flags },
        )
    }

    pub fn propose_admin_ix(&self, admin: &Pubkey, pending_admin: Pubkey) -> Instruction {
        engine_ix(
            intent_engine::accounts::ProposeAdmin {
                admin: *admin,
                config: config_pda(),
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::ProposeAdmin { pending_admin },
        )
    }

    pub fn accept_admin_ix(&self, pending_admin: &Pubkey) -> Instruction {
        engine_ix(
            intent_engine::accounts::AcceptAdmin {
                pending_admin: *pending_admin,
                config: config_pda(),
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::AcceptAdmin {},
        )
    }

    pub fn raise_pause_ix(&self, authority: &Pubkey, flags: u8) -> Instruction {
        engine_ix(
            intent_engine::accounts::RaisePause {
                authority: *authority,
                config: config_pda(),
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::RaisePause { flags },
        )
    }

    pub fn config(&self) -> TestResult<intent_engine::state::Config> {
        load(&self.svm, &config_pda())
    }

    pub fn user(&self, owner: &Pubkey) -> TestResult<intent_engine::state::UserState> {
        load(&self.svm, &user_pda(owner))
    }

    pub fn intent(&self, owner: &Pubkey, nonce: u64) -> TestResult<intent_engine::state::Intent> {
        load(&self.svm, &intent_pda(owner, nonce))
    }

    pub fn fill_amount(&self, owner: &Pubkey, nonce: u64) -> u64 {
        self.amount_in.unwrap_or_else(|| {
            self.intent(owner, nonce)
                .map(|i| i.escrowed.saturating_sub(i.filled))
                .unwrap_or(0)
        })
    }

    pub fn fill_mandate(&self, owner: &Pubkey, nonce: u64) -> (Option<Pubkey>, Option<Pubkey>) {
        self.mandate_accounts.unwrap_or_else(|| {
            self.intent(owner, nonce)
                .ok()
                .filter(|i| i.mandate != Pubkey::default())
                .map_or((None, None), |i| (Some(i.mandate), Some(user_pda(owner))))
        })
    }

    pub fn fill_agent(&self, owner: &Pubkey, nonce: u64, market: &Market) -> Option<Pubkey> {
        self.agent_to.unwrap_or_else(|| {
            self.intent(owner, nonce)
                .ok()
                .filter(|i| i.agent_fee > 0)
                .map(|i| {
                    anchor_spl::associated_token::get_associated_token_address_with_program_id(
                        &i.rent_payer,
                        &market.input_mint,
                        &market.input_program,
                    )
                })
        })
    }

    pub fn epoch(&self, owner: &Pubkey) -> u64 {
        self.user(owner).map(|u| u.epoch).unwrap_or(0)
    }

    pub fn advance_epoch_ix(&self, owner: &Pubkey, epoch: u64) -> Instruction {
        engine_ix(
            intent_engine::accounts::AdvanceEpoch {
                owner: *owner,
                user_state: user_pda(owner),
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::AdvanceEpoch { epoch },
        )
    }
}

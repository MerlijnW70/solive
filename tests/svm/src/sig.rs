use super::*;

pub fn signature_of(signer: &Keypair, message: &[u8]) -> [u8; 64] {
    <[u8; 64]>::from(signer.sign_message(message))
}

pub fn ed25519_ix(signer: &Keypair, message: &[u8]) -> Instruction {
    solana_ed25519_program::new_ed25519_instruction_with_signature(
        message,
        &signature_of(signer, message),
        &signer.pubkey().to_bytes(),
    )
}

pub struct SigEntry {
    pub pubkey: [u8; 32],
    pub signature: [u8; 64],
    pub message: Vec<u8>,
}

pub fn raw_ed25519_ix(prefix: &[u8], entries: &[SigEntry]) -> TestResult<Instruction> {
    let count = u8::try_from(entries.len())?;
    let header_len = 2usize.saturating_add(entries.len().saturating_mul(14));
    let mut payload = prefix.to_vec();
    let mut offsets = Vec::new();
    for e in entries {
        let base = header_len.saturating_add(payload.len());
        let pk = u16::try_from(base)?;
        let sig = u16::try_from(base.saturating_add(32))?;
        let msg = u16::try_from(base.saturating_add(96))?;
        for v in [
            sig,
            u16::MAX,
            pk,
            u16::MAX,
            msg,
            u16::try_from(e.message.len())?,
            u16::MAX,
        ] {
            offsets.extend_from_slice(&v.to_le_bytes());
        }
        payload.extend_from_slice(&e.pubkey);
        payload.extend_from_slice(&e.signature);
        payload.extend_from_slice(&e.message);
    }
    let mut data = vec![count, 0];
    data.extend_from_slice(&offsets);
    data.extend_from_slice(&payload);
    let program_id = ed25519_ix(&Keypair::new(), &[0]).program_id;
    Ok(Instruction {
        program_id,
        accounts: Vec::new(),
        data,
    })
}

impl Env {
    pub fn approve_delegate(
        &mut self,
        trader: &Trader,
        market: &Market,
        amount: u64,
    ) -> TestResult {
        let decimals = self.decimals(&market.input_mint)?;
        let ix = token_ix::approve_checked(
            &market.input_program,
            &trader.input,
            &market.input_mint,
            &delegate_pda(&trader.key.pubkey()),
            &trader.key.pubkey(),
            &[],
            amount,
            decimals,
        )?;
        let key = trader.key.insecure_clone();
        self.send(&key, &[ix], &[])?;
        Ok(())
    }

    pub fn signed_message(
        &self,
        trader: &Trader,
        market: &Market,
        spec: &IntentSpec,
        domain: [u8; 32],
        submit_by: i64,
    ) -> [u8; intent_core::sig::ENVELOPE_LEN] {
        let epoch = self.epoch(&trader.key.pubkey());
        self.signed_message_at(trader, market, spec, domain, submit_by, epoch)
    }

    pub fn signed_message_at(
        &self,
        trader: &Trader,
        market: &Market,
        spec: &IntentSpec,
        domain: [u8; 32],
        submit_by: i64,
        epoch: u64,
    ) -> [u8; intent_core::sig::ENVELOPE_LEN] {
        let owner = trader.key.pubkey().to_bytes();
        let preimage = intent_core::sig::SignedIntent {
            program: intent_engine::ID.to_bytes(),
            domain,
            owner,
            owner_input: trader.input.to_bytes(),
            input_mint: market.input_mint.to_bytes(),
            output_mint: market.output_mint.to_bytes(),
            receiver: trader.receiver.to_bytes(),
            nonce: spec.nonce,
            expires_at: spec.expires_at,
            submit_by,
            kind: spec.kind,
            flags: spec.flags,
            params: &spec.params,
            epoch,
            ext_hash: solana_sha256_hasher::hashv(&[&spec.ext]).to_bytes(),
            relayer_fee: self.relayer_fee,
        }
        .preimage();
        let digest = solana_sha256_hasher::hashv(&[&preimage]).to_bytes();
        intent_core::sig::offchain_envelope(&owner, &digest)
    }

    pub fn create_signed_ix(
        &self,
        payer: &Pubkey,
        trader: &Trader,
        market: &Market,
        spec: &IntentSpec,
        submit_by: i64,
    ) -> Instruction {
        let owner = trader.key.pubkey();
        let intent = intent_pda(&owner, spec.nonce);
        engine_ix(
            intent_engine::accounts::CreateIntentSigned {
                payer: *payer,
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
                delegate: delegate_pda(&owner),
                input_token_program: market.input_program,
                output_token_program: market.output_program,
                treasury: self.fee_recipient,
                relayer_fee_to: self.relayer_fee_to,
                system_program: anchor_lang::system_program::ID,
                instructions: solana_instructions_sysvar::ID,
                mint_cap: self.mint_cap,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::CreateIntentSigned {
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
                submit_by,
                relayer_fee: self.relayer_fee,
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn fill_attested_ix(
        &self,
        solver: &Pubkey,
        owner: &Pubkey,
        market: &Market,
        nonce: u64,
        payee: &Pubkey,
        fee_to: Option<&Pubkey>,
        result: u64,
    ) -> Instruction {
        let intent = intent_pda(owner, nonce);
        engine_ix(
            intent_engine::accounts::FillAttested {
                solver: *solver,
                config: config_pda(),
                intent,
                vault: vault_pda(&intent),
                input_mint: market.input_mint,
                payee: *payee,
                fee_to: fee_to.copied(),
                partner_to: self.partner_to,
                judge_to: self.judge_to,
                input_token_program: market.input_program,
                instructions: solana_instructions_sysvar::ID,
                claims: self.claims,
                stake_to: self.stake_to,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::FillAttested {
                amount_in: self.fill_amount(owner, nonce),
                result,
                max_fee_bps: self.max_fee_bps,
                ext: intent_engine::Ext(self.ext.clone()),
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn fill_attested_split_ix(
        &self,
        solver: &Pubkey,
        owner: &Pubkey,
        market: &Market,
        nonce: u64,
        recipients: &[Pubkey],
        weights: &[u16],
        fee_to: Option<&Pubkey>,
        result: u64,
    ) -> Instruction {
        let intent = intent_pda(owner, nonce);
        let atas: Vec<Pubkey> = recipients
            .iter()
            .map(|w| canonical_refund(w, market))
            .collect();
        let slot = |i: usize| atas.get(i).copied();
        engine_ix(
            intent_engine::accounts::FillAttestedSplit {
                solver: *solver,
                config: config_pda(),
                intent,
                vault: vault_pda(&intent),
                input_mint: market.input_mint,
                fee_to: fee_to.copied(),
                partner_to: self.partner_to,
                judge_to: self.judge_to,
                recipient0: slot(0),
                recipient1: slot(1),
                recipient2: slot(2),
                recipient3: slot(3),
                recipient4: slot(4),
                recipient5: slot(5),
                recipient6: slot(6),
                recipient7: slot(7),
                input_token_program: market.input_program,
                instructions: solana_instructions_sysvar::ID,
                claims: self.claims,
                stake_to: self.stake_to,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::FillAttestedSplit {
                amount_in: self.fill_amount(owner, nonce),
                result,
                max_fee_bps: self.max_fee_bps,
                claim: intent_engine::SplitClaim {
                    recipients: recipients.to_vec(),
                    weights: weights.to_vec(),
                },
                ext: intent_engine::Ext(self.ext.clone()),
            },
        )
    }
}

pub struct Attestation {
    pub domain: [u8; 32],
    pub intent: Pubkey,
    pub payee: Pubkey,
    pub amount_in: u64,
    pub result: u64,
    pub filled: u64,
    pub revision: u32,
    pub max_fee_bps: u16,
    pub ext_hash: [u8; 32],
}

pub fn empty_ext_hash() -> [u8; 32] {
    solana_sha256_hasher::hashv(&[&[]]).to_bytes()
}

pub fn attestation_message(
    domain: [u8; 32],
    attestor: &Pubkey,
    intent: &Pubkey,
    payee: &Pubkey,
    amount_in: u64,
    result: u64,
) -> [u8; intent_core::sig::ENVELOPE_LEN] {
    attestation_envelope(
        attestor,
        &Attestation {
            domain,
            intent: *intent,
            payee: *payee,
            amount_in,
            result,
            filled: 0,
            revision: 0,
            max_fee_bps: intent_engine::state::MAX_FEE_BPS,
            ext_hash: empty_ext_hash(),
        },
    )
}

pub fn attestation_envelope(
    attestor: &Pubkey,
    a: &Attestation,
) -> [u8; intent_core::sig::ENVELOPE_LEN] {
    let preimage = intent_core::sig::AttestedFill {
        program: intent_engine::ID.to_bytes(),
        domain: a.domain,
        intent: a.intent.to_bytes(),
        payee: a.payee.to_bytes(),
        amount_in: a.amount_in,
        result: a.result,
        filled: a.filled,
        revision: a.revision,
        max_fee_bps: a.max_fee_bps,
        ext_hash: a.ext_hash,
    }
    .preimage();
    let digest = solana_sha256_hasher::hashv(&[&preimage]).to_bytes();
    intent_core::sig::offchain_envelope(&attestor.to_bytes(), &digest)
}

#[allow(clippy::too_many_arguments)]
pub fn attestation_proof_message(
    domain: [u8; 32],
    attestor: &Pubkey,
    intent: &Pubkey,
    payee: &Pubkey,
    amount_in: u64,
    result: u64,
    spec_hash: [u8; 32],
) -> [u8; intent_core::sig::ENVELOPE_LEN] {
    let preimage = intent_core::sig::AttestedProof {
        program: intent_engine::ID.to_bytes(),
        domain,
        intent: intent.to_bytes(),
        payee: payee.to_bytes(),
        amount_in,
        result,
        filled: 0,
        revision: 0,
        max_fee_bps: intent_engine::state::MAX_FEE_BPS,
        ext_hash: empty_ext_hash(),
        spec_hash,
    }
    .preimage();
    let digest = solana_sha256_hasher::hashv(&[&preimage]).to_bytes();
    intent_core::sig::offchain_envelope(&attestor.to_bytes(), &digest)
}

pub fn split_commit(recipients: &[Pubkey], weights: &[u16]) -> [u8; 32] {
    let mut buf = Vec::new();
    for (wallet, bps) in recipients.iter().zip(weights.iter()) {
        buf.extend_from_slice(wallet.as_ref());
        buf.extend_from_slice(&bps.to_le_bytes());
    }
    solana_sha256_hasher::hashv(&[&buf]).to_bytes()
}

#[allow(clippy::too_many_arguments)]
pub fn attestation_split_message(
    domain: [u8; 32],
    attestor: &Pubkey,
    intent: &Pubkey,
    amount_in: u64,
    result: u64,
    spec_hash: [u8; 32],
    split_hash: [u8; 32],
) -> [u8; intent_core::sig::ENVELOPE_LEN] {
    let preimage = intent_core::sig::AttestedSplit {
        program: intent_engine::ID.to_bytes(),
        domain,
        intent: intent.to_bytes(),
        amount_in,
        result,
        filled: 0,
        revision: 0,
        max_fee_bps: intent_engine::state::MAX_FEE_BPS,
        ext_hash: empty_ext_hash(),
        spec_hash,
        split_hash,
    }
    .preimage();
    let digest = solana_sha256_hasher::hashv(&[&preimage]).to_bytes();
    intent_core::sig::offchain_envelope(&attestor.to_bytes(), &digest)
}

pub fn split_digest(
    domain: [u8; 32],
    intent: &Pubkey,
    amount_in: u64,
    result: u64,
    spec_hash: [u8; 32],
    split_hash: [u8; 32],
) -> [u8; 32] {
    let preimage = intent_core::sig::AttestedSplit {
        program: intent_engine::ID.to_bytes(),
        domain,
        intent: intent.to_bytes(),
        amount_in,
        result,
        filled: 0,
        revision: 0,
        max_fee_bps: intent_engine::state::MAX_FEE_BPS,
        ext_hash: empty_ext_hash(),
        spec_hash,
        split_hash,
    }
    .preimage();
    solana_sha256_hasher::hashv(&[&preimage]).to_bytes()
}

pub fn split_cosign_message(digest: &[u8; 32]) -> [u8; intent_core::sig::ENVELOPE_LEN] {
    intent_core::sig::offchain_envelope(&intent_core::sig::SPLIT_COSIGN_TAG, digest)
}

pub fn cosign_batch_ix(signers: &[&Keypair], digest: &[u8; 32]) -> TestResult<Instruction> {
    batch_ix(signers, &split_cosign_message(digest))
}

pub fn batch_ix(signers: &[&Keypair], message: &[u8]) -> TestResult<Instruction> {
    let m = signers.len();
    let len = u16::try_from(message.len())?;
    let pubkeys_at = 14usize.saturating_mul(m).saturating_add(2);
    let sigs_at = pubkeys_at.saturating_add(32usize.saturating_mul(m));
    let message_at = sigs_at.saturating_add(64usize.saturating_mul(m));
    let mut data = vec![u8::try_from(m)?, 0];
    for k in 0..m {
        let sig = u16::try_from(sigs_at.saturating_add(64usize.saturating_mul(k)))?;
        let pk = u16::try_from(pubkeys_at.saturating_add(32usize.saturating_mul(k)))?;
        let msg = u16::try_from(message_at)?;
        for v in [sig, u16::MAX, pk, u16::MAX, msg, len, u16::MAX] {
            data.extend_from_slice(&v.to_le_bytes());
        }
    }
    for s in signers {
        data.extend_from_slice(&s.pubkey().to_bytes());
    }
    for s in signers {
        data.extend_from_slice(&signature_of(s, message));
    }
    data.extend_from_slice(message);
    let program_id = ed25519_ix(&Keypair::new(), &[0]).program_id;
    Ok(Instruction {
        program_id,
        accounts: Vec::new(),
        data,
    })
}

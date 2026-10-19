use super::*;
use intent_core::committee::{Committee as CoreCommittee, COMMITTEE_COSIGN_TAG};

pub fn committee_id(
    members: &[Pubkey],
    threshold: u8,
    fee_wallet: &Pubkey,
) -> TestResult<[u8; 32]> {
    let keys: Vec<[u8; 32]> = members.iter().map(Pubkey::to_bytes).collect();
    let core = CoreCommittee::new(&keys, threshold, fee_wallet.to_bytes())
        .map_err(|e| format!("{e:?}"))?;
    Ok(solana_sha256_hasher::hashv(&[&core.preimage()]).to_bytes())
}

pub fn committee_pda(id: &[u8; 32]) -> Pubkey {
    pda(&[COMMITTEE_SEED, id])
}

pub fn sorted_members(n: usize) -> Vec<Keypair> {
    let mut members: Vec<Keypair> = (0..n).map(|_| Keypair::new()).collect();
    members.sort_by_key(Signer::pubkey);
    members
}

pub fn committee_message(members: &[Pubkey], digest: &[u8; 32]) -> TestResult<Vec<u8>> {
    cosign_message(members, digest)
}

pub fn committee_batch_ix(
    members: &[Pubkey],
    signers: &[&Keypair],
    digest: &[u8; 32],
) -> TestResult<Instruction> {
    cosign_ix(members, signers, digest)
}

pub fn proof_preimage(
    domain: [u8; 32],
    intent: &Pubkey,
    payee: &Pubkey,
    amount_in: u64,
    result: u64,
    spec_hash: [u8; 32],
) -> [u8; intent_core::sig::ATTEST_PROOF_PREIMAGE_LEN] {
    intent_core::sig::AttestedProof {
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
    .preimage()
}

pub fn proof_digest(
    domain: [u8; 32],
    intent: &Pubkey,
    payee: &Pubkey,
    amount_in: u64,
    result: u64,
    spec_hash: [u8; 32],
) -> [u8; 32] {
    let preimage = proof_preimage(domain, intent, payee, amount_in, result, spec_hash);
    solana_sha256_hasher::hashv(&[&COMMITTEE_COSIGN_TAG, &preimage]).to_bytes()
}

pub fn create_committee_with_id_ix(
    payer: &Pubkey,
    id: [u8; 32],
    members: &[Pubkey],
    threshold: u8,
    fee_wallet: &Pubkey,
) -> Instruction {
    engine_ix(
        intent_engine::accounts::CreateCommittee {
            payer: *payer,
            committee: committee_pda(&id),
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::CreateCommittee {
            id,
            members: members.to_vec(),
            threshold,
            fee_wallet: *fee_wallet,
        },
    )
}

pub fn create_committee_ix(
    payer: &Pubkey,
    members: &[Pubkey],
    threshold: u8,
    fee_wallet: &Pubkey,
) -> TestResult<(Instruction, Pubkey)> {
    let id = committee_id(members, threshold, fee_wallet)?;
    Ok((
        create_committee_with_id_ix(payer, id, members, threshold, fee_wallet),
        committee_pda(&id),
    ))
}

pub struct CommitteeFill<'a> {
    pub solver: &'a Pubkey,
    pub owner: &'a Pubkey,
    pub market: &'a Market,
    pub nonce: u64,
    pub fee_to: Option<&'a Pubkey>,
    pub committee: &'a Pubkey,
    pub signers: u8,
    pub result: u64,
}

impl Env {
    pub fn fill_attested_committee_ix(&self, fill: &CommitteeFill, payee: &Pubkey) -> Instruction {
        let intent = intent_pda(fill.owner, fill.nonce);
        engine_ix(
            intent_engine::accounts::FillAttestedCommittee {
                solver: *fill.solver,
                config: config_pda(),
                intent,
                vault: vault_pda(&intent),
                input_mint: fill.market.input_mint,
                payee: *payee,
                fee_to: fill.fee_to.copied(),
                partner_to: self.partner_to,
                judge_to: self.judge_to,
                committee: *fill.committee,
                input_token_program: fill.market.input_program,
                instructions: solana_instructions_sysvar::ID,
                claims: self.claims,
                stake_to: self.stake_to,
                mint_cap: self.mint_cap,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::FillAttestedCommittee {
                amount_in: self.fill_amount(fill.owner, fill.nonce),
                result: fill.result,
                max_fee_bps: self.max_fee_bps,
                signers: fill.signers,
                ext: intent_engine::Ext(self.ext.clone()),
            },
        )
    }

    pub fn fill_attested_split_committee_ix(
        &self,
        fill: &CommitteeFill,
        recipients: &[Pubkey],
        weights: &[u16],
    ) -> Instruction {
        let intent = intent_pda(fill.owner, fill.nonce);
        let atas: Vec<Pubkey> = recipients
            .iter()
            .map(|w| canonical_refund(w, fill.market))
            .collect();
        let slot = |i: usize| atas.get(i).copied();
        engine_ix(
            intent_engine::accounts::FillAttestedSplitCommittee {
                solver: *fill.solver,
                config: config_pda(),
                intent,
                vault: vault_pda(&intent),
                input_mint: fill.market.input_mint,
                fee_to: fill.fee_to.copied(),
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
                committee: *fill.committee,
                input_token_program: fill.market.input_program,
                instructions: solana_instructions_sysvar::ID,
                claims: self.claims,
                stake_to: self.stake_to,
                mint_cap: self.mint_cap,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::FillAttestedSplitCommittee {
                amount_in: self.fill_amount(fill.owner, fill.nonce),
                result: fill.result,
                max_fee_bps: self.max_fee_bps,
                signers: fill.signers,
                claim: intent_engine::SplitClaim {
                    recipients: recipients.to_vec(),
                    weights: weights.to_vec(),
                },
                ext: intent_engine::Ext(self.ext.clone()),
            },
        )
    }
}

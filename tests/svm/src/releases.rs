use super::*;

pub fn judged_spec(
    nonce: u64,
    amount_in: u64,
    attestor: &Pubkey,
    spec_hash: [u8; 32],
    judge_fee: u64,
) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: intent_core::kinds::Kind::AttestedResult as u8,
        params: intent_core::kinds::attested_result::Params {
            amount_in,
            min_result: 1,
            max_result: 1,
            attestor: attestor.to_bytes(),
            spec_hash,
            judge_fee,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(nonce, amount_in)?
    })
}

pub struct Panel {
    pub members: Vec<Keypair>,
    pub keys: Vec<Pubkey>,
    pub fee_wallet: Pubkey,
    pub address: Pubkey,
}

impl Panel {
    pub fn signers(&self, picks: &[usize]) -> Vec<&Keypair> {
        picks.iter().filter_map(|i| self.members.get(*i)).collect()
    }
}

pub struct Rents {
    pub vault: u64,
    pub intent: u64,
    pub bounty: u64,
}

impl Env {
    pub fn convene(&mut self, size: usize, threshold: u8) -> TestResult<Panel> {
        let members = sorted_members(size);
        let keys: Vec<Pubkey> = members.iter().map(Signer::pubkey).collect();
        let fee_wallet = Pubkey::new_unique();
        let payer = self.funded()?;
        let (ix, address) = create_committee_ix(&payer.pubkey(), &keys, threshold, &fee_wallet)?;
        self.send(&payer, &[ix], &[])?;
        Ok(Panel {
            members,
            keys,
            fee_wallet,
            address,
        })
    }

    pub fn hold_claim(
        &mut self,
        owner: &Keypair,
        nonce: u64,
        worker: &Keypair,
        secs: u32,
        stake: u64,
    ) -> TestResult {
        let intent = intent_pda(&owner.pubkey(), nonce);
        let open = open_claims_ix(&owner.pubkey(), &intent, secs, stake);
        self.send(owner, &[open], &[])?;
        let claim = claim_job_ix(&worker.pubkey(), &intent, &owner.pubkey(), secs);
        self.send(worker, &[claim], &[])?;
        Ok(())
    }

    pub fn rents(&self, owner: &Pubkey, nonce: u64) -> TestResult<Rents> {
        let intent = intent_pda(owner, nonce);
        Ok(Rents {
            vault: self.lamports(&vault_pda(&intent)),
            intent: self.lamports(&intent),
            bounty: u64::from(self.intent(owner, nonce)?.bounty),
        })
    }
}

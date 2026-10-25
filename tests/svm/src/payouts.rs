use super::*;
use anchor_spl::token_2022::spl_token_2022::error::TokenError;

pub const RELEASE_QUORUM: [usize; 2] = [0, 2];
pub const RELEASE_QUORUM_MASK: u8 = 0b101;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleasePath {
    Attested,
    AttestedSplit,
    Committee,
    CommitteeSplit,
}

impl ReleasePath {
    pub fn by_committee(self) -> bool {
        matches!(self, Self::Committee | Self::CommitteeSplit)
    }

    pub fn split(self) -> bool {
        matches!(self, Self::AttestedSplit | Self::CommitteeSplit)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseTerms {
    pub funded: u64,
    pub escrow: u64,
    pub judge_fee: u64,
    pub spec: [u8; 32],
    pub weights: [u16; 2],
    pub partner_bps: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Setting {
    MemoRequired,
    CpiGuard,
    Frozen,
    Closed,
}

pub fn token_error_at(index: u8, e: TokenError) -> TransactionError {
    TransactionError::InstructionError(index, InstructionError::Custom(e as u32))
}

impl Env {
    pub fn close_token_account(
        &mut self,
        owner: &Keypair,
        account: &Pubkey,
        token_program: Pubkey,
    ) -> TestResult {
        let ix = token_ix::close_account(
            &token_program,
            account,
            &owner.pubkey(),
            &owner.pubkey(),
            &[],
        )?;
        self.send(owner, &[ix], &[])?;
        Ok(())
    }

    pub fn apply_setting(
        &mut self,
        owner: &Keypair,
        account: &Pubkey,
        mint: &Pubkey,
        token_program: Pubkey,
        setting: Setting,
    ) -> TestResult {
        match setting {
            Setting::MemoRequired => {
                self.add_account_ext(owner, account, token_program, AccountExt::MemoRequired)
            }
            Setting::CpiGuard => {
                self.add_account_ext(owner, account, token_program, AccountExt::CpiGuard)
            }
            Setting::Frozen => self.set_frozen(account, mint, token_program, true),
            Setting::Closed => self.close_token_account(owner, account, token_program),
        }
    }
}

pub struct ReleaseWorld {
    pub env: Env,
    pub terms: ReleaseTerms,
    pub market: Market,
    pub trader: Trader,
    pub solver: Keypair,
    pub attestor: Keypair,
    pub panel: Option<Panel>,
    pub workers: [Keypair; 2],
    pub atas: [Pubkey; 2],
    pub judge_to: Pubkey,
    pub fee_owner: Keypair,
    pub fee_to: Pubkey,
    pub partner: Keypair,
    pub partner_to: Option<Pubkey>,
}

impl ReleaseWorld {
    pub fn new(exts: &[MintExt], path: ReleasePath, terms: ReleaseTerms) -> TestResult<Self> {
        let t22 = anchor_spl::token_2022::ID;
        let mut env = Env::new()?;
        let fee_owner = env.funded()?;
        env.fee_recipient = fee_owner.pubkey();
        env.init_config()?;
        let market = env.market(t22, exts, t22, &[])?;
        let trader = env.trader(&market, terms.funded)?;
        let attestor = env.funded()?;
        let partner = env.funded()?;
        let panel = if path.by_committee() {
            Some(env.convene(3, 2)?)
        } else {
            None
        };
        let (judge, fee_wallet) = panel
            .as_ref()
            .map_or((attestor.pubkey(), attestor.pubkey()), |p| {
                (p.address, p.fee_wallet)
            });
        let mut spec = judged_spec(0, terms.escrow, &judge, terms.spec, terms.judge_fee)?;
        if terms.partner_bps > 0 {
            spec.ext = partner_ext(&partner.pubkey(), terms.partner_bps);
        }
        env.create_intent(&trader, &market, &spec)?;
        let judge_to = env.create_ata(&fee_wallet, &market.input_mint, t22)?;
        env.judge_to = Some(judge_to);
        let partner_to = if terms.partner_bps > 0 {
            Some(env.create_ata(&partner.pubkey(), &market.input_mint, t22)?)
        } else {
            None
        };
        env.partner_to = partner_to;
        let workers = [env.funded()?, env.funded()?];
        let atas = [
            env.create_ata(&workers[0].pubkey(), &market.input_mint, t22)?,
            env.create_ata(&workers[1].pubkey(), &market.input_mint, t22)?,
        ];
        let solver = env.funded()?;
        let fee_to = env.fee_account(&market)?;
        Ok(Self {
            env,
            terms,
            market,
            trader,
            solver,
            attestor,
            panel,
            workers,
            atas,
            judge_to,
            fee_owner,
            fee_to,
            partner,
            partner_to,
        })
    }

    pub fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    pub fn intent(&self) -> Pubkey {
        intent_pda(&self.owner(), 0)
    }

    pub fn vault(&self) -> Pubkey {
        vault_pda(&self.intent())
    }

    pub fn wallets(&self) -> Vec<Pubkey> {
        self.workers.iter().map(Signer::pubkey).collect()
    }

    pub fn panel(&self) -> TestResult<&Panel> {
        Ok(self.panel.as_ref().ok_or("no committee")?)
    }

    pub fn release_ixs(
        &self,
        path: ReleasePath,
        delivery: &Delivery,
        payee: &Pubkey,
    ) -> TestResult<[Instruction; 2]> {
        let terms = self.terms;
        let solver = self.solver.pubkey();
        let owner = self.owner();
        let committee = self.panel.as_ref().map(|p| p.address).unwrap_or_default();
        let fill = CommitteeFill {
            solver: &solver,
            owner: &owner,
            market: &self.market,
            nonce: 0,
            fee_to: Some(&self.fee_to),
            committee: &committee,
            signers: RELEASE_QUORUM_MASK,
            result: 1,
        };
        let wallets = self.wallets();
        let split_hash = split_commit(&wallets, &terms.weights);
        let split = split_digest(
            DOMAIN,
            &self.intent(),
            terms.escrow,
            1,
            terms.spec,
            split_hash,
            delivery,
        );
        Ok(match path {
            ReleasePath::Attested => {
                let message = attestation_proof_message(
                    DOMAIN,
                    &self.attestor.pubkey(),
                    &self.intent(),
                    payee,
                    terms.escrow,
                    1,
                    terms.spec,
                    delivery,
                );
                [
                    ed25519_ix(&self.attestor, &message),
                    self.env.fill_attested_ix(
                        &solver,
                        &owner,
                        &self.market,
                        0,
                        payee,
                        Some(&self.fee_to),
                        1,
                    ),
                ]
            }
            ReleasePath::AttestedSplit => {
                let [a, b] = &self.workers;
                [
                    cosign_batch_ix(&[a, b, &self.attestor], &split)?,
                    self.env.fill_attested_split_ix(
                        &solver,
                        &owner,
                        &self.market,
                        0,
                        &wallets,
                        &terms.weights,
                        Some(&self.fee_to),
                        1,
                    ),
                ]
            }
            ReleasePath::Committee => {
                let panel = self.panel()?;
                let digest = proof_digest(
                    DOMAIN,
                    &self.intent(),
                    payee,
                    terms.escrow,
                    1,
                    terms.spec,
                    delivery,
                );
                [
                    committee_batch_ix(&panel.keys, &panel.signers(&RELEASE_QUORUM), &digest)?,
                    self.env.fill_attested_committee_ix(&fill, payee),
                ]
            }
            ReleasePath::CommitteeSplit => {
                let panel = self.panel()?;
                let listed: Vec<Pubkey> =
                    wallets.iter().chain(panel.keys.iter()).copied().collect();
                let signers: Vec<&Keypair> = self
                    .workers
                    .iter()
                    .chain(panel.signers(&RELEASE_QUORUM))
                    .collect();
                [
                    cosign_ix(&listed, &signers, &split)?,
                    self.env
                        .fill_attested_split_committee_ix(&fill, &wallets, &terms.weights),
                ]
            }
        })
    }

    pub fn release_to(
        &mut self,
        path: ReleasePath,
        delivery: &Delivery,
        payee: &Pubkey,
    ) -> TestResult<Result<TransactionMetadata, TransactionError>> {
        let ixs = self.release_ixs(path, delivery, payee)?;
        let solver = self.solver.insecure_clone();
        Ok(self.env.send(&solver, &ixs, &[]))
    }

    pub fn release(
        &mut self,
        path: ReleasePath,
        delivery: &Delivery,
    ) -> TestResult<Result<TransactionMetadata, TransactionError>> {
        let payee = self.atas[0];
        self.release_to(path, delivery, &payee)
    }

    pub fn paid(&self) -> TestResult<[u64; 2]> {
        Ok([
            self.env.balance(&self.atas[0])?,
            self.env.balance(&self.atas[1])?,
        ])
    }
}

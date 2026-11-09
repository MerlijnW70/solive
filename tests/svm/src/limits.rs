use super::*;
use solana_message::AddressLookupTableAccount;

pub const LIMIT_ESCROW: u64 = 1_000_000;
pub const LIMIT_JUDGE_FEE: u64 = 10_000;
pub const LIMIT_SPEC: [u8; 32] = [0x6c; 32];
pub const MAX_COMPUTE_UNITS: u32 = 1_400_000;
pub const LANDABLE_SPLIT: usize = 4;
pub const LIMIT_STAKE: u64 = 50_000_000;
pub const LIMIT_PARTNER_BPS: u16 = 10;
pub const COMPUTE_BUDGET_ID: Pubkey =
    Pubkey::from_str_const("ComputeBudget111111111111111111111111111111");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseKind {
    Proof,
    Committee,
    Split,
    SplitCommittee,
}

impl ReleaseKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Proof => "fill_attested",
            Self::Committee => "fill_attested_committee",
            Self::Split => "fill_attested_split",
            Self::SplitCommittee => "fill_attested_split_committee",
        }
    }

    pub fn by_committee(self) -> bool {
        matches!(self, Self::Committee | Self::SplitCommittee)
    }

    pub fn split(self) -> bool {
        matches!(self, Self::Split | Self::SplitCommittee)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shape {
    pub kind: ReleaseKind,
    pub recipients: usize,
    pub members: usize,
    pub threshold: u8,
    pub full: bool,
}

impl Shape {
    pub fn new(kind: ReleaseKind, recipients: usize, members: usize, threshold: u8) -> Self {
        Self {
            kind,
            recipients,
            members,
            threshold,
            full: false,
        }
    }

    pub fn full(self) -> Self {
        Self { full: true, ..self }
    }
}

pub fn mint_cap_pda(mint: &Pubkey) -> Pubkey {
    pda(&[intent_engine::state::MINT_CAP_SEED, mint.as_ref()])
}

pub fn set_mint_cap_ix(admin: &Pubkey, mint: &Pubkey, max_per_order: u64) -> Instruction {
    engine_ix(
        intent_engine::accounts::SetMintCap {
            admin: *admin,
            payer: *admin,
            config: config_pda(),
            mint: *mint,
            mint_cap: mint_cap_pda(mint),
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::SetMintCap {
            max_per_order,
            window_cap: max_per_order.saturating_mul(100),
            window_secs: 3_600,
            total_limit: 0,
        },
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
    Legacy,
    Table,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Row {
    pub shape: Shape,
    pub legacy: usize,
    pub v0: usize,
    pub tabled: usize,
    pub landed: Option<(Form, u64)>,
}

impl Row {
    pub fn fits_bare(&self) -> bool {
        self.v0 <= PACKET_DATA_SIZE
    }

    pub fn fits_table(&self) -> bool {
        self.tabled <= PACKET_DATA_SIZE
    }
}

pub fn compute_unit_limit_ix(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: COMPUTE_BUDGET_ID,
        accounts: Vec::new(),
        data,
    }
}

pub fn split_weights(n: usize) -> TestResult<Vec<u16>> {
    let count = u16::try_from(n)?;
    let each = 10_000u16.checked_div(count).ok_or("no recipients")?;
    let rest = 10_000u16
        .checked_sub(each.saturating_mul(count.saturating_sub(1)))
        .ok_or("weights overflow")?;
    Ok((0..n).map(|i| if i == 0 { rest } else { each }).collect())
}

pub fn quorum_mask(threshold: u8) -> u8 {
    (0..threshold).fold(0u8, |mask, i| mask | (1u8 << i))
}

pub fn cli_table(fill: &Instruction, token_program: &Pubkey, payer: &Pubkey) -> Vec<Pubkey> {
    let skipped = [intent_engine::ID, *token_program, *payer];
    let mut keys: Vec<Pubkey> = Vec::new();
    for meta in &fill.accounts {
        if !skipped.contains(&meta.pubkey) && !keys.contains(&meta.pubkey) {
            keys.push(meta.pubkey);
        }
    }
    keys
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Setup {
    pub copied: bool,
    pub frozen: Option<usize>,
}

pub struct Release {
    pub env: Env,
    pub shape: Shape,
    pub setup: Setup,
    pub judge: Keypair,
    pub coauthors: Vec<Keypair>,
    pub weights: Vec<u16>,
    pub delivery: Delivery,
    pub earlier: Option<(Keypair, Delivery)>,
    pub intent: Pubkey,
    pub market: Market,
    pub payer: Keypair,
    pub ixs: Vec<Instruction>,
    pub table: Vec<Pubkey>,
    pub paid_to: Vec<Pubkey>,
    pub fee_to: Pubkey,
    pub judge_to: Pubkey,
    pub partner_to: Option<Pubkey>,
    pub holder: Option<Pubkey>,
    pub vault: Pubkey,
    pub derived: Vec<Pubkey>,
}

fn ata_bump(owner: &Pubkey, market: &Market) -> u8 {
    Pubkey::find_program_address(
        &[
            owner.as_ref(),
            market.input_program.as_ref(),
            market.input_mint.as_ref(),
        ],
        &anchor_spl::associated_token::ID,
    )
    .1
}

pub fn release_world(program: Pubkey, shape: Shape) -> TestResult<Release> {
    release_world_with(program, shape, Setup::default())
}

pub fn release_world_with(program: Pubkey, shape: Shape, setup: Setup) -> TestResult<Release> {
    let mut env = Env::new()?;
    env.init_config()?;
    let exts: &[MintExt] = if setup.frozen.is_some() {
        &[MintExt::Freezable]
    } else {
        &[]
    };
    let market = env.market(program, exts, program, &[])?;
    let trader = env.trader(&market, LIMIT_ESCROW)?;
    let owner = trader.key.pubkey();
    let judge = env.funded()?;
    let panel = if shape.kind.by_committee() {
        Some(env.convene(shape.members, shape.threshold)?)
    } else {
        None
    };
    let (attestor, fee_wallet) = panel
        .as_ref()
        .map_or((judge.pubkey(), judge.pubkey()), |p| {
            (p.address, p.fee_wallet)
        });
    let mut spec = judged_spec(0, LIMIT_ESCROW, &attestor, LIMIT_SPEC, LIMIT_JUDGE_FEE)?;
    let partner = Pubkey::new_unique();
    if shape.full {
        let admin = env.authority.insecure_clone();
        let cap = set_mint_cap_ix(
            &admin.pubkey(),
            &market.input_mint,
            LIMIT_ESCROW.saturating_mul(10),
        );
        env.send(&admin, &[cap], &[])?;
        env.mint_cap = Some(mint_cap_pda(&market.input_mint));
        spec.ext = partner_ext(&partner, LIMIT_PARTNER_BPS);
        env.partner_to = Some(env.create_ata(&partner, &market.input_mint, program)?);
    }
    env.create_intent(&trader, &market, &spec)?;
    let judge_to = env.create_ata(&fee_wallet, &market.input_mint, program)?;
    env.judge_to = Some(judge_to);
    let fee_to = env.fee_account(&market)?;
    let count = if shape.kind.split() {
        shape.recipients
    } else {
        1
    };
    let mut coauthors = Vec::new();
    let mut paid_to = Vec::new();
    for _ in 0..count {
        let coauthor = env.funded()?;
        paid_to.push(env.create_ata(&coauthor.pubkey(), &market.input_mint, program)?);
        coauthors.push(coauthor);
    }
    let wallets: Vec<Pubkey> = coauthors.iter().map(Signer::pubkey).collect();
    let weights = split_weights(count)?;
    let intent = intent_pda(&owner, 0);
    let earlier = if setup.copied {
        let author = env.funded()?;
        let made = env.announce_as(&author, &intent)?;
        let message = reject_envelope(
            &judge.pubkey(),
            DOMAIN,
            &intent,
            &made.announcement,
            made.seq,
        );
        let reject = Reject::new(intent, made.announcement, judge.pubkey()).ix();
        let by = judge.insecure_clone();
        env.send(&by, &[ed25519_ix(&judge, &message), reject], &[])?;
        Some((author, made))
    } else {
        None
    };
    let first = coauthors.first().ok_or("no co-author")?.insecure_clone();
    let holder = if shape.full {
        let open = open_claims_ix(&owner, &intent, 3_600, LIMIT_STAKE);
        env.send(&trader.key, &[open], &[])?;
        env.send(
            &first,
            &[claim_job_ix(&first.pubkey(), &intent, &owner, 600)],
            &[],
        )?;
        Some(first.pubkey())
    } else {
        None
    };
    let delivery = env.announce_as(&first, &intent)?;
    if shape.full {
        env.claims = Some(claims_pda(&intent));
        env.stake_to = holder;
    }
    if let Some(index) = setup.frozen {
        let wallet = coauthors
            .get(index)
            .ok_or("no such co-author")?
            .insecure_clone();
        let ata = *paid_to.get(index).ok_or("no such co-author")?;
        let mint = market.input_mint;
        env.apply_setting(&wallet, &ata, &mint, program, Setting::Frozen)?;
    }
    let payer = if shape.kind.by_committee() {
        env.funded()?
    } else {
        judge.insecure_clone()
    };
    let solver = payer.pubkey();
    let payee = *paid_to.first().ok_or("no payee")?;
    let split = split_digest(
        DOMAIN,
        &intent,
        LIMIT_ESCROW,
        1,
        LIMIT_SPEC,
        split_commit(&wallets, &weights),
        &delivery,
    );
    let proof = proof_digest(
        DOMAIN,
        &intent,
        &payee,
        LIMIT_ESCROW,
        1,
        LIMIT_SPEC,
        &delivery,
    );
    let picks: Vec<usize> = (0..usize::from(shape.threshold)).collect();
    let committee = panel.as_ref().map(|p| p.address).unwrap_or_default();
    let fill = CommitteeFill {
        solver: &solver,
        owner: &owner,
        market: &market,
        nonce: 0,
        fee_to: Some(&fee_to),
        committee: &committee,
        signers: quorum_mask(shape.threshold),
        result: 1,
    };
    let (batch, settle) = match (shape.kind, panel.as_ref()) {
        (ReleaseKind::Proof, _) => {
            let message = attestation_proof_message(
                DOMAIN,
                &judge.pubkey(),
                &intent,
                &payee,
                LIMIT_ESCROW,
                1,
                LIMIT_SPEC,
                &delivery,
            );
            (
                ed25519_ix(&judge, &message),
                env.fill_attested_ix(&solver, &owner, &market, 0, &payee, Some(&fee_to), 1),
            )
        }
        (ReleaseKind::Split, _) => {
            let signers: Vec<&Keypair> = coauthors.iter().chain(std::iter::once(&judge)).collect();
            (
                cosign_batch_ix(&signers, &split)?,
                env.fill_attested_split_ix(
                    &solver,
                    &owner,
                    &market,
                    0,
                    &wallets,
                    &weights,
                    Some(&fee_to),
                    1,
                ),
            )
        }
        (ReleaseKind::Committee, Some(panel)) => (
            committee_batch_ix(&panel.keys, &panel.signers(&picks), &proof)?,
            env.fill_attested_committee_ix(&fill, &payee),
        ),
        (ReleaseKind::SplitCommittee, Some(panel)) => {
            let listed: Vec<Pubkey> = wallets.iter().chain(panel.keys.iter()).copied().collect();
            let signers: Vec<&Keypair> = coauthors.iter().chain(panel.signers(&picks)).collect();
            (
                cosign_ix(&listed, &signers, &split)?,
                env.fill_attested_split_committee_ix(&fill, &wallets, &weights),
            )
        }
        _ => return Err("a committee release needs a committee".into()),
    };
    let table = cli_table(&settle, &market.input_program, &solver);
    let derived: Vec<Pubkey> = std::iter::once(env.config()?.fee_recipient)
        .chain(std::iter::once(fee_wallet))
        .chain(wallets.iter().copied().filter(|_| shape.kind.split()))
        .chain(std::iter::once(partner).filter(|_| shape.full))
        .collect();
    let partner_to = env.partner_to;
    Ok(Release {
        env,
        shape,
        setup,
        judge,
        coauthors,
        weights,
        delivery,
        earlier,
        intent,
        market,
        payer,
        ixs: vec![batch, settle, compute_unit_limit_ix(MAX_COMPUTE_UNITS)],
        table,
        paid_to,
        fee_to,
        judge_to,
        partner_to,
        holder,
        vault: vault_pda(&intent),
        derived,
    })
}

impl Release {
    pub fn bump_cost(&self) -> u64 {
        self.derived
            .iter()
            .map(|owner| bump_search_cost(ata_bump(owner, &self.market)))
            .fold(0u64, u64::saturating_add)
    }

    pub fn lookup(&mut self) -> Result<AddressLookupTableAccount, TransactionError> {
        let table = self.table.clone();
        self.env.lookup_table(&table)
    }

    fn partner_balance(&self) -> TestResult<u64> {
        self.partner_to.map_or(Ok(0), |a| self.env.balance(&a))
    }

    fn holder_lamports(&self) -> u64 {
        self.holder.map_or(0, |h| self.env.lamports(&h))
    }

    fn conserved(&self, before: [u64; 4]) -> TestResult {
        let [fee_before, judge_before, partner_before, holder_before] = before;
        let paid = self
            .paid_to
            .iter()
            .map(|a| self.env.balance(a))
            .collect::<TestResult<Vec<u64>>>()?;
        let held = self.env.balance(&self.vault)?;
        let fees = self
            .env
            .balance(&self.fee_to)?
            .checked_sub(fee_before)
            .ok_or("the fee account shrank")?;
        let judged = self
            .env
            .balance(&self.judge_to)?
            .checked_sub(judge_before)
            .ok_or("the judge account shrank")?;
        let partnered = self
            .partner_balance()?
            .checked_sub(partner_before)
            .ok_or("the partner account shrank")?;
        if (partnered > 0) != self.partner_to.is_some() {
            return Err(format!("{:?}: the partner got {partnered}", self.shape).into());
        }
        let staked = self.holder_lamports().saturating_sub(holder_before);
        if staked != self.holder.map_or(0, |_| LIMIT_STAKE) {
            return Err(format!("{:?}: the holder got back {staked}", self.shape).into());
        }
        let total = paid
            .iter()
            .chain([fees, judged, partnered, held].iter())
            .try_fold(0u64, |sum, v| sum.checked_add(*v))
            .ok_or("payouts overflow")?;
        if total != LIMIT_ESCROW || judged != LIMIT_JUDGE_FEE {
            return Err(format!(
                "{:?}: paid {paid:?} fee {fees} judge {judged} of {LIMIT_ESCROW}",
                self.shape
            )
            .into());
        }
        let unpaid: Vec<usize> = paid
            .iter()
            .enumerate()
            .filter(|(_, p)| **p == 0)
            .map(|(i, _)| i)
            .collect();
        if unpaid != self.setup.frozen.into_iter().collect::<Vec<usize>>() {
            return Err(format!(
                "{:?}: paid {paid:?} with {:?} frozen",
                self.shape, self.setup
            )
            .into());
        }
        if (held == 0) != self.setup.frozen.is_none() {
            return Err(format!("{:?}: the vault holds {held}", self.shape).into());
        }
        Ok(())
    }

    pub fn measure(&mut self) -> TestResult<Row> {
        let payer = self.payer.pubkey();
        let table = self.lookup()?;
        let legacy = legacy_size(&payer, &self.ixs);
        let v0 = v0_size(&payer, &self.ixs, &[])?;
        let tabled = v0_size(&payer, &self.ixs, std::slice::from_ref(&table))?;
        let before = [
            self.env.balance(&self.fee_to)?,
            self.env.balance(&self.judge_to)?,
            self.partner_balance()?,
            self.holder_lamports(),
        ];
        let key = self.payer.insecure_clone();
        let ixs = self.ixs.clone();
        let sent = if legacy <= PACKET_DATA_SIZE {
            Some((Form::Legacy, self.env.send(&key, &ixs, &[])))
        } else if tabled <= PACKET_DATA_SIZE {
            Some((Form::Table, self.env.send_v0(&key, &ixs, &[], &[table])))
        } else {
            None
        };
        let landed = match sent {
            Some((form, result)) => {
                let meta = result.map_err(|e| format!("{:?} refused: {e:?}", self.shape))?;
                self.conserved(before)?;
                Some((
                    form,
                    meta.compute_units_consumed.saturating_sub(self.bump_cost()),
                ))
            }
            None => None,
        };
        Ok(Row {
            shape: self.shape,
            legacy,
            v0,
            tabled,
            landed,
        })
    }
}

pub fn measure_shape(program: Pubkey, shape: Shape) -> TestResult<Row> {
    release_world(program, shape)?.measure()
}

pub fn render_rows(rows: &[Row]) -> String {
    let mut out = String::from(
        "| release | recipients | committee | accounts | legacy B | v0 B | v0+ALT B | lands as | CU |\n|---|---|---|---|---|---|---|---|---|\n",
    );
    for row in rows {
        let s = row.shape;
        let committee = if s.kind.by_committee() {
            format!("{}-of-{}", s.threshold, s.members)
        } else {
            "-".to_owned()
        };
        let (form, cu) = match row.landed {
            Some((Form::Legacy, cu)) => ("legacy", cu.to_string()),
            Some((Form::Table, cu)) => ("v0+ALT", cu.to_string()),
            None => ("does not fit", "-".to_owned()),
        };
        out.push_str(&format!(
            "| {} | {} | {committee} | {} | {} | {} | {} | {form} | {cu} |\n",
            s.kind.name(),
            s.recipients,
            if s.full { "full" } else { "minimal" },
            row.legacy,
            row.v0,
            row.tabled,
        ));
    }
    out
}

impl Release {
    pub fn wallets(&self) -> Vec<Pubkey> {
        self.coauthors.iter().map(Signer::pubkey).collect()
    }

    pub fn claim(&self) -> intent_engine::SplitClaim {
        intent_engine::SplitClaim {
            recipients: self.wallets(),
            weights: self.weights.clone(),
        }
    }

    pub fn claim_held_ix(&self, index: u8, to: &Pubkey) -> TestResult<Instruction> {
        let wallet = self
            .coauthors
            .get(usize::from(index))
            .ok_or("no such co-author")?
            .pubkey();
        let intent = self.intent;
        Ok(engine_ix(
            intent_engine::accounts::ClaimHeld {
                wallet,
                intent,
                vault: vault_pda(&intent),
                input_mint: self.market.input_mint,
                announcement: self.delivery.announcement,
                to: *to,
                input_token_program: self.market.input_program,
                mint_cap: self.env.mint_cap,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::ClaimHeld {
                index,
                claim: self.claim(),
            },
        ))
    }
}

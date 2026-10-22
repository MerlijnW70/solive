use anchor_lang::prelude::Pubkey;
use intent_core::bounty::split_n;
use intent_core::fee::split_fees;
use intent_engine::events::{StakeMoved, STAKE_TO_WORKER};
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    attestation_proof_message, claims_pda, committee_batch_ix, cosign_batch_ix, cosign_ix,
    ed25519_ix, events, intent_pda, judged_spec, proof_digest, settle_claims_ix, split_commit,
    split_digest, vault_pda, CommitteeFill, Env, Market, MintExt, Panel, TestResult, Trader,
    DOMAIN, START_TS,
};

const T22: Pubkey = anchor_spl::token_2022::ID;
const FUNDED: u64 = 1_000_000;
const ESCROW: u64 = 100_000;
const JUDGE_FEE: u64 = 1_234;
const PROTOCOL_FEE: u64 = 50;
const NET: u64 = 98_716;
const SHARES: [u64; 2] = [59_230, 39_486];
const WEIGHTS: [u16; 2] = [6_000, 4_000];
const SPEC: [u8; 32] = [0x5d; 32];
const STAKE: u64 = 50_000_000;
const HOUR: u32 = 3_600;
const QUORUM: [usize; 2] = [0, 2];
const QUORUM_MASK: u8 = 0b101;
const EXTENSIONS: [&[MintExt]; 6] = [
    &[MintExt::InterestBearing],
    &[MintExt::ScaledUi],
    &[MintExt::MetadataPointer],
    &[MintExt::Freezable],
    &[
        MintExt::InterestBearing,
        MintExt::MetadataPointer,
        MintExt::Freezable,
    ],
    &[
        MintExt::ScaledUi,
        MintExt::MetadataPointer,
        MintExt::Freezable,
    ],
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Path {
    Attested,
    AttestedSplit,
    Committee,
    CommitteeSplit,
}

impl Path {
    fn by_committee(self) -> bool {
        matches!(self, Self::Committee | Self::CommitteeSplit)
    }

    fn split(self) -> bool {
        matches!(self, Self::AttestedSplit | Self::CommitteeSplit)
    }
}

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Keypair,
    attestor: Keypair,
    panel: Option<Panel>,
    workers: [Keypair; 2],
    atas: [Pubkey; 2],
    judge_to: Pubkey,
    fee_to: Pubkey,
}

fn world(exts: &[MintExt], path: Path) -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(T22, exts, T22, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let attestor = Keypair::new();
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
    env.create_intent(
        &trader,
        &market,
        &judged_spec(0, ESCROW, &judge, SPEC, JUDGE_FEE)?,
    )?;
    let judge_to = env.create_ata(&fee_wallet, &market.input_mint, T22)?;
    env.judge_to = Some(judge_to);
    let workers = [env.funded()?, env.funded()?];
    let atas = [
        env.create_ata(&workers[0].pubkey(), &market.input_mint, T22)?,
        env.create_ata(&workers[1].pubkey(), &market.input_mint, T22)?,
    ];
    let solver = env.funded()?;
    let fee_to = env.fee_account(&market)?;
    Ok(World {
        env,
        market,
        trader,
        solver,
        attestor,
        panel,
        workers,
        atas,
        judge_to,
        fee_to,
    })
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn intent(&self) -> Pubkey {
        intent_pda(&self.owner(), 0)
    }

    fn wallets(&self) -> Vec<Pubkey> {
        self.workers.iter().map(Signer::pubkey).collect()
    }

    fn panel(&self) -> TestResult<&Panel> {
        Ok(self.panel.as_ref().ok_or("no committee")?)
    }

    fn release_ixs(&self, path: Path) -> TestResult<[Instruction; 2]> {
        let payee = self.atas[0];
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
            signers: QUORUM_MASK,
            result: 1,
        };
        let wallets = self.wallets();
        let split_hash = split_commit(&wallets, &WEIGHTS);
        let split = split_digest(DOMAIN, &self.intent(), ESCROW, 1, SPEC, split_hash);
        Ok(match path {
            Path::Attested => {
                let message = attestation_proof_message(
                    DOMAIN,
                    &self.attestor.pubkey(),
                    &self.intent(),
                    &payee,
                    ESCROW,
                    1,
                    SPEC,
                );
                [
                    ed25519_ix(&self.attestor, &message),
                    self.env.fill_attested_ix(
                        &self.solver.pubkey(),
                        &self.owner(),
                        &self.market,
                        0,
                        &payee,
                        Some(&self.fee_to),
                        1,
                    ),
                ]
            }
            Path::AttestedSplit => {
                let [a, b] = &self.workers;
                [
                    cosign_batch_ix(&[a, b, &self.attestor], &split)?,
                    self.env.fill_attested_split_ix(
                        &self.solver.pubkey(),
                        &self.owner(),
                        &self.market,
                        0,
                        &wallets,
                        &WEIGHTS,
                        Some(&self.fee_to),
                        1,
                    ),
                ]
            }
            Path::Committee => {
                let panel = self.panel()?;
                let digest = proof_digest(DOMAIN, &self.intent(), &payee, ESCROW, 1, SPEC);
                [
                    committee_batch_ix(&panel.keys, &panel.signers(&QUORUM), &digest)?,
                    self.env.fill_attested_committee_ix(&fill, &payee),
                ]
            }
            Path::CommitteeSplit => {
                let panel = self.panel()?;
                let listed: Vec<Pubkey> =
                    wallets.iter().chain(panel.keys.iter()).copied().collect();
                let signers: Vec<&Keypair> =
                    self.workers.iter().chain(panel.signers(&QUORUM)).collect();
                [
                    cosign_ix(&listed, &signers, &split)?,
                    self.env
                        .fill_attested_split_committee_ix(&fill, &wallets, &WEIGHTS),
                ]
            }
        })
    }

    fn release(&mut self, path: Path) -> TestResult<TransactionMetadata> {
        let ixs = self.release_ixs(path)?;
        let solver = self.solver.insecure_clone();
        Ok(self.env.send(&solver, &ixs, &[])?)
    }

    fn paid(&self) -> TestResult<[u64; 2]> {
        Ok([
            self.env.balance(&self.atas[0])?,
            self.env.balance(&self.atas[1])?,
        ])
    }
}

fn every_extension(path: Path, held: bool) -> TestResult {
    for exts in EXTENSIONS {
        settles(exts, path, held).map_err(|e| format!("{path:?} on {exts:?}: {e}"))?;
    }
    Ok(())
}

fn settles(exts: &[MintExt], path: Path, held: bool) -> TestResult {
    let mut w = world(exts, path)?;
    let owner = w.owner();
    let intent = w.intent();
    let board = claims_pda(&intent);
    let claimant = w.workers[0].pubkey();
    if held {
        let trader = w.trader.key.insecure_clone();
        let worker = w.workers[0].insecure_clone();
        w.env.hold_claim(&trader, 0, &worker, HOUR, STAKE)?;
        w.env.claims = Some(board);
        w.env.stake_to = Some(claimant);
    }
    w.env.set_now(START_TS + 1_800);
    assert_eq!(w.env.balance(&vault_pda(&intent))?, ESCROW);
    assert_eq!(w.env.balance(&w.fee_to)?, 0);
    assert_eq!(w.env.balance(&w.judge_to)?, 0);
    assert_eq!(w.paid()?, [0, 0]);
    let claimant_before = w.env.lamports(&claimant);
    let board_before = w.env.lamports(&board);

    let meta = w.release(path)?;

    let expected = if path.split() { SHARES } else { [NET, 0] };
    assert_eq!(w.paid()?, expected, "workers");
    assert_eq!(w.env.balance(&w.judge_to)?, JUDGE_FEE, "judge fee");
    assert_eq!(w.env.balance(&w.fee_to)?, PROTOCOL_FEE, "protocol fee");
    assert_eq!(w.env.balance(&vault_pda(&intent))?, 0, "vault emptied");
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - ESCROW);
    let moved: Vec<_> = events::<StakeMoved>(&meta)
        .into_iter()
        .map(|e| (e.worker, e.to, e.amount, e.role))
        .collect();
    if held {
        assert_eq!(moved, [(claimant, claimant, STAKE, STAKE_TO_WORKER)]);
        assert_eq!(
            w.env.lamports(&claimant).checked_sub(claimant_before),
            Some(STAKE),
            "stake"
        );
        assert_eq!(
            board_before.checked_sub(w.env.lamports(&board)),
            Some(STAKE)
        );
    } else {
        assert!(moved.is_empty());
        assert_eq!(w.env.lamports(&claimant), claimant_before);
        assert!(!w.env.exists(&board));
    }

    let rents = w.env.rents(&owner, 0)?;
    let rent_payer = w.env.lamports(&owner);
    let cranker = w.env.funded()?;
    let close = w
        .env
        .close_ix_by(&cranker.pubkey(), &owner, &w.market, 0, &w.trader.input);
    w.env.send(&cranker, &[close], &[])?;
    assert!(!w.env.exists(&vault_pda(&intent)), "vault closed");
    assert!(!w.env.exists(&intent), "intent closed");
    assert!(rents.vault > 0 && rents.intent > rents.bounty);
    assert_eq!(
        w.env.lamports(&owner).checked_sub(rent_payer),
        rents
            .vault
            .checked_add(rents.intent)
            .and_then(|r| r.checked_sub(rents.bounty)),
        "rent returned"
    );
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - ESCROW);

    if held {
        let board_rent = w.env.lamports(&board);
        let before = w.env.lamports(&owner);
        w.env
            .send(&cranker, &[settle_claims_ix(&intent, &owner, None)], &[])?;
        assert!(!w.env.exists(&board), "board closed");
        assert_eq!(
            w.env.lamports(&owner).checked_sub(before),
            Some(board_rent),
            "board rent"
        );
        assert_eq!(
            w.env.lamports(&claimant).checked_sub(claimant_before),
            Some(STAKE)
        );
    }
    Ok(())
}

#[test]
fn the_expected_amounts_follow_the_fee_and_split_rules() -> TestResult {
    let fees = split_fees(ESCROW - JUDGE_FEE, 5, 0, 0).map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        (fees.protocol, fees.partner, fees.net),
        (PROTOCOL_FEE, 0, NET)
    );
    let plan = split_n(NET, &WEIGHTS).map_err(|e| format!("{e:?}"))?;
    assert_eq!(plan.as_slice(), SHARES.as_slice());
    assert_eq!(JUDGE_FEE + PROTOCOL_FEE + NET, ESCROW);
    Ok(())
}

#[test]
fn attested_releases_pay_to_the_base_unit_on_every_allowed_extension() -> TestResult {
    every_extension(Path::Attested, false)
}

#[test]
fn attested_split_releases_pay_to_the_base_unit_on_every_allowed_extension() -> TestResult {
    every_extension(Path::AttestedSplit, false)
}

#[test]
fn committee_releases_pay_to_the_base_unit_on_every_allowed_extension() -> TestResult {
    every_extension(Path::Committee, false)
}

#[test]
fn committee_split_releases_pay_to_the_base_unit_on_every_allowed_extension() -> TestResult {
    every_extension(Path::CommitteeSplit, false)
}

#[test]
fn attested_releases_return_a_held_stake_to_the_claimant_on_every_allowed_extension() -> TestResult
{
    every_extension(Path::Attested, true)
}

#[test]
fn attested_split_releases_return_a_held_stake_to_the_claimant_on_every_allowed_extension(
) -> TestResult {
    every_extension(Path::AttestedSplit, true)
}

#[test]
fn committee_releases_return_a_held_stake_to_the_claimant_on_every_allowed_extension() -> TestResult
{
    every_extension(Path::Committee, true)
}

#[test]
fn committee_split_releases_return_a_held_stake_to_the_claimant_on_every_allowed_extension(
) -> TestResult {
    every_extension(Path::CommitteeSplit, true)
}

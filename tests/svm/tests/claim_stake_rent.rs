use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use intent_engine::state::ClaimBoard;
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{engine_error_at, ClaimWorld, ReleasePath, ReleaseTerms, TestResult, START_TS};

const FLOOR: u64 = 890_880;
const SMALL: u64 = 10_000;
const HOUR: u32 = 3_600;
const HOLD: u32 = 600;
const SHORT: u32 = 60;
const TERMS: ReleaseTerms = ReleaseTerms {
    funded: 1_000_000,
    escrow: 100_000,
    judge_fee: 0,
    spec: [0x5b; 32],
    weights: [6_000, 4_000],
    partner_bps: 0,
};
const RELEASES: [ReleasePath; 4] = [
    ReleasePath::Attested,
    ReleasePath::AttestedSplit,
    ReleasePath::Committee,
    ReleasePath::CommitteeSplit,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Path {
    CancelHeld,
    ReleaseHeld(ReleasePath),
    Drop,
    SettleHeld,
    CancelLapsed,
    ReleaseLapsed(ReleasePath),
    ClaimLapsed,
    AdvanceLapsed,
    SettleLapsed,
}

impl Path {
    fn release(self) -> Option<ReleasePath> {
        match self {
            Self::ReleaseHeld(path) | Self::ReleaseLapsed(path) => Some(path),
            _ => None,
        }
    }

    fn lapses(self) -> bool {
        matches!(
            self,
            Self::CancelLapsed
                | Self::ReleaseLapsed(_)
                | Self::ClaimLapsed
                | Self::AdvanceLapsed
                | Self::SettleLapsed
        )
    }
}

fn paths() -> Vec<Path> {
    let mut all = vec![
        Path::CancelHeld,
        Path::Drop,
        Path::SettleHeld,
        Path::CancelLapsed,
        Path::ClaimLapsed,
        Path::AdvanceLapsed,
        Path::SettleLapsed,
    ];
    all.extend(RELEASES.map(Path::ReleaseHeld));
    all.extend(RELEASES.map(Path::ReleaseLapsed));
    all
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Moves,
    FailsOnRent,
}

struct Scene {
    world: ClaimWorld,
    holder: Keypair,
    receiver: Pubkey,
}

fn plant(world: &mut ClaimWorld, edit: impl FnOnce(&mut ClaimBoard)) -> TestResult {
    let key = world.board_key();
    let svm = &mut world.release.env.svm;
    let mut account = svm.get_account(&key).ok_or("no board")?;
    let end = std::mem::size_of::<ClaimBoard>()
        .checked_add(8)
        .ok_or("overflow")?;
    let body = account.data.get_mut(8..end).ok_or("board too short")?;
    let mut board: ClaimBoard = bytemuck::pod_read_unaligned(body);
    edit(&mut board);
    body.copy_from_slice(bytemuck::bytes_of(&board));
    svm.set_account(key, account)?;
    Ok(())
}

fn empty(world: &mut ClaimWorld, who: &Keypair) -> TestResult {
    let all = world.lamports(&who.pubkey());
    let sink = Pubkey::new_unique();
    let ix = solana_system_interface::instruction::transfer(&who.pubkey(), &sink, all);
    world
        .send(&[ix], &[who])
        .map_err(|e| format!("emptying a wallet: {e:?}"))?;
    if world.lamports(&who.pubkey()) != 0 {
        return Err("the wallet still holds lamports".into());
    }
    Ok(())
}

fn later(secs: u32) -> TestResult<i64> {
    Ok(START_TS.checked_add(i64::from(secs)).ok_or("overflow")?)
}

fn stage(path: Path, stake: u64) -> TestResult<Scene> {
    let mut world = ClaimWorld::new(path.release().unwrap_or(ReleasePath::Attested), TERMS)?;
    let holder = world.release.workers[0].insecure_clone();
    let owner = world.release.trader.key.insecure_clone();
    world
        .open(HOUR, FLOOR, None)
        .map_err(|e| format!("open: {e:?}"))?;
    if stake != FLOOR {
        plant(&mut world, |board| board.stake = stake)?;
    }
    if path.release().is_some() {
        world.announce(&holder)?;
    }
    let secs = if path.lapses() { SHORT } else { HOLD };
    world
        .claim(&holder, secs)
        .map_err(|e| format!("claim: {e:?}"))?;
    if path == Path::AdvanceLapsed {
        let waiter = world.funded()?;
        world
            .stand_by(&waiter, HOLD)?
            .map_err(|e| format!("stand by: {e:?}"))?;
    }
    if path.lapses() {
        world.set_now(later(SHORT)?);
    }
    if path == Path::SettleHeld {
        let expires_at = world.expires_at()?;
        let until = expires_at.checked_add(i64::from(HOUR)).ok_or("overflow")?;
        plant(&mut world, |board| board.until = until)?;
        world.set_now(expires_at);
        world.expire().map_err(|e| format!("expire: {e:?}"))?;
    }
    let receiving = if path.lapses() {
        owner
    } else {
        holder.insecure_clone()
    };
    empty(&mut world, &receiving)?;
    Ok(Scene {
        world,
        holder,
        receiver: receiving.pubkey(),
    })
}

fn act(scene: &mut Scene, path: Path) -> TestResult<Result<TransactionMetadata, TransactionError>> {
    let receiver = scene.receiver;
    let world = &mut scene.world;
    Ok(match path {
        Path::CancelHeld | Path::CancelLapsed => world.cancel(Some(&receiver)),
        Path::ReleaseHeld(release) | Path::ReleaseLapsed(release) => {
            world.release_to(release, Some(&receiver))?
        }
        Path::Drop => {
            let holder = scene.holder.insecure_clone();
            world.drop_claim(&holder)?
        }
        Path::SettleHeld | Path::SettleLapsed => world.settle()?,
        Path::ClaimLapsed => {
            let fresh = world.funded()?;
            world.claim(&fresh, HOLD)
        }
        Path::AdvanceLapsed => world.advance()?,
    })
}

fn run(path: Path, stake: u64) -> TestResult<Outcome> {
    let mut scene = stage(path, stake)?;
    let board = scene.world.board_key();
    let before = scene.world.lamports(&board);
    let sent = act(&mut scene, path)?;
    let got = scene.world.lamports(&scene.receiver);
    match sent {
        Ok(_) => {
            if got != stake {
                return Err(
                    format!("{path:?}: the receiver holds {got}, its stake is {stake}").into(),
                );
            }
            if scene.world.exists(&board) {
                scene.world.check_holdings(stake)?;
            }
            Ok(Outcome::Moves)
        }
        Err(TransactionError::InsufficientFundsForRent { .. }) => {
            if got != 0 || scene.world.lamports(&board) != before {
                return Err(format!("{path:?}: a refused transaction moved lamports").into());
            }
            Ok(Outcome::FailsOnRent)
        }
        Err(e) => Err(format!("{path:?}: {e:?}").into()),
    }
}

#[test]
fn the_floor_is_the_rent_exempt_minimum_of_a_zero_byte_account() -> TestResult {
    let world = ClaimWorld::new(ReleasePath::Attested, TERMS)?;
    assert_eq!(
        world.release.env.svm.minimum_balance_for_rent_exemption(0),
        FLOOR
    );
    Ok(())
}

#[test]
fn a_stake_below_rent_sent_to_an_empty_wallet_fails_on_every_path_that_moves_only_the_stake(
) -> TestResult {
    for stake in [SMALL, FLOOR - 1] {
        for path in paths() {
            assert_eq!(
                run(path, stake)?,
                Outcome::FailsOnRent,
                "{path:?} at {stake}"
            );
        }
    }
    Ok(())
}

#[test]
fn a_stake_at_the_floor_reaches_an_empty_wallet_on_every_path() -> TestResult {
    for path in paths() {
        assert_eq!(run(path, FLOOR)?, Outcome::Moves, "{path:?}");
    }
    Ok(())
}

#[test]
fn open_claims_refuses_a_stake_above_zero_and_below_the_floor() -> TestResult {
    for stake in [1, SMALL, FLOOR - 1] {
        let mut world = ClaimWorld::new(ReleasePath::Attested, TERMS)?;
        assert_eq!(
            world.open(HOUR, stake, None).err(),
            Some(engine_error_at(0, EngineError::StakeBelowRent)),
            "{stake}"
        );
        assert!(!world.exists(&world.board_key()));
    }
    for stake in [0, FLOOR] {
        let mut world = ClaimWorld::new(ReleasePath::Attested, TERMS)?;
        world
            .open(HOUR, stake, None)
            .map_err(|e| format!("open at {stake}: {e:?}"))?;
        assert_eq!(world.board()?.stake, stake);
    }
    Ok(())
}

#[test]
fn open_claims_listed_refuses_a_stake_above_zero_and_below_the_floor() -> TestResult {
    for (stake, refused) in [(FLOOR - 1, true), (1, true), (0, false), (FLOOR, false)] {
        let mut world = ClaimWorld::new(ReleasePath::Attested, TERMS)?;
        let workers = world.release.wallets();
        let sent = world.open(HOUR, stake, Some(&workers));
        if refused {
            assert_eq!(
                sent.err(),
                Some(engine_error_at(0, EngineError::StakeBelowRent)),
                "{stake}"
            );
            assert!(!world.exists(&world.board_key()));
            assert!(!world.exists(&world.list_key()));
        } else {
            sent.map_err(|e| format!("open listed at {stake}: {e:?}"))?;
            assert_eq!(world.board()?.stake, stake);
        }
    }
    Ok(())
}

#[test]
fn a_holder_that_empties_its_wallet_cannot_block_the_owners_cancel() -> TestResult {
    let mut scene = stage(Path::CancelHeld, FLOOR)?;
    let refund = scene.world.release.trader.input;
    let tokens = scene.world.release.env.balance(&refund)?;
    let board = scene.world.board_key();
    let board_before = scene.world.lamports(&board);
    let holder = scene.holder.pubkey();
    scene
        .world
        .cancel(Some(&holder))
        .map_err(|e| format!("cancel: {e:?}"))?;
    assert_eq!(scene.world.lamports(&holder), FLOOR);
    assert_eq!(
        board_before.checked_sub(scene.world.lamports(&board)),
        Some(FLOOR)
    );
    assert_eq!(
        scene.world.release.env.balance(&refund)?,
        tokens.checked_add(TERMS.escrow).ok_or("overflow")?
    );
    Ok(())
}

#[test]
fn an_owner_that_empties_its_wallet_cannot_block_a_new_claim_or_the_line() -> TestResult {
    for path in [Path::ClaimLapsed, Path::AdvanceLapsed] {
        let mut scene = stage(path, FLOOR)?;
        act(&mut scene, path)?.map_err(|e| format!("{path:?}: {e:?}"))?;
        assert_eq!(scene.world.lamports(&scene.receiver), FLOOR, "{path:?}");
        let board = scene.world.board()?;
        assert_ne!(board.worker, Pubkey::default(), "{path:?}");
        assert_eq!(board.held, FLOOR, "{path:?}");
        scene.world.check_holdings(FLOOR)?;
    }
    Ok(())
}

#[test]
fn a_standby_entry_returns_at_least_its_rent_to_an_empty_wallet_even_below_the_floor() -> TestResult
{
    for stake in [SMALL, FLOOR] {
        let mut world = ClaimWorld::new(ReleasePath::Attested, TERMS)?;
        world
            .open(HOUR, FLOOR, None)
            .map_err(|e| format!("open: {e:?}"))?;
        plant(&mut world, |board| board.stake = stake)?;
        let holder = world.release.workers[0].insecure_clone();
        let served = world.funded()?;
        let leaver = world.funded()?;
        world
            .claim(&holder, HOLD)
            .map_err(|e| format!("claim: {e:?}"))?;
        world
            .stand_by(&served, HOLD)?
            .map_err(|e| format!("stand by: {e:?}"))?;
        world
            .stand_by(&leaver, HOLD)?
            .map_err(|e| format!("stand by: {e:?}"))?;
        empty(&mut world, &served)?;
        empty(&mut world, &leaver)?;
        let rent = world.entry_rent();
        world
            .leave(&leaver, 1, &leaver.pubkey())
            .map_err(|e| format!("leave: {e:?}"))?;
        assert_eq!(
            world.lamports(&leaver.pubkey()),
            rent.checked_add(stake).ok_or("overflow")?
        );
        world
            .drop_claim(&holder)?
            .map_err(|e| format!("drop: {e:?}"))?;
        assert_eq!(world.lamports(&served.pubkey()), rent);
        let board = world.board()?;
        assert_eq!((board.worker, board.held), (served.pubkey(), stake));
        world.check_holdings(stake)?;
    }
    Ok(())
}

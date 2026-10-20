use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::Discriminator;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::{AccountMigrated, LegacyClosed};
use intent_engine::state::{
    ClaimBoard, Committee, Config, Intent, Mandate, MintCap, Profile, Standby, UserState,
    MINT_CAP_SEED, PROFILE_SEED,
};
use intent_engine::versions::{
    board_terms, is_current, layout_of, recorded_payer, stored_version, LAYOUTS,
};
use intent_engine::ProfileFields;
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    anchor_error, claim_job_ix, claims_pda, close_legacy_full_ix, config_pda, create_committee_ix,
    drop_claim_ix, drop_claim_line_ix, engine_error, engine_ix, event_authority, events,
    intent_pda, leave_ix, mandate_pda, mandate_terms, migrate_ix, pda, settle_claims_ix,
    sorted_members, stand_by_ix, standby_pda, swap_spec, user_pda, vault_pda, CommitteeFill, Env,
    IntentSpec, LegacyClose, Market, TestResult, Trader, START_TS,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const STAKE: u64 = 50_000_000;
const HOUR: u32 = 3_600;
const OLD: u8 = 1;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    worker: Keypair,
    waiting: Keypair,
    wallet: Keypair,
    committee: Pubkey,
    mandate: Pubkey,
    caller: Keypair,
}

fn set_mint_cap_ix(admin: &Pubkey, mint: &Pubkey) -> Instruction {
    set_mint_cap_limit_ix(admin, mint, 0)
}

fn set_mint_cap_limit_ix(admin: &Pubkey, mint: &Pubkey, total_limit: u64) -> Instruction {
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
            max_per_order: 1_000,
            window_cap: 2_000,
            window_secs: HOUR,
            total_limit,
        },
    )
}

fn mint_cap_pda(mint: &Pubkey) -> Pubkey {
    pda(&[MINT_CAP_SEED, mint.as_ref()])
}

fn profile_pda(wallet: &Pubkey) -> Pubkey {
    pda(&[PROFILE_SEED, wallet.as_ref()])
}

fn profile_fields() -> ProfileFields {
    ProfileFields {
        skills: vec!["rust".to_owned()],
        endpoint: "https://".to_owned() + "worker.example",
        doc_url: String::new(),
        doc_hash: [0; 32],
        encryption_key: [0; 32],
    }
}

fn create_profile_ix(wallet: &Pubkey) -> Instruction {
    engine_ix(
        intent_engine::accounts::CreateProfile {
            wallet: *wallet,
            profile: profile_pda(wallet),
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::CreateProfile {
            args: profile_fields(),
        },
    )
}

fn update_profile_ix(wallet: &Pubkey) -> Instruction {
    engine_ix(
        intent_engine::accounts::UpdateProfile {
            wallet: *wallet,
            profile: profile_pda(wallet),
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::UpdateProfile {
            args: profile_fields(),
        },
    )
}

fn close_profile_ix(wallet: &Pubkey) -> Instruction {
    engine_ix(
        intent_engine::accounts::CloseProfile {
            wallet: *wallet,
            profile: profile_pda(wallet),
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::CloseProfile {},
    )
}

fn escrow_spec(attestor: &Pubkey) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.to_bytes(),
            spec_hash: [0x3c; 32],
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    })
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let members: Vec<Pubkey> = sorted_members(3).iter().map(Signer::pubkey).collect();
    let caller = env.funded()?;
    let (convene, committee) =
        create_committee_ix(&caller.pubkey(), &members, 2, &Pubkey::new_unique())?;
    env.send(&caller, &[convene], &[])?;
    env.create_intent(&trader, &market, &escrow_spec(&committee)?)?;
    let owner = trader.key.pubkey();
    let intent = intent_pda(&owner, 0);
    let open = svm_tests::open_claims_ix(&owner, &intent, HOUR, STAKE);
    env.send(&trader.key, &[open], &[])?;
    let worker = env.funded()?;
    env.send(
        &worker,
        &[claim_job_ix(&worker.pubkey(), &intent, &owner, HOUR)],
        &[],
    )?;
    let waiting = env.funded()?;
    let line = stand_by_ix(&waiting.pubkey(), &intent, 0, HOUR);
    env.send(&waiting, &[line], &[])?;
    let agent = Pubkey::new_unique();
    env.approve_delegate(&trader, &market, FUNDED)?;
    let grant = env.create_mandate_ix(
        &trader,
        &market,
        intent_engine::MandateArgs {
            id: 1,
            ..mandate_terms(agent, START_TS + 86_400)
        },
    );
    env.send(&trader.key, &[grant], &[])?;
    let admin = env.authority.insecure_clone();
    let cap = set_mint_cap_ix(&admin.pubkey(), &market.input_mint);
    env.send(&admin, &[cap], &[])?;
    let wallet = env.funded()?;
    env.send(&wallet, &[create_profile_ix(&wallet.pubkey())], &[])?;
    Ok(World {
        env,
        market,
        mandate: mandate_pda(&owner, &agent, 1),
        trader,
        worker,
        waiting,
        wallet,
        committee,
        caller,
    })
}

struct Held {
    name: &'static str,
    address: Pubkey,
    discriminator: &'static [u8],
    payee: Pubkey,
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn intent(&self) -> Pubkey {
        intent_pda(&self.owner(), 0)
    }

    fn held(&self) -> Vec<Held> {
        let owner = self.owner();
        let fees = self.env.fee_recipient;
        let held = |name, address, discriminator, payee| Held {
            name,
            address,
            discriminator,
            payee,
        };
        vec![
            held("user", user_pda(&owner), UserState::DISCRIMINATOR, owner),
            held("intent", self.intent(), Intent::DISCRIMINATOR, owner),
            held("mandate", self.mandate, Mandate::DISCRIMINATOR, owner),
            held(
                "mint cap",
                mint_cap_pda(&self.market.input_mint),
                MintCap::DISCRIMINATOR,
                fees,
            ),
            held("committee", self.committee, Committee::DISCRIMINATOR, fees),
            held(
                "claim board",
                claims_pda(&self.intent()),
                ClaimBoard::DISCRIMINATOR,
                owner,
            ),
            held(
                "stand-by entry",
                standby_pda(&self.intent(), 0),
                Standby::DISCRIMINATOR,
                self.waiting.pubkey(),
            ),
            held(
                "profile",
                profile_pda(&self.wallet.pubkey()),
                Profile::DISCRIMINATOR,
                self.wallet.pubkey(),
            ),
            held(
                "config",
                config_pda(),
                Config::DISCRIMINATOR,
                self.env.authority.pubkey(),
            ),
        ]
    }

    fn data(&self, address: &Pubkey) -> TestResult<Vec<u8>> {
        Ok(self
            .env
            .svm
            .get_account(address)
            .ok_or("account missing")?
            .data)
    }

    fn set_version(&mut self, address: &Pubkey, version: u8) -> TestResult {
        let mut account = self.env.svm.get_account(address).ok_or("account missing")?;
        let at = layout_of(&account.data)
            .ok_or("no layout")?
            .version_at
            .checked_add(8)
            .ok_or("overflow")?;
        *account.data.get_mut(at).ok_or("short")? = version;
        self.env.svm.set_account(*address, account)?;
        Ok(())
    }

    fn close(
        &mut self,
        address: &Pubkey,
        payee: &Pubkey,
        with_config: bool,
    ) -> Result<TransactionMetadata, TransactionError> {
        let intent = self
            .env
            .svm
            .get_account(address)
            .and_then(|a| board_terms(&a.data))
            .map(|t| t.intent);
        self.close_with(&LegacyClose {
            account: *address,
            payee: *payee,
            with_config,
            vault: Some(vault_pda(address)),
            stake_to: None,
            intent,
            fee_to: None,
        })
    }

    fn close_with(&mut self, close: &LegacyClose) -> Result<TransactionMetadata, TransactionError> {
        let caller = self.caller.insecure_clone();
        let ix = close_legacy_full_ix(close);
        self.env.send(&caller, &[ix], &[])
    }

    fn plant(&mut self, data: Vec<u8>, lamports: u64) -> TestResult<Pubkey> {
        let mut account = self
            .env
            .svm
            .get_account(&config_pda())
            .ok_or("config missing")?;
        account.data = data;
        account.lamports = lamports;
        let address = Pubkey::new_unique();
        self.env.svm.set_account(address, account)?;
        Ok(address)
    }

    fn send(&mut self, signer: &Keypair, ix: Instruction) -> Option<TransactionError> {
        self.env.send(signer, &[ix], &[]).err()
    }
}

#[test]
fn every_account_type_is_created_at_its_current_version() -> TestResult {
    let w = world()?;
    let held = w.held();
    assert_eq!(held.len(), LAYOUTS.len());
    for layout in &LAYOUTS {
        assert!(
            held.iter().any(|h| h.discriminator == layout.discriminator),
            "{layout:?}"
        );
    }
    for h in &held {
        let data = w.data(&h.address)?;
        let (layout, version) = stored_version(&data).ok_or(h.name)?;
        assert_eq!(layout.discriminator, h.discriminator, "{}", h.name);
        assert_eq!(version, layout.version, "{}", h.name);
        assert_eq!(data.len(), layout.space, "{}", h.name);
        assert!(is_current(&data), "{}", h.name);
    }
    Ok(())
}

#[test]
fn close_legacy_refuses_every_current_account() -> TestResult {
    let mut w = world()?;
    for h in w.held() {
        let with_config = recorded_payer(&w.data(&h.address)?).is_none();
        let before = w.env.lamports(&h.address);
        assert_eq!(
            w.close(&h.address, &h.payee, with_config).err(),
            Some(engine_error(EngineError::NotLegacy)),
            "{}",
            h.name
        );
        assert_eq!(w.env.lamports(&h.address), before, "{}", h.name);
    }
    Ok(())
}

#[test]
fn an_account_of_another_version_closes_to_the_wallet_its_layout_records() -> TestResult {
    let mut w = world()?;
    for version in [0u8, OLD, 3, u8::MAX] {
        let mut w = world()?;
        for h in w.held() {
            let version = if layout_of(&w.data(&h.address)?).map(|l| l.version) == Some(version) {
                OLD.wrapping_sub(1)
            } else {
                version
            };
            w.set_version(&h.address, version)?;
            let data = w.data(&h.address)?;
            assert!(!is_current(&data), "{} {version}", h.name);
            let with_config = recorded_payer(&data).is_none();
            let refused = if h.discriminator == Intent::DISCRIMINATOR {
                Some(EngineError::LegacyVaultOpen)
            } else if h.discriminator == ClaimBoard::DISCRIMINATOR {
                Some(if version == OLD {
                    EngineError::ClaimHeld
                } else {
                    EngineError::StakeAccountMismatch
                })
            } else if h.discriminator == Config::DISCRIMINATOR
                || h.discriminator == UserState::DISCRIMINATOR
            {
                Some(EngineError::LegacyMigrates)
            } else {
                None
            };
            if let Some(refused) = refused {
                assert_eq!(
                    w.close(&h.address, &h.payee, with_config).err(),
                    Some(engine_error(refused)),
                    "{} {version}",
                    h.name
                );
                continue;
            }
            let stranger = Pubkey::new_unique();
            assert_eq!(
                w.close(&h.address, &stranger, with_config).err(),
                Some(engine_error(EngineError::LegacyPayeeMismatch)),
                "{} {version}",
                h.name
            );
            let rent = w.env.lamports(&h.address);
            let before = w.env.lamports(&h.payee);
            let meta = w
                .close(&h.address, &h.payee, with_config)
                .map_err(|e| format!("{} {version}: {e:?}", h.name))?;
            assert!(!w.env.exists(&h.address), "{} {version}", h.name);
            assert_eq!(
                Some(w.env.lamports(&h.payee)),
                before.checked_add(rent),
                "{} {version}",
                h.name
            );
            let closed = events::<LegacyClosed>(&meta).pop().ok_or("missing")?;
            assert_eq!(
                (closed.account, closed.payee, closed.lamports, closed.stake),
                (h.address, h.payee, rent, 0),
                "{} {version}",
                h.name
            );
        }
    }
    let committee = w.committee;
    w.set_version(&committee, OLD)?;
    let fees = w.env.fee_recipient;
    assert_eq!(
        w.close(&committee, &fees, false).err(),
        Some(engine_error(EngineError::LegacyPayeeMismatch))
    );
    Ok(())
}

#[test]
fn a_lapsed_claim_board_of_the_earlier_168_byte_layout_closes_to_its_owner() -> TestResult {
    let mut w = world()?;
    let data = old_board(&w, START_TS)?;
    assert_eq!(data.len(), 168);
    let lamports = w
        .env
        .svm
        .minimum_balance_for_rent_exemption(168)
        .checked_add(STAKE)
        .ok_or("overflow")?;
    let old = w.plant(data, lamports)?;
    assert!(!is_current(&w.data(&old)?));
    let worker = w.worker.pubkey();
    assert_eq!(
        w.close(&old, &worker, false).err(),
        Some(engine_error(EngineError::LegacyPayeeMismatch))
    );
    let owner = w.owner();
    let before = w.env.lamports(&owner);
    let worker_before = w.env.lamports(&worker);
    let meta = w.close(&old, &owner, false)?;
    assert!(!w.env.exists(&old));
    assert_eq!(Some(w.env.lamports(&owner)), before.checked_add(lamports));
    assert_eq!(w.env.lamports(&worker), worker_before);
    let closed = events::<LegacyClosed>(&meta).pop().ok_or("missing")?;
    assert_eq!((closed.lamports, closed.stake), (lamports, 0));
    Ok(())
}

#[test]
fn an_unknown_program_account_closes_to_the_fee_recipient_and_a_foreign_one_never() -> TestResult {
    let mut w = world()?;
    let fees = w.env.fee_recipient;
    let truncated = w.data(&w.intent())?.get(..100).ok_or("short")?.to_vec();
    for data in [vec![7u8; 40], Vec::new(), truncated] {
        let lamports = 5_000_000;
        let odd = w.plant(data, lamports)?;
        assert_eq!(
            w.close(&odd, &fees, false).err(),
            Some(engine_error(EngineError::LegacyPayeeMismatch))
        );
        let before = w.env.lamports(&fees);
        w.close(&odd, &fees, true)?;
        assert!(!w.env.exists(&odd));
        assert_eq!(Some(w.env.lamports(&fees)), before.checked_add(lamports));
    }
    let owner = w.owner();
    let foreign = w.trader.input;
    assert_eq!(
        w.close(&foreign, &owner, true).err(),
        Some(anchor_error(ErrorCode::ConstraintOwner))
    );
    let config = config_pda();
    w.set_version(&config, OLD)?;
    let unknown = w.plant(vec![7u8; 40], 5_000_000)?;
    assert_eq!(
        w.close(&unknown, &fees, true).err(),
        Some(engine_error(EngineError::AccountOutdated))
    );
    Ok(())
}

#[test]
fn boards_entries_caps_committees_and_profiles_of_another_version_are_refused() -> TestResult {
    let mut w = world()?;
    let outdated = Some(engine_error(EngineError::AccountOutdated));
    let owner = w.owner();
    let intent = w.intent();
    let board = claims_pda(&intent);
    w.set_version(&board, 0)?;
    let other = w.env.funded()?;
    let claim = claim_job_ix(&other.pubkey(), &intent, &owner, HOUR);
    assert_eq!(w.send(&other, claim), outdated);
    let line = stand_by_ix(&other.pubkey(), &intent, 1, HOUR);
    assert_eq!(w.send(&other, line), outdated);
    let worker = w.worker.insecure_clone();
    assert_eq!(
        w.send(&worker, drop_claim_ix(&worker.pubkey(), &intent)),
        outdated
    );
    let caller = w.caller.insecure_clone();
    let settle = settle_claims_ix(&intent, &owner, Some(&worker.pubkey()));
    assert_eq!(w.send(&caller, settle), outdated);
    w.set_version(&board, intent_engine::state::CLAIMS_VERSION)?;

    let entry = standby_pda(&intent, 0);
    w.set_version(&entry, 0)?;
    let waiting = w.waiting.insecure_clone();
    let leave = leave_ix(&waiting.pubkey(), &intent, 0, &waiting.pubkey());
    assert_eq!(w.send(&waiting, leave), outdated);

    let cap = mint_cap_pda(&w.market.input_mint);
    w.set_version(&cap, OLD)?;
    let admin = w.env.authority.insecure_clone();
    let reset = set_mint_cap_ix(&admin.pubkey(), &w.market.input_mint);
    assert_eq!(w.send(&admin, reset), outdated);
    w.env.mint_cap = Some(cap);
    let create = w
        .env
        .create_intent_ix(&w.trader, &w.market, &swap_spec(5, 10)?);
    let trader = w.trader.key.insecure_clone();
    assert_eq!(w.send(&trader, create), outdated);
    w.env.mint_cap = None;

    let committee = w.committee;
    w.set_version(&committee, OLD)?;
    let solver = w.env.solver(&w.market, 0)?;
    let fee_to = w.env.fee_account(&w.market)?;
    let fill = w.env.fill_attested_committee_ix(
        &CommitteeFill {
            solver: &solver.key.pubkey(),
            owner: &owner,
            market: &w.market,
            nonce: 0,
            fee_to: Some(&fee_to),
            committee: &committee,
            signers: 0b11,
            result: 1,
        },
        &solver.input,
    );
    assert_eq!(w.send(&solver.key, fill), outdated);

    let wallet = w.wallet.insecure_clone();
    w.set_version(&profile_pda(&wallet.pubkey()), OLD)?;
    assert_eq!(
        w.send(&wallet, update_profile_ix(&wallet.pubkey())),
        outdated
    );
    assert_eq!(
        w.send(&wallet, close_profile_ix(&wallet.pubkey())),
        outdated
    );
    Ok(())
}

fn old_board(w: &World, until: i64) -> TestResult<Vec<u8>> {
    let board: ClaimBoard = svm_tests::load(&w.env.svm, &claims_pda(&w.intent()))?;
    let mut data = ClaimBoard::DISCRIMINATOR.to_vec();
    data.extend_from_slice(board.intent.as_ref());
    data.extend_from_slice(board.owner.as_ref());
    data.extend_from_slice(board.worker.as_ref());
    data.extend_from_slice(&until.to_le_bytes());
    data.extend_from_slice(&board.stake.to_le_bytes());
    data.extend_from_slice(&board.held.to_le_bytes());
    data.extend_from_slice(&board.max_secs.to_le_bytes());
    data.extend_from_slice(&[OLD, board.bump, 0, 0]);
    data.extend_from_slice(Pubkey::default().as_ref());
    Ok(data)
}

#[test]
fn an_intent_board_and_entry_of_the_previous_version_return_every_token_stake_and_rent(
) -> TestResult {
    let mut w = world()?;
    let owner = w.owner();
    let intent = w.intent();
    let board = claims_pda(&intent);
    w.set_version(&intent, OLD)?;
    w.set_version(&board, OLD)?;
    let refund = w.trader.input;
    let tokens = w.env.balance(&refund)?;
    let worker = w.worker.pubkey();
    let worker_before = w.env.lamports(&worker);
    w.env.claims = Some(board);
    w.env.stake_to = Some(worker);
    let cancel = w.env.cancel_ix(&owner, &w.market, 0, &refund);
    let trader = w.trader.key.insecure_clone();
    w.env.send(&trader, &[cancel], &[])?;
    assert_eq!(Some(w.env.balance(&refund)?), tokens.checked_add(ESCROW));
    assert_eq!(
        Some(w.env.lamports(&worker)),
        worker_before.checked_add(STAKE)
    );

    let rent = w.env.lamports(&intent);
    let before = w.env.lamports(&owner);
    let caller = w.caller.insecure_clone();
    let close = w
        .env
        .close_ix_by(&caller.pubkey(), &owner, &w.market, 0, &refund);
    w.env.send(&caller, &[close], &[])?;
    assert!(!w.env.exists(&intent) && !w.env.exists(&vault_pda(&intent)));
    assert!(Some(w.env.lamports(&owner)) >= before.checked_add(rent));

    let board_rent = w.env.lamports(&board);
    let before = w.env.lamports(&owner);
    w.env
        .send(&caller, &[settle_claims_ix(&intent, &owner, None)], &[])?;
    assert!(!w.env.exists(&board));
    assert_eq!(Some(w.env.lamports(&owner)), before.checked_add(board_rent));

    let entry = standby_pda(&intent, 0);
    w.set_version(&entry, 0)?;
    let waiting = w.waiting.pubkey();
    let held = w.env.lamports(&entry);
    assert!(held > STAKE);
    let before = w.env.lamports(&waiting);
    w.close(&entry, &waiting, false)?;
    assert_eq!(Some(w.env.lamports(&waiting)), before.checked_add(held));
    Ok(())
}

#[test]
fn an_intent_with_a_lapsed_168_byte_board_cancels_once_close_legacy_settled_the_stake() -> TestResult
{
    let mut w = world()?;
    let owner = w.owner();
    let intent = w.intent();
    let board = claims_pda(&intent);
    let data = old_board(&w, START_TS)?;
    let mut account = w.env.svm.get_account(&board).ok_or("board missing")?;
    account.data = data;
    w.env.svm.set_account(board, account)?;
    let refund = w.trader.input;
    let trader = w.trader.key.insecure_clone();
    w.env.claims = Some(board);
    w.env.stake_to = Some(w.worker.pubkey());
    let held = w.env.lamports(&board);
    let before = w.env.lamports(&owner);
    w.close(&board, &owner, false)?;
    assert_eq!(Some(w.env.lamports(&owner)), before.checked_add(held));
    let tokens = w.env.balance(&refund)?;
    w.env.stake_to = None;
    let cancel = w.env.cancel_ix(&owner, &w.market, 0, &refund);
    w.env.send(&trader, &[cancel], &[])?;
    assert_eq!(Some(w.env.balance(&refund)?), tokens.checked_add(ESCROW));
    Ok(())
}

fn set_caps_required_ix(admin: &Pubkey) -> Instruction {
    engine_ix(
        intent_engine::accounts::SetCapsRequired {
            admin: *admin,
            config: config_pda(),
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::SetCapsRequired { required: true },
    )
}

const CAPPED: u64 = 10;

fn outstanding(w: &World) -> TestResult<u64> {
    let cap: MintCap = svm_tests::load(&w.env.svm, &mint_cap_pda(&w.market.input_mint))?;
    Ok(cap.outstanding)
}

#[test]
fn capped_intents_of_the_previous_version_refund_with_an_old_a_missing_or_a_recreated_cap(
) -> TestResult {
    let mut w = world()?;
    let admin = w.env.authority.insecure_clone();
    let require = set_caps_required_ix(&admin.pubkey());
    w.env.send(&admin, &[require], &[])?;
    let cap = mint_cap_pda(&w.market.input_mint);
    w.env.mint_cap = Some(cap);
    for nonce in 1..=4 {
        w.env
            .create_intent(&w.trader, &w.market, &swap_spec(nonce, CAPPED)?)
            .map_err(|e| format!("create {nonce}: {e:?}"))?;
        w.set_version(&intent_pda(&w.owner(), nonce), OLD)?;
    }
    assert_eq!(outstanding(&w)?, 4 * CAPPED);
    w.set_version(&cap, OLD)?;
    let owner = w.owner();
    let refund = w.trader.input;
    let trader = w.trader.key.insecure_clone();
    let caller = w.caller.insecure_clone();

    let tokens = w.env.balance(&refund)?;
    let cancel = w.env.cancel_ix(&owner, &w.market, 1, &refund);
    w.env.send(&trader, &[cancel], &[])?;
    assert_eq!(Some(w.env.balance(&refund)?), tokens.checked_add(CAPPED));
    assert_eq!(outstanding(&w)?, 3 * CAPPED);

    w.env.mint_cap = None;
    let unnamed = w.env.cancel_ix(&owner, &w.market, 2, &refund);
    assert_eq!(
        w.env.send(&trader, &[unnamed], &[]).err(),
        Some(engine_error(EngineError::MintCapMissing))
    );
    w.env.mint_cap = Some(Pubkey::new_unique());
    let forged = w.env.cancel_ix(&owner, &w.market, 2, &refund);
    assert_eq!(
        w.env.send(&trader, &[forged], &[]).err(),
        Some(engine_error(EngineError::MintCapMismatch))
    );
    w.env.mint_cap = Some(cap);

    w.env.set_now(START_TS + 3_601);
    let tokens = w.env.balance(&refund)?;
    let expire = w
        .env
        .expire_ix(&caller.pubkey(), &owner, &w.market, 4, &refund);
    w.env.send(&caller, &[expire], &[])?;
    assert_eq!(Some(w.env.balance(&refund)?), tokens.checked_add(CAPPED));

    let fees = w.env.fee_recipient;
    w.close(&cap, &fees, true)?;
    assert!(!w.env.exists(&cap));
    let tokens = w.env.balance(&refund)?;
    let expire = w
        .env
        .expire_ix(&caller.pubkey(), &owner, &w.market, 2, &refund);
    w.env.send(&caller, &[expire], &[])?;
    assert_eq!(Some(w.env.balance(&refund)?), tokens.checked_add(CAPPED));

    let reset = set_mint_cap_ix(&admin.pubkey(), &w.market.input_mint);
    w.env.send(&admin, &[reset], &[])?;
    assert_eq!(outstanding(&w)?, 0);
    let tokens = w.env.balance(&refund)?;
    let expire = w
        .env
        .expire_ix(&caller.pubkey(), &owner, &w.market, 3, &refund);
    w.env.send(&caller, &[expire], &[])?;
    assert_eq!(Some(w.env.balance(&refund)?), tokens.checked_add(CAPPED));
    assert_eq!(outstanding(&w)?, 0);

    for nonce in 1..=4 {
        let close = w
            .env
            .close_ix_by(&caller.pubkey(), &owner, &w.market, nonce, &refund);
        w.env
            .send(&caller, &[close], &[])
            .map_err(|e| format!("close {nonce}: {e:?}"))?;
        assert!(!w.env.exists(&intent_pda(&owner, nonce)));
    }
    Ok(())
}

#[test]
fn close_legacy_pays_a_held_stake_as_settle_claims_would() -> TestResult {
    let mut w = world()?;
    let owner = w.owner();
    let intent = w.intent();
    let board = claims_pda(&intent);
    w.set_version(&board, OLD)?;
    assert_eq!(
        w.close(&board, &owner, false).err(),
        Some(engine_error(EngineError::ClaimHeld))
    );
    let mut account = w.env.svm.get_account(&intent).ok_or("intent missing")?;
    *account.data.get_mut(8 + 161).ok_or("short")? = 1;
    w.env.svm.set_account(intent, account)?;
    let worker = w.worker.pubkey();
    let close = |stake_to, intent| LegacyClose {
        account: board,
        payee: owner,
        with_config: false,
        vault: None,
        stake_to,
        intent,
        fee_to: None,
    };
    let mismatch = Some(engine_error(EngineError::StakeAccountMismatch));
    assert_eq!(w.close_with(&close(None, Some(intent))).err(), mismatch);
    assert_eq!(
        w.close_with(&close(Some(owner), Some(intent))).err(),
        mismatch
    );
    let missing = Some(engine_error(EngineError::ClaimsMissing));
    assert_eq!(w.close_with(&close(Some(worker), None)).err(), missing);
    assert_eq!(
        w.close_with(&close(Some(worker), Some(Pubkey::new_unique())))
            .err(),
        missing
    );
    let held = w.env.lamports(&board);
    let before = w.env.lamports(&owner);
    let worker_before = w.env.lamports(&worker);
    let meta = w.close_with(&close(Some(worker), Some(intent)))?;
    assert_eq!(
        Some(w.env.lamports(&worker)),
        worker_before.checked_add(STAKE)
    );
    let rent = held.checked_sub(STAKE).ok_or("overflow")?;
    assert_eq!(Some(w.env.lamports(&owner)), before.checked_add(rent));
    let closed = events::<LegacyClosed>(&meta).pop().ok_or("missing")?;
    assert_eq!((closed.lamports, closed.stake), (rent, STAKE));
    Ok(())
}

#[test]
fn close_legacy_reads_vaults_by_address_and_token_state_and_pays_fees_for_an_executable_payer(
) -> TestResult {
    let mut w = world()?;
    let owner = w.owner();
    let intent = w.intent();
    w.set_version(&intent, 0)?;
    let wrong = LegacyClose {
        account: intent,
        payee: owner,
        with_config: false,
        vault: Some(Pubkey::new_unique()),
        stake_to: None,
        intent: None,
        fee_to: None,
    };
    let open = Some(engine_error(EngineError::LegacyVaultOpen));
    assert_eq!(w.close_with(&wrong).err(), open);
    assert_eq!(w.close(&intent, &owner, false).err(), open);
    let vault = vault_pda(&intent);
    let mut dust = w
        .env
        .svm
        .get_account(&w.caller.pubkey())
        .ok_or("caller missing")?;
    dust.lamports = 1;
    w.env.svm.set_account(vault, dust)?;
    let held = w.env.lamports(&intent);
    let before = w.env.lamports(&owner);
    w.close(&intent, &owner, false)?;
    assert_eq!(Some(w.env.lamports(&owner)), before.checked_add(held));

    let wallet = w.wallet.pubkey();
    let profile = profile_pda(&wallet);
    let mut data = w.data(&profile)?;
    data.get_mut(8..40)
        .ok_or("short")?
        .copy_from_slice(anchor_spl::token::ID.as_ref());
    let lamports = 7_000_000;
    let odd = w.plant(data, lamports)?;
    w.set_version(&odd, OLD)?;
    let program = anchor_spl::token::ID;
    let fees = w.env.fee_recipient;
    let mut close = LegacyClose {
        account: odd,
        payee: program,
        with_config: true,
        vault: None,
        stake_to: None,
        intent: None,
        fee_to: None,
    };
    let mismatch = Some(engine_error(EngineError::LegacyPayeeMismatch));
    assert_eq!(w.close_with(&close).err(), mismatch);
    close.fee_to = Some(Pubkey::new_unique());
    assert_eq!(w.close_with(&close).err(), mismatch);
    close.fee_to = Some(fees);
    let before = w.env.lamports(&fees);
    w.close_with(&close)?;
    assert_eq!(Some(w.env.lamports(&fees)), before.checked_add(lamports));
    Ok(())
}

#[test]
fn close_legacy_never_closes_a_config_or_user_state() -> TestResult {
    let mut w = world()?;
    let owner = w.owner();
    let user = user_pda(&owner);
    let admin = w.env.authority.pubkey();
    for (address, payee) in [(user, owner), (config_pda(), admin)] {
        w.set_version(&address, OLD)?;
        assert_eq!(
            w.close(&address, &payee, false).err(),
            Some(engine_error(EngineError::LegacyMigrates))
        );
        assert!(w.env.exists(&address));
    }
    Ok(())
}

#[test]
fn cancel_refuses_a_claims_board_of_another_intent() -> TestResult {
    let mut w = world()?;
    let owner = w.owner();
    let refund = w.trader.input;
    w.env.claims = Some(claims_pda(&Pubkey::new_unique()));
    let cancel = w.env.cancel_ix(&owner, &w.market, 0, &refund);
    let trader = w.trader.key.insecure_clone();
    assert_eq!(
        w.env.send(&trader, &[cancel], &[]).err(),
        Some(anchor_error(ErrorCode::ConstraintSeeds))
    );
    Ok(())
}

#[test]
fn an_owner_cancels_over_a_held_claim_on_a_168_byte_board_and_the_worker_gets_the_stake(
) -> TestResult {
    let mut w = world()?;
    let owner = w.owner();
    let intent = w.intent();
    let board = claims_pda(&intent);
    let data = old_board(&w, START_TS + 600)?;
    let mut account = w.env.svm.get_account(&board).ok_or("board missing")?;
    account.data = data;
    w.env.svm.set_account(board, account)?;
    let refund = w.trader.input;
    let trader = w.trader.key.insecure_clone();
    let worker = w.worker.pubkey();
    let tokens = w.env.balance(&refund)?;
    let worker_before = w.env.lamports(&worker);
    w.env.claims = Some(board);
    w.env.stake_to = Some(owner);
    let wrong = w.env.cancel_ix(&owner, &w.market, 0, &refund);
    assert_eq!(
        w.env.send(&trader, &[wrong], &[]).err(),
        Some(engine_error(EngineError::StakeAccountMismatch))
    );
    w.env.stake_to = Some(worker);
    let cancel = w.env.cancel_ix(&owner, &w.market, 0, &refund);
    w.env.send(&trader, &[cancel], &[])?;
    assert_eq!(Some(w.env.balance(&refund)?), tokens.checked_add(ESCROW));
    assert_eq!(
        Some(w.env.lamports(&worker)),
        worker_before.checked_add(STAKE)
    );
    let left = w.data(&board)?;
    assert_eq!(left.len(), 168);
    assert_eq!(
        board_terms(&left).map(|t| (t.worker, t.held)),
        Some((Pubkey::default(), 0))
    );
    let rent = w.env.lamports(&board);
    let before = w.env.lamports(&owner);
    w.close(&board, &owner, false)?;
    assert_eq!(Some(w.env.lamports(&owner)), before.checked_add(rent));
    Ok(())
}

fn capped_world() -> TestResult<World> {
    let mut w = world()?;
    let admin = w.env.authority.insecure_clone();
    let require = set_caps_required_ix(&admin.pubkey());
    w.env.send(&admin, &[require], &[])?;
    w.env.mint_cap = Some(mint_cap_pda(&w.market.input_mint));
    Ok(w)
}

fn create_capped(
    w: &mut World,
    nonce: u64,
) -> TestResult<Result<TransactionMetadata, TransactionError>> {
    let ix = w
        .env
        .create_intent_ix(&w.trader, &w.market, &swap_spec(nonce, CAPPED)?);
    let trader = w.trader.key.insecure_clone();
    Ok(w.env.send(&trader, &[ix], &[]))
}

#[test]
fn old_intents_refunded_against_a_recreated_cap_leave_its_count_and_limit_intact() -> TestResult {
    let mut w = capped_world()?;
    for nonce in 1..=2 {
        create_capped(&mut w, nonce)?.map_err(|e| format!("create {nonce}: {e:?}"))?;
        w.set_version(&intent_pda(&w.owner(), nonce), OLD)?;
    }
    let cap = mint_cap_pda(&w.market.input_mint);
    w.set_version(&cap, OLD)?;
    let fees = w.env.fee_recipient;
    w.close(&cap, &fees, true)?;
    w.env.set_now(START_TS + 60);
    let admin = w.env.authority.insecure_clone();
    let limit = 2 * CAPPED;
    let reset = set_mint_cap_limit_ix(&admin.pubkey(), &w.market.input_mint, limit);
    w.env.send(&admin, &[reset], &[])?;
    for nonce in 5..=6 {
        create_capped(&mut w, nonce)?.map_err(|e| format!("create {nonce}: {e:?}"))?;
    }
    assert_eq!(outstanding(&w)?, limit);
    let owner = w.owner();
    let refund = w.trader.input;
    let trader = w.trader.key.insecure_clone();
    for nonce in 1..=2 {
        let tokens = w.env.balance(&refund)?;
        let cancel = w.env.cancel_ix(&owner, &w.market, nonce, &refund);
        w.env.send(&trader, &[cancel], &[])?;
        assert_eq!(Some(w.env.balance(&refund)?), tokens.checked_add(CAPPED));
    }
    assert_eq!(outstanding(&w)?, limit);
    assert_eq!(
        create_capped(&mut w, 7)?.err(),
        Some(engine_error(EngineError::MintCapTotal))
    );
    let cancel = w.env.cancel_ix(&owner, &w.market, 5, &refund);
    w.env.send(&trader, &[cancel], &[])?;
    assert_eq!(outstanding(&w)?, CAPPED);
    create_capped(&mut w, 7)?.map_err(|e| format!("create 7: {e:?}"))?;
    Ok(())
}

#[test]
fn a_refund_refuses_another_mints_cap_and_skips_a_cap_address_no_program_account_holds(
) -> TestResult {
    let mut w = capped_world()?;
    create_capped(&mut w, 1)?.map_err(|e| format!("{e:?}"))?;
    create_capped(&mut w, 2)?.map_err(|e| format!("{e:?}"))?;
    let other = w
        .env
        .market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let admin = w.env.authority.insecure_clone();
    let ix = set_mint_cap_ix(&admin.pubkey(), &other.input_mint);
    w.env.send(&admin, &[ix], &[])?;
    let copy = w
        .env
        .svm
        .get_account(&mint_cap_pda(&other.input_mint))
        .ok_or("cap missing")?;
    let planted = Pubkey::new_unique();
    w.env.svm.set_account(planted, copy)?;
    let owner = w.owner();
    let refund = w.trader.input;
    let trader = w.trader.key.insecure_clone();
    let mismatch = Some(engine_error(EngineError::MintCapMismatch));
    for cap in [planted, mint_cap_pda(&other.input_mint)] {
        w.env.mint_cap = Some(cap);
        let cancel = w.env.cancel_ix(&owner, &w.market, 1, &refund);
        assert_eq!(w.env.send(&trader, &[cancel], &[]).err(), mismatch);
    }
    let cap = mint_cap_pda(&w.market.input_mint);
    let mut foreign = w.env.svm.get_account(&cap).ok_or("cap missing")?;
    foreign.owner = anchor_spl::token::ID;
    w.env.svm.set_account(cap, foreign)?;
    w.env.mint_cap = Some(cap);
    let tokens = w.env.balance(&refund)?;
    let cancel = w.env.cancel_ix(&owner, &w.market, 1, &refund);
    w.env.send(&trader, &[cancel], &[])?;
    assert_eq!(Some(w.env.balance(&refund)?), tokens.checked_add(CAPPED));
    assert_eq!(outstanding(&w)?, 2 * CAPPED);
    Ok(())
}

fn migrate(
    w: &mut World,
    address: &Pubkey,
    payer: &Keypair,
    config: bool,
) -> Option<TransactionError> {
    let ix = migrate_ix(&payer.pubkey(), address, config.then(config_pda));
    w.send(payer, ix)
}

#[test]
fn every_account_of_the_previous_version_migrates_in_place_once() -> TestResult {
    let mut w = world()?;
    let caller = w.caller.insecure_clone();
    let admin = w.env.authority.insecure_clone();
    let intent: Intent = svm_tests::load(&w.env.svm, &w.intent())?;
    assert_ne!(intent.fee_bps, 0, "the escrow records a fee");
    for h in w.held() {
        let current = w.data(&h.address)?;
        let lamports = w.env.lamports(&h.address);
        let old = if h.discriminator == Standby::DISCRIMINATOR {
            0
        } else {
            OLD
        };
        w.set_version(&h.address, old)?;
        let is_config = h.discriminator == Config::DISCRIMINATOR;
        let signer = if is_config {
            assert_eq!(
                migrate(&mut w, &h.address, &caller, false),
                Some(engine_error(EngineError::Unauthorized)),
                "{}",
                h.name
            );
            &admin
        } else {
            &caller
        };
        assert_eq!(
            migrate(&mut w, &h.address, signer, !is_config),
            None,
            "{}",
            h.name
        );
        assert_eq!(w.data(&h.address)?, current, "{} keeps every value", h.name);
        assert_eq!(w.env.lamports(&h.address), lamports, "{}", h.name);
        assert_eq!(
            migrate(&mut w, &h.address, signer, !is_config),
            Some(engine_error(EngineError::AlreadyCurrent)),
            "{}",
            h.name
        );
    }
    let intent = w.intent();
    let waiting = w.waiting.insecure_clone();
    let leave = leave_ix(&waiting.pubkey(), &intent, 0, &waiting.pubkey());
    assert_eq!(w.send(&waiting, leave), None);
    let worker = w.worker.insecure_clone();
    let entries = [standby_pda(&intent, 0)];
    let drop = drop_claim_line_ix(&worker.pubkey(), &intent, &entries, None);
    assert_eq!(w.send(&worker, drop), None);
    Ok(())
}

#[test]
fn an_open_escrow_without_a_fee_takes_the_configured_one_and_needs_the_config() -> TestResult {
    let mut w = world()?;
    let caller = w.caller.insecure_clone();
    let intent = w.intent();
    let mut account = w.env.svm.get_account(&intent).ok_or("intent missing")?;
    let fee_at = 8 + core::mem::offset_of!(Intent, fee_bps);
    let recorded = account
        .data
        .get(fee_at..fee_at.saturating_add(2))
        .ok_or("short")?
        .to_vec();
    account
        .data
        .get_mut(fee_at..fee_at.saturating_add(2))
        .ok_or("short")?
        .copy_from_slice(&[0, 0]);
    w.env.svm.set_account(intent, account)?;
    w.set_version(&intent, OLD)?;
    assert_eq!(
        migrate(&mut w, &intent, &caller, false),
        Some(engine_error(EngineError::ConfigMissing))
    );
    assert_eq!(migrate(&mut w, &intent, &caller, true), None);
    let data = w.data(&intent)?;
    assert_eq!(
        data.get(fee_at..fee_at.saturating_add(2)),
        Some(recorded.as_slice())
    );
    Ok(())
}

fn migrated_with(w: &mut World, address: &Pubkey) -> TestResult<AccountMigrated> {
    let caller = w.caller.insecure_clone();
    let ix = migrate_ix(&caller.pubkey(), address, Some(config_pda()));
    let meta = w.env.send(&caller, &[ix], &[])?;
    Ok(events::<AccountMigrated>(&meta)
        .into_iter()
        .next()
        .ok_or("no event")?)
}

fn put_bytes(w: &mut World, address: &Pubkey, at: usize, bytes: &[u8]) -> TestResult {
    let mut account = w.env.svm.get_account(address).ok_or("missing")?;
    account
        .data
        .get_mut(at..at.saturating_add(bytes.len()))
        .ok_or("short")?
        .copy_from_slice(bytes);
    w.env.svm.set_account(*address, account)?;
    Ok(())
}

#[test]
fn an_open_escrow_keeps_a_recovered_fee_only_when_its_release_still_settles() -> TestResult {
    let fee_at = 8 + core::mem::offset_of!(Intent, fee_bps);
    let params_at = core::mem::offset_of!(Intent, params).saturating_add(8);
    let partner_at = core::mem::offset_of!(Intent, partner_bps).saturating_add(8);
    for tight in [false, true] {
        let mut w = world()?;
        let intent = w.intent();
        let held: Intent = svm_tests::load(&w.env.svm, &intent)?;
        let recorded = held.fee_bps;
        assert_ne!(recorded, 0);
        put_bytes(&mut w, &intent, fee_at, &[0, 0])?;
        if tight {
            let mut params =
                attested_result::Params::decode(&held.params).map_err(|e| format!("{e:?}"))?;
            params.judge_fee = ESCROW.saturating_sub(1);
            let encoded = params.encode().map_err(|e| format!("{e:?}"))?;
            put_bytes(&mut w, &intent, params_at, &encoded)?;
            put_bytes(&mut w, &intent, partner_at, &50u16.to_le_bytes())?;
        }
        w.set_version(&intent, OLD)?;
        let event = migrated_with(&mut w, &intent)?;
        let after: Intent = svm_tests::load(&w.env.svm, &intent)?;
        let kept = if tight { 0 } else { recorded };
        assert_eq!((event.fee_bps, event.fee_dropped), (kept, tight));
        assert_eq!(after.fee_bps, kept);
    }
    Ok(())
}

#[test]
fn a_168_byte_board_holding_a_stake_grows_rent_exempt_beyond_the_stake() -> TestResult {
    let mut w = world()?;
    let intent = w.intent();
    let board = claims_pda(&intent);
    let held: ClaimBoard = svm_tests::load(&w.env.svm, &board)?;
    assert_eq!(held.held, STAKE);
    let small = w.env.svm.minimum_balance_for_rent_exemption(168);
    let large = w
        .env
        .svm
        .minimum_balance_for_rent_exemption(ClaimBoard::SPACE);
    let mut account = w.env.svm.get_account(&board).ok_or("board missing")?;
    account.data.truncate(168);
    account.lamports = small.checked_add(STAKE).ok_or("overflow")?;
    w.env.svm.set_account(board, account)?;
    w.set_version(&board, OLD)?;
    let event = migrated_with(&mut w, &board)?;
    assert_eq!(
        w.env.lamports(&board),
        large.checked_add(STAKE).ok_or("overflow")?
    );
    assert_eq!(Some(event.top_up), large.checked_sub(small));
    let worker = w.worker.insecure_clone();
    let before = w.env.lamports(&worker.pubkey());
    assert_eq!(
        w.send(&worker, drop_claim_ix(&worker.pubkey(), &intent)),
        None
    );
    assert_eq!(w.env.lamports(&board), large);
    assert!(w.env.lamports(&worker.pubkey()) > before);
    Ok(())
}

#[test]
fn caps_and_capped_escrows_keep_their_counts_through_migration() -> TestResult {
    let mut w = capped_world()?;
    create_capped(&mut w, 1)?.map_err(|e| format!("{e:?}"))?;
    let caller = w.caller.insecure_clone();
    let cap = mint_cap_pda(&w.market.input_mint);
    let capped = intent_pda(&w.owner(), 1);
    assert_eq!(outstanding(&w)?, CAPPED);
    for address in [cap, capped] {
        let current = w.data(&address)?;
        w.set_version(&address, OLD)?;
        assert_eq!(migrate(&mut w, &address, &caller, true), None);
        assert_eq!(w.data(&address)?, current);
    }
    assert_eq!(outstanding(&w)?, CAPPED);
    let owner = w.owner();
    let refund = w.trader.input;
    let trader = w.trader.key.insecure_clone();
    let cancel = w.env.cancel_ix(&owner, &w.market, 1, &refund);
    w.env.send(&trader, &[cancel], &[])?;
    assert_eq!(outstanding(&w)?, 0);
    Ok(())
}

#[test]
fn a_layout_no_version_describes_is_refused_and_stays_closable() -> TestResult {
    let mut w = world()?;
    let caller = w.caller.insecure_clone();
    let profile = profile_pda(&w.wallet.pubkey());
    w.set_version(&profile, 0)?;
    assert_eq!(
        migrate(&mut w, &profile, &caller, false),
        Some(engine_error(EngineError::UnknownLayout))
    );
    let wallet = w.wallet.pubkey();
    w.close(&profile, &wallet, false)
        .map_err(|e| format!("{e:?}"))?;
    assert!(!w.env.exists(&profile));
    let odd = w.plant(vec![9; 48], 1_000_000)?;
    assert_eq!(
        migrate(&mut w, &odd, &caller, false),
        Some(engine_error(EngineError::UnknownLayout))
    );
    let user = user_pda(&w.owner());
    assert_eq!(
        migrate(&mut w, &user, &caller, false),
        Some(engine_error(EngineError::AlreadyCurrent))
    );
    Ok(())
}

use anchor_lang::prelude::Pubkey;
use anchor_lang::Discriminator;
use core::mem::offset_of;
use intent_core::kinds::{attested_result, Kind};
use intent_core::lifecycle::Status;
use intent_core::nonce::Window;
use intent_engine::errors::EngineError;
use intent_engine::events::AccountMigrated;
use intent_engine::policy::FeeSchedule;
use intent_engine::state::{
    ClaimBoard, Config, Intent, Mandate, Profile, UserState, BPS, CONFIG_VERSION,
    MAX_ATTESTED_FEE_BPS, PAUSE_ALL, PROFILE_SEED,
};
use intent_engine::versions::{
    config_terms, is_current, migration_of, Layout, FIRST_VERSION, LAYOUTS, LEGACY_BOARD_SPACE,
    LEGACY_CONFIG_SPACE,
};
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use std::collections::BTreeMap;
use svm_tests::{
    claim_job_ix, claims_pda, close_legacy_full_ix, close_legacy_ix, config_pda, devnet_env,
    devnet_snapshot, ed25519_ix, empty_ext_hash, engine_error, engine_ix, event_authority, events,
    intent_pda, leave_ix, load, migrate_ix, open_claims_ix, pda, send_as, settle_claims_ix,
    stand_by_ix, standby_pda, swap_spec, user_pda, vault_pda, Delivery, Env, IntentSpec,
    LegacyClose, Market, Saved, Snapshot, TestResult, FUNDING,
};

const HEAD: usize = 8;
const HOUR: u32 = 3_600;
const ESCROW: u64 = 1_000_000;
const STAKE: u64 = 1_000_000;
const SPEC: [u8; 32] = [0x5a; 32];

struct Devnet {
    env: Env,
    snap: Snapshot,
    admin: Pubkey,
    payer: Keypair,
}

fn devnet() -> TestResult<Devnet> {
    let snap = devnet_snapshot()?;
    let mut env = devnet_env(&snap)?;
    let config = snap.get(&config_pda()).ok_or("no config")?;
    let admin = config_terms(&config.data).ok_or("config unreadable")?.admin;
    env.svm
        .airdrop(&admin, FUNDING)
        .map_err(|f| format!("airdrop: {:?}", f.err))?;
    let payer = env.funded()?;
    Ok(Devnet {
        env,
        snap,
        admin,
        payer,
    })
}

fn body<T: bytemuck::Pod>(data: &[u8]) -> TestResult<T> {
    let bytes = data
        .get(HEAD..HEAD.saturating_add(core::mem::size_of::<T>()))
        .ok_or("account too short")?;
    Ok(bytemuck::pod_read_unaligned(bytes))
}

fn layout_index(layout: &Layout) -> usize {
    LAYOUTS
        .iter()
        .position(|l| l.discriminator == layout.discriminator)
        .unwrap_or(usize::MAX)
}

fn is_open(intent: &Intent) -> bool {
    intent.status == Status::Open as u8
}

impl Devnet {
    fn send(&mut self, ixs: &[Instruction]) -> Result<TransactionMetadata, TransactionError> {
        let payer = self.payer.pubkey();
        send_as(&mut self.env, &payer, ixs)
    }

    fn migrate(&mut self, account: &Pubkey) -> Result<TransactionMetadata, TransactionError> {
        if *account == config_pda() {
            let admin = self.admin;
            send_as(&mut self.env, &admin, &[migrate_ix(&admin, account, None)])
        } else {
            let payer = self.payer.pubkey();
            let ix = migrate_ix(&payer, account, Some(config_pda()));
            send_as(&mut self.env, &payer, &[ix])
        }
    }

    fn addresses(&self) -> Vec<Pubkey> {
        let config = config_pda();
        let mut all: Vec<Pubkey> = self
            .snap
            .accounts
            .iter()
            .map(|s| s.address)
            .filter(|a| *a != config)
            .collect();
        all.push(config);
        all
    }

    fn migrate_all(&mut self) -> TestResult {
        for address in self.addresses() {
            self.migrate(&address)?;
        }
        Ok(())
    }

    fn addresses_of(&self, discriminator: &[u8]) -> Vec<Pubkey> {
        self.snap
            .of_type(discriminator)
            .into_iter()
            .map(|s| s.address)
            .collect()
    }

    fn lamports(&self, key: &Pubkey) -> u64 {
        self.env.lamports(key)
    }

    fn data(&self, key: &Pubkey) -> TestResult<Vec<u8>> {
        Ok(self.env.svm.get_account(key).ok_or("account missing")?.data)
    }

    fn intents(&self) -> TestResult<Vec<(Pubkey, Intent)>> {
        self.snap
            .of_type(Intent::DISCRIMINATOR)
            .into_iter()
            .map(|s| Ok((s.address, body::<Intent>(&s.data)?)))
            .collect()
    }

    fn market(&self, intent: &Intent) -> TestResult<Market> {
        let program = self
            .env
            .svm
            .get_account(&intent.input_mint)
            .ok_or("input mint missing")?
            .owner;
        Ok(Market {
            input_mint: intent.input_mint,
            output_mint: intent.output_mint,
            input_program: program,
            output_program: program,
        })
    }
}

#[test]
fn the_fixture_holds_every_devnet_account_in_a_listed_layout() -> TestResult {
    let snap = devnet_snapshot()?;
    let mut counts: BTreeMap<(usize, usize, u8), usize> = BTreeMap::new();
    for saved in &snap.accounts {
        assert!(
            !is_current(&saved.data),
            "{} is already current",
            saved.address
        );
        let (layout, from) = migration_of(&saved.data).ok_or("an unlisted layout")?;
        let count = counts
            .entry((layout_index(layout), from.space, from.version))
            .or_default();
        *count = count.saturating_add(1);
    }
    let expected: BTreeMap<(usize, usize, u8), usize> = [
        ((0, LEGACY_CONFIG_SPACE, FIRST_VERSION), 1),
        ((1, UserState::SPACE, FIRST_VERSION), 166),
        ((2, Intent::SPACE, FIRST_VERSION), 64),
        ((3, Mandate::SPACE, FIRST_VERSION), 9),
        (
            (5, intent_engine::state::Committee::SPACE, FIRST_VERSION),
            1,
        ),
        ((6, LEGACY_BOARD_SPACE, FIRST_VERSION), 21),
        ((8, Profile::SPACE, FIRST_VERSION), 1),
    ]
    .into_iter()
    .collect();
    assert_eq!(counts, expected);
    for saved in &snap.tokens {
        assert!(saved.owner == anchor_spl::token::ID || saved.owner == anchor_spl::token_2022::ID);
    }
    Ok(())
}

fn expected_after(saved: &Saved, layout: &Layout, schedule: &FeeSchedule) -> TestResult<Vec<u8>> {
    let mut data = saved.data.clone();
    data.resize(layout.space, 0);
    *data
        .get_mut(HEAD.saturating_add(layout.version_at))
        .ok_or("short")? = layout.version;
    if layout.discriminator == Intent::DISCRIMINATOR {
        let intent = body::<Intent>(&saved.data)?;
        if is_open(&intent) && intent.fee_bps == 0 {
            let fee = schedule
                .fee_bps(intent.kind)
                .map_err(|e| format!("{e:?}"))?;
            let at = HEAD.saturating_add(offset_of!(Intent, fee_bps));
            data.get_mut(at..at.saturating_add(2))
                .ok_or("short")?
                .copy_from_slice(&fee.to_le_bytes());
        }
    }
    Ok(data)
}

#[test]
fn every_devnet_account_migrates_once_keeping_its_values_and_lamports() -> TestResult {
    let mut d = devnet()?;
    let config = d.snap.get(&config_pda()).ok_or("no config")?;
    let schedule = FeeSchedule::of(&config_terms(&config.data).ok_or("config")?);
    let mut grown = 0usize;
    for address in d.addresses() {
        let saved = d.snap.get(&address).ok_or("not in the fixture")?;
        let (layout, from) = migration_of(&saved.data).ok_or("unlisted")?;
        let (layout, from) = (*layout, *from);
        let expected = expected_after(saved, &layout, &schedule)?;
        let before = saved.lamports;
        let meta = d.migrate(&address)?;
        let after = d.data(&address)?;
        assert!(is_current(&after), "{address}");
        assert_eq!(after, expected, "{address} keeps every value");
        let rent = d.env.svm.minimum_balance_for_rent_exemption(layout.space);
        let lamports = d.lamports(&address);
        if from.space < layout.space {
            grown = grown.saturating_add(1);
            assert_eq!(lamports, before.max(rent), "{address} is topped up");
        } else {
            assert_eq!(lamports, before, "{address} keeps its lamports");
        }
        let moved: Vec<(Pubkey, u8, u8, u64)> = events::<AccountMigrated>(&meta)
            .into_iter()
            .map(|e| (e.account, e.from_version, e.version, e.top_up))
            .collect();
        assert_eq!(
            moved,
            [(
                address,
                from.version,
                layout.version,
                lamports.saturating_sub(before)
            )]
        );
        assert_eq!(
            d.migrate(&address).err(),
            Some(engine_error(EngineError::AlreadyCurrent)),
            "{address} migrates once"
        );
        assert_eq!(d.lamports(&address), lamports);
    }
    assert_eq!(grown, 22, "the config and every board grow");
    let fees: Vec<(u8, u16)> = d
        .intents()?
        .into_iter()
        .map(|(address, _)| body::<Intent>(&d.data(&address)?))
        .collect::<TestResult<Vec<Intent>>>()?
        .into_iter()
        .filter(|i| i.fee_bps != 0)
        .map(|i| (i.status, i.fee_bps))
        .collect();
    assert_eq!(
        fees,
        [(Status::Open as u8, MAX_ATTESTED_FEE_BPS); 2],
        "the two open escrows keep the fee devnet would charge them"
    );
    Ok(())
}

#[test]
fn an_unknown_or_foreign_layout_is_refused_and_only_the_admin_migrates_the_config() -> TestResult {
    let mut d = devnet()?;
    let stranger = d.payer.pubkey();
    let config = config_pda();
    assert_eq!(
        send_as(
            &mut d.env,
            &stranger,
            &[migrate_ix(&stranger, &config, None)]
        )
        .err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    let odd = Pubkey::new_unique();
    let mut account = d.env.svm.get_account(&config).ok_or("config")?;
    account.data = vec![7; 64];
    d.env.svm.set_account(odd, account)?;
    let ix = migrate_ix(&stranger, &odd, Some(config));
    assert_eq!(
        send_as(&mut d.env, &stranger, &[ix]).err(),
        Some(engine_error(EngineError::UnknownLayout))
    );
    let old = config_terms(&d.snap.get(&config).ok_or("config")?.data).ok_or("config")?;
    d.migrate(&config)?;
    let new: Config = load(&d.env.svm, &config)?;
    assert_eq!(
        (
            new.admin,
            new.pending_admin,
            new.guardian,
            new.fee_recipient,
            new.domain
        ),
        (
            old.admin,
            old.pending_admin,
            old.guardian,
            old.fee_recipient,
            old.domain
        )
    );
    assert_eq!(
        (
            new.fee_bps,
            new.kind_fee_mask,
            new.kind_fee_bps,
            new.partner_cut_bps
        ),
        (
            old.fee_bps,
            old.kind_fee_mask,
            old.kind_fee_bps,
            old.partner_cut_bps
        )
    );
    assert_eq!(
        (
            new.paused,
            new.enabled_kinds,
            new.fill_disabled_kinds,
            new.crank_bounty
        ),
        (
            old.paused,
            old.enabled_kinds,
            old.fill_disabled_kinds,
            old.crank_bounty
        )
    );
    assert_eq!(
        (new.create_fee, new.caps_required, new.bump, new.version),
        (old.create_fee, old.caps_required, old.bump, CONFIG_VERSION)
    );
    assert_eq!(
        new.floor_amounts, [0; 8],
        "no committee floor until the admin sets one"
    );
    assert_eq!(new.floor_mints, [Pubkey::default(); 8]);
    let admin = d.admin;
    let raise = d.env.raise_pause_ix(&admin, PAUSE_ALL);
    d.send(&[raise])?;
    assert_eq!(load::<Config>(&d.env.svm, &config)?.paused, PAUSE_ALL);
    let lower = d.env.lower_pause_ix(&admin, PAUSE_ALL);
    d.send(&[lower])?;
    assert_eq!(load::<Config>(&d.env.svm, &config)?.paused, old.paused);
    Ok(())
}

fn close_profile_ix(wallet: &Pubkey) -> Instruction {
    engine_ix(
        intent_engine::accounts::CloseProfile {
            wallet: *wallet,
            profile: pda(&[PROFILE_SEED, wallet.as_ref()]),
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::CloseProfile {},
    )
}

enum Ending {
    Cancel,
    Expire,
}

fn refund_intents(d: &mut Devnet, ending: &Ending) -> TestResult<usize> {
    let mut refunded = 0usize;
    for (address, intent) in d.intents()? {
        let market = d.market(&intent)?;
        let refund = d
            .env
            .create_ata(&intent.owner, &market.input_mint, market.input_program)?;
        let vault = vault_pda(&address);
        let held = d.env.balance(&vault)?;
        let owned = d.env.balance(&refund)?;
        let owner = intent.owner;
        let cranker = d.payer.pubkey();
        if is_open(&intent) {
            let ix = match ending {
                Ending::Cancel => d.env.cancel_ix(&owner, &market, intent.nonce, &refund),
                Ending::Expire => {
                    let now = d.env.now();
                    d.env.set_now(now.max(intent.expires_at));
                    d.env
                        .expire_ix(&cranker, &owner, &market, intent.nonce, &refund)
                }
            };
            d.send(&[ix])?;
            assert_eq!(d.env.balance(&vault)?, 0);
        }
        let rent_to = intent.rent_payer;
        let gain = d
            .lamports(&address)
            .checked_add(d.lamports(&vault))
            .ok_or("overflow")?;
        let before = d.lamports(&rent_to);
        let close = d
            .env
            .close_ix_with(&cranker, &owner, &rent_to, &market, intent.nonce, &refund);
        d.send(&[close])?;
        assert_eq!(
            d.env.balance(&refund)?,
            owned.checked_add(held).ok_or("overflow")?,
            "{address} gives its owner every token back"
        );
        assert!(
            !d.env.exists(&address) && !d.env.exists(&vault),
            "{address}"
        );
        assert_eq!(
            d.lamports(&rent_to),
            before.checked_add(gain).ok_or("overflow")?,
            "{address} gives its rent back"
        );
        refunded = refunded.saturating_add(usize::from(held > 0));
    }
    Ok(refunded)
}

fn refund_rest(d: &mut Devnet, migrated: bool) -> TestResult {
    let config = config_pda();
    for address in d.addresses_of(ClaimBoard::DISCRIMINATOR) {
        let mut data = d.data(&address)?;
        data.resize(data.len().max(ClaimBoard::SPACE), 0);
        let board: ClaimBoard = body(&data)?;
        assert_eq!((board.held, board.worker), (0, Pubkey::default()));
        let gain = d.lamports(&address);
        let before = d.lamports(&board.owner);
        let ix = if migrated {
            settle_claims_ix(&board.intent, &board.owner, None)
        } else {
            close_legacy_full_ix(&LegacyClose {
                account: address,
                payee: board.owner,
                with_config: false,
                vault: None,
                stake_to: None,
                intent: Some(board.intent),
                fee_to: None,
            })
        };
        d.send(&[ix])?;
        assert_eq!(address, claims_pda(&board.intent));
        assert!(!d.env.exists(&address));
        assert_eq!(
            d.lamports(&board.owner),
            before.checked_add(gain).ok_or("overflow")?
        );
    }
    for address in d.addresses_of(Mandate::DISCRIMINATOR) {
        let mandate: Mandate = body(&d.data(&address)?)?;
        let gain = d.lamports(&address);
        let before = d.lamports(&mandate.owner);
        let ix = if migrated {
            d.env.revoke_mandate_ix(&mandate.owner, address)
        } else {
            close_legacy_ix(&address, &mandate.owner, false)
        };
        d.send(&[ix])?;
        assert_eq!(
            d.lamports(&mandate.owner),
            before.checked_add(gain).ok_or("overflow")?
        );
    }
    for address in d.addresses_of(Profile::DISCRIMINATOR) {
        let profile: Profile = body(&d.data(&address)?)?;
        let gain = d.lamports(&address);
        let before = d.lamports(&profile.wallet);
        let ix = if migrated {
            close_profile_ix(&profile.wallet)
        } else {
            close_legacy_ix(&address, &profile.wallet, false)
        };
        d.send(&[ix])?;
        assert_eq!(
            d.lamports(&profile.wallet),
            before.checked_add(gain).ok_or("overflow")?
        );
    }
    assert!(d.env.exists(&config));
    Ok(())
}

#[test]
fn every_refund_works_on_devnet_accounts_before_migrating() -> TestResult {
    let mut d = devnet()?;
    assert_eq!(refund_intents(&mut d, &Ending::Cancel)?, 2);
    refund_rest(&mut d, false)?;
    let mut d = devnet()?;
    assert_eq!(refund_intents(&mut d, &Ending::Expire)?, 2);
    Ok(())
}

#[test]
fn every_refund_works_on_devnet_accounts_after_migrating() -> TestResult {
    let mut d = devnet()?;
    d.migrate_all()?;
    assert_eq!(refund_intents(&mut d, &Ending::Cancel)?, 2);
    refund_rest(&mut d, true)?;
    let mut d = devnet()?;
    d.migrate_all()?;
    assert_eq!(refund_intents(&mut d, &Ending::Expire)?, 2);
    Ok(())
}

fn free_nonce(user: &UserState) -> TestResult<u64> {
    let window = Window {
        base: user.nonce_base,
        bits: user.nonce_bitmap,
    };
    (0..256u64)
        .filter_map(|i| user.nonce_base.checked_add(i))
        .find(|n| window.is_used(*n).ok() == Some(false))
        .ok_or_else(|| "no free nonce".into())
}

struct Order<'a> {
    owner: Pubkey,
    market: &'a Market,
    owner_input: Pubkey,
    receiver: Pubkey,
    spec: IntentSpec,
}

fn create_ix(env: &Env, o: &Order) -> Instruction {
    let intent = intent_pda(&o.owner, o.spec.nonce);
    engine_ix(
        intent_engine::accounts::CreateIntent {
            owner: o.owner,
            config: config_pda(),
            user_state: user_pda(&o.owner),
            intent,
            input_mint: o.market.input_mint,
            output_mint: o.market.output_mint,
            owner_input: o.owner_input,
            receiver: o.receiver,
            receiver_authority: o.owner,
            vault: vault_pda(&intent),
            input_token_program: o.market.input_program,
            output_token_program: o.market.output_program,
            treasury: env.fee_recipient,
            system_program: anchor_lang::system_program::ID,
            committee: None,
            mint_cap: None,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::CreateIntent {
            args: intent_engine::CreateIntentArgs {
                nonce: o.spec.nonce,
                kind: o.spec.kind,
                flags: o.spec.flags,
                params: o.spec.params,
                expires_at: o.spec.expires_at,
                ext: intent_engine::Ext(o.spec.ext.clone()),
                max_create_fee: env.max_create_fee,
                max_bounty: env.max_bounty,
            },
        },
    )
}

fn proof_message(
    domain: [u8; 32],
    attestor: &Pubkey,
    intent: &Pubkey,
    payee: &Pubkey,
    delivery: &Delivery,
) -> Vec<u8> {
    let preimage = intent_core::sig::AttestedDelivery {
        program: intent_engine::ID.to_bytes(),
        domain,
        intent: intent.to_bytes(),
        payee: payee.to_bytes(),
        amount_in: ESCROW,
        result: 1,
        filled: 0,
        revision: 0,
        max_fee_bps: MAX_ATTESTED_FEE_BPS,
        ext_hash: empty_ext_hash(),
        spec_hash: SPEC,
        announcement: delivery.announcement.to_bytes(),
        seq: delivery.seq,
        delivered: delivery.opening.delivered,
        salt: delivery.opening.salt,
    }
    .preimage();
    let digest = solana_sha256_hasher::hashv(&[&preimage]).to_bytes();
    intent_core::sig::offchain_envelope(&attestor.to_bytes(), &digest).to_vec()
}

#[test]
fn after_migrating_the_engine_runs_on_devnet_accounts() -> TestResult {
    let mut d = devnet()?;
    d.migrate_all()?;
    let (_, held) = d
        .intents()?
        .into_iter()
        .find(|(_, i)| is_open(i))
        .ok_or("no open escrow")?;
    let owner = held.owner;
    d.env
        .svm
        .airdrop(&owner, FUNDING)
        .map_err(|f| format!("airdrop: {:?}", f.err))?;
    let wsol = d.market(&held)?;
    let owner_input = d
        .env
        .create_ata(&owner, &wsol.input_mint, wsol.input_program)?;
    let cancel = d.env.cancel_ix(&owner, &wsol, held.nonce, &owner_input);
    d.send(&[cancel])?;
    assert_eq!(d.env.balance(&owner_input)?, held.escrowed);

    let output_mint = d.env.create_mint(anchor_spl::token::ID, &[])?;
    let market = Market {
        input_mint: wsol.input_mint,
        output_mint,
        input_program: wsol.input_program,
        output_program: anchor_spl::token::ID,
    };
    let receiver = d
        .env
        .create_token_account(&output_mint, &owner, anchor_spl::token::ID)?;
    let attestor = Keypair::new();
    let user: UserState = load(&d.env.svm, &user_pda(&owner))?;
    let nonce = free_nonce(&user)?;
    let expires_at = d.env.now().saturating_add(i64::from(HOUR));
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        expires_at,
        ..swap_spec(nonce, ESCROW)?
    };
    let order = Order {
        owner,
        market: &market,
        owner_input,
        receiver,
        spec,
    };
    d.send(&[create_ix(&d.env, &order)])?;
    let intent = intent_pda(&owner, nonce);
    let created: Intent = load(&d.env.svm, &intent)?;
    assert_eq!(created.fee_bps, MAX_ATTESTED_FEE_BPS);

    d.send(&[open_claims_ix(&owner, &intent, HOUR, STAKE)])?;
    let worker = d.env.funded()?;
    let waiting = d.env.funded()?;
    d.env.send(
        &worker,
        &[claim_job_ix(&worker.pubkey(), &intent, &owner, HOUR)],
        &[],
    )?;
    d.env.send(
        &waiting,
        &[stand_by_ix(&waiting.pubkey(), &intent, 0, HOUR)],
        &[],
    )?;
    assert!(d.env.exists(&standby_pda(&intent, 0)));

    let payee = d
        .env
        .create_ata(&worker.pubkey(), &market.input_mint, market.input_program)?;
    let recipient = d.env.fee_recipient;
    let fee_to = d
        .env
        .create_ata(&recipient, &market.input_mint, market.input_program)?;
    let fees_before = d.env.balance(&fee_to)?;
    let config: Config = load(&d.env.svm, &config_pda())?;
    let delivery = d.env.announce_for(&worker, &intent)?;
    let message = proof_message(
        config.domain,
        &attestor.pubkey(),
        &intent,
        &payee,
        &delivery,
    );
    d.env.claims = Some(claims_pda(&intent));
    d.env.stake_to = Some(worker.pubkey());
    d.env.max_fee_bps = MAX_ATTESTED_FEE_BPS;
    let fill = d.env.fill_attested_ix(
        &worker.pubkey(),
        &owner,
        &market,
        nonce,
        &payee,
        Some(&fee_to),
        1,
    );
    d.env.claims = None;
    d.env.stake_to = None;
    d.env
        .send(&worker, &[ed25519_ix(&attestor, &message), fill], &[])?;
    let fee = ESCROW
        .checked_mul(u64::from(MAX_ATTESTED_FEE_BPS))
        .and_then(|f| f.checked_div(u64::from(BPS)))
        .ok_or("overflow")?;
    assert_eq!(d.env.balance(&payee)?, ESCROW.saturating_sub(fee));
    assert_eq!(d.env.balance(&fee_to)?.saturating_sub(fees_before), fee);

    let waited = d.lamports(&waiting.pubkey());
    let entry = d.lamports(&standby_pda(&intent, 0));
    let leave = leave_ix(&waiting.pubkey(), &intent, 0, &waiting.pubkey());
    d.env.send(&waiting, &[leave], &[])?;
    assert!(!d.env.exists(&standby_pda(&intent, 0)));
    assert!(d.lamports(&waiting.pubkey()) > waited);
    assert!(entry > 0);

    let swap_nonce = free_nonce(&load(&d.env.svm, &user_pda(&owner))?)?;
    let swap = IntentSpec {
        expires_at,
        ..swap_spec(swap_nonce, ESCROW)?
    };
    let order = Order {
        spec: swap,
        ..order
    };
    d.send(&[create_ix(&d.env, &order)])?;
    let solver = d.env.solver(&market, ESCROW)?;
    d.env.max_fee_bps = intent_engine::state::MAX_FEE_BPS;
    let fill = d.env.fill_ix(
        &solver,
        &owner,
        &market,
        swap_nonce,
        &receiver,
        Some(&fee_to),
        ESCROW,
    );
    d.env.send(&solver.key, &[fill], &[])?;
    assert_eq!(d.env.balance(&receiver)?, ESCROW);
    assert!(d.env.balance(&solver.input)? > 0);

    for saved in d.snap.of_type(Profile::DISCRIMINATOR) {
        let profile: Profile = load(&d.env.svm, &saved.address)?;
        let kept: Profile = body(&saved.data)?;
        assert_eq!(
            (
                profile.wallet,
                profile.endpoint,
                profile.skills,
                profile.doc_hash
            ),
            (kept.wallet, kept.endpoint, kept.skills, kept.doc_hash)
        );
        assert_eq!(profile.version, intent_engine::state::PROFILE_VERSION);
        assert_eq!(profile.encryption_key, [0; 32]);
    }
    Ok(())
}

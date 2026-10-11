use anchor_lang::prelude::Pubkey;
use intent_engine::events::{
    AdminAccepted, AdminProposed, ConfigInitialized, ConfigUpdated, IntentCancelled, IntentClosed,
    IntentCreated, IntentExpired, NonceAdvanced, PauseLowered, PauseRaised, UserInitialized,
};
use intent_engine::state::{PAUSE_CREATE, PAUSE_FILL};
use solana_signer::Signer;
use svm_tests::{events, intent_pda, swap_spec, Env, TestResult};

#[test]
fn config_instructions_emit_events() -> TestResult {
    let mut env = Env::new()?;
    let authority = env.authority.insecure_clone();
    let guardian = env.guardian.insecure_clone();
    let settings = env.settings();
    let ix = env.init_config_ix(&authority.pubkey(), settings);
    let meta = env.send(&authority, &[ix], &[])?;
    let got = events::<ConfigInitialized>(&meta);
    assert_eq!(got.len(), 1);
    let e = got.first().ok_or("missing")?;
    assert_eq!(e.admin, authority.pubkey());
    assert_eq!(e.domain, svm_tests::DOMAIN);
    assert_eq!(e.guardian, settings.guardian);
    assert_eq!(e.fee_recipient, settings.fee_recipient);
    assert_eq!(e.enabled_kinds, settings.enabled_kinds);
    assert_eq!(e.fee_bps, settings.fee_bps);
    assert_eq!(e.paused, settings.paused);

    let mut next = settings;
    next.fee_bps = 9;
    next.enabled_kinds = 0b10;
    next.guardian = Pubkey::new_unique();
    next.fee_recipient = Pubkey::new_unique();
    let ix = env.update_config_ix(&authority.pubkey(), next);
    let meta = env.send(&authority, &[ix], &[])?;
    let e = events::<ConfigUpdated>(&meta).pop().ok_or("missing")?;
    assert_eq!(
        (
            e.guardian,
            e.fee_recipient,
            e.enabled_kinds,
            e.fee_bps,
            e.paused
        ),
        (next.guardian, next.fee_recipient, next.enabled_kinds, 9, 0)
    );

    let ix = env.update_config_ix(&authority.pubkey(), settings);
    env.send(&authority, &[ix], &[])?;
    let ix = env.raise_pause_ix(&guardian.pubkey(), PAUSE_CREATE);
    let meta = env.send(&guardian, &[ix], &[])?;
    let e = events::<PauseRaised>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.by, e.paused), (guardian.pubkey(), PAUSE_CREATE));
    let ix = env.raise_pause_ix(&guardian.pubkey(), PAUSE_FILL);
    env.send(&guardian, &[ix], &[])?;
    let ix = env.update_config_ix(&authority.pubkey(), settings);
    let meta = env.send(&authority, &[ix], &[])?;
    let e = events::<ConfigUpdated>(&meta).pop().ok_or("missing")?;
    assert_eq!(e.paused, PAUSE_CREATE | PAUSE_FILL);
    let ix = env.lower_pause_ix(&authority.pubkey(), PAUSE_CREATE | PAUSE_FILL);
    let meta = env.send(&authority, &[ix], &[])?;
    let e = events::<PauseLowered>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.by, e.paused), (authority.pubkey(), 0));

    let next_admin = env.funded()?;
    let ix = env.propose_admin_ix(&authority.pubkey(), next_admin.pubkey());
    let meta = env.send(&authority, &[ix], &[])?;
    let e = events::<AdminProposed>(&meta).pop().ok_or("missing")?;
    assert_eq!(
        (e.admin, e.pending_admin),
        (authority.pubkey(), next_admin.pubkey())
    );

    let ix = env.accept_admin_ix(&next_admin.pubkey());
    let meta = env.send(&next_admin, &[ix], &[])?;
    let e = events::<AdminAccepted>(&meta).pop().ok_or("missing")?;
    assert_eq!(
        (e.previous_admin, e.admin),
        (authority.pubkey(), next_admin.pubkey())
    );
    Ok(())
}

#[test]
fn user_instructions_emit_events() -> TestResult {
    let mut env = Env::new()?;
    let owner = env.funded()?;
    let meta = env.init_user(&owner)?;
    let e = events::<UserInitialized>(&meta).pop().ok_or("missing")?;
    assert_eq!(e.owner, owner.pubkey());
    let ix = env.advance_ix(&owner.pubkey(), 77);
    let meta = env.send(&owner, &[ix], &[])?;
    let e = events::<NonceAdvanced>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.owner, e.nonce_base), (owner.pubkey(), 77));
    Ok(())
}

#[test]
fn intent_instructions_emit_events() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let program = anchor_spl::token::ID;
    let market = env.market(program, &[], program, &[])?;
    let trader = env.trader(&market, 1_000)?;
    let owner = trader.key.pubkey();

    let spec = swap_spec(4, 250)?;
    let meta = env.create_intent(&trader, &market, &spec)?;
    let e = events::<IntentCreated>(&meta).pop().ok_or("missing")?;
    assert_eq!(e.intent, intent_pda(&owner, 4));
    assert_eq!(e.owner, owner);
    assert_eq!(e.nonce, 4);
    assert_eq!(e.kind, spec.kind);
    assert_eq!(e.input_mint, market.input_mint);
    assert_eq!(e.output_mint, market.output_mint);
    assert_eq!(e.receiver, trader.receiver);
    assert_eq!(e.escrowed, 250);
    assert_eq!(e.expires_at, spec.expires_at);
    assert_eq!((e.flags, spec.flags), (0, 0));

    let ix = env.cancel_ix(&owner, &market, 4, &trader.input);
    let meta = env.send(&trader.key, &[ix], &[])?;
    let e = events::<IntentCancelled>(&meta).pop().ok_or("missing")?;
    assert_eq!(
        (e.intent, e.owner, e.refunded),
        (intent_pda(&owner, 4), owner, 250)
    );

    let cranker = env.funded()?;
    let ix = env.close_ix_by(&cranker.pubkey(), &owner, &market, 4, &trader.input);
    let meta = env.send(&cranker, &[ix], &[])?;
    let e = events::<IntentClosed>(&meta).pop().ok_or("missing")?;
    assert_eq!(
        (e.intent, e.owner, e.swept, e.rent_to),
        (intent_pda(&owner, 4), owner, 0, owner)
    );

    let spec = swap_spec(5, 60)?;
    env.create_intent(&trader, &market, &spec)?;
    env.set_now(spec.expires_at);
    let ix = env.expire_ix(&cranker.pubkey(), &owner, &market, 5, &trader.input);
    let meta = env.send(&cranker, &[ix], &[])?;
    let e = events::<IntentExpired>(&meta).pop().ok_or("missing")?;
    assert_eq!(
        (e.intent, e.owner, e.refunded, e.by),
        (intent_pda(&owner, 5), owner, 60, cranker.pubkey())
    );
    Ok(())
}

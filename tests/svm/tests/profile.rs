use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use intent_engine::events::{ProfileClosed, ProfileSet};
use intent_engine::state::{Profile, PROFILE_SEED, PROFILE_VERSION};
use intent_engine::ProfileFields;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{engine_error_at, engine_ix, event_authority, events, load, pda, Env, TestResult};

fn profile_pda(wallet: &Pubkey) -> Pubkey {
    pda(&[PROFILE_SEED, wallet.as_ref()])
}

fn args(skills: &[&str], endpoint: &str, doc: Option<(&str, [u8; 32])>) -> ProfileFields {
    let (doc_url, doc_hash) = doc.map_or((String::new(), [0; 32]), |(u, h)| (u.to_owned(), h));
    ProfileFields {
        skills: skills.iter().map(|s| (*s).to_owned()).collect(),
        endpoint: endpoint.to_owned(),
        doc_url,
        doc_hash,
    }
}

fn create_ix(wallet: &Pubkey, profile: Pubkey, args: ProfileFields) -> Instruction {
    engine_ix(
        intent_engine::accounts::CreateProfile {
            wallet: *wallet,
            profile,
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::CreateProfile { args },
    )
}

fn update_ix(wallet: &Pubkey, profile: Pubkey, args: ProfileFields) -> Instruction {
    engine_ix(
        intent_engine::accounts::UpdateProfile {
            wallet: *wallet,
            profile,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::UpdateProfile { args },
    )
}

fn close_ix(wallet: &Pubkey, profile: Pubkey) -> Instruction {
    engine_ix(
        intent_engine::accounts::CloseProfile {
            wallet: *wallet,
            profile,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::CloseProfile {},
    )
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_end_matches('\0')
        .to_owned()
}

#[test]
fn a_wallet_publishes_its_skills_endpoint_and_document() -> TestResult {
    let mut env = Env::new()?;
    let agent = env.funded()?;
    let me = agent.pubkey();
    let doc = ("https://agent.example/profile.json", [9; 32]);
    let set = args(&["rust", "writing"], "https://agent.example/api", Some(doc));
    let meta = env.send(&agent, &[create_ix(&me, profile_pda(&me), set)], &[])?;
    let stored: Profile = load(&env.svm, &profile_pda(&me))?;
    assert_eq!(stored.wallet, me);
    assert_eq!(
        (stored.version, stored.doc_hash, stored.updated_at),
        (PROFILE_VERSION, [9; 32], env.now())
    );
    let skills: Vec<String> = stored
        .skills
        .iter()
        .map(|s| text(s))
        .filter(|s| !s.is_empty())
        .collect();
    assert_eq!(skills, ["rust", "writing"]);
    assert_eq!(text(&stored.endpoint), "https://agent.example/api");
    assert_eq!(text(&stored.doc_url), doc.0);
    let announced: Vec<_> = events::<ProfileSet>(&meta)
        .into_iter()
        .map(|e| (e.wallet, e.skills, e.endpoint))
        .collect();
    assert_eq!(
        announced,
        [(
            me,
            vec!["rust".to_owned(), "writing".to_owned()],
            "https://agent.example/api".to_owned()
        )]
    );
    Ok(())
}

#[test]
fn only_the_wallet_updates_or_closes_its_profile() -> TestResult {
    let mut env = Env::new()?;
    let agent = env.funded()?;
    let stranger = env.funded()?;
    let me = agent.pubkey();
    env.send(
        &agent,
        &[create_ix(
            &me,
            profile_pda(&me),
            args(&["rust"], "https://a.example", None),
        )],
        &[],
    )?;
    let hijack = update_ix(
        &stranger.pubkey(),
        profile_pda(&me),
        args(&["scam"], "https://evil.example", None),
    );
    assert!(env.send(&stranger, &[hijack], &[]).is_err());
    let close_other = close_ix(&stranger.pubkey(), profile_pda(&me));
    assert!(env.send(&stranger, &[close_other], &[]).is_err());
    env.send(
        &agent,
        &[update_ix(
            &me,
            profile_pda(&me),
            args(&["rust", "solana"], "https://b.example", None),
        )],
        &[],
    )?;
    let stored: Profile = load(&env.svm, &profile_pda(&me))?;
    assert_eq!(text(&stored.endpoint), "https://b.example");
    assert_eq!(text(stored.skills.get(1).ok_or("skill")?), "solana");
    let meta = env.send(&agent, &[close_ix(&me, profile_pda(&me))], &[])?;
    assert_eq!(events::<ProfileClosed>(&meta).len(), 1);
    assert!(!env.exists(&profile_pda(&me)));
    Ok(())
}

#[test]
fn a_malformed_profile_is_refused() -> TestResult {
    let mut env = Env::new()?;
    let agent = env.funded()?;
    let me = agent.pubkey();
    let nine: Vec<String> = (0..9).map(|i| format!("s{i}")).collect();
    let nine: Vec<&str> = nine.iter().map(String::as_str).collect();
    for bad in [
        args(&[], "https://a.example", None),
        args(&nine, "https://a.example", None),
        args(&["Rust"], "https://a.example", None),
        args(&["rust", "rust"], "https://a.example", None),
        args(&["rust"], "http://a.example", None),
        args(&["rust"], "", None),
        args(
            &["rust"],
            "https://a.example",
            Some(("https://a.example/p", [0; 32])),
        ),
        args(&["rust"], "https://a.example", Some(("", [5; 32]))),
    ] {
        assert_eq!(
            env.send(
                &agent,
                &[create_ix(&me, profile_pda(&me), bad.clone())],
                &[]
            )
            .err(),
            Some(engine_error_at(0, EngineError::ProfileInvalid)),
            "{:?} {:?}",
            bad.skills,
            bad.endpoint
        );
    }
    assert!(!env.exists(&profile_pda(&me)));
    let other = Keypair::new();
    let misplaced = create_ix(
        &me,
        profile_pda(&other.pubkey()),
        args(&["rust"], "https://a.example", None),
    );
    assert!(
        env.send(&agent, &[misplaced], &[]).is_err(),
        "a profile lives only at its own wallet's address"
    );
    Ok(())
}

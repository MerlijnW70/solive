use anchor_lang::prelude::Pubkey;
use intent_core::committee::{MAX_MEMBERS, MAX_THRESHOLD};
use intent_core::delivery::{FINGERPRINT_LEN, MAX_BLOB_URL};
use intent_core::roster::MAX_CLAIMANTS;
use intent_engine::state::{
    CLAIMS_SEED, CLAIM_LIST_SEED, DELIVERY_BOOK_SEED, REFUTATION_SEED, STANDBY_SEED,
};
use intent_engine::MAX_SPLIT_RECIPIENTS;
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    book_pda, bump_search_cost, claim_list_pda, claims_pda, commitment_of, committee_batch_ix,
    cu_gates, legacy_size, load, measure_shape, open_claims_listed_review_ix, quorum_mask,
    refutation_pda, refute_ix, reject_committee_digest, release_world_with, set_announce_fee_ix,
    sync_committee_keys_ix, test_blob, Announce, ClaimWorld, Delivery, ReleaseKind, ReleasePath,
    ReleasePlace, ReleaseTerms, Reject, Setup, Shape, TestResult, DELIVERED, DOMAIN,
    PACKET_DATA_SIZE, SALT, START_TS,
};

const STAKE: u64 = 50_000_000;
const KILL: u64 = 20_000_000;
const HOLD: u32 = 3_600;
const REVIEW: u32 = 172_800;
const EXPIRY: i64 = START_TS + 10 * 86_400;
const LINE: usize = 4;
const TERMS: ReleaseTerms = ReleaseTerms {
    funded: 1_000_000,
    escrow: 100_000,
    judge_fee: 1_000,
    spec: [0x6e; 32],
    weights: [6_000, 4_000],
    partner_bps: 0,
};

fn bump_of(seeds: &[&[u8]]) -> u64 {
    bump_search_cost(Pubkey::find_program_address(seeds, &intent_engine::ID).1)
}

fn landed(row: &svm_tests::Row) -> TestResult<u64> {
    Ok(row.landed.ok_or_else(|| format!("{row:?} did not land"))?.1)
}

fn largest_split(kind: ReleaseKind, members: usize, threshold: u8) -> TestResult<svm_tests::Row> {
    for n in (1..=MAX_SPLIT_RECIPIENTS).rev() {
        let row = measure_shape(
            PROGRAM,
            Shape {
                kind,
                recipients: n,
                members,
                threshold,
            },
        )?;
        if row.landed.is_some() {
            return Ok(row);
        }
    }
    Err(format!("no {kind:?} fits").into())
}

#[test]
fn the_largest_releases_that_fit_stay_within_their_measured_budgets() -> TestResult {
    let split = largest_split(ReleaseKind::Split, 0, 0)?;
    let split_committee = largest_split(ReleaseKind::SplitCommittee, 3, 2)?;
    let committee = measure_shape(
        PROGRAM,
        Shape {
            kind: ReleaseKind::Committee,
            recipients: 1,
            members: MAX_MEMBERS,
            threshold: MAX_THRESHOLD,
        },
    )?;
    cu_gates(&[
        (format!("fill_attested_split{CU_SUFFIX}"), landed(&split)?),
        (format!("fill_attested_committee{CU_SUFFIX}"), landed(&committee)?),
        (
            format!("fill_attested_split_committee{CU_SUFFIX}"),
            landed(&split_committee)?,
        ),
    ])
}

#[test]
fn a_held_claim_and_a_refute_at_the_largest_split_stay_within_their_budgets() -> TestResult {
    for n in (1..=MAX_SPLIT_RECIPIENTS).rev() {
        let last = n.saturating_sub(1);
        let mut r = release_world_with(
            PROGRAM,
            Shape {
                kind: ReleaseKind::Split,
                recipients: n,
                members: 0,
                threshold: 0,
            },
            Setup {
                copied: true,
                frozen: Some(last),
            },
        )?;
        if r.measure()?.landed.is_none() {
            continue;
        }
        let wallet = r.coauthors.get(last).ok_or("co-author")?.insecure_clone();
        let mint = r.market.input_mint;
        let to = r
            .env
            .create_token_account(&mint, &wallet.pubkey(), PROGRAM)?;
        let index = u8::try_from(last)?;
        let held = r.env.balance(&r.vault)?;
        let claim = r.claim_held_ix(index, &to)?;
        let claimed = r.env.send(&wallet, &[claim], &[])?;
        assert_eq!(r.env.balance(&to)?, held, "the held share reaches its wallet");
        let (author, earlier) = r.earlier.as_ref().ok_or("no earlier copy")?;
        let author = author.insecure_clone();
        let refute = refute_ix(
            &author.pubkey(),
            &r.delivery.announcement,
            &earlier.announcement,
            SALT,
            Some(r.claim()),
        );
        let refuted = r.env.send(&author, &[refute], &[])?;
        assert!(r.env.exists(&refutation_pda(&earlier.announcement)));
        let refutation_bump = bump_of(&[REFUTATION_SEED, earlier.announcement.as_ref()]);
        return cu_gates(&[
            (
                format!("claim_held{CU_SUFFIX}"),
                claimed.compute_units_consumed,
            ),
            (
                format!("refute_release{CU_SUFFIX}"),
                refuted
                    .compute_units_consumed
                    .saturating_sub(refutation_bump),
            ),
        ]);
    }
    Err("no split fits".into())
}

fn place(members: usize, threshold: u8) -> ReleasePlace {
    ReleasePlace {
        program: PROGRAM,
        members,
        threshold,
    }
}

fn claims_world(path: ReleasePath, members: usize, threshold: u8) -> TestResult<ClaimWorld> {
    ClaimWorld::on(&place(members, threshold), path, TERMS, EXPIRY)
}

fn opening_cost(w: &ClaimWorld, listed: bool) -> u64 {
    let intent = w.intent();
    let board = bump_of(&[CLAIMS_SEED, intent.as_ref()]);
    let book = bump_of(&[DELIVERY_BOOK_SEED, intent.as_ref()]);
    board
        .saturating_add(book)
        .saturating_add(list_cost(w, listed))
}

fn list_cost(w: &ClaimWorld, listed: bool) -> u64 {
    if listed {
        bump_of(&[CLAIM_LIST_SEED, w.intent().as_ref()])
    } else {
        0
    }
}

fn longest_list(w: &ClaimWorld, review: (u32, u64), tail: &[Pubkey]) -> TestResult<Vec<Pubkey>> {
    for n in (tail.len()..=MAX_CLAIMANTS).rev() {
        let mut workers: Vec<Pubkey> = (tail.len()..n).map(|_| Pubkey::new_unique()).collect();
        workers.extend_from_slice(tail);
        let ix = open_claims_listed_review_ix(
            &w.owner(),
            &w.intent(),
            (HOLD, STAKE),
            u8::try_from(n)?,
            &workers,
            review,
        );
        let signed = Instruction {
            accounts: ix
                .accounts
                .iter()
                .cloned()
                .chain(std::iter::once(
                    solana_instruction::AccountMeta::new_readonly(w.payer.pubkey(), true),
                ))
                .collect(),
            ..ix
        };
        if legacy_size(&w.payer.pubkey(), &[signed]) <= PACKET_DATA_SIZE {
            return Ok(workers);
        }
    }
    Err("no claimant list fits".into())
}

fn open_listed(
    w: &mut ClaimWorld,
    workers: &[Pubkey],
    review: (u32, u64),
) -> Result<TransactionMetadata, TransactionError> {
    let owner = w.release.trader.key.insecure_clone();
    let size = u8::try_from(workers.len()).unwrap_or(u8::MAX);
    let ix =
        open_claims_listed_review_ix(&w.owner(), &w.intent(), (HOLD, STAKE), size, workers, review);
    w.listed = true;
    w.send(&[ix], &[&owner])
}

#[test]
fn every_way_to_open_claims_stays_within_its_measured_budget() -> TestResult {
    let mut plain = claims_world(ReleasePath::Attested, 3, 2)?;
    let opened = plain.open(HOLD, STAKE, None)?;
    let plain_cu = opened
        .compute_units_consumed
        .saturating_sub(opening_cost(&plain, false));
    let mut reviewed = claims_world(ReleasePath::Attested, 3, 2)?;
    let opened = reviewed.open_review(HOLD, STAKE, REVIEW, KILL)?;
    let review_cu = opened
        .compute_units_consumed
        .saturating_sub(opening_cost(&reviewed, false));
    let mut listed = claims_world(ReleasePath::Attested, 3, 2)?;
    let workers = longest_list(&listed, (0, 0), &[])?;
    let opened = open_listed(&mut listed, &workers, (0, 0))?;
    let listed_cu = opened
        .compute_units_consumed
        .saturating_sub(opening_cost(&listed, true));
    let mut both = claims_world(ReleasePath::Attested, 3, 2)?;
    let workers = longest_list(&both, (REVIEW, KILL), &[])?;
    let opened = open_listed(&mut both, &workers, (REVIEW, KILL))?;
    let both_cu = opened
        .compute_units_consumed
        .saturating_sub(opening_cost(&both, true));
    let list: intent_engine::state::ClaimList =
        load(&both.release.env.svm, &claim_list_pda(&both.intent()))?;
    assert_eq!(usize::from(list.count), workers.len(), "the whole list rides one transaction");
    cu_gates(&[
        (format!("open_claims{CU_SUFFIX}"), plain_cu),
        (format!("open_claims_review{CU_SUFFIX}"), review_cu),
        (format!("open_claims_listed{CU_SUFFIX}"), listed_cu),
        (format!("open_claims_listed_review{CU_SUFFIX}"), both_cu),
    ])
}

#[test]
fn a_full_listed_line_claims_waits_advances_and_settles_within_budget() -> TestResult {
    let mut w = claims_world(ReleasePath::Attested, 3, 2)?;
    let line: Vec<Keypair> = (0..LINE).map(|_| Keypair::new()).collect();
    let holder = w.funded()?;
    for waiter in &line {
        w.release
            .env
            .svm
            .airdrop(&waiter.pubkey(), 1_000_000_000)
            .map_err(|f| format!("airdrop: {:?}", f.err))?;
    }
    let mut tail: Vec<Pubkey> = line.iter().map(Signer::pubkey).collect();
    tail.push(holder.pubkey());
    let workers = longest_list(&w, (0, 0), &tail)?;
    open_listed(&mut w, &workers, (0, 0))?;
    let claimed = w.claim(&holder, HOLD)?;
    let mut stood = None;
    for waiter in &line {
        let seq = w.board()?.tail;
        let meta = w.stand_by(waiter, HOLD)??;
        stood = Some(
            meta.compute_units_consumed
                .saturating_sub(bump_of(&[STANDBY_SEED, w.intent().as_ref(), &seq.to_le_bytes()])),
        );
    }
    let stood = stood.ok_or("nobody stood by")?;
    assert_eq!(w.window()?.len(), LINE, "the line window is full");
    let board = w.board()?;
    w.set_now(board.until.saturating_add(1));
    let advanced = w
        .advance()??
        .compute_units_consumed
        .saturating_sub(bump_of(&[
            STANDBY_SEED,
            w.intent().as_ref(),
            &board.head.to_le_bytes(),
        ]));
    assert_eq!(w.board()?.worker, line.first().ok_or("line")?.pubkey());
    w.set_now(EXPIRY);
    let settled = w
        .settle()??
        .compute_units_consumed
        .saturating_sub(list_cost(&w, true));
    assert!(!w.exists(&w.board_key()) && !w.exists(&w.list_key()));
    cu_gates(&[
        (
            format!("claim_job{CU_SUFFIX}"),
            claimed.compute_units_consumed,
        ),
        (format!("stand_by{CU_SUFFIX}"), stood),
        (format!("advance{CU_SUFFIX}"), advanced),
        (format!("settle_claims{CU_SUFFIX}"), settled),
    ])
}

fn committee_blob(w: &mut ClaimWorld, url: usize) -> TestResult<Vec<u8>> {
    let panel = w.release.panel()?.address;
    let stored: intent_engine::state::Committee = load(&w.release.env.svm, &panel)?;
    let fps: Vec<[u8; FINGERPRINT_LEN]> = stored
        .key_fps
        .iter()
        .take(usize::from(stored.count))
        .copied()
        .collect();
    let fill = w
        .release
        .env
        .svm
        .get_account(&book_pda(&w.intent()))
        .and_then(|a| a.data.get(72).copied())
        .unwrap_or(0);
    Ok(test_blob(stored.keys_mask, &fps, url, fill))
}

fn largest_announce(w: &mut ClaimWorld, worker: &Keypair) -> TestResult<Announce> {
    let intent = w.intent();
    let panel = w.release.panel()?.address;
    let fee_to = w.release.env.fee_recipient;
    for url in (1..=MAX_BLOB_URL).rev() {
        let a = Announce {
            commitment: commitment_of(&intent, &worker.pubkey(), &SALT, &DELIVERED),
            profile: false,
            committee: true,
            board: Some(claims_pda(&intent)),
            claim_list: w.listed.then(|| claim_list_pda(&intent)),
            fee_to: Some(fee_to),
            ..Announce::new(worker.pubkey(), intent, panel, committee_blob(w, url)?)
        };
        if legacy_size(&worker.pubkey(), &[a.ix()]) <= PACKET_DATA_SIZE {
            return Ok(a);
        }
    }
    Err("no announcement fits".into())
}

#[test]
fn the_largest_committee_announcement_and_its_rejection_stay_within_budget() -> TestResult {
    let mut w = claims_world(ReleasePath::Committee, MAX_MEMBERS, MAX_THRESHOLD)?;
    let admin = w.release.env.authority.insecure_clone();
    let fee = set_announce_fee_ix(&admin.pubkey(), 5_000);
    w.release.env.send(&admin, &[fee], &[])?;
    let panel = w.release.panel()?.address;
    let profiles: Vec<Pubkey> = w
        .release
        .panel()?
        .keys
        .iter()
        .map(svm_tests::profile_pda)
        .collect();
    let syncer = w.funded()?;
    w.release
        .env
        .send(&syncer, &[sync_committee_keys_ix(&panel, &profiles)], &[])?;
    let holder = w.funded()?;
    let workers = longest_list(&w, (REVIEW, KILL), &[holder.pubkey()])?;
    open_listed(&mut w, &workers, (REVIEW, KILL))?;
    w.claim(&holder, HOLD)?;
    let a = largest_announce(&mut w, &holder)?;
    let intent = w.intent();
    let announced = w.release.env.send(&holder, &[a.ix()], &[])?;
    let made: intent_engine::state::Announcement = load(&w.release.env.svm, &a.address())?;
    let announce_cu = announced
        .compute_units_consumed
        .saturating_sub(bump_search_cost(
            Pubkey::find_program_address(
                &[
                    intent_engine::state::ANNOUNCEMENT_SEED,
                    intent.as_ref(),
                    holder.pubkey().as_ref(),
                    &svm_tests::sha256(&a.blob),
                ],
                &intent_engine::ID,
            )
            .1,
        ))
        .saturating_sub(bump_of(&[
            intent_engine::state::DELIVERY_BOOK_SEED,
            intent.as_ref(),
        ]));
    let delivery = Delivery {
        announcement: a.address(),
        seq: made.seq,
        opening: intent_engine::Opening {
            delivered: DELIVERED,
            salt: SALT,
        },
    };
    let picks: Vec<usize> = (0..usize::from(MAX_THRESHOLD)).collect();
    let digest = reject_committee_digest(DOMAIN, &intent, &delivery.announcement, delivery.seq);
    let keys = w.release.panel()?.keys.clone();
    let batch = committee_batch_ix(&keys, &w.release.panel()?.signers(&picks), &digest)?;
    let reject = Reject {
        committee: true,
        board: Some(w.board_key()),
        stake_to: Some(holder.pubkey()),
        mask: quorum_mask(MAX_THRESHOLD),
        ..Reject::new(intent, delivery.announcement, panel)
    }
    .ix();
    let relayer = w.funded()?;
    let ixs = [batch, reject];
    let rejected = if legacy_size(&relayer.pubkey(), &ixs) <= PACKET_DATA_SIZE {
        w.release.env.send(&relayer, &ixs, &[])?
    } else {
        w.release.env.send_tabled(&relayer, &ixs, &[])?
    };
    assert_eq!(w.board()?.worker, Pubkey::default(), "the rejection frees the job");
    cu_gates(&[
        (format!("announce_delivery{CU_SUFFIX}"), announce_cu),
        (
            format!("reject_delivery{CU_SUFFIX}"),
            rejected.compute_units_consumed,
        ),
    ])
}

use anchor_lang::prelude::Pubkey;
use solana_signer::Signer;
use svm_tests::{
    book_pda, open_claims_review_ix, ClaimWorld, ReleasePath, TestResult, FAIR_EXPIRY, FAIR_REVIEW,
    FAIR_STAKE, FAIR_TERMS,
};

fn announced() -> TestResult<(ClaimWorld, Pubkey)> {
    let mut w = ClaimWorld::expiring(ReleasePath::Attested, FAIR_TERMS, FAIR_EXPIRY)?;
    let worker = w.release.workers[0].insecure_clone();
    let d = w.announce(&worker)?;
    Ok((w, d.announcement))
}

fn cancel_with(w: &mut ClaimWorld, book: Pubkey) -> bool {
    let owner = w.release.trader.key.insecure_clone();
    let mut ix = w.release.env.cancel_ix(
        &owner.pubkey(),
        &w.release.market,
        0,
        &w.release.trader.input,
    );
    let canonical = book_pda(&w.intent());
    for m in ix.accounts.iter_mut() {
        if m.pubkey == canonical {
            m.pubkey = book;
        }
    }
    w.send(&[ix], &[&owner]).is_ok()
}

#[test]
fn cancel_refuses_every_book_account_but_the_canonical_one() -> TestResult {
    let (mut w, ann) = announced()?;
    let intent = w.intent();
    let vault = w.release.vault();
    let owner = w.owner();
    for fake in [Pubkey::new_unique(), intent, ann, vault, owner] {
        assert!(
            !cancel_with(&mut w, fake),
            "fake book {fake} skipped the notice"
        );
    }
    assert!(!cancel_with(&mut w, book_pda(&intent)));
    assert!(w.escrow_open()?);
    Ok(())
}

#[test]
fn open_claims_refuses_a_substitute_book_after_an_announcement() -> TestResult {
    let (mut w, ann) = announced()?;
    let owner = w.release.trader.key.insecure_clone();
    let canonical = book_pda(&w.intent());
    for fake in [Pubkey::new_unique(), ann, canonical] {
        let mut ix =
            open_claims_review_ix(&owner.pubkey(), &w.intent(), FAIR_REVIEW, FAIR_STAKE, 0, 0);
        for m in ix.accounts.iter_mut() {
            if m.pubkey == canonical {
                m.pubkey = fake;
            }
        }
        assert!(
            w.send(&[ix], &[&owner]).is_err(),
            "book {fake} let claims open"
        );
    }
    Ok(())
}

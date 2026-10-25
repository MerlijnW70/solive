use anchor_lang::prelude::Pubkey;
use intent_core::kinds::swap_exact_in;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    advance_ix, agent_lane, attestation_message, attestation_proof_message, canonical_refund,
    claim_job_ix, claims_pda, close_delivery_book_ix, close_legacy_ix, committee_batch_ix,
    config_pda, cosign_batch_ix, cosign_ix, create_committee_ix, create_profile_ix, drop_claim_ix,
    ed25519_ix, extend_claimants_ix, intent_pda, judged_spec, leave_ix, list_claimants_ix,
    mandate_pda, mandate_terms, migrate_ix, open_claims_ix, open_claims_listed_ix, proof_digest,
    refute_ix, set_announce_fee_ix, settle_claims_ix, sorted_members, split_commit, split_digest,
    stand_by_ix, standby_pda, swap_spec, sync_committee_keys_ix, update_profile_ix, user_pda,
    vault_pda, CommitteeFill, Delivery, Env, IntentSpec, Market, Panel, Solver, TestResult, Trader,
    DOMAIN, START_TS,
};

use super::{
    announce_ix, close_announcement, close_profile_ix, init_user_ix, intent_of, profile_of,
    put_byte, set_caps_required_ix, set_committee_floor_ix, set_mint_cap_ix, Ready, ESCROW, FUNDED,
    HOUR, SPEC, STAKE,
};

pub struct Base {
    pub env: Env,
    pub market: Market,
    pub trader: Trader,
}

impl Base {
    pub fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    pub fn intent(&self, nonce: u64) -> Pubkey {
        intent_of(&self.trader, nonce)
    }

    pub fn owner_key(&self) -> Keypair {
        self.trader.key.insecure_clone()
    }

    pub fn ready(
        self,
        ix: solana_instruction::Instruction,
        keys: Vec<Keypair>,
    ) -> TestResult<Ready> {
        let owner = self.owner();
        let input = self.trader.input;
        let receiver = self.trader.receiver;
        let input_mint = self.market.input_mint;
        let output_mint = self.market.output_mint;
        let mut keys = keys;
        if !keys.iter().any(|k| k.pubkey() == owner) {
            keys.push(self.trader.key.insecure_clone());
        }
        Ok(Ready::new(self.env, ix, keys)?
            .named("owner", owner)
            .named("user", user_pda(&owner))
            .named("input", input)
            .named("receiver", receiver)
            .named("input_mint", input_mint)
            .named("output_mint", output_mint)
            .named("intent", intent_pda(&owner, 0))
            .named("vault", vault_pda(&intent_pda(&owner, 0)))
            .named("other_vault", vault_pda(&intent_pda(&owner, 1))))
    }
}

pub fn base() -> TestResult<Base> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    Ok(Base {
        env,
        market,
        trader,
    })
}

pub fn swap_base() -> TestResult<Base> {
    let mut b = base()?;
    b.env
        .create_intent(&b.trader, &b.market, &swap_spec(0, ESCROW)?)?;
    b.env
        .create_intent(&b.trader, &b.market, &swap_spec(1, ESCROW)?)?;
    Ok(b)
}

pub fn proof_spec(nonce: u64, attestor: &Pubkey, spec_hash: [u8; 32]) -> TestResult<IntentSpec> {
    judged_spec(nonce, ESCROW, attestor, spec_hash, 0)
}

pub fn proof_base(spec_hash: [u8; 32]) -> TestResult<(Base, Keypair)> {
    let mut b = base()?;
    let judge = b.env.funded()?;
    b.env.create_intent(
        &b.trader,
        &b.market,
        &proof_spec(0, &judge.pubkey(), spec_hash)?,
    )?;
    b.env.create_intent(
        &b.trader,
        &b.market,
        &proof_spec(1, &judge.pubkey(), spec_hash)?,
    )?;
    Ok((b, judge))
}

pub fn admin_ready(
    make: impl Fn(&Env, &Pubkey) -> solana_instruction::Instruction,
) -> TestResult<Ready> {
    let b = base()?;
    let admin = b.env.authority.insecure_clone();
    let ix = make(&b.env, &admin.pubkey());
    Ok(b.ready(ix, vec![admin.insecure_clone()])?
        .named("admin", admin.pubkey()))
}

pub fn init_config() -> TestResult<Ready> {
    let env = Env::new()?;
    let authority = env.authority.insecure_clone();
    let ix = env.init_config_ix(&authority.pubkey(), env.settings());
    Ok(Ready::new(env, ix, vec![authority.insecure_clone()])?
        .named("admin", authority.pubkey())
        .named("config", config_pda())
        .named("program_data", svm_tests::program_data_address()))
}

pub fn update_config() -> TestResult<Ready> {
    admin_ready(|env, admin| env.update_config_ix(admin, env.settings()))
}

pub fn update_economics() -> TestResult<Ready> {
    admin_ready(|env, admin| {
        env.economics_ix(
            admin,
            intent_engine::Economics {
                kind_fee_mask: 0,
                kind_fee_bps: [0; 4],
                partner_cut_bps: 0,
                crank_bounty: 0,
                create_fee: 0,
            },
        )
    })
}

pub fn propose_admin() -> TestResult<Ready> {
    admin_ready(|env, admin| env.propose_admin_ix(admin, Pubkey::new_unique()))
}

pub fn lower_pause() -> TestResult<Ready> {
    admin_ready(|env, admin| env.lower_pause_ix(admin, 1))
}

pub fn set_caps_required() -> TestResult<Ready> {
    admin_ready(|_, admin| set_caps_required_ix(admin, false))
}

pub fn set_announce_fee() -> TestResult<Ready> {
    admin_ready(|_, admin| set_announce_fee_ix(admin, 1))
}

pub fn set_committee_floor() -> TestResult<Ready> {
    let b = base()?;
    let admin = b.env.authority.insecure_clone();
    let ix = set_committee_floor_ix(&admin.pubkey(), &b.market.input_mint, 1_000);
    Ok(b.ready(ix, vec![admin.insecure_clone()])?
        .named("admin", admin.pubkey()))
}

pub fn set_mint_cap() -> TestResult<Ready> {
    let mut b = base()?;
    let admin = b.env.authority.insecure_clone();
    let payer = b.env.funded()?;
    let ix = set_mint_cap_ix(&admin.pubkey(), &payer.pubkey(), &b.market.input_mint);
    let cap = super::mint_cap_pda(&b.market.input_mint);
    Ok(
        b.ready(ix, vec![admin.insecure_clone(), payer.insecure_clone()])?
            .named("admin", admin.pubkey())
            .named("cap_payer", payer.pubkey())
            .named("mint_cap", cap),
    )
}

pub fn raise_pause() -> TestResult<Ready> {
    let b = base()?;
    let guardian = b.env.guardian.insecure_clone();
    let ix = b.env.raise_pause_ix(&guardian.pubkey(), 1);
    Ok(b.ready(ix, vec![guardian.insecure_clone()])?
        .named("guardian", guardian.pubkey()))
}

pub fn accept_admin() -> TestResult<Ready> {
    let mut b = base()?;
    let admin = b.env.authority.insecure_clone();
    let nominee = b.env.funded()?;
    let propose = b.env.propose_admin_ix(&admin.pubkey(), nominee.pubkey());
    b.env.send(&admin, &[propose], &[])?;
    let ix = b.env.accept_admin_ix(&nominee.pubkey());
    Ok(b.ready(ix, vec![nominee.insecure_clone()])?
        .named("nominee", nominee.pubkey()))
}

pub fn init_user() -> TestResult<Ready> {
    let mut b = base()?;
    let fresh = b.env.funded()?;
    let ix = init_user_ix(&fresh.pubkey(), &user_pda(&fresh.pubkey()));
    Ok(b.ready(ix, vec![fresh.insecure_clone()])?
        .named("fresh", fresh.pubkey())
        .named("fresh_user", user_pda(&fresh.pubkey())))
}

pub fn advance_nonce() -> TestResult<Ready> {
    let b = base()?;
    let ix = b.env.advance_ix(&b.owner(), 5);
    let key = b.owner_key();
    b.ready(ix, vec![key])
}

pub fn advance_epoch() -> TestResult<Ready> {
    let b = base()?;
    let ix = b.env.advance_epoch_ix(&b.owner(), 1);
    let key = b.owner_key();
    b.ready(ix, vec![key])
}

pub fn create_intent() -> TestResult<Ready> {
    let b = base()?;
    let ix = b
        .env
        .create_intent_ix(&b.trader, &b.market, &swap_spec(0, ESCROW)?);
    let key = b.owner_key();
    b.ready(ix, vec![key])
}

pub fn create_intent_signed() -> TestResult<Ready> {
    let mut b = base()?;
    b.env.approve_delegate(&b.trader, &b.market, ESCROW)?;
    let relayer = b.env.funded()?;
    let spec = swap_spec(0, ESCROW)?;
    let submit_by = START_TS.saturating_add(600);
    let message = b
        .env
        .signed_message(&b.trader, &b.market, &spec, DOMAIN, submit_by);
    let ix = b
        .env
        .create_signed_ix(&relayer.pubkey(), &b.trader, &b.market, &spec, submit_by);
    let sig = ed25519_ix(&b.trader.key, &message);
    let mut r = b
        .ready(ix, vec![relayer.insecure_clone()])?
        .named("relayer", relayer.pubkey());
    r.before.push(sig);
    Ok(r)
}

pub fn mandate_base() -> TestResult<(Base, Keypair)> {
    let mut b = base()?;
    let agent = b.env.funded()?;
    let ix = b.env.create_mandate_ix(
        &b.trader,
        &b.market,
        mandate_terms(agent.pubkey(), START_TS.saturating_add(86_400)),
    );
    let owner = b.owner_key();
    b.env.send(&owner, &[ix], &[])?;
    Ok((b, agent))
}

pub fn create_mandate() -> TestResult<Ready> {
    let mut b = base()?;
    let agent = b.env.funded()?;
    let ix = b.env.create_mandate_ix(
        &b.trader,
        &b.market,
        mandate_terms(agent.pubkey(), START_TS.saturating_add(86_400)),
    );
    let key = b.owner_key();
    let mandate = mandate_pda(&b.owner(), &agent.pubkey(), 0);
    Ok(b.ready(ix, vec![key])?
        .named("mandate", mandate)
        .named("agent", agent.pubkey()))
}

pub fn revoke_mandate() -> TestResult<Ready> {
    let (b, agent) = mandate_base()?;
    let mandate = mandate_pda(&b.owner(), &agent.pubkey(), 0);
    let ix = b.env.revoke_mandate_ix(&b.owner(), mandate);
    let key = b.owner_key();
    Ok(b.ready(ix, vec![key])?
        .named("mandate", mandate)
        .named("agent", agent.pubkey()))
}

pub fn agent_spec(nonce: u64) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        params: swap_exact_in::Params {
            amount_in: 10,
            min_out: 5,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(nonce, 10)?
    })
}

pub fn create_intent_by_agent() -> TestResult<Ready> {
    let (mut b, agent) = mandate_base()?;
    b.env.approve_delegate(&b.trader, &b.market, ESCROW)?;
    let mandate = mandate_pda(&b.owner(), &agent.pubkey(), 0);
    let ix = b.env.agent_intent_ix(
        &agent.pubkey(),
        mandate,
        &b.trader,
        &b.market,
        &agent_spec(agent_lane(1, 0))?,
    );
    Ok(b.ready(ix, vec![agent.insecure_clone()])?
        .named("mandate", mandate)
        .named("agent", agent.pubkey()))
}

pub fn fill_intent() -> TestResult<Ready> {
    let mut b = swap_base()?;
    let solver = b.env.solver(&b.market, 1_000)?;
    let fee_to = b.env.fee_account(&b.market)?;
    let ix = b.env.fill_ix(
        &solver,
        &b.owner(),
        &b.market,
        0,
        &b.trader.receiver,
        Some(&fee_to),
        1_000,
    );
    Ok(b.ready(ix, vec![solver.key.insecure_clone()])?
        .named("solver", solver.key.pubkey())
        .named("solver_output", solver.output)
        .named("solver_input", solver.input)
        .named("fee_to", fee_to))
}

pub struct Flash {
    pub begin: solana_instruction::Instruction,
    pub end: solana_instruction::Instruction,
}

pub fn flash_base() -> TestResult<(Base, Solver, Solver, Pubkey, Flash)> {
    let mut b = swap_base()?;
    let solver = b.env.solver(&b.market, 0)?;
    let closer = b.env.solver(&b.market, 1_000)?;
    let fee_to = b.env.fee_account(&b.market)?;
    let begin = b.env.begin_fill_ix(
        &solver.key.pubkey(),
        &b.owner(),
        &b.market,
        0,
        &solver.input,
        Some(&fee_to),
        1,
    );
    let end = b.env.end_fill_ix(
        &closer.key.pubkey(),
        &b.owner(),
        &b.market,
        0,
        &b.trader.receiver,
        &closer.output,
        1_000,
    );
    Ok((b, solver, closer, fee_to, Flash { begin, end }))
}

pub fn flash_ready(
    b: Base,
    solver: Solver,
    closer: Solver,
    fee_to: Pubkey,
    ix: solana_instruction::Instruction,
) -> TestResult<Ready> {
    Ok(b.ready(
        ix,
        vec![solver.key.insecure_clone(), closer.key.insecure_clone()],
    )?
    .named("solver", solver.key.pubkey())
    .named("closer", closer.key.pubkey())
    .named("solver_output", closer.output)
    .named("solver_input", solver.input)
    .named("fee_to", fee_to))
}

pub fn begin_fill() -> TestResult<Ready> {
    let (b, solver, closer, fee_to, flash) = flash_base()?;
    let mut r = flash_ready(b, solver, closer, fee_to, flash.begin)?;
    r.after.push(flash.end);
    Ok(r)
}

pub fn end_fill() -> TestResult<Ready> {
    let (b, solver, closer, fee_to, flash) = flash_base()?;
    let mut r = flash_ready(b, solver, closer, fee_to, flash.end)?;
    r.before.push(flash.begin);
    Ok(r)
}

pub fn cancel_intent() -> TestResult<Ready> {
    let b = swap_base()?;
    let ix = b.env.cancel_ix(&b.owner(), &b.market, 0, &b.trader.input);
    let key = b.owner_key();
    b.ready(ix, vec![key])
}

pub fn expire_intent() -> TestResult<Ready> {
    let mut b = swap_base()?;
    let expires = b.env.intent(&b.owner(), 0)?.expires_at;
    b.env.set_now(expires);
    let cranker = b.env.funded()?;
    let refund = canonical_refund(&b.owner(), &b.market);
    let ix = b
        .env
        .expire_ix(&cranker.pubkey(), &b.owner(), &b.market, 0, &refund);
    Ok(b.ready(ix, vec![cranker.insecure_clone()])?
        .named("cranker", cranker.pubkey()))
}

pub fn close_intent() -> TestResult<Ready> {
    let mut b = swap_base()?;
    let owner = b.owner_key();
    let cancel = b.env.cancel_ix(&b.owner(), &b.market, 0, &b.trader.input);
    b.env.send(&owner, &[cancel], &[])?;
    let cranker = b.env.funded()?;
    let ix = b
        .env
        .close_ix_by(&cranker.pubkey(), &b.owner(), &b.market, 0, &b.trader.input);
    Ok(b.ready(ix, vec![cranker.insecure_clone()])?
        .named("cranker", cranker.pubkey()))
}

pub fn fill_attested() -> TestResult<Ready> {
    let (mut b, judge) = proof_base([0; 32])?;
    let solver = b.env.solver(&b.market, 0)?;
    let fee_to = b.env.fee_account(&b.market)?;
    let message = attestation_message(
        DOMAIN,
        &judge.pubkey(),
        &b.intent(0),
        &solver.input,
        ESCROW,
        1,
    );
    let ix = b.env.fill_attested_ix(
        &solver.key.pubkey(),
        &b.owner(),
        &b.market,
        0,
        &solver.input,
        Some(&fee_to),
        1,
    );
    let mut r = b
        .ready(ix, vec![solver.key.insecure_clone()])?
        .named("solver", solver.key.pubkey())
        .named("payee", solver.input)
        .named("judge", judge.pubkey())
        .named("fee_to", fee_to);
    r.before.push(ed25519_ix(&judge, &message));
    Ok(r)
}

pub struct Team {
    pub coauthors: Vec<Keypair>,
    pub recipients: Vec<Pubkey>,
    pub weights: Vec<u16>,
}

pub fn team(env: &mut Env, market: &Market) -> TestResult<Team> {
    let coauthors = vec![env.funded()?, env.funded()?];
    let recipients: Vec<Pubkey> = coauthors.iter().map(Signer::pubkey).collect();
    for r in &recipients {
        env.create_ata(r, &market.input_mint, market.input_program)?;
    }
    Ok(Team {
        coauthors,
        recipients,
        weights: vec![6_000, 4_000],
    })
}

pub fn fill_attested_split() -> TestResult<Ready> {
    let (mut b, judge) = proof_base(SPEC)?;
    let solver = b.env.solver(&b.market, 0)?;
    let fee_to = b.env.fee_account(&b.market)?;
    let t = team(&mut b.env, &b.market)?;
    let first = t.coauthors.first().ok_or("coauthor")?.insecure_clone();
    let intent = b.intent(0);
    let delivery = b.env.announce_for(&first, &intent)?;
    let digest = split_digest(
        DOMAIN,
        &intent,
        ESCROW,
        1,
        SPEC,
        split_commit(&t.recipients, &t.weights),
        &delivery,
    );
    let signers: Vec<&Keypair> = t.coauthors.iter().chain(std::iter::once(&judge)).collect();
    let batch = cosign_batch_ix(&signers, &digest)?;
    let market = super::market_of(&b.market);
    let ix = b.env.fill_attested_split_ix(
        &solver.key.pubkey(),
        &b.owner(),
        &b.market,
        0,
        &t.recipients,
        &t.weights,
        Some(&fee_to),
        1,
    );
    let mut r = b
        .ready(ix, vec![solver.key.insecure_clone()])?
        .named("solver", solver.key.pubkey())
        .named("judge", judge.pubkey())
        .named("announcement", delivery.announcement)
        .named("fee_to", fee_to)
        .named(
            "recipient0",
            canonical_refund(t.recipients.first().ok_or("recipient")?, &market),
        )
        .named(
            "recipient1",
            canonical_refund(t.recipients.get(1).ok_or("recipient")?, &market),
        );
    r.before.push(batch);
    Ok(r)
}

pub fn panel_base(size: usize, threshold: u8) -> TestResult<(Base, Panel)> {
    let mut b = base()?;
    let panel = b.env.convene(size, threshold)?;
    b.env
        .create_intent(&b.trader, &b.market, &proof_spec(0, &panel.address, SPEC)?)?;
    b.env
        .create_intent(&b.trader, &b.market, &proof_spec(1, &panel.address, SPEC)?)?;
    Ok((b, panel))
}

pub fn fill_attested_committee() -> TestResult<Ready> {
    let (mut b, panel) = panel_base(3, 2)?;
    let solver = b.env.solver(&b.market, 0)?;
    let fee_to = b.env.fee_account(&b.market)?;
    let intent = b.intent(0);
    let delivery: Delivery = b.env.announce_for(&solver.key, &intent)?;
    let digest = proof_digest(DOMAIN, &intent, &solver.input, ESCROW, 1, SPEC, &delivery);
    let batch = committee_batch_ix(&panel.keys, &panel.signers(&[0, 1]), &digest)?;
    let owner = b.owner();
    let ix = b.env.fill_attested_committee_ix(
        &CommitteeFill {
            solver: &solver.key.pubkey(),
            owner: &owner,
            market: &b.market,
            nonce: 0,
            fee_to: Some(&fee_to),
            committee: &panel.address,
            signers: 0b011,
            result: 1,
        },
        &solver.input,
    );
    let mut r = b
        .ready(ix, vec![solver.key.insecure_clone()])?
        .named("solver", solver.key.pubkey())
        .named("committee", panel.address)
        .named("announcement", delivery.announcement)
        .named("fee_to", fee_to);
    r.before.push(batch);
    Ok(r)
}

pub fn fill_attested_split_committee() -> TestResult<Ready> {
    let (mut b, panel) = panel_base(3, 2)?;
    let solver = b.env.solver(&b.market, 0)?;
    let fee_to = b.env.fee_account(&b.market)?;
    let t = team(&mut b.env, &b.market)?;
    let first = t.coauthors.first().ok_or("coauthor")?.insecure_clone();
    let intent = b.intent(0);
    let delivery = b.env.announce_for(&first, &intent)?;
    let digest = split_digest(
        DOMAIN,
        &intent,
        ESCROW,
        1,
        SPEC,
        split_commit(&t.recipients, &t.weights),
        &delivery,
    );
    let listed: Vec<Pubkey> = t
        .recipients
        .iter()
        .chain(panel.keys.iter())
        .copied()
        .collect();
    let signers: Vec<&Keypair> = t.coauthors.iter().chain(panel.signers(&[0, 1])).collect();
    let batch = cosign_ix(&listed, &signers, &digest)?;
    let owner = b.owner();
    let market = super::market_of(&b.market);
    let ix = b.env.fill_attested_split_committee_ix(
        &CommitteeFill {
            solver: &solver.key.pubkey(),
            owner: &owner,
            market: &b.market,
            nonce: 0,
            fee_to: Some(&fee_to),
            committee: &panel.address,
            signers: 0b011,
            result: 1,
        },
        &t.recipients,
        &t.weights,
    );
    let mut r = b
        .ready(ix, vec![solver.key.insecure_clone()])?
        .named("solver", solver.key.pubkey())
        .named("committee", panel.address)
        .named("announcement", delivery.announcement)
        .named("fee_to", fee_to)
        .named(
            "recipient0",
            canonical_refund(t.recipients.first().ok_or("recipient")?, &market),
        )
        .named(
            "recipient1",
            canonical_refund(t.recipients.get(1).ok_or("recipient")?, &market),
        );
    r.before.push(batch);
    Ok(r)
}

pub fn create_committee() -> TestResult<Ready> {
    let mut b = base()?;
    let payer = b.env.funded()?;
    let members = sorted_members(3);
    let keys: Vec<Pubkey> = members.iter().map(Signer::pubkey).collect();
    let (ix, address) = create_committee_ix(&payer.pubkey(), &keys, 2, &Pubkey::new_unique())?;
    Ok(b.ready(ix, vec![payer.insecure_clone()])?
        .named("committee_payer", payer.pubkey())
        .named("committee", address))
}

pub fn sync_committee_keys() -> TestResult<Ready> {
    let (b, panel) = panel_base(3, 2)?;
    let profiles: Vec<Pubkey> = panel.keys.iter().map(profile_of).collect();
    let ix = sync_committee_keys_ix(&panel.address, &profiles);
    Ok(b.ready(ix, Vec::new())?.named("committee", panel.address))
}

pub fn claims_base() -> TestResult<(Base, Keypair)> {
    let (mut b, judge) = proof_base(SPEC)?;
    let owner = b.owner_key();
    let open = open_claims_ix(&b.owner(), &b.intent(0), HOUR, STAKE);
    b.env.send(&owner, &[open], &[])?;
    Ok((b, judge))
}

pub fn held_base() -> TestResult<(Base, Keypair)> {
    let (mut b, _) = claims_base()?;
    let worker = b.env.funded()?;
    let claim = claim_job_ix(&worker.pubkey(), &b.intent(0), &b.owner(), 600);
    b.env.send(&worker, &[claim], &[])?;
    Ok((b, worker))
}

pub fn waiting_base() -> TestResult<(Base, Keypair, Keypair)> {
    let (mut b, holder) = held_base()?;
    let waiter = b.env.funded()?;
    let join = stand_by_ix(&waiter.pubkey(), &b.intent(0), 0, 600);
    b.env.send(&waiter, &[join], &[])?;
    Ok((b, holder, waiter))
}

pub fn open_claims() -> TestResult<Ready> {
    let (b, _) = proof_base(SPEC)?;
    let ix = open_claims_ix(&b.owner(), &b.intent(0), HOUR, STAKE);
    let key = b.owner_key();
    let board = claims_pda(&b.intent(0));
    Ok(b.ready(ix, vec![key])?.named("board", board))
}

pub fn open_claims_listed() -> TestResult<Ready> {
    let (b, _) = proof_base(SPEC)?;
    let listed = [Pubkey::new_unique(), Pubkey::new_unique()];
    let ix = open_claims_listed_ix(&b.owner(), &b.intent(0), HOUR, STAKE, 2, &listed);
    let key = b.owner_key();
    let board = claims_pda(&b.intent(0));
    Ok(b.ready(ix, vec![key])?.named("board", board))
}

pub fn list_claimants() -> TestResult<Ready> {
    let (b, _) = claims_base()?;
    let ix = list_claimants_ix(&b.owner(), &b.intent(0), 2, &[Pubkey::new_unique()]);
    let key = b.owner_key();
    let board = claims_pda(&b.intent(0));
    let list = svm_tests::claim_list_pda(&b.intent(0));
    Ok(b.ready(ix, vec![key])?
        .named("board", board)
        .named("list", list))
}

pub fn extend_claimants() -> TestResult<Ready> {
    let (mut b, _) = proof_base(SPEC)?;
    let owner = b.owner_key();
    let open = open_claims_listed_ix(
        &b.owner(),
        &b.intent(0),
        HOUR,
        STAKE,
        2,
        &[Pubkey::new_unique()],
    );
    b.env.send(&owner, &[open], &[])?;
    let ix = extend_claimants_ix(&b.owner(), &b.intent(0), &[Pubkey::new_unique()]);
    b.ready(ix, vec![owner])
}

pub fn claim_job() -> TestResult<Ready> {
    let (mut b, _) = claims_base()?;
    let worker = b.env.funded()?;
    let ix = claim_job_ix(&worker.pubkey(), &b.intent(0), &b.owner(), 600);
    let board = claims_pda(&b.intent(0));
    Ok(b.ready(ix, vec![worker.insecure_clone()])?
        .named("worker", worker.pubkey())
        .named("board", board))
}

pub fn drop_claim() -> TestResult<Ready> {
    let (b, worker) = held_base()?;
    let ix = drop_claim_ix(&worker.pubkey(), &b.intent(0));
    let board = claims_pda(&b.intent(0));
    Ok(b.ready(ix, vec![worker.insecure_clone()])?
        .named("worker", worker.pubkey())
        .named("board", board))
}

pub fn stand_by() -> TestResult<Ready> {
    let (mut b, _) = held_base()?;
    let waiter = b.env.funded()?;
    let ix = stand_by_ix(&waiter.pubkey(), &b.intent(0), 0, 600);
    let board = claims_pda(&b.intent(0));
    let entry = standby_pda(&b.intent(0), 0);
    Ok(b.ready(ix, vec![waiter.insecure_clone()])?
        .named("worker", waiter.pubkey())
        .named("board", board)
        .named("entry", entry))
}

pub fn advance() -> TestResult<Ready> {
    let (mut b, _, waiter) = waiting_base()?;
    let now = b.env.now();
    b.env.set_now(now.saturating_add(600));
    let entry = standby_pda(&b.intent(0), 0);
    let ix = advance_ix(&b.intent(0), &b.owner(), &[entry], Some(&waiter.pubkey()));
    let board = claims_pda(&b.intent(0));
    Ok(b.ready(ix, Vec::new())?
        .named("worker", waiter.pubkey())
        .named("board", board)
        .named("entry", entry))
}

pub fn leave() -> TestResult<Ready> {
    let (b, _, waiter) = waiting_base()?;
    let ix = leave_ix(&waiter.pubkey(), &b.intent(0), 0, &waiter.pubkey());
    let entry = standby_pda(&b.intent(0), 0);
    Ok(b.ready(ix, vec![waiter.insecure_clone()])?
        .named("worker", waiter.pubkey())
        .named("entry", entry))
}

pub fn settle_claims() -> TestResult<Ready> {
    let (mut b, worker) = held_base()?;
    let owner = b.owner_key();
    b.env.claims = Some(claims_pda(&b.intent(0)));
    b.env.stake_to = Some(worker.pubkey());
    let cancel = b.env.cancel_ix(&b.owner(), &b.market, 0, &b.trader.input);
    b.env.send(&owner, &[cancel], &[])?;
    b.env.claims = None;
    b.env.stake_to = None;
    let ix = settle_claims_ix(&b.intent(0), &b.owner(), None);
    let board = claims_pda(&b.intent(0));
    Ok(b.ready(ix, Vec::new())?
        .named("worker", worker.pubkey())
        .named("board", board))
}

pub fn announce_delivery() -> TestResult<Ready> {
    let (mut b, judge) = proof_base(SPEC)?;
    let worker = b.env.funded()?;
    let intent = b.intent(0);
    let a = announce_ix(&mut b.env, &worker.pubkey(), &intent, &judge.pubkey())?;
    let address = a.address();
    let book = svm_tests::book_pda(&b.intent(0));
    Ok(b.ready(a.ix(), vec![worker.insecure_clone()])?
        .named("worker", worker.pubkey())
        .named("judge", judge.pubkey())
        .named("announcement", address)
        .named("book", book))
}

pub fn announced_base() -> TestResult<(Base, Keypair, Keypair, Delivery)> {
    let (mut b, judge) = proof_base(SPEC)?;
    let worker = b.env.funded()?;
    let delivery = b.env.announce_for(&worker, &b.intent(0))?;
    b.env.clear_announcement();
    Ok((b, judge, worker, delivery))
}

pub fn close_announcement_ready() -> TestResult<Ready> {
    let (mut b, _, worker, delivery) = announced_base()?;
    let owner = b.owner_key();
    let cancel = b.env.cancel_ix(&b.owner(), &b.market, 0, &b.trader.input);
    b.env.send(&owner, &[cancel], &[])?;
    let ix = svm_tests::close_announcement_ix(
        &worker.pubkey(),
        &delivery.announcement,
        &b.intent(0),
        &worker.pubkey(),
    );
    let book = svm_tests::book_pda(&b.intent(0));
    Ok(b.ready(ix, vec![worker.insecure_clone()])?
        .named("worker", worker.pubkey())
        .named("announcement", delivery.announcement)
        .named("book", book))
}

pub fn close_delivery_book() -> TestResult<Ready> {
    let (mut b, _, worker, delivery) = announced_base()?;
    let owner = b.owner_key();
    let cancel = b.env.cancel_ix(&b.owner(), &b.market, 0, &b.trader.input);
    b.env.send(&owner, &[cancel], &[])?;
    let intent = b.intent(0);
    close_announcement(&mut b.env, &worker, &delivery.announcement, &intent)?;
    let by = b.env.funded()?;
    let ix = close_delivery_book_ix(&by.pubkey(), &b.intent(0), &worker.pubkey());
    let book = svm_tests::book_pda(&b.intent(0));
    Ok(b.ready(ix, vec![by.insecure_clone()])?
        .named("worker", worker.pubkey())
        .named("by", by.pubkey())
        .named("book", book))
}

pub fn refute_release() -> TestResult<Ready> {
    let (mut b, judge) = proof_base(SPEC)?;
    let early = b.env.funded()?;
    let late = b.env.solver(&b.market, 0)?;
    let intent = b.intent(0);
    let first = b.env.announce_for(&early, &intent)?;
    let paid = b.env.announce_for(&late.key, &intent)?;
    let fee_to = b.env.fee_account(&b.market)?;
    let message = attestation_proof_message(
        DOMAIN,
        &judge.pubkey(),
        &intent,
        &late.input,
        ESCROW,
        1,
        SPEC,
        &paid,
    );
    let fill = b.env.fill_attested_ix(
        &late.key.pubkey(),
        &b.owner(),
        &b.market,
        0,
        &late.input,
        Some(&fee_to),
        1,
    );
    b.env
        .send(&late.key, &[ed25519_ix(&judge, &message), fill], &[])?;
    b.env.clear_announcement();
    let ix = refute_ix(
        &early.pubkey(),
        &paid.announcement,
        &first.announcement,
        SALT_OF,
        None,
    );
    Ok(
        b.ready(ix, vec![early.insecure_clone(), late.key.insecure_clone()])?
            .named("worker", early.pubkey())
            .named("late", late.key.pubkey())
            .named("paid", paid.announcement)
            .named("earlier", first.announcement),
    )
}

pub const SALT_OF: [u8; 16] = svm_tests::SALT;

pub fn create_profile() -> TestResult<Ready> {
    let mut b = base()?;
    let wallet = b.env.funded()?;
    let ix = create_profile_ix(&wallet.pubkey(), [0; 32]);
    Ok(b.ready(ix, vec![wallet.insecure_clone()])?
        .named("wallet", wallet.pubkey())
        .named("profile", profile_of(&wallet.pubkey())))
}

pub fn profile_base() -> TestResult<(Base, Keypair)> {
    let mut b = base()?;
    let wallet = b.env.funded()?;
    let ix = create_profile_ix(&wallet.pubkey(), [0; 32]);
    b.env.send(&wallet, &[ix], &[])?;
    Ok((b, wallet))
}

pub fn update_profile() -> TestResult<Ready> {
    let (b, wallet) = profile_base()?;
    let ix = update_profile_ix(&wallet.pubkey(), [0; 32]);
    Ok(b.ready(ix, vec![wallet.insecure_clone()])?
        .named("wallet", wallet.pubkey())
        .named("profile", profile_of(&wallet.pubkey())))
}

pub fn close_profile() -> TestResult<Ready> {
    let (b, wallet) = profile_base()?;
    let ix = close_profile_ix(&wallet.pubkey());
    Ok(b.ready(ix, vec![wallet.insecure_clone()])?
        .named("wallet", wallet.pubkey())
        .named("profile", profile_of(&wallet.pubkey())))
}

pub fn version_offset(version_at: usize) -> usize {
    version_at.saturating_add(8)
}

pub fn close_legacy() -> TestResult<Ready> {
    let (mut b, wallet) = profile_base()?;
    let profile = profile_of(&wallet.pubkey());
    let at = version_offset(core::mem::offset_of!(
        intent_engine::state::Profile,
        version
    ));
    put_byte(&mut b.env, &profile, at, 1)?;
    let ix = close_legacy_ix(&profile, &wallet.pubkey(), false);
    Ok(b.ready(ix, Vec::new())?
        .named("wallet", wallet.pubkey())
        .named("legacy", profile))
}

pub fn migrate() -> TestResult<Ready> {
    let mut b = base()?;
    let admin = b.env.authority.insecure_clone();
    let at = version_offset(core::mem::offset_of!(intent_engine::state::Config, version));
    put_byte(&mut b.env, &config_pda(), at, 1)?;
    let ix = migrate_ix(&admin.pubkey(), &config_pda(), None);
    Ok(b.ready(ix, vec![admin.insecure_clone()])?
        .named("admin", admin.pubkey())
        .named("legacy", config_pda()))
}

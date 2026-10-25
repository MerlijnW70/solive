use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, Kind};
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    attestation_message, intent_pda, swap_spec, vault_pda, Env, IntentSpec, Market, Solver,
    TestResult, Trader, DOMAIN, START_TS,
};

const PROGRAM: Pubkey = anchor_spl::token::ID;
const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SWAP: u64 = 0;
const ATTESTED: u64 = 1;
const SIGNED: u64 = 7;
const SUBMIT_BY: i64 = START_TS + 600;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    attestor: Keypair,
    fee_to: Pubkey,
    attacker: Keypair,
}

fn attested_spec(nonce: u64, attestor: &Pubkey) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        nonce,
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 10,
            max_result: 20,
            attestor: attestor.to_bytes(),
            spec_hash: [0; 32],
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        expires_at: START_TS.saturating_add(3_600),
        flags: 0,
        ext: Vec::new(),
    })
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED * 2)?;
    env.approve_delegate(&trader, &market, ESCROW)?;
    let solver = env.solver(&market, 10_000)?;
    let fee_to = env.fee_account(&market)?;
    let attestor = Keypair::new();
    env.create_intent(&trader, &market, &swap_spec(SWAP, ESCROW)?)?;
    env.create_intent(
        &trader,
        &market,
        &attested_spec(ATTESTED, &attestor.pubkey())?,
    )?;
    let attacker = env.funded()?;
    Ok(World {
        env,
        market,
        trader,
        solver,
        attestor,
        fee_to,
        attacker,
    })
}

fn unsigned_ed25519(claimed_signer: &Pubkey, message: &[u8]) -> Instruction {
    solana_ed25519_program::new_ed25519_instruction_with_signature(
        message,
        &[0u8; 64],
        &claimed_signer.to_bytes(),
    )
}

fn sysvar_bytes(listed: &[&Instruction], current: u16) -> TestResult<Vec<u8>> {
    let mut bodies = Vec::new();
    for ix in listed {
        let mut body = Vec::new();
        body.extend_from_slice(&u16::try_from(ix.accounts.len())?.to_le_bytes());
        for meta in &ix.accounts {
            body.push(u8::from(meta.is_signer) | (u8::from(meta.is_writable) << 1));
            body.extend_from_slice(meta.pubkey.as_ref());
        }
        body.extend_from_slice(ix.program_id.as_ref());
        body.extend_from_slice(&u16::try_from(ix.data.len())?.to_le_bytes());
        body.extend_from_slice(&ix.data);
        bodies.push(body);
    }
    let mut data = u16::try_from(listed.len())?.to_le_bytes().to_vec();
    let mut at = 2usize.saturating_add(listed.len().saturating_mul(2));
    for body in &bodies {
        data.extend_from_slice(&u16::try_from(at)?.to_le_bytes());
        at = at.saturating_add(body.len());
    }
    for body in bodies {
        data.extend_from_slice(&body);
    }
    data.extend_from_slice(&current.to_le_bytes());
    Ok(data)
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn plant(&mut self, data: Vec<u8>) -> TestResult<Pubkey> {
        let forged = Pubkey::new_unique();
        let mut account = self
            .env
            .svm
            .get_account(&self.attacker.pubkey())
            .ok_or("attacker missing")?;
        account.lamports = self.env.svm.minimum_balance_for_rent_exemption(data.len());
        account.data = data;
        account.owner = Pubkey::new_unique();
        self.env.svm.set_account(forged, account)?;
        Ok(forged)
    }

    fn send_with_forged_sysvar(
        &mut self,
        mut target: Instruction,
        claimed: &[&Instruction],
        current: u16,
    ) -> TestResult<Result<TransactionMetadata, TransactionError>> {
        let mut view: Vec<&Instruction> = claimed.to_vec();
        let honest_target = target.clone();
        view.insert(usize::from(current), &honest_target);
        let forged = self.plant(sysvar_bytes(&view, current)?)?;
        let slot = target
            .accounts
            .iter_mut()
            .find(|meta| meta.pubkey == solana_instructions_sysvar::ID)
            .ok_or("no instructions sysvar")?;
        slot.pubkey = forged;
        let attacker = self.attacker.insecure_clone();
        Ok(self.env.send(&attacker, &[target], &[]))
    }
}

fn unsupported() -> Option<TransactionError> {
    Some(TransactionError::InstructionError(
        0,
        InstructionError::UnsupportedSysvar,
    ))
}

#[test]
fn a_forged_instructions_account_claiming_the_owners_verified_signature_creates_nothing(
) -> TestResult {
    let mut w = world()?;
    let spec = swap_spec(SIGNED, ESCROW)?;
    let message = w
        .env
        .signed_message(&w.trader, &w.market, &spec, DOMAIN, SUBMIT_BY);
    let claimed = unsigned_ed25519(&w.owner(), &message);
    let create =
        w.env
            .create_signed_ix(&w.attacker.pubkey(), &w.trader, &w.market, &spec, SUBMIT_BY);
    let before = w.env.balance(&w.trader.input)?;
    let sent = w.send_with_forged_sysvar(create, &[&claimed], 1)?;
    assert_eq!(sent.err(), unsupported());
    assert!(!w.env.exists(&intent_pda(&w.owner(), SIGNED)));
    assert_eq!(w.env.balance(&w.trader.input)?, before);
    Ok(())
}

#[test]
fn a_forged_instructions_account_claiming_the_judges_verified_release_pays_nobody() -> TestResult {
    let mut w = world()?;
    let loot = w.env.create_token_account(
        &w.market.input_mint,
        &w.attacker.pubkey(),
        w.market.input_program,
    )?;
    let message = attestation_message(
        DOMAIN,
        &w.attestor.pubkey(),
        &intent_pda(&w.owner(), ATTESTED),
        &loot,
        ESCROW,
        15,
    );
    let claimed = unsigned_ed25519(&w.attestor.pubkey(), &message);
    let release = w.env.fill_attested_ix(
        &w.attacker.pubkey(),
        &w.owner(),
        &w.market,
        ATTESTED,
        &loot,
        Some(&w.fee_to),
        15,
    );
    let sent = w.send_with_forged_sysvar(release, &[&claimed], 1)?;
    assert_eq!(sent.err(), unsupported());
    assert_eq!(w.env.balance(&loot)?, 0);
    assert_eq!(
        w.env
            .balance(&vault_pda(&intent_pda(&w.owner(), ATTESTED)))?,
        ESCROW
    );
    Ok(())
}

#[test]
fn a_forged_instructions_account_claiming_a_later_end_fill_releases_no_escrow() -> TestResult {
    let mut w = world()?;
    let thief = w.env.solver(&w.market, 0)?;
    let begin = w.env.begin_fill_ix(
        &w.attacker.pubkey(),
        &w.owner(),
        &w.market,
        SWAP,
        &thief.input,
        Some(&w.fee_to),
        1,
    );
    let end = w.env.end_fill_ix(
        &w.attacker.pubkey(),
        &w.owner(),
        &w.market,
        SWAP,
        &w.trader.receiver,
        &w.solver.output,
        ESCROW,
    );
    let sent = w.send_with_forged_sysvar(begin, &[&end], 0)?;
    assert_eq!(sent.err(), unsupported());
    assert_eq!(w.env.balance(&thief.input)?, 0);
    assert_eq!(
        w.env.balance(&vault_pda(&intent_pda(&w.owner(), SWAP)))?,
        ESCROW
    );
    Ok(())
}

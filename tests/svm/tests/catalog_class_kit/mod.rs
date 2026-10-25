#![allow(dead_code)]

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_engine::state::{MINT_CAP_SEED, PROFILE_SEED};
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use svm_tests::{
    anchor_error_at, close_announcement_ix, commitment_of, config_pda, engine_ix, event_authority,
    intent_pda, pda, Announce, Env, Market, TestResult, Trader, DELIVERED, SALT,
};

pub mod worlds;

pub const FUNDED: u64 = 10_000;
pub const ESCROW: u64 = 400;
pub const SPEC: [u8; 32] = [0x3c; 32];
pub const STAKE: u64 = 50_000_000;
pub const HOUR: u32 = 3_600;

pub struct Ready {
    pub env: Env,
    pub before: Vec<Instruction>,
    pub ix: Instruction,
    pub after: Vec<Instruction>,
    pub keys: Vec<Keypair>,
    pub payer: Keypair,
    pub names: Vec<(&'static str, Pubkey)>,
}

impl Ready {
    pub fn new(mut env: Env, ix: Instruction, keys: Vec<Keypair>) -> TestResult<Self> {
        let payer = env.funded()?;
        Ok(Self {
            env,
            before: Vec::new(),
            ix,
            after: Vec::new(),
            keys,
            payer,
            names: Vec::new(),
        })
    }

    pub fn named(mut self, name: &'static str, key: Pubkey) -> Self {
        self.names.push((name, key));
        self
    }

    pub fn key(&self, name: &str) -> TestResult<Pubkey> {
        self.names
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, k)| *k)
            .ok_or_else(|| format!("no address named {name}").into())
    }

    pub fn at(&self) -> u8 {
        u8::try_from(self.before.len()).unwrap_or(u8::MAX)
    }

    pub fn run(&mut self, ixs: &[Instruction]) -> Result<TransactionMetadata, TransactionError> {
        self.env.svm.expire_blockhash();
        let message = Message::new(ixs, Some(&self.payer.pubkey()));
        let required = usize::from(message.header.num_required_signatures);
        let mut signers: Vec<&Keypair> = Vec::new();
        for key in message.account_keys.iter().take(required) {
            if *key == self.payer.pubkey() {
                signers.push(&self.payer);
            } else if let Some(k) = self.keys.iter().find(|k| k.pubkey() == *key) {
                signers.push(k);
            } else {
                return Err(TransactionError::SignatureFailure);
            }
        }
        let tx = Transaction::new(&signers, message, self.env.svm.latest_blockhash());
        self.env.svm.send_transaction(tx).map_err(|f| f.err)
    }

    pub fn send_with(&mut self, ix: Instruction) -> Result<TransactionMetadata, TransactionError> {
        let mut ixs = self.before.clone();
        ixs.push(ix);
        ixs.extend(self.after.iter().cloned());
        self.run(&ixs)
    }

    pub fn refused(&mut self, ix: Instruction) -> Option<TransactionError> {
        self.send_with(ix).err()
    }

    pub fn send(&mut self) -> Result<TransactionMetadata, TransactionError> {
        let ix = self.ix.clone();
        self.send_with(ix)
    }

    pub fn accepts(mut self) -> TestResult {
        self.send()?;
        Ok(())
    }
}

pub fn unsigned(ix: &Instruction, key: &Pubkey) -> TestResult<Instruction> {
    let mut out = ix.clone();
    let mut cleared = 0usize;
    for meta in out
        .accounts
        .iter_mut()
        .filter(|m| m.pubkey == *key && m.is_signer)
    {
        meta.is_signer = false;
        cleared = cleared.saturating_add(1);
    }
    if cleared == 0 {
        return Err("the key does not sign this instruction".into());
    }
    Ok(out)
}

pub fn swapped(ix: &Instruction, from: &Pubkey, to: &Pubkey) -> TestResult<Instruction> {
    let mut out = ix.clone();
    let mut moved = 0usize;
    for meta in out.accounts.iter_mut().filter(|m| m.pubkey == *from) {
        meta.pubkey = *to;
        moved = moved.saturating_add(1);
    }
    if moved == 0 {
        return Err("the account is not in this instruction".into());
    }
    Ok(out)
}

pub fn swapped_at(ix: &Instruction, at: usize, to: &Pubkey) -> TestResult<Instruction> {
    let mut out = ix.clone();
    out.accounts
        .get_mut(at)
        .ok_or("no account at that index")?
        .pubkey = *to;
    Ok(out)
}

pub fn position(ix: &Instruction, key: &Pubkey) -> TestResult<usize> {
    ix.accounts
        .iter()
        .position(|m| m.pubkey == *key)
        .ok_or_else(|| "the account is not in this instruction".into())
}

pub fn missing_signer(mut r: Ready, key: Pubkey) -> TestResult {
    let ix = unsigned(&r.ix, &key)?;
    let at = r.at();
    assert_eq!(
        r.refused(ix),
        Some(anchor_error_at(at, ErrorCode::AccountNotSigner))
    );
    r.accepts()
}

pub fn refuses_swap(
    mut r: Ready,
    from: Pubkey,
    to: Pubkey,
    expected: impl Fn(u8) -> TransactionError,
) -> TestResult {
    let ix = swapped(&r.ix, &from, &to)?;
    let at = r.at();
    assert_eq!(r.refused(ix), Some(expected(at)));
    r.accepts()
}

pub fn stranger_signs(
    mut r: Ready,
    authority: Pubkey,
    expected: impl Fn(u8) -> TransactionError,
) -> TestResult {
    let stranger = r.env.funded()?;
    let to = stranger.pubkey();
    r.keys.push(stranger);
    refuses_swap(r, authority, to, expected)
}

pub fn foreign_copy(env: &mut Env, of: &Pubkey) -> TestResult<Pubkey> {
    let mut account = env.svm.get_account(of).ok_or("no account to copy")?;
    account.owner = Pubkey::new_unique();
    let at = Pubkey::new_unique();
    env.svm.set_account(at, account)?;
    Ok(at)
}

pub fn owner_checked(mut r: Ready, of: Pubkey) -> TestResult {
    let fake = foreign_copy(&mut r.env, &of)?;
    refuses_swap(r, of, fake, |at| {
        anchor_error_at(at, ErrorCode::AccountOwnedByWrongProgram)
    })
}

pub fn type_checked(r: Ready, of: Pubkey, other: Pubkey) -> TestResult {
    refuses_swap(r, of, other, |at| {
        anchor_error_at(at, ErrorCode::AccountDiscriminatorMismatch)
    })
}

pub fn programs_checked(mut r: Ready) -> TestResult {
    let fake = anchor_spl::associated_token::ID;
    let targets = [
        anchor_spl::token::ID,
        anchor_spl::token_2022::ID,
        anchor_lang::system_program::ID,
    ];
    let at = r.at();
    let last = r.ix.accounts.len().checked_sub(1).ok_or("no accounts")?;
    let authority = last.checked_sub(1).ok_or("no event authority")?;
    if r.ix.accounts.get(authority).map(|m| m.pubkey) != Some(event_authority())
        || r.ix.accounts.get(last).map(|m| m.pubkey) != Some(intent_engine::ID)
    {
        return Err("the instruction does not end in its event accounts".into());
    }
    for i in 0..authority {
        let key = r.ix.accounts.get(i).map(|m| m.pubkey).ok_or("index")?;
        if !targets.contains(&key) {
            continue;
        }
        let ix = swapped_at(&r.ix, i, &fake)?;
        assert_eq!(
            r.refused(ix),
            Some(anchor_error_at(at, ErrorCode::InvalidProgramId)),
            "account {i}"
        );
    }
    let ix = swapped_at(&r.ix, authority, &fake)?;
    assert_eq!(
        r.refused(ix),
        Some(anchor_error_at(at, ErrorCode::ConstraintAddress))
    );
    let ix = swapped_at(&r.ix, last, &fake)?;
    match r.send_with(ix) {
        Ok(meta) => {
            let named = fake.to_string();
            assert!(meta.logs.iter().all(|line| !line.contains(&named)));
            Ok(())
        }
        Err(e) => {
            assert_eq!(
                e,
                TransactionError::InstructionError(
                    at,
                    solana_instruction_error::InstructionError::MissingAccount
                )
            );
            r.accepts()
        }
    }
}

pub fn sysvar_checked(mut r: Ready) -> TestResult {
    let fake = r.env.funded()?.pubkey();
    let ix = swapped(&r.ix, &solana_instructions_sysvar::ID, &fake)?;
    let at = r.at();
    assert_eq!(
        r.refused(ix),
        Some(TransactionError::InstructionError(
            at,
            solana_instruction_error::InstructionError::UnsupportedSysvar
        ))
    );
    r.accepts()
}

pub fn off_bump(seeds: &[&[u8]]) -> TestResult<Pubkey> {
    let (_, canonical) = Pubkey::find_program_address(seeds, &intent_engine::ID);
    let mut bump = canonical;
    while let Some(next) = bump.checked_sub(1) {
        bump = next;
        let mut with: Vec<&[u8]> = seeds.to_vec();
        let tail = [bump];
        with.push(&tail);
        if let Ok(address) = Pubkey::create_program_address(&with, &intent_engine::ID) {
            return Ok(address);
        }
    }
    Err("no address off the canonical bump".into())
}

pub fn put_byte(env: &mut Env, address: &Pubkey, at: usize, value: u8) -> TestResult {
    let mut account = env.svm.get_account(address).ok_or("no account")?;
    *account.data.get_mut(at).ok_or("offset")? = value;
    env.svm.set_account(*address, account)?;
    Ok(())
}

pub fn fund(env: &mut Env, address: &Pubkey, lamports: u64) -> TestResult {
    env.svm
        .airdrop(address, lamports)
        .map_err(|f| format!("airdrop: {:?}", f.err))?;
    Ok(())
}

pub fn transfer_ix(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    solana_system_interface::instruction::transfer(from, to, lamports)
}

pub fn gone(env: &Env, address: &Pubkey) -> bool {
    env.svm
        .get_account(address)
        .is_none_or(|a| a.data.is_empty() && a.owner == anchor_lang::system_program::ID)
}

pub fn mint_cap_pda(mint: &Pubkey) -> Pubkey {
    pda(&[MINT_CAP_SEED, mint.as_ref()])
}

pub fn profile_of(wallet: &Pubkey) -> Pubkey {
    pda(&[PROFILE_SEED, wallet.as_ref()])
}

pub fn set_mint_cap_ix(admin: &Pubkey, payer: &Pubkey, mint: &Pubkey) -> Instruction {
    engine_ix(
        intent_engine::accounts::SetMintCap {
            admin: *admin,
            payer: *payer,
            config: config_pda(),
            mint: *mint,
            mint_cap: mint_cap_pda(mint),
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::SetMintCap {
            max_per_order: 1_000,
            window_cap: 10_000,
            window_secs: 3_600,
            total_limit: 0,
        },
    )
}

pub fn set_caps_required_ix(admin: &Pubkey, required: bool) -> Instruction {
    engine_ix(
        intent_engine::accounts::SetCapsRequired {
            admin: *admin,
            config: config_pda(),
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::SetCapsRequired { required },
    )
}

pub fn set_committee_floor_ix(admin: &Pubkey, mint: &Pubkey, floor: u64) -> Instruction {
    engine_ix(
        intent_engine::accounts::SetCommitteeFloor {
            admin: *admin,
            config: config_pda(),
            mint: *mint,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::SetCommitteeFloor { floor },
    )
}

pub fn close_profile_ix(wallet: &Pubkey) -> Instruction {
    engine_ix(
        intent_engine::accounts::CloseProfile {
            wallet: *wallet,
            profile: profile_of(wallet),
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::CloseProfile {},
    )
}

pub fn init_user_ix(owner: &Pubkey, user_state: &Pubkey) -> Instruction {
    engine_ix(
        intent_engine::accounts::InitUser {
            owner: *owner,
            user_state: *user_state,
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::InitUser {},
    )
}

pub fn announce_ix(
    env: &mut Env,
    worker: &Pubkey,
    intent: &Pubkey,
    attestor: &Pubkey,
) -> TestResult<Announce> {
    let (blob, committee) = env.delivery_blob(intent, attestor)?;
    Ok(Announce {
        commitment: commitment_of(intent, worker, &SALT, &DELIVERED),
        profile: !committee,
        committee,
        ..Announce::new(*worker, *intent, *attestor, blob)
    })
}

pub fn close_announcement(
    env: &mut Env,
    worker: &Keypair,
    announcement: &Pubkey,
    intent: &Pubkey,
) -> TestResult {
    let ix = close_announcement_ix(&worker.pubkey(), announcement, intent, &worker.pubkey());
    env.send(worker, &[ix], &[])?;
    Ok(())
}

pub fn intent_of(trader: &Trader, nonce: u64) -> Pubkey {
    intent_pda(&trader.key.pubkey(), nonce)
}

pub fn market_of(market: &Market) -> Market {
    Market {
        input_mint: market.input_mint,
        output_mint: market.output_mint,
        input_program: market.input_program,
        output_program: market.output_program,
    }
}

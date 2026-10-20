use super::*;
use base64::Engine as _;
use serde_json::Value;
use std::str::FromStr;

pub const RENT_SYSVAR: Pubkey =
    anchor_lang::prelude::pubkey!("SysvarRent111111111111111111111111111111111");
pub const SYSVAR_OWNER: Pubkey =
    anchor_lang::prelude::pubkey!("Sysvar1111111111111111111111111111111111111");

pub struct Saved {
    pub address: Pubkey,
    pub owner: Pubkey,
    pub lamports: u64,
    pub data: Vec<u8>,
}

pub struct Snapshot {
    pub time: i64,
    pub rent: Vec<u8>,
    pub accounts: Vec<Saved>,
    pub tokens: Vec<Saved>,
}

pub fn devnet_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/devnet.json")
}

fn text<'a>(value: &'a Value, key: &str) -> TestResult<&'a str> {
    Ok(value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("fixture field {key} missing"))?)
}

fn number(value: &Value, key: &str) -> TestResult<u64> {
    Ok(value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("fixture field {key} missing"))?)
}

fn bytes(value: &Value, key: &str) -> TestResult<Vec<u8>> {
    Ok(base64::engine::general_purpose::STANDARD.decode(text(value, key)?)?)
}

fn key(value: &Value, field: &str) -> TestResult<Pubkey> {
    Ok(Pubkey::from_str(text(value, field)?)?)
}

fn saved_list(root: &Value, list: &str, owner: Option<Pubkey>) -> TestResult<Vec<Saved>> {
    root.get(list)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("fixture list {list} missing"))?
        .iter()
        .map(|entry| {
            Ok(Saved {
                address: key(entry, "address")?,
                owner: match owner {
                    Some(program) => program,
                    None => key(entry, "owner")?,
                },
                lamports: number(entry, "lamports")?,
                data: bytes(entry, "data")?,
            })
        })
        .collect()
}

pub fn devnet_snapshot() -> TestResult<Snapshot> {
    let root: Value = serde_json::from_str(&std::fs::read_to_string(devnet_fixture_path())?)?;
    let program = key(&root, "program")?;
    if program != intent_engine::ID {
        return Err(format!("the fixture holds accounts of {program}").into());
    }
    Ok(Snapshot {
        time: i64::try_from(number(&root, "time")?)?,
        rent: bytes(&root, "rent")?,
        accounts: saved_list(&root, "accounts", Some(intent_engine::ID))?,
        tokens: saved_list(&root, "tokens", None)?,
    })
}

impl Snapshot {
    pub fn get(&self, address: &Pubkey) -> Option<&Saved> {
        self.accounts
            .iter()
            .chain(&self.tokens)
            .find(|s| s.address == *address)
    }

    pub fn of_type(&self, discriminator: &[u8]) -> Vec<&Saved> {
        self.accounts
            .iter()
            .filter(|s| s.data.get(..discriminator.len()) == Some(discriminator))
            .collect()
    }
}

pub fn put(svm: &mut LiteSVM, saved: &Saved) -> TestResult {
    let mut account = svm.get_account(&saved.address).unwrap_or_default();
    account.lamports = saved.lamports;
    account.data = saved.data.clone();
    account.owner = saved.owner;
    account.executable = false;
    svm.set_account(saved.address, account)?;
    Ok(())
}

pub fn devnet_env(snapshot: &Snapshot) -> TestResult<Env> {
    let mut env = Env::new()?;
    env.svm = std::mem::take(&mut env.svm).with_sigverify(false);
    put(
        &mut env.svm,
        &Saved {
            address: RENT_SYSVAR,
            owner: SYSVAR_OWNER,
            lamports: 1,
            data: snapshot.rent.clone(),
        },
    )?;
    env.set_now(snapshot.time);
    for saved in snapshot.accounts.iter().chain(&snapshot.tokens) {
        put(&mut env.svm, saved)?;
    }
    let config = snapshot
        .get(&config_pda())
        .ok_or("the fixture has no config")?;
    env.fee_recipient = intent_engine::versions::config_terms(&config.data)
        .ok_or("the fixture config is unreadable")?
        .fee_recipient;
    Ok(env)
}

pub fn send_as(
    env: &mut Env,
    payer: &Pubkey,
    ixs: &[Instruction],
) -> Result<TransactionMetadata, TransactionError> {
    env.svm.expire_blockhash();
    let message = Message::new_with_blockhash(ixs, Some(payer), &env.svm.latest_blockhash());
    env.svm
        .send_transaction(Transaction::new_unsigned(message))
        .map_err(|f| f.err)
}

pub fn migrate_ix(payer: &Pubkey, account: &Pubkey, config: Option<Pubkey>) -> Instruction {
    engine_ix(
        intent_engine::accounts::Migrate {
            payer: *payer,
            account: *account,
            config,
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::Migrate {},
    )
}

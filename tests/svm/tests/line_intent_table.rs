use anchor_lang::prelude::Pubkey;
use anchor_lang::Discriminator;
use intent_engine::state::{ClaimBoard, ClaimList, Intent, Mandate, Standby};
use intent_engine::versions::line_intent;
use serde_json::Value;
use std::path::PathBuf;
use svm_tests::TestResult;

const MARK: [u8; 32] = [7; 32];
const NO_ENGINE: [u8; 8] = [0; 8];
const NO_ENGINE_SPACE: usize = 72;

fn table() -> TestResult<Vec<Value>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/core/test/golden/line-intent.json");
    let parsed: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    Ok(parsed.as_array().ok_or("the table is not a list")?.clone())
}

fn layout(account: &str) -> TestResult<(&'static [u8], usize)> {
    Ok(match account {
        "claim board" => (ClaimBoard::DISCRIMINATOR, ClaimBoard::SPACE),
        "claim list" => (ClaimList::DISCRIMINATOR, ClaimList::SPACE),
        "stand-by entry" => (Standby::DISCRIMINATOR, Standby::SPACE),
        "intent" => (Intent::DISCRIMINATOR, Intent::SPACE),
        "mandate" => (Mandate::DISCRIMINATOR, Mandate::SPACE),
        "none" => (&NO_ENGINE, NO_ENGINE_SPACE),
        other => return Err(format!("no layout named {other}").into()),
    })
}

fn data_of(row: &Value) -> TestResult<Vec<u8>> {
    let (discriminator, space) = layout(
        row.get("account")
            .and_then(Value::as_str)
            .ok_or("no account")?,
    )?;
    let at = usize::try_from(
        row.get("intentAt")
            .and_then(Value::as_u64)
            .ok_or("no intentAt")?,
    )?
    .checked_add(8)
    .ok_or("overflow")?;
    let mut data = vec![0u8; space];
    data.get_mut(..discriminator.len())
        .ok_or("short")?
        .copy_from_slice(discriminator);
    data.get_mut(at..at.checked_add(32).ok_or("overflow")?)
        .ok_or("short")?
        .copy_from_slice(&MARK);
    let length = match row.get("length").and_then(Value::as_u64) {
        Some(length) => usize::try_from(length)?,
        None => space,
    };
    data.truncate(length);
    Ok(data)
}

#[test]
fn line_intent_names_the_intent_the_shared_table_expects() -> TestResult {
    let rows = table()?;
    assert!(!rows.is_empty());
    for row in &rows {
        let expected = row
            .get("named")
            .and_then(Value::as_bool)
            .ok_or("no named")?
            .then_some(Pubkey::new_from_array(MARK));
        assert_eq!(
            line_intent(&data_of(row)?),
            expected,
            "{}",
            row.get("case").and_then(Value::as_str).unwrap_or_default()
        );
    }
    Ok(())
}

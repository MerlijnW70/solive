use std::path::PathBuf;

use svm_tests::{
    bump_search_cost, cu_baseline_path, cu_gate_into, cu_gates_into, cu_records_dir, cu_within,
    TestResult, BUMP_STEP, CU_TOLERANCE_PCT,
};

fn private_records(test: &str) -> PathBuf {
    std::env::temp_dir().join(format!("solive-cu-{test}-{}", std::process::id()))
}

#[test]
fn tolerance_is_five_percent_either_way() {
    assert_eq!(CU_TOLERANCE_PCT, 5);
    assert!(cu_within(1_000, 1_000));
    assert!(cu_within(1_000, 1_050));
    assert!(!cu_within(1_000, 1_051));
    assert!(cu_within(1_000, 950));
    assert!(!cu_within(1_000, 949));
    assert!(cu_within(0, 0));
    assert!(!cu_within(0, 1));
}

#[test]
fn each_bump_below_the_first_try_costs_one_more_search_step() {
    assert_eq!(BUMP_STEP, 1_500);
    assert_eq!(bump_search_cost(255), 0);
    assert_eq!(bump_search_cost(254), 1_500);
    assert_eq!(bump_search_cost(250), 7_500);
    assert_eq!(bump_search_cost(0), 382_500);
}

#[test]
fn every_baseline_entry_is_a_positive_unit_count() -> TestResult {
    let table: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(cu_baseline_path())?)?;
    let entries = table.as_object().ok_or("baseline is not an object")?;
    assert_eq!(entries.len(), 26);
    for (name, value) in entries {
        assert!(value.as_u64().is_some_and(|v| v > 0), "{name}");
    }
    Ok(())
}

#[test]
fn the_gate_rejects_drift_and_unknown_names() -> TestResult {
    let table: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(cu_baseline_path())?)?;
    let flash = table
        .get("flash_fill")
        .and_then(serde_json::Value::as_u64)
        .ok_or("flash_fill missing")?;
    let dir = private_records("drift");
    assert!(cu_gate_into(&dir, "flash_fill", flash).is_ok());
    assert!(cu_gate_into(&dir, "flash_fill", flash.saturating_mul(2)).is_err());
    assert!(cu_gate_into(&dir, "flash_fill", flash / 2).is_err());
    assert!(cu_gate_into(&dir, "no_such_entry", flash).is_err());
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

#[test]
fn every_gated_measurement_is_recorded_for_rebaselining() -> TestResult {
    let name = "cu_gate_self_test_entry";
    let dir = private_records("record");
    let path = dir.join(name);
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    assert!(cu_gate_into(&dir, name, 4_321).is_err());
    assert_eq!(std::fs::read_to_string(&path)?, "4321");
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

#[test]
fn a_batch_records_every_measurement_and_reports_only_the_drifting_ones() -> TestResult {
    let table: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(cu_baseline_path())?)?;
    let base = |name: &str| table.get(name).and_then(serde_json::Value::as_u64);
    let (cancel, close) = (
        base("cancel_spl").ok_or("cancel_spl missing")?,
        base("close_spl").ok_or("close_spl missing")?,
    );
    let dir = private_records("batch");
    assert!(cu_gates_into(
        &dir,
        &[
            ("cancel_spl".to_owned(), cancel),
            ("close_spl".to_owned(), close)
        ]
    )
    .is_ok());
    let drifted = close.saturating_mul(2);
    let err = cu_gates_into(
        &dir,
        &[
            ("cancel_spl".to_owned(), cancel),
            ("close_spl".to_owned(), drifted),
        ],
    )
    .err()
    .ok_or("a drifting batch passed")?
    .to_string();
    assert_eq!(
        err,
        format!("close_spl measured {drifted} against baseline {close}")
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("cancel_spl"))?,
        cancel.to_string()
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("close_spl"))?,
        drifted.to_string()
    );
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

#[test]
fn real_measurements_are_recorded_inside_the_running_build_not_a_machine_wide_folder() -> TestResult
{
    let exe = std::env::current_exe()?;
    let profile = exe
        .parent()
        .and_then(std::path::Path::parent)
        .ok_or("the test binary has no profile folder")?;
    assert_eq!(cu_records_dir(), profile.join("solive-cu"));
    assert!(
        !cu_records_dir().starts_with(std::env::temp_dir())
            || profile.starts_with(std::env::temp_dir())
    );
    Ok(())
}

use super::*;

pub const CU_TOLERANCE_PCT: u64 = 5;
pub const BUMP_STEP: u64 = 1_500;

pub fn bump_search_cost(bump: u8) -> u64 {
    u64::from(u8::MAX.abs_diff(bump)).saturating_mul(BUMP_STEP)
}

pub fn cu_baseline_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("cu-baseline.json")
}

pub fn cu_within(baseline: u64, measured: u64) -> bool {
    measured.abs_diff(baseline).saturating_mul(100) <= baseline.saturating_mul(CU_TOLERANCE_PCT)
}

pub fn cu_measured_path(name: &str) -> PathBuf {
    std::env::temp_dir().join("solive-cu").join(name)
}

fn cu_record(name: &str, measured: u64) -> TestResult {
    let record = cu_measured_path(name);
    std::fs::create_dir_all(record.parent().ok_or("measurement path has no parent")?)?;
    std::fs::write(&record, measured.to_string())?;
    Ok(())
}

fn cu_check(name: &str, measured: u64) -> TestResult {
    let table: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(cu_baseline_path())?)?;
    let baseline = table
        .get(name)
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| format!("{name} missing from cu-baseline.json"))?;
    if cu_within(baseline, measured) {
        Ok(())
    } else {
        Err(format!("{name} measured {measured} against baseline {baseline}").into())
    }
}

pub fn cu_gate(name: &str, measured: u64) -> TestResult {
    cu_record(name, measured)?;
    cu_check(name, measured)
}

pub fn cu_gates(measurements: &[(String, u64)]) -> TestResult {
    for (name, measured) in measurements {
        cu_record(name, *measured)?;
    }
    let failures: Vec<String> = measurements
        .iter()
        .filter_map(|(name, measured)| cu_check(name, *measured).err().map(|e| e.to_string()))
        .collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; ").into())
    }
}

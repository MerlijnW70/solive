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

pub fn cu_records_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let profile = exe.parent().and_then(std::path::Path::parent);
    profile
        .map_or_else(std::env::temp_dir, PathBuf::from)
        .join("solive-cu")
}

pub fn cu_measured_path(name: &str) -> PathBuf {
    cu_records_dir().join(name)
}

fn cu_record(dir: &std::path::Path, name: &str, measured: u64) -> TestResult {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(name), measured.to_string())?;
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
    cu_gate_into(&cu_records_dir(), name, measured)
}

pub fn cu_gate_into(dir: &std::path::Path, name: &str, measured: u64) -> TestResult {
    cu_record(dir, name, measured)?;
    cu_check(name, measured)
}

pub fn cu_gates(measurements: &[(String, u64)]) -> TestResult {
    cu_gates_into(&cu_records_dir(), measurements)
}

pub fn cu_gates_into(dir: &std::path::Path, measurements: &[(String, u64)]) -> TestResult {
    for (name, measured) in measurements {
        cu_record(dir, name, *measured)?;
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

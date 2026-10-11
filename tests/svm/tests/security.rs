use std::path::PathBuf;

use svm_tests::{engine_program_path, TestResult};

const BEGIN: &[u8] = b"=======BEGIN SECURITY.TXT V1=======\0";
const END: &[u8] = b"=======END SECURITY.TXT V1=======\0";

fn repository() -> TestResult<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../identity.toml");
    let text = std::fs::read_to_string(path)?;
    let line = text
        .lines()
        .find_map(|l| l.strip_prefix("repository = \""))
        .ok_or("identity.toml has no security.repository")?;
    Ok(line.trim_end_matches('"').to_owned())
}

fn embedded() -> TestResult<Vec<(String, String)>> {
    let so = std::fs::read(engine_program_path())?;
    let start = so
        .windows(BEGIN.len())
        .position(|w| w == BEGIN)
        .ok_or("no security.txt in the program")?
        .checked_add(BEGIN.len())
        .ok_or("offset overflow")?;
    let body = so.get(start..).ok_or("truncated")?;
    let end = body
        .windows(END.len())
        .position(|w| w == END)
        .ok_or("unterminated security.txt")?;
    let fields: Vec<String> = body
        .get(..end)
        .ok_or("truncated")?
        .split(|b| *b == 0)
        .filter(|f| !f.is_empty())
        .map(|f| String::from_utf8_lossy(f).into_owned())
        .collect();
    Ok(fields
        .chunks(2)
        .filter_map(|pair| match pair {
            [k, v] => Some((k.clone(), v.clone())),
            _ => None,
        })
        .collect())
}

#[test]
fn the_program_carries_a_security_txt_bound_to_identity() -> TestResult {
    let repo = repository()?;
    assert!(repo.starts_with("https://"), "{repo}");
    let report = format!("{repo}/security/advisories/new");
    assert_eq!(
        embedded()?,
        vec![
            ("name".to_owned(), "intent-engine".to_owned()),
            ("project_url".to_owned(), repo.clone()),
            ("contacts".to_owned(), format!("link:{report}")),
            ("policy".to_owned(), report),
            ("source_code".to_owned(), repo),
        ]
    );
    Ok(())
}

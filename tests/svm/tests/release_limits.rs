use std::io::Write;
use std::path::PathBuf;

use intent_core::committee::{MAX_MEMBERS, MAX_THRESHOLD};
use intent_engine::MAX_SPLIT_RECIPIENTS;
use svm_tests::{
    measure_shape, render_rows, Form, ReleaseKind, Row, Shape, TestResult, LANDABLE_SPLIT,
    PACKET_DATA_SIZE,
};

const SPLIT_PANEL: (usize, u8) = (3, 2);
const SPLIT_COMMITTEE_FITS: usize = 1;
const SPLIT_COMMITTEE_FITS_WITH_TABLE: usize = 3;
const COMMITTEE_FITS_MEMBERS: usize = 5;

fn cli_constant(name: &str) -> TestResult<usize> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/cli/src/agent/wallet/split.ts");
    let source = std::fs::read_to_string(path)?;
    let prefix = format!("export const {name} = ");
    let value = source
        .lines()
        .find_map(|line| line.strip_prefix(prefix.as_str()))
        .and_then(|rest| rest.strip_suffix(';'))
        .ok_or_else(|| format!("{name} is not a plain constant in split.ts"))?;
    Ok(value.parse()?)
}

fn shape(kind: ReleaseKind, recipients: usize, members: usize, threshold: u8) -> Shape {
    Shape {
        kind,
        recipients,
        members,
        threshold,
    }
}

fn measured_rows() -> TestResult<Vec<Row>> {
    let program = anchor_spl::token::ID;
    let mut rows = vec![measure_shape(program, shape(ReleaseKind::Proof, 1, 0, 0))?];
    for members in 1..=MAX_MEMBERS {
        let threshold = u8::try_from(members)?.min(MAX_THRESHOLD);
        rows.push(measure_shape(
            program,
            shape(ReleaseKind::Committee, 1, members, threshold),
        )?);
    }
    for n in 1..=MAX_SPLIT_RECIPIENTS {
        rows.push(measure_shape(program, shape(ReleaseKind::Split, n, 0, 0))?);
    }
    let (members, threshold) = SPLIT_PANEL;
    for n in 1..=MAX_SPLIT_RECIPIENTS {
        rows.push(measure_shape(
            program,
            shape(ReleaseKind::SplitCommittee, n, members, threshold),
        )?);
    }
    Ok(rows)
}

fn largest(rows: &[Row], kind: ReleaseKind, fits: fn(&Row) -> bool) -> usize {
    rows.iter()
        .filter(|r| r.shape.kind == kind && fits(r))
        .map(|r| r.shape.recipients)
        .max()
        .unwrap_or(0)
}

#[test]
fn every_release_kind_is_measured_against_the_packet_limit_and_pins_the_cli_split_limits(
) -> TestResult {
    let rows = measured_rows()?;
    let table = render_rows(&rows);
    writeln!(
        std::io::stdout().lock(),
        "release size and compute at the {PACKET_DATA_SIZE}-byte packet limit\n{table}"
    )?;
    for row in &rows {
        let fits = row.legacy <= PACKET_DATA_SIZE || row.fits_table();
        assert_eq!(row.landed.is_some(), fits, "{row:?}");
        assert_eq!(row.v0, row.legacy.saturating_add(2), "{row:?}");
        assert!(row.tabled < row.v0, "{row:?}");
        if let Some((form, _)) = row.landed {
            assert_eq!(
                form == Form::Legacy,
                row.legacy <= PACKET_DATA_SIZE,
                "{row:?}"
            );
        }
    }
    for kind in [ReleaseKind::Split, ReleaseKind::SplitCommittee] {
        let sizes: Vec<&Row> = rows.iter().filter(|r| r.shape.kind == kind).collect();
        assert!(
            sizes
                .windows(2)
                .all(|w| matches!(w, [a, b] if a.tabled < b.tabled && a.v0 < b.v0)),
            "{kind:?} grows with every co-author"
        );
    }
    assert_eq!(
        largest(&rows, ReleaseKind::Split, Row::fits_bare),
        cli_constant("SPLIT_FITS")?,
        "SPLIT_FITS matches the largest split without a lookup table\n{table}"
    );
    assert_eq!(
        largest(&rows, ReleaseKind::Split, Row::fits_table),
        cli_constant("SPLIT_FITS_WITH_TABLE")?,
        "SPLIT_FITS_WITH_TABLE matches the largest split with a lookup table\n{table}"
    );
    assert_eq!(
        largest(&rows, ReleaseKind::Split, Row::fits_table),
        LANDABLE_SPLIT,
        "the split fuzz covers every split that can land\n{table}"
    );
    assert_eq!(
        largest(&rows, ReleaseKind::SplitCommittee, Row::fits_bare),
        SPLIT_COMMITTEE_FITS,
        "{table}"
    );
    assert_eq!(
        largest(&rows, ReleaseKind::SplitCommittee, Row::fits_table),
        SPLIT_COMMITTEE_FITS_WITH_TABLE,
        "{table}"
    );
    let committees: Vec<&Row> = rows
        .iter()
        .filter(|r| r.shape.kind == ReleaseKind::Committee)
        .collect();
    assert_eq!(
        committees
            .iter()
            .filter(|r| r.fits_bare())
            .map(|r| r.shape.members)
            .max(),
        Some(COMMITTEE_FITS_MEMBERS),
        "{table}"
    );
    assert!(
        committees.iter().all(|r| r.fits_table()),
        "every committee size releases one payee with a lookup table\n{table}"
    );
    assert!(
        rows.iter()
            .filter(|r| r.shape.kind.split() && r.shape.recipients == MAX_SPLIT_RECIPIENTS)
            .all(|r| !r.fits_table()),
        "the {MAX_SPLIT_RECIPIENTS}-recipient cap cannot ride one transaction even with a lookup table\n{table}"
    );
    Ok(())
}

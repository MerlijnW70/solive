use std::io::Write;
use std::path::PathBuf;

use intent_core::committee::{MAX_MEMBERS, MAX_THRESHOLD};
use intent_engine::MAX_SPLIT_RECIPIENTS;
use svm_tests::{
    measure_shape, render_rows, Form, ReleaseKind, Row, Shape, TestResult, LANDABLE_SPLIT,
    PACKET_DATA_SIZE,
};

const SPLIT_PANELS: [(usize, u8); 3] = [(3, 2), (5, 3), (MAX_MEMBERS, MAX_THRESHOLD)];
const MINIMAL_SPLIT_FITS: usize = 2;
const MINIMAL_SPLIT_FITS_WITH_TABLE: usize = 4;
const MINIMAL_PANEL_SPLIT_FITS: usize = 1;
const MINIMAL_PANEL_SPLIT_FITS_WITH_TABLE: usize = 3;
const COMMITTEE_FITS_MEMBERS: usize = 5;
const FULL_COMMITTEE_FITS_MEMBERS: usize = 2;

fn cli_constant(file: &str, name: &str) -> TestResult<usize> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/cli/src/agent/wallet")
        .join(file);
    let source = std::fs::read_to_string(path)?;
    let prefix = format!("export const {name} = ");
    let value = source
        .lines()
        .find_map(|line| line.strip_prefix(prefix.as_str()))
        .and_then(|rest| rest.strip_suffix(';'))
        .ok_or_else(|| format!("{name} is not a plain constant in {file}"))?;
    Ok(value.parse()?)
}

fn measured_rows() -> TestResult<Vec<Row>> {
    let program = anchor_spl::token::ID;
    let mut shapes = vec![Shape::new(ReleaseKind::Proof, 1, 0, 0)];
    for members in 1..=MAX_MEMBERS {
        let threshold = u8::try_from(members)?.min(MAX_THRESHOLD);
        shapes.push(Shape::new(ReleaseKind::Committee, 1, members, threshold));
    }
    for n in 1..=MAX_SPLIT_RECIPIENTS {
        shapes.push(Shape::new(ReleaseKind::Split, n, 0, 0));
    }
    for (members, threshold) in SPLIT_PANELS {
        for n in 1..=MAX_SPLIT_RECIPIENTS {
            shapes.push(Shape::new(
                ReleaseKind::SplitCommittee,
                n,
                members,
                threshold,
            ));
        }
    }
    let mut rows = Vec::new();
    for shape in shapes {
        rows.push(measure_shape(program, shape)?);
        rows.push(measure_shape(program, shape.full())?);
    }
    Ok(rows)
}

fn largest(rows: &[Row], pick: impl Fn(&Shape) -> bool, fits: fn(&Row) -> bool) -> usize {
    rows.iter()
        .filter(|r| pick(&r.shape) && fits(r))
        .map(|r| r.shape.recipients)
        .max()
        .unwrap_or(0)
}

fn split(full: bool) -> impl Fn(&Shape) -> bool {
    move |s| s.kind == ReleaseKind::Split && s.full == full
}

fn panel(full: bool, members: usize) -> impl Fn(&Shape) -> bool {
    move |s| s.kind == ReleaseKind::SplitCommittee && s.full == full && s.members == members
}

fn committee_members(rows: &[Row], full: bool) -> usize {
    rows.iter()
        .filter(|r| r.shape.kind == ReleaseKind::Committee && r.shape.full == full && r.fits_bare())
        .map(|r| r.shape.members)
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
        "release size and compute at the {PACKET_DATA_SIZE}-byte packet limit, with the fewest and with every optional account (claims, stake, partner, mint cap)\n{table}"
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
    for pair in rows.chunks(2) {
        let [minimal, full] = pair else {
            return Err("rows come in pairs".into());
        };
        assert!(
            full.v0 > minimal.v0 && full.tabled >= minimal.tabled,
            "{minimal:?} {full:?}"
        );
    }
    let ordered = |pick: &dyn Fn(&Shape) -> bool| {
        let sizes: Vec<&Row> = rows.iter().filter(|r| pick(&r.shape)).collect();
        sizes
            .windows(2)
            .all(|w| matches!(w, [a, b] if a.tabled < b.tabled && a.v0 < b.v0))
    };
    for full in [false, true] {
        assert!(ordered(&split(full)), "splits grow with every co-author");
        for (members, _) in SPLIT_PANELS {
            assert!(
                ordered(&panel(full, members)),
                "{members}-member splits grow"
            );
        }
    }
    assert_eq!(
        largest(&rows, split(true), Row::fits_bare),
        cli_constant("split.ts", "SPLIT_FITS")?,
        "SPLIT_FITS is the largest split that fits without a lookup table whatever accounts the job carries\n{table}"
    );
    assert_eq!(
        largest(&rows, split(true), Row::fits_table),
        cli_constant("split.ts", "SPLIT_FITS_WITH_TABLE")?,
        "SPLIT_FITS_WITH_TABLE is the largest split that fits with a lookup table whatever accounts the job carries\n{table}"
    );
    assert_eq!(
        largest(&rows, split(false), Row::fits_bare),
        MINIMAL_SPLIT_FITS
    );
    assert_eq!(
        largest(&rows, split(false), Row::fits_table),
        MINIMAL_SPLIT_FITS_WITH_TABLE
    );
    assert_eq!(
        largest(&rows, split(true), Row::fits_table),
        LANDABLE_SPLIT,
        "the split fuzz covers every split that can land\n{table}"
    );
    let worst = |fits: fn(&Row) -> bool| {
        SPLIT_PANELS
            .iter()
            .map(|(members, _)| largest(&rows, panel(true, *members), fits))
            .min()
            .unwrap_or(0)
    };
    assert_eq!(
        worst(Row::fits_bare),
        cli_constant("committee-split.ts", "COMMITTEE_SPLIT_FITS")?,
        "COMMITTEE_SPLIT_FITS holds for every committee and every account set\n{table}"
    );
    assert_eq!(
        worst(Row::fits_table),
        cli_constant("committee-split.ts", "COMMITTEE_SPLIT_FITS_WITH_TABLE")?,
        "COMMITTEE_SPLIT_FITS_WITH_TABLE holds for every committee and every account set\n{table}"
    );
    assert_eq!(
        largest(&rows, panel(false, 3), Row::fits_bare),
        MINIMAL_PANEL_SPLIT_FITS
    );
    assert_eq!(
        largest(&rows, panel(false, 3), Row::fits_table),
        MINIMAL_PANEL_SPLIT_FITS_WITH_TABLE
    );
    assert_eq!(
        committee_members(&rows, false),
        COMMITTEE_FITS_MEMBERS,
        "{table}"
    );
    assert_eq!(
        committee_members(&rows, true),
        FULL_COMMITTEE_FITS_MEMBERS,
        "{table}"
    );
    assert!(
        rows.iter()
            .filter(|r| r.shape.kind == ReleaseKind::Committee)
            .all(Row::fits_table),
        "every committee pays one payee once wallet_committee_release is given a lookup table\n{table}"
    );
    assert!(
        rows.iter()
            .filter(|r| r.shape.kind.split() && r.shape.recipients == MAX_SPLIT_RECIPIENTS)
            .all(|r| !r.fits_table()),
        "the {MAX_SPLIT_RECIPIENTS}-recipient cap cannot ride one transaction even with a lookup table\n{table}"
    );
    Ok(())
}

use intent_core::bounty::split_n;
use intent_core::Error;

#[test]
fn a_split_awards_rounding_dust_to_the_lowest_index_among_the_tied_maximum_weights(
) -> Result<(), Error> {
    let canonical = split_n(101, &[2500, 2500, 2500, 2500])?;
    assert_eq!(canonical.as_slice(), &[26, 25, 25, 25]);
    assert_eq!(canonical.total(), 101);

    let two_way = split_n(101, &[5000, 5000])?;
    assert_eq!(two_way.as_slice(), &[51, 50]);
    assert_eq!(two_way.total(), 101);

    let two_way_big_dust = split_n(7, &[5000, 5000])?;
    assert_eq!(two_way_big_dust.as_slice(), &[4, 3]);
    assert_eq!(two_way_big_dust.total(), 7);

    let leading_subset = split_n(101, &[4000, 4000, 2000])?;
    assert_eq!(leading_subset.as_slice(), &[41, 40, 20]);
    assert_eq!(leading_subset.total(), 101);

    let trailing_subset = split_n(101, &[2000, 4000, 4000])?;
    assert_eq!(trailing_subset.as_slice(), &[20, 41, 40]);
    assert_eq!(trailing_subset.total(), 101);

    let four_way_subset = split_n(101, &[3000, 3000, 3000, 1000])?;
    assert_eq!(four_way_subset.as_slice(), &[31, 30, 30, 10]);
    assert_eq!(four_way_subset.total(), 101);

    let sixteen_way = split_n(7, &[625; 16])?;
    assert_eq!(
        sixteen_way.as_slice(),
        &[7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    );
    assert_eq!(sixteen_way.total(), 7);

    let sixteen_way_small_dust = split_n(10_003, &[625; 16])?;
    assert_eq!(
        sixteen_way_small_dust.as_slice(),
        &[628, 625, 625, 625, 625, 625, 625, 625, 625, 625, 625, 625, 625, 625, 625, 625]
    );
    assert_eq!(sixteen_way_small_dust.total(), 10_003);

    Ok(())
}

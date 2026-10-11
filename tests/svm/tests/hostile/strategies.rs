fn mutation() -> impl Strategy<Value = Mutation> {
    prop_oneof![
        3 => (0..20usize, 0..64usize).prop_map(|(slot, pick)| Mutation::Account { slot, pick }),
        4 => (0..20usize, 0..64usize).prop_map(|(slot, pick)| Mutation::TokenAccount { slot, pick }),
        1 => (0..20usize, 0..20usize).prop_map(|(a, b)| Mutation::Swap { a, b }),
        1 => (0..48usize).prop_map(|len| Mutation::Truncate { len }),
        1 => any::<u8>().prop_map(|byte| Mutation::Append { byte }),
        2 => (0..48usize, 1..=255u8).prop_map(|(at, mask)| Mutation::Flip { at, mask }),
        2 => (0..24usize, prop::sample::select(WORDS.to_vec())).prop_map(|(at, value)| Mutation::Word { at, value }),
        1 => (0..6usize).prop_map(|pick| Mutation::Ext { pick }),
    ]
}

mod spl {
    const PROGRAM: anchor_lang::prelude::Pubkey = anchor_spl::token::ID;
    const CU_SUFFIX: &str = "";
    include!("cases/flash.rs");
}

mod token_2022 {
    const PROGRAM: anchor_lang::prelude::Pubkey = anchor_spl::token_2022::ID;
    const CU_SUFFIX: &str = "_token_2022";
    include!("cases/flash.rs");
}

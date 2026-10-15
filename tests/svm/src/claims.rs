use super::*;

pub fn claims_pda(intent: &Pubkey) -> Pubkey {
    pda(&[CLAIMS_SEED, intent.as_ref()])
}

pub fn open_claims_ix(owner: &Pubkey, intent: &Pubkey, max_secs: u32, stake: u64) -> Instruction {
    engine_ix(
        intent_engine::accounts::OpenClaims {
            owner: *owner,
            intent: *intent,
            board: claims_pda(intent),
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::OpenClaims { max_secs, stake },
    )
}

pub fn claim_job_ix(worker: &Pubkey, intent: &Pubkey, owner: &Pubkey, secs: u32) -> Instruction {
    engine_ix(
        intent_engine::accounts::ClaimJob {
            worker: *worker,
            intent: *intent,
            board: claims_pda(intent),
            owner: *owner,
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::ClaimJob { secs },
    )
}

pub fn drop_claim_ix(worker: &Pubkey, intent: &Pubkey) -> Instruction {
    engine_ix(
        intent_engine::accounts::DropClaim {
            worker: *worker,
            intent: *intent,
            board: claims_pda(intent),
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::DropClaim {},
    )
}

pub fn settle_claims_ix(intent: &Pubkey, owner: &Pubkey, worker: Option<&Pubkey>) -> Instruction {
    engine_ix(
        intent_engine::accounts::SettleClaims {
            board: claims_pda(intent),
            intent: *intent,
            owner: *owner,
            worker: worker.copied(),
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::SettleClaims {},
    )
}

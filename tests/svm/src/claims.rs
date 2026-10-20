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
            config: config_pda(),
            owner: *owner,
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::ClaimJob { secs },
    )
}

pub fn standby_pda(intent: &Pubkey, seq: u32) -> Pubkey {
    pda(&[STANDBY_SEED, intent.as_ref(), &seq.to_le_bytes()])
}

fn entry(entries: &[Pubkey], i: usize) -> Option<Pubkey> {
    entries.get(i).copied()
}

pub fn drop_claim_ix(worker: &Pubkey, intent: &Pubkey) -> Instruction {
    drop_claim_line_ix(worker, intent, &[], None)
}

pub fn drop_claim_line_ix(
    worker: &Pubkey,
    intent: &Pubkey,
    entries: &[Pubkey],
    next_worker: Option<&Pubkey>,
) -> Instruction {
    engine_ix(
        intent_engine::accounts::DropClaim {
            worker: *worker,
            intent: *intent,
            board: claims_pda(intent),
            next_worker: next_worker.copied(),
            entry_0: entry(entries, 0),
            entry_1: entry(entries, 1),
            entry_2: entry(entries, 2),
            entry_3: entry(entries, 3),
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::DropClaim {},
    )
}

pub fn stand_by_ix(worker: &Pubkey, intent: &Pubkey, seq: u32, secs: u32) -> Instruction {
    engine_ix(
        intent_engine::accounts::StandBy {
            worker: *worker,
            intent: *intent,
            board: claims_pda(intent),
            config: config_pda(),
            entry: standby_pda(intent, seq),
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::StandBy { secs },
    )
}

pub fn advance_ix(
    intent: &Pubkey,
    owner: &Pubkey,
    entries: &[Pubkey],
    next_worker: Option<&Pubkey>,
) -> Instruction {
    engine_ix(
        intent_engine::accounts::Advance {
            intent: *intent,
            board: claims_pda(intent),
            owner: *owner,
            next_worker: next_worker.copied(),
            entry_0: entry(entries, 0),
            entry_1: entry(entries, 1),
            entry_2: entry(entries, 2),
            entry_3: entry(entries, 3),
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::Advance {},
    )
}

pub fn leave_ix(caller: &Pubkey, intent: &Pubkey, seq: u32, worker: &Pubkey) -> Instruction {
    engine_ix(
        intent_engine::accounts::Leave {
            caller: *caller,
            intent: *intent,
            entry: standby_pda(intent, seq),
            worker: *worker,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::Leave { seq },
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

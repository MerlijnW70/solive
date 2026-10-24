use super::*;
use intent_core::delivery::{BLOB_VERSION, FINGERPRINT_LEN};
use intent_engine::state::{ANNOUNCEMENT_SEED, DELIVERY_BOOK_SEED, PROFILE_SEED};

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[bytes]).to_bytes()
}

pub fn book_pda(intent: &Pubkey) -> Pubkey {
    pda(&[DELIVERY_BOOK_SEED, intent.as_ref()])
}

pub fn announcement_pda(intent: &Pubkey, worker: &Pubkey, blob: &[u8]) -> Pubkey {
    pda(&[
        ANNOUNCEMENT_SEED,
        intent.as_ref(),
        worker.as_ref(),
        sha256(blob).as_ref(),
    ])
}

pub fn profile_pda(wallet: &Pubkey) -> Pubkey {
    pda(&[PROFILE_SEED, wallet.as_ref()])
}

pub fn test_blob(mask: u8, fps: &[[u8; FINGERPRINT_LEN]], url_len: usize, fill: u8) -> Vec<u8> {
    let count = u8::try_from(fps.len()).unwrap_or(u8::MAX);
    let mut blob = vec![BLOB_VERSION, count, mask];
    for fp in fps {
        blob.extend_from_slice(fp);
    }
    let rest = 32usize
        .saturating_add(32)
        .saturating_add(32usize.saturating_mul(fps.len()))
        .saturating_add(16)
        .saturating_add(url_len)
        .saturating_add(16);
    blob.extend(core::iter::repeat_n(fill, rest));
    blob
}

#[derive(Clone)]
pub struct Announce {
    pub worker: Pubkey,
    pub payer: Pubkey,
    pub intent: Pubkey,
    pub attestor: Pubkey,
    pub commitment: [u8; 32],
    pub blob: Vec<u8>,
    pub profile: bool,
    pub committee: bool,
    pub board: Option<Pubkey>,
    pub claim_list: Option<Pubkey>,
    pub fee_to: Option<Pubkey>,
}

impl Announce {
    pub fn new(worker: Pubkey, intent: Pubkey, attestor: Pubkey, blob: Vec<u8>) -> Self {
        Self {
            worker,
            payer: worker,
            intent,
            attestor,
            commitment: [7; 32],
            blob,
            profile: true,
            committee: false,
            board: None,
            claim_list: None,
            fee_to: None,
        }
    }

    pub fn address(&self) -> Pubkey {
        announcement_pda(&self.intent, &self.worker, &self.blob)
    }

    pub fn ix(&self) -> Instruction {
        engine_ix(
            intent_engine::accounts::AnnounceDelivery {
                worker: self.worker,
                payer: self.payer,
                config: config_pda(),
                intent: self.intent,
                attestor: self.attestor,
                judge_profile: self.profile.then(|| profile_pda(&self.attestor)),
                committee: self.committee.then_some(self.attestor),
                board: self.board,
                claim_list: self.claim_list,
                book: book_pda(&self.intent),
                announcement: self.address(),
                fee_to: self.fee_to,
                system_program: anchor_lang::system_program::ID,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::AnnounceDelivery {
                commitment: self.commitment,
                blob_hash: sha256(&self.blob),
                blob: self.blob.clone(),
            },
        )
    }
}

pub fn set_announce_fee_ix(admin: &Pubkey, fee: u32) -> Instruction {
    engine_ix(
        intent_engine::accounts::SetAnnounceFee {
            admin: *admin,
            config: config_pda(),
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::SetAnnounceFee { fee },
    )
}

pub fn create_profile_ix(wallet: &Pubkey, encryption_key: [u8; 32]) -> Instruction {
    engine_ix(
        intent_engine::accounts::CreateProfile {
            wallet: *wallet,
            profile: profile_pda(wallet),
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::CreateProfile {
            args: intent_engine::ProfileFields {
                skills: vec!["judge".to_owned()],
                endpoint: "https://judge.example".to_owned(),
                doc_url: String::new(),
                doc_hash: [0; 32],
                encryption_key,
            },
        },
    )
}

pub fn update_profile_ix(wallet: &Pubkey, encryption_key: [u8; 32]) -> Instruction {
    engine_ix(
        intent_engine::accounts::UpdateProfile {
            wallet: *wallet,
            profile: profile_pda(wallet),
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::UpdateProfile {
            args: intent_engine::ProfileFields {
                skills: vec!["judge".to_owned()],
                endpoint: "https://judge.example".to_owned(),
                doc_url: String::new(),
                doc_hash: [0; 32],
                encryption_key,
            },
        },
    )
}

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

pub fn sync_committee_keys_ix(committee: &Pubkey, profiles: &[Pubkey]) -> Instruction {
    let mut ix = engine_ix(
        intent_engine::accounts::SyncCommitteeKeys {
            committee: *committee,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::SyncCommitteeKeys {},
    );
    ix.accounts.extend(
        profiles
            .iter()
            .map(|p| solana_instruction::AccountMeta::new_readonly(*p, false)),
    );
    ix
}

pub const DELIVERED: [u8; 32] = [0xd1; 32];
pub const SALT: [u8; 16] = [0x5a; 16];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Delivery {
    pub announcement: Pubkey,
    pub seq: u64,
    pub opening: intent_engine::Opening,
}

pub fn commitment_of(
    intent: &Pubkey,
    worker: &Pubkey,
    salt: &[u8; 16],
    sha256: &[u8; 32],
) -> [u8; 32] {
    let preimage = intent_core::delivery::commitment_preimage(
        &intent.to_bytes(),
        &worker.to_bytes(),
        salt,
        sha256,
    );
    solana_sha256_hasher::hashv(&[&preimage]).to_bytes()
}

impl Env {
    pub fn delivery_blob(
        &mut self,
        intent: &Pubkey,
        attestor: &Pubkey,
    ) -> TestResult<(Vec<u8>, bool)> {
        let fill = self
            .svm
            .get_account(&book_pda(intent))
            .and_then(|a| a.data.get(72).copied())
            .unwrap_or(0);
        let committee = self
            .svm
            .get_account(attestor)
            .is_some_and(|a| a.owner == intent_engine::ID);
        if committee {
            let stored: intent_engine::state::Committee = load(&self.svm, attestor)?;
            if stored.keys_synced == 0 {
                let profiles: Vec<Pubkey> = stored
                    .members
                    .iter()
                    .take(usize::from(stored.count))
                    .map(profile_pda)
                    .collect();
                let payer = self.funded()?;
                self.send(&payer, &[sync_committee_keys_ix(attestor, &profiles)], &[])?;
            }
            let synced: intent_engine::state::Committee = load(&self.svm, attestor)?;
            let fps: Vec<[u8; FINGERPRINT_LEN]> = synced
                .key_fps
                .iter()
                .take(usize::from(synced.count))
                .copied()
                .collect();
            return Ok((test_blob(synced.keys_mask, &fps, 40, fill), true));
        }
        let key = self
            .svm
            .get_account(&profile_pda(attestor))
            .filter(|a| a.owner == intent_engine::ID)
            .map(|_| load::<intent_engine::state::Profile>(&self.svm, &profile_pda(attestor)))
            .transpose()?
            .map(|p| p.encryption_key)
            .filter(|k| *k != [0; 32]);
        Ok(match key {
            Some(key) => (
                test_blob(1, &[intent_engine::delivery::fingerprint(&key)], 40, fill),
                false,
            ),
            None => (test_blob(0, &[[0; FINGERPRINT_LEN]], 40, fill), false),
        })
    }

    pub fn announce_for(&mut self, worker: &Keypair, intent: &Pubkey) -> TestResult<Delivery> {
        let stored: intent_engine::state::Intent = load(&self.svm, intent)?;
        let attestor = match intent_core::kinds::Intent::decode(stored.kind, &stored.params)
            .map_err(|e| format!("{e:?}"))?
        {
            intent_core::kinds::Intent::AttestedResult(p) => Pubkey::new_from_array(p.attestor),
            _ => return Err("announce_for needs an attested intent".into()),
        };
        let (blob, committee) = self.delivery_blob(intent, &attestor)?;
        let claims_open = stored.claims == intent_engine::state::CLAIMS_OPEN;
        let list = claim_list_pda(intent);
        let a = Announce {
            commitment: commitment_of(intent, &worker.pubkey(), &SALT, &DELIVERED),
            profile: !committee,
            committee,
            board: claims_open.then(|| claims_pda(intent)),
            claim_list: (claims_open && self.svm.get_account(&list).is_some()).then_some(list),
            fee_to: (self.config()?.announce_fee > 0).then_some(self.fee_recipient),
            ..Announce::new(worker.pubkey(), *intent, attestor, blob)
        };
        let funded = worker.insecure_clone();
        self.send(&funded, &[a.ix()], &[])?;
        let made: intent_engine::state::Announcement = load(&self.svm, &a.address())?;
        let opening = intent_engine::Opening {
            delivered: DELIVERED,
            salt: SALT,
        };
        self.announcement = Some(a.address());
        self.opening = opening;
        Ok(Delivery {
            announcement: a.address(),
            seq: made.seq,
            opening,
        })
    }
}

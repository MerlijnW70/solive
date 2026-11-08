use super::*;
use std::collections::HashMap;
use std::sync::OnceLock;

use litesvm::types::FailedTransactionMetadata;
use solana_address_lookup_table_interface::instruction as table_ix;
use solana_message::{v0, AddressLookupTableAccount, VersionedMessage};
use solana_slot_hashes::SlotHashes;
use solana_transaction::versioned::VersionedTransaction;

pub const PACKET_DATA_SIZE: usize = 1_232;
pub const TABLE_EXTEND_CHUNK: usize = 20;

pub fn wire_size(tx: &VersionedTransaction) -> usize {
    bincode::serialized_size(tx)
        .ok()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(usize::MAX)
}

fn engine_names() -> &'static HashMap<Vec<u8>, String> {
    static NAMES: OnceLock<HashMap<Vec<u8>, String>> = OnceLock::new();
    NAMES.get_or_init(|| {
        let idl: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../idl/intent_engine.json"
        )))
        .unwrap_or_default();
        idl.get("instructions")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|ix| {
                let name = ix.get("name")?.as_str()?.to_owned();
                let discriminator = ix
                    .get("discriminator")?
                    .as_array()?
                    .iter()
                    .map(|b| b.as_u64().and_then(|b| u8::try_from(b).ok()))
                    .collect::<Option<Vec<u8>>>()?;
                Some((discriminator, name))
            })
            .collect()
    })
}

pub fn unsigned_size(message: &VersionedMessage) -> usize {
    let signatures = usize::from(message.header().num_required_signatures);
    let prefix = if signatures < 0x80 { 1 } else { 2 };
    signatures
        .saturating_mul(64)
        .saturating_add(prefix)
        .saturating_add(message.serialize().len())
}

pub fn legacy_size(payer: &Pubkey, ixs: &[Instruction]) -> usize {
    unsigned_size(&VersionedMessage::Legacy(Message::new(ixs, Some(payer))))
}

pub fn v0_size(
    payer: &Pubkey,
    ixs: &[Instruction],
    tables: &[AddressLookupTableAccount],
) -> TestResult<usize> {
    let message = v0::Message::try_compile(payer, ixs, tables, solana_message::Hash::default())
        .map_err(|e| format!("{e:?}"))?;
    Ok(unsigned_size(&VersionedMessage::V0(message)))
}

pub fn instruction_names(message: &VersionedMessage) -> Vec<String> {
    let keys = message.static_account_keys();
    message
        .instructions()
        .iter()
        .map(|ix| {
            let program = keys
                .get(usize::from(ix.program_id_index))
                .copied()
                .unwrap_or_default();
            let named = [intent_engine::ID, RELAY_ID]
                .contains(&program)
                .then(|| ix.data.get(..8).and_then(|d| engine_names().get(d)))
                .flatten();
            match named {
                Some(name) if program == RELAY_ID => format!("relayed {name}"),
                Some(name) => name.clone(),
                None => program.to_string(),
            }
        })
        .collect()
}

pub fn oversize(tx: &VersionedTransaction) -> Option<String> {
    let size = wire_size(tx);
    (size > PACKET_DATA_SIZE).then(|| {
        format!(
            "a {size}-byte transaction is over the {PACKET_DATA_SIZE}-byte packet limit and cannot land on a cluster: {}",
            instruction_names(&tx.message).join(", ")
        )
    })
}

pub fn assert_sendable(tx: &VersionedTransaction) {
    let problem = oversize(tx);
    assert!(problem.is_none(), "{}", problem.unwrap_or_default());
}

pub fn unused_tables(
    message: &VersionedMessage,
    tables: &[AddressLookupTableAccount],
) -> Vec<Pubkey> {
    let used: Vec<Pubkey> = message
        .address_table_lookups()
        .unwrap_or_default()
        .iter()
        .map(|l| l.account_key)
        .collect();
    tables
        .iter()
        .map(|t| t.key)
        .filter(|k| !used.contains(k))
        .collect()
}

pub fn send_sendable(
    svm: &mut LiteSVM,
    tx: impl Into<VersionedTransaction>,
) -> Result<TransactionMetadata, Box<FailedTransactionMetadata>> {
    let tx = tx.into();
    assert_sendable(&tx);
    svm.send_transaction(tx).map_err(Box::new)
}

pub fn table_accounts(ixs: &[Instruction]) -> Vec<Pubkey> {
    let invoked: Vec<Pubkey> = ixs.iter().map(|ix| ix.program_id).collect();
    let mut keys: Vec<Pubkey> = Vec::new();
    for meta in ixs.iter().flat_map(|ix| ix.accounts.iter()) {
        if !meta.is_signer && !invoked.contains(&meta.pubkey) && !keys.contains(&meta.pubkey) {
            keys.push(meta.pubkey);
        }
    }
    keys
}

impl Env {
    pub fn send_tabled(
        &mut self,
        payer: &Keypair,
        ixs: &[Instruction],
        extra: &[&Keypair],
    ) -> Result<TransactionMetadata, TransactionError> {
        let table = self.lookup_table(&table_accounts(ixs))?;
        self.send_v0(payer, ixs, extra, &[table])
    }

    pub fn lookup_table(
        &mut self,
        addresses: &[Pubkey],
    ) -> Result<AddressLookupTableAccount, TransactionError> {
        let authority = Keypair::new();
        self.svm
            .airdrop(&authority.pubkey(), FUNDING)
            .map_err(|f| f.err)?;
        let slot = self.svm.get_sysvar::<Clock>().slot;
        let mut hashes: Vec<_> = self
            .svm
            .get_sysvar::<SlotHashes>()
            .iter()
            .copied()
            .collect();
        if !hashes.iter().any(|(s, _)| *s == slot) {
            hashes.insert(0, (slot, self.svm.latest_blockhash()));
            self.svm.set_sysvar(&SlotHashes::new(&hashes));
        }
        let (create, key) =
            table_ix::create_lookup_table(authority.pubkey(), authority.pubkey(), slot);
        self.send(&authority, &[create], &[])?;
        for chunk in addresses.chunks(TABLE_EXTEND_CHUNK) {
            let extend = table_ix::extend_lookup_table(
                key,
                authority.pubkey(),
                Some(authority.pubkey()),
                chunk.to_vec(),
            );
            self.send(&authority, &[extend], &[])?;
        }
        self.svm.warp_to_slot(slot.saturating_add(1));
        Ok(AddressLookupTableAccount {
            key,
            addresses: addresses.to_vec(),
        })
    }

    pub fn v0_transaction(
        &mut self,
        payer: &Keypair,
        ixs: &[Instruction],
        extra: &[&Keypair],
        tables: &[AddressLookupTableAccount],
    ) -> Result<VersionedTransaction, TransactionError> {
        self.svm.expire_blockhash();
        let message = VersionedMessage::V0(
            v0::Message::try_compile(&payer.pubkey(), ixs, tables, self.svm.latest_blockhash())
                .map_err(|_| TransactionError::SanitizeFailure)?,
        );
        let unused = unused_tables(&message, tables);
        assert!(
            unused.is_empty(),
            "lookup tables {unused:?} resolve no account of this transaction"
        );
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra);
        VersionedTransaction::try_new(message, &signers)
            .map_err(|_| TransactionError::SignatureFailure)
    }

    pub fn send_v0(
        &mut self,
        payer: &Keypair,
        ixs: &[Instruction],
        extra: &[&Keypair],
        tables: &[AddressLookupTableAccount],
    ) -> Result<TransactionMetadata, TransactionError> {
        let tx = self.v0_transaction(payer, ixs, extra, tables)?;
        send_sendable(&mut self.svm, tx).map_err(|f| f.err)
    }
}

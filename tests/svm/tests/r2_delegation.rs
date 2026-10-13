use intent_engine::errors::EngineError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    ed25519_ix, engine_error_at, swap_spec, Env, IntentSpec, Market, TestResult, Trader, DOMAIN,
    START_TS,
};

const PROGRAM: anchor_lang::prelude::Pubkey = anchor_spl::token::ID;
const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SUBMIT_BY: i64 = START_TS + 600;

struct Setup {
    env: Env,
    market: Market,
    trader: Trader,
    relayer: Keypair,
    spec: IntentSpec,
}

fn setup() -> TestResult<Setup> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    env.approve_delegate(&trader, &market, ESCROW)?;
    let relayer = env.funded()?;
    let spec = swap_spec(7, ESCROW)?;
    Ok(Setup {
        env,
        market,
        trader,
        relayer,
        spec,
    })
}

impl Setup {
    fn create(&self, spec: &IntentSpec) -> anchor_lang::solana_program::instruction::Instruction {
        self.env.create_signed_ix(
            &self.relayer.pubkey(),
            &self.trader,
            &self.market,
            spec,
            SUBMIT_BY,
        )
    }

    fn submit(
        &mut self,
        ixs: &[anchor_lang::solana_program::instruction::Instruction],
    ) -> Result<litesvm::types::TransactionMetadata, TransactionError> {
        let relayer = self.relayer.insecure_clone();
        self.env.send(&relayer, ixs, &[])
    }
}

#[test]
fn a_signature_bound_to_another_cluster_domain_cannot_be_relayed() -> TestResult {
    let mut s = setup()?;
    let owner = s.trader.key.pubkey().to_bytes();
    let foreign = intent_core::sig::SignedIntent {
        program: intent_engine::ID.to_bytes(),
        domain: [0x99; 32],
        owner,
        owner_input: s.trader.input.to_bytes(),
        input_mint: s.market.input_mint.to_bytes(),
        output_mint: s.market.output_mint.to_bytes(),
        receiver: s.trader.receiver.to_bytes(),
        nonce: s.spec.nonce,
        expires_at: s.spec.expires_at,
        submit_by: SUBMIT_BY,
        kind: s.spec.kind,
        flags: s.spec.flags,
        params: &s.spec.params,
        epoch: 0,
        ext_hash: solana_sha256_hasher::hashv(&[&s.spec.ext]).to_bytes(),
        relayer_fee: 0,
    };
    assert_ne!(
        foreign.domain, DOMAIN,
        "the test domain must differ from config"
    );
    let digest = solana_sha256_hasher::hashv(&[&foreign.preimage()]).to_bytes();
    let envelope = intent_core::sig::offchain_envelope(&owner, &digest);
    let ixs = [ed25519_ix(&s.trader.key, &envelope), s.create(&s.spec)];
    assert_eq!(
        s.submit(&ixs).err(),
        Some(engine_error_at(1, EngineError::SigMessage))
    );
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED);
    Ok(())
}

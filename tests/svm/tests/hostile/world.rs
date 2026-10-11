#![allow(dead_code)]

use anchor_spl::token_2022::spl_token_2022::state::Mint as MintState;
use intent_core::kinds::{attested_result, dutch_auction, limit_order, Intent as CoreIntent, Kind};
use intent_core::lifecycle::Status;
use intent_core::mandate::{in_lane, MANDATE_NONCE_BIT};
use litesvm::types::FailedTransactionMetadata;

use anchor_lang::prelude::Pubkey;
use anchor_spl::token_2022::spl_token_2022::extension::StateWithExtensions;
use solana_instruction::Instruction;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use svm_tests::{
    agent_lane, attestation_message, canonical_refund, config_pda, delegate_pda, ed25519_ix,
    event_authority, intent_pda, mandate_pda, mandate_terms, swap_spec, user_pda, vault_pda, Env,
    IntentSpec, Market, MintExt, Solver, TestResult, Trader, DOMAIN,
};

pub const FUNDED: u64 = 10_000;
pub const SOLVER_FUNDS: u64 = 5_000;
pub const ESCROW: u64 = 300;
pub const VICTIM: usize = 1;
pub const AGENT_NONCES: [u64; 3] = [
    MANDATE_NONCE_BIT | (1 << 32) | 10,
    MANDATE_NONCE_BIT | (1 << 32) | 11,
    MANDATE_NONCE_BIT | (1 << 32) | 12,
];
pub const SCANNED_NONCES: u64 = 16;
pub const MANDATE_LIMITS: intent_core::mandate::Limits = intent_core::mandate::Limits {
    kinds: 0b10,
    per_intent: ESCROW,
    total: 2 * ESCROW,
    max_intents: 2,
    max_ttl: 240,
    valid_until: i64::MAX,
    floor_out: 1,
    floor_in: 10,
    agent_fee: 7,
};

#[derive(Debug, Clone)]
pub enum Mutation {
    Account { slot: usize, pick: usize },
    TokenAccount { slot: usize, pick: usize },
    Swap { a: usize, b: usize },
    Truncate { len: usize },
    Append { byte: u8 },
    Flip { at: usize, mask: u8 },
    Word { at: usize, value: u64 },
    Ext { pick: usize },
}

pub const WORDS: [u64; 8] = [
    0,
    1,
    ESCROW - 1,
    ESCROW,
    ESCROW + 1,
    1 << 32,
    u64::MAX - 1,
    u64::MAX,
];

pub fn ext_payload(pick: usize) -> Vec<u8> {
    match pick % 6 {
        0 => vec![1, 0, 0],
        1 => vec![0, 0, 0],
        2 => vec![1, 5, 0],
        3 => vec![7],
        4 => [vec![1, 0xfd, 0x01], vec![0; 509]].concat(),
        _ => [vec![1, 0xfe, 0x01], vec![0; 510]].concat(),
    }
}

pub struct Tracked {
    pub owner: Pubkey,
    pub nonce: u64,
    pub receiver: Pubkey,
}

pub struct World {
    pub env: Env,
    pub market: Market,
    pub traders: Vec<Trader>,
    pub attacker: Solver,
    pub relayer: Keypair,
    pub attestor: Keypair,
    pub fee_to: Pubkey,
    pub tracked: Vec<Tracked>,
    pub pool: Vec<Pubkey>,
    pub tokens: Vec<Pubkey>,
    pub stash: Pubkey,
    pub mandate: Pubkey,
    pub captured: Vec<Instruction>,
    pub agent_fees: Pubkey,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Seen {
    status: Option<u8>,
    escrowed: u64,
    vault: u64,
    receiver: u64,
    filled: u64,
    revision: u32,
    in_flight: u64,
    bounty: u32,
    lamports: u64,
    vault_lamports: u64,
    agent_fee: u64,
}

pub const BOUNTY: u32 = 50_000;
pub const CREATE_FEE: u32 = 10_000;
pub const ECONOMICS: intent_engine::Economics = intent_engine::Economics {
    kind_fee_mask: 0,
    kind_fee_bps: [0; 4],
    partner_cut_bps: 0,
    crank_bounty: BOUNTY,
    create_fee: CREATE_FEE,
};

impl World {
    pub fn new(program: Pubkey) -> TestResult<Self> {
        Self::with_mints(program, &[])
    }

    pub fn with_mints(program: Pubkey, exts: &[MintExt]) -> TestResult<Self> {
        let mut env = Env::new()?;
        env.init_config()?;
        let admin = env.authority.insecure_clone();
        let ix = env.economics_ix(&admin.pubkey(), ECONOMICS);
        env.send(&admin, &[ix], &[])?;
        let market = env.market(program, exts, program, exts)?;
        let traders = vec![env.trader(&market, FUNDED)?, env.trader(&market, FUNDED)?];
        let attacker = env.solver(&market, SOLVER_FUNDS)?;
        let fee_to = env.fee_account(&market)?;
        let relayer = env.funded()?;
        let attestor = Keypair::new();
        let stash = env.create_token_account(
            &market.output_mint,
            &attacker.key.pubkey(),
            market.output_program,
        )?;
        let mut world = Self {
            env,
            market,
            traders,
            attacker,
            relayer,
            attestor,
            fee_to,
            tracked: Vec::new(),
            pool: Vec::new(),
            tokens: Vec::new(),
            stash,
            mandate: Pubkey::default(),
            captured: Vec::new(),
            agent_fees: Pubkey::default(),
        };
        world.open_intents()?;
        world.grant()?;
        world.pool = world.addresses();
        world.tokens = world.token_accounts();
        Ok(world)
    }

    pub fn trader(&self, i: usize) -> TestResult<&Trader> {
        Ok(self.traders.get(i).ok_or("no trader")?)
    }

    fn open_intents(&mut self) -> TestResult {
        let now = self.env.now();
        let expires_at = now.checked_add(240).ok_or("clock")?;
        let err = |e: intent_core::Error| format!("{e:?}");
        let specs = [
            swap_spec(0, ESCROW)?,
            IntentSpec {
                nonce: 1,
                kind: Kind::LimitOrder as u8,
                params: limit_order::Params {
                    make_amount: ESCROW,
                    take_amount: 40,
                }
                .encode()
                .map_err(err)?,
                expires_at,
                flags: 0,
                ext: Vec::new(),
            },
            IntentSpec {
                nonce: 2,
                kind: Kind::DutchAuction as u8,
                params: dutch_auction::Params {
                    amount_in: ESCROW,
                    start_out: 90,
                    end_out: 30,
                    start_ts: now,
                    end_ts: expires_at,
                }
                .encode()
                .map_err(err)?,
                expires_at,
                flags: 0,
                ext: Vec::new(),
            },
            IntentSpec {
                nonce: 3,
                kind: Kind::AttestedResult as u8,
                params: attested_result::Params {
                    amount_in: ESCROW,
                    min_result: 5,
                    max_result: 9,
                    attestor: self.attestor.pubkey().to_bytes(),
                }
                .encode()
                .map_err(err)?,
                expires_at,
                flags: 0,
                ext: Vec::new(),
            },
        ];
        for spec in &specs {
            let t = self.traders.first().ok_or("no trader")?;
            let (owner, receiver) = (t.key.pubkey(), t.receiver);
            self.env
                .create_intent(t, &self.market, spec)
                .map_err(|e| format!("{e:?}"))?;
            self.tracked.push(Tracked {
                owner,
                nonce: spec.nonce,
                receiver,
            });
        }
        let t = self.traders.get(1).ok_or("no trader")?;
        let key = t.key.insecure_clone();
        let (owner, receiver) = (key.pubkey(), t.receiver);
        self.env.approve_delegate(t, &self.market, ESCROW)?;
        let spec = swap_spec(4, ESCROW)?;
        let message = self
            .env
            .signed_message(t, &self.market, &spec, DOMAIN, expires_at);
        let ixs = [
            ed25519_ix(&key, &message),
            self.env
                .create_signed_ix(&self.relayer.pubkey(), t, &self.market, &spec, expires_at),
        ];
        self.captured.extend(ixs.iter().cloned());
        let relayer = self.relayer.insecure_clone();
        self.env
            .send(&relayer, &ixs, &[])
            .map_err(|e| format!("{e:?}"))?;
        self.tracked.push(Tracked {
            owner,
            nonce: 4,
            receiver,
        });
        Ok(())
    }

    fn grant(&mut self) -> TestResult {
        let victim = self.traders.get(VICTIM).ok_or("no victim")?;
        let key = victim.key.insecure_clone();
        self.env
            .approve_delegate(victim, &self.market, 10 * ESCROW)?;
        let l = MANDATE_LIMITS;
        let args = intent_engine::MandateArgs {
            kinds: l.kinds,
            per_intent: l.per_intent,
            total: l.total,
            max_intents: l.max_intents,
            max_ttl: l.max_ttl,
            floor_out: l.floor_out,
            floor_in: l.floor_in,
            agent_fee: l.agent_fee,
            ..mandate_terms(self.attacker.key.pubkey(), l.valid_until)
        };
        self.agent_fees = self.env.create_ata(
            &self.attacker.key.pubkey(),
            &self.market.input_mint,
            self.market.input_program,
        )?;
        let ix = self.env.create_mandate_ix(victim, &self.market, args);
        self.env
            .send(&key, &[ix], &[])
            .map_err(|e| format!("{e:?}"))?;
        self.mandate = mandate_pda(&key.pubkey(), &self.attacker.key.pubkey(), 0);
        Ok(())
    }

    pub fn victim_intents(&self) -> TestResult<Vec<u64>> {
        let owner = self.trader(VICTIM)?.key.pubkey();
        Ok((0..SCANNED_NONCES)
            .flat_map(|n| [n, agent_lane(1, n), agent_lane(2, n), MANDATE_NONCE_BIT | n])
            .filter(|n| self.env.exists(&intent_pda(&owner, *n)))
            .collect())
    }

    pub fn addresses(&self) -> Vec<Pubkey> {
        let mut keys = vec![
            self.attacker.key.pubkey(),
            self.attacker.input,
            self.attacker.output,
            self.relayer.pubkey(),
            self.attestor.pubkey(),
            self.stash,
            self.fee_to,
            self.agent_fees,
            self.market.input_mint,
            self.market.output_mint,
            self.market.input_program,
            config_pda(),
            event_authority(),
            intent_engine::ID,
            anchor_spl::token::ID,
            anchor_spl::token_2022::ID,
            anchor_spl::associated_token::ID,
            anchor_lang::system_program::ID,
            solana_instructions_sysvar::ID,
            self.mandate,
            Pubkey::new_unique(),
        ];
        for t in &self.traders {
            let owner = t.key.pubkey();
            keys.extend([
                owner,
                t.input,
                t.receiver,
                user_pda(&owner),
                delegate_pda(&owner),
            ]);
        }
        for i in &self.tracked {
            let intent = intent_pda(&i.owner, i.nonce);
            keys.extend([intent, vault_pda(&intent)]);
        }
        keys
    }

    pub fn token_accounts(&self) -> Vec<Pubkey> {
        let mut keys = vec![
            self.attacker.input,
            self.attacker.output,
            self.stash,
            self.fee_to,
            self.agent_fees,
        ];
        for t in &self.traders {
            keys.extend([t.input, t.receiver]);
        }
        for i in &self.tracked {
            keys.push(vault_pda(&intent_pda(&i.owner, i.nonce)));
        }
        keys
    }

    pub fn bases(&self) -> TestResult<Vec<Vec<Instruction>>> {
        let me = self.attacker.key.pubkey();
        let now = self.env.now();
        let mut out = Vec::new();
        for i in &self.tracked {
            let required = self
                .env
                .intent(&i.owner, i.nonce)
                .ok()
                .and_then(|state| {
                    CoreIntent::decode(state.kind, &state.params)
                        .ok()?
                        .required_out(state.escrowed, now)
                        .ok()
                })
                .unwrap_or(1);
            out.push(vec![self.env.fill_ix(
                &self.attacker,
                &i.owner,
                &self.market,
                i.nonce,
                &i.receiver,
                Some(&self.fee_to),
                required,
            )]);
            out.push(vec![
                self.env.begin_fill_ix(
                    &me,
                    &i.owner,
                    &self.market,
                    i.nonce,
                    &self.attacker.input,
                    Some(&self.fee_to),
                    1,
                ),
                self.env.end_fill_ix(
                    &me,
                    &i.owner,
                    &self.market,
                    i.nonce,
                    &i.receiver,
                    &self.attacker.output,
                    required,
                ),
            ]);
            let intent = intent_pda(&i.owner, i.nonce);
            let message = attestation_message(
                DOMAIN,
                &self.attestor.pubkey(),
                &intent,
                &self.attacker.input,
                ESCROW,
                7,
            );
            out.push(vec![
                ed25519_ix(&self.attestor, &message),
                self.env.fill_attested_ix(
                    &me,
                    &i.owner,
                    &self.market,
                    i.nonce,
                    &self.attacker.input,
                    Some(&self.fee_to),
                    7,
                ),
            ]);
            out.push(vec![self.env.cancel_ix(
                &i.owner,
                &self.market,
                i.nonce,
                &self.attacker.input,
            )]);
            out.push(vec![self.env.expire_ix(
                &me,
                &i.owner,
                &self.market,
                i.nonce,
                &self.attacker.input,
            )]);
            out.push(vec![self.env.close_ix(
                &i.owner,
                &self.market,
                i.nonce,
                &self.attacker.input,
            )]);
        }
        let victim = self.trader(VICTIM)?;
        let victim_owner = victim.key.pubkey();
        for nonce in AGENT_NONCES {
            let spec = IntentSpec {
                params: intent_core::kinds::swap_exact_in::Params {
                    amount_in: ESCROW
                        .checked_sub(MANDATE_LIMITS.agent_fee)
                        .ok_or("agent fee above escrow")?,
                    min_out: 30,
                }
                .encode()
                .map_err(|e| format!("{e:?}"))?,
                expires_at: now.saturating_add(200),
                ..swap_spec(nonce, ESCROW)?
            };
            out.push(vec![self.env.agent_intent_ix(
                &me,
                self.mandate,
                victim,
                &self.market,
                &spec,
            )]);
        }
        let err = |e: intent_core::Error| format!("{e:?}");
        let swap = |amount_in, min_out| {
            intent_core::kinds::swap_exact_in::Params { amount_in, min_out }
                .encode()
                .map_err(err)
        };
        let beyond = [
            (swap(ESCROW, 29)?, Kind::SwapExactIn, 200),
            (swap(ESCROW + 1, 40)?, Kind::SwapExactIn, 200),
            (swap(ESCROW, 30)?, Kind::SwapExactIn, 241),
            (
                limit_order::Params {
                    make_amount: ESCROW,
                    take_amount: 30,
                }
                .encode()
                .map_err(err)?,
                Kind::LimitOrder,
                200,
            ),
        ];
        for (params, kind, ttl) in beyond {
            let spec = IntentSpec {
                nonce: agent_lane(1, 13),
                kind: kind as u8,
                params,
                expires_at: now.saturating_add(ttl),
                flags: 0,
                ext: Vec::new(),
            };
            out.push(vec![self.env.agent_intent_ix(
                &me,
                self.mandate,
                victim,
                &self.market,
                &spec,
            )]);
        }
        out.push(vec![self
            .env
            .revoke_mandate_ix(&victim_owner, self.mandate)]);
        out.push(vec![self.env.create_mandate_ix(
            victim,
            &self.market,
            intent_engine::MandateArgs {
                id: 1,
                ..mandate_terms(me, i64::MAX)
            },
        )]);
        let owner = self.trader(0)?.key.pubkey();
        out.push(vec![self.env.advance_ix(&owner, 400)]);
        out.push(vec![self.env.advance_epoch_ix(&owner, u64::MAX)]);
        out.push(vec![self.env.economics_ix(
            &me,
            intent_engine::Economics {
                crank_bounty: intent_engine::state::MAX_CRANK_BOUNTY,
                ..ECONOMICS
            },
        )]);
        let s = self.env.settings();
        out.push(vec![self.env.update_ix(
            &me,
            intent_engine::ConfigUpdate {
                guardian: me,
                fee_recipient: me,
                enabled_kinds: s.enabled_kinds,
                fee_bps: s.fee_bps,
                fill_disabled_kinds: intent_core::kinds::ALL_KINDS_MASK,
            },
        )]);
        out.push(vec![self.env.raise_pause_ix(&me, 3)]);
        out.push(vec![self.env.lower_pause_ix(&me, 3)]);
        let mut settings = self.env.settings();
        settings.fee_bps = 100;
        settings.fee_recipient = me;
        out.push(vec![self.env.update_config_ix(&me, settings)]);
        out.push(vec![self.env.propose_admin_ix(&me, me)]);
        out.push(vec![self.env.accept_admin_ix(&me)]);
        out.push(vec![self.env.init_config_ix(&me, settings)]);
        let taken = swap_spec(SCANNED_NONCES - 1, ESCROW)?;
        out.push(vec![self.env.create_intent_ix(
            victim,
            &self.market,
            &taken,
        )]);
        let submit_by = now.saturating_add(240);
        let claimed = self
            .env
            .signed_message(victim, &self.market, &taken, DOMAIN, submit_by);
        out.push(vec![
            ed25519_ix(&self.attacker.key, &claimed),
            self.env
                .create_signed_ix(&me, victim, &self.market, &taken, submit_by),
        ]);
        Ok(out)
    }

    pub fn seen(&self, i: &Tracked) -> TestResult<Seen> {
        let intent = intent_pda(&i.owner, i.nonce);
        let state = self.env.intent(&i.owner, i.nonce).ok();
        let vault = vault_pda(&intent);
        Ok(Seen {
            status: state.map(|s| s.status),
            escrowed: state.map_or(0, |s| s.escrowed),
            vault: if self.env.exists(&vault) {
                self.env.balance(&vault)?
            } else {
                0
            },
            receiver: self.env.balance(&i.receiver)?,
            filled: state.map_or(0, |s| s.filled),
            revision: state.map_or(0, |s| s.revision),
            in_flight: state.map_or(0, |s| s.in_flight),
            bounty: state.map_or(0, |s| s.bounty),
            lamports: self.env.lamports(&intent),
            vault_lamports: self.env.lamports(&vault),
            agent_fee: state.map_or(0, |s| s.agent_fee),
        })
    }

    pub fn is_program(&self, key: &Pubkey) -> bool {
        self.env.svm.get_account(key).is_some_and(|a| a.executable)
    }

    pub fn supply(&self, mint: &Pubkey) -> TestResult<u64> {
        let account = self.env.svm.get_account(mint).ok_or("mint missing")?;
        Ok(StateWithExtensions::<MintState>::unpack(&account.data)?
            .base
            .supply)
    }

    pub fn attack(&mut self, base: usize, mutations: &[Mutation]) -> TestResult {
        let bases = self.bases()?;
        let mut ixs = bases
            .get(base.checked_rem(bases.len()).ok_or("no bases")?)
            .ok_or("no base")?
            .clone();
        let last = ixs.last_mut().ok_or("empty base")?;
        self.mutate(last, mutations)?;
        self.submit(ixs)
    }

    pub fn mutate(&self, last: &mut Instruction, mutations: &[Mutation]) -> TestResult {
        for m in mutations {
            let n = last.accounts.len().max(1);
            match *m {
                Mutation::Account { slot, pick } => {
                    let key = *self
                        .pool
                        .get(pick.checked_rem(self.pool.len()).ok_or("empty pool")?)
                        .ok_or("pool")?;
                    if let Some(meta) = last.accounts.get_mut(slot.checked_rem(n).ok_or("n")?) {
                        meta.pubkey = key;
                    }
                }
                Mutation::TokenAccount { slot, pick } => {
                    let slots: Vec<usize> = last
                        .accounts
                        .iter()
                        .enumerate()
                        .filter(|(_, meta)| self.tokens.contains(&meta.pubkey))
                        .map(|(at, _)| at)
                        .collect();
                    if let Some(&at) = slots.get(slot.checked_rem(slots.len().max(1)).ok_or("n")?) {
                        let current = last.accounts.get(at).map(|meta| meta.pubkey);
                        let others: Vec<Pubkey> = self
                            .tokens
                            .iter()
                            .copied()
                            .filter(|key| Some(*key) != current)
                            .collect();
                        let key = *others
                            .get(pick.checked_rem(others.len()).ok_or("no tokens")?)
                            .ok_or("tokens")?;
                        if let Some(meta) = last.accounts.get_mut(at) {
                            meta.pubkey = key;
                        }
                    }
                }
                Mutation::Swap { a, b } => {
                    let (a, b) = (a.checked_rem(n).ok_or("n")?, b.checked_rem(n).ok_or("n")?);
                    if a < last.accounts.len() && b < last.accounts.len() {
                        last.accounts.swap(a, b);
                    }
                }
                Mutation::Truncate { len } => last.data.truncate(len),
                Mutation::Append { byte } => last.data.push(byte),
                Mutation::Flip { at, mask } => {
                    let n = last.data.len().max(1);
                    if let Some(byte) = last.data.get_mut(at.checked_rem(n).ok_or("n")?) {
                        *byte ^= mask;
                    }
                }
                Mutation::Word { at, value } => {
                    let start = at.checked_add(8).ok_or("overflow")?;
                    let end = start.checked_add(8).ok_or("overflow")?;
                    if let Some(word) = last.data.get_mut(start..end) {
                        word.copy_from_slice(&value.to_le_bytes());
                    }
                }
                Mutation::Ext { pick } => {
                    let keep = last.data.len().saturating_sub(4);
                    if keep >= 8 && last.data.get(keep..) == Some(&[0, 0, 0, 0][..]) {
                        let payload = ext_payload(pick);
                        last.data.truncate(keep);
                        last.data
                            .extend_from_slice(&u32::try_from(payload.len())?.to_le_bytes());
                        last.data.extend_from_slice(&payload);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn submit(&mut self, mut ixs: Vec<Instruction>) -> TestResult {
        let me = self.attacker.key.pubkey();
        for ix in &mut ixs {
            for meta in &mut ix.accounts {
                if meta.is_signer {
                    meta.pubkey = me;
                }
            }
        }
        let before: Vec<Seen> = self
            .tracked
            .iter()
            .map(|i| self.seen(i))
            .collect::<TestResult<_>>()?;
        let states: Vec<Option<intent_engine::state::Intent>> = self
            .tracked
            .iter()
            .map(|i| self.env.intent(&i.owner, i.nonce).ok())
            .collect();
        let refunds: Vec<u64> = self
            .tracked
            .iter()
            .map(|i| self.env.balance(&canonical_refund(&i.owner, &self.market)))
            .collect::<TestResult<_>>()?;
        let supplies = (
            self.supply(&self.market.input_mint)?,
            self.supply(&self.market.output_mint)?,
        );
        let config = self
            .env
            .svm
            .get_account(&config_pda())
            .ok_or("config")?
            .data;
        let gained_before = self
            .env
            .balance(&self.attacker.input)?
            .checked_add(self.env.balance(&self.agent_fees)?)
            .ok_or("overflow")?;
        let lamports_before = self.env.lamports(&me);
        let users: Vec<Vec<u8>> = self
            .traders
            .iter()
            .map(|t| {
                self.env
                    .svm
                    .get_account(&user_pda(&t.key.pubkey()))
                    .map(|a| a.data)
                    .unwrap_or_default()
            })
            .collect();
        let victim_input = self.trader(VICTIM)?.input;
        let victim_balance = self.env.balance(&victim_input)?;
        let mandate_before = self.env.mandate(&self.mandate)?;
        let victim_user = self.env.user(&self.trader(VICTIM)?.key.pubkey())?;
        let existing = self.victim_intents()?;
        let now = self.env.now();
        self.env.svm.expire_blockhash();
        let payer = self.attacker.key.insecure_clone();
        let tx = Transaction::new(
            &[&payer],
            Message::new(&ixs, Some(&me)),
            self.env.svm.latest_blockhash(),
        );
        if let Err(FailedTransactionMetadata { err, meta }) = self.env.svm.send_transaction(tx) {
            let crashed = matches!(
                err,
                TransactionError::InstructionError(_, InstructionError::ProgramFailedToComplete)
            ) || meta.logs.iter().any(|l| l.contains("panicked"));
            if crashed {
                return Err(format!("crash {err:?}: {:?}", meta.logs).into());
            }
        }
        if (
            self.supply(&self.market.input_mint)?,
            self.supply(&self.market.output_mint)?,
        ) != supplies
        {
            return Err("token supply changed".into());
        }
        if self
            .env
            .svm
            .get_account(&config_pda())
            .ok_or("config")?
            .data
            != config
        {
            return Err("config changed".into());
        }
        let created: Vec<u64> = self
            .victim_intents()?
            .into_iter()
            .filter(|n| !existing.contains(n))
            .collect();
        self.check_mandated(&created, now, victim_balance, &mandate_before, &victim_user)?;
        for (index, (t, was)) in self.traders.iter().zip(&users).enumerate() {
            if index == VICTIM {
                continue;
            }
            let is = self
                .env
                .svm
                .get_account(&user_pda(&t.key.pubkey()))
                .map(|a| a.data)
                .unwrap_or_default();
            if &is != was {
                return Err("a user's nonce window or epoch changed".into());
            }
        }
        let mut earned: u64 = 0;
        let mut bounties: u64 = 0;
        let mut forfeited: u64 = 0;
        let rent = self
            .env
            .svm
            .minimum_balance_for_rent_exemption(intent_engine::state::Intent::SPACE);
        for (((i, was), state), refund) in
            self.tracked.iter().zip(&before).zip(&states).zip(&refunds)
        {
            let is = self.seen(i)?;
            let open = Status::Open as u8;
            if is.status == Some(open)
                && is.vault < is.escrowed.checked_add(is.agent_fee).ok_or("overflow")?
            {
                return Err(format!("open intent {} under-backed: {is:?}", i.nonce).into());
            }
            if is.status.is_some() && Some(is.lamports) != rent.checked_add(u64::from(is.bounty)) {
                return Err(format!(
                    "intent {} lamports drifted from its bounty: {is:?}",
                    i.nonce
                )
                .into());
            }
            if is.bounty > was.bounty {
                return Err(format!("intent {} bounty grew: {was:?} -> {is:?}", i.nonce).into());
            }
            bounties = bounties
                .checked_add(u64::from(was.bounty.saturating_sub(is.bounty)))
                .ok_or("overflow")?;
            if let Some(state) = state.filter(|_| was.status.is_some() && is.status.is_none()) {
                if self.is_program(&state.rent_payer) {
                    forfeited = was
                        .lamports
                        .checked_sub(u64::from(was.bounty))
                        .and_then(|r| r.checked_add(was.vault_lamports))
                        .and_then(|r| r.checked_add(forfeited))
                        .ok_or("overflow")?;
                }
            }
            if is.in_flight != 0 {
                return Err(format!("intent {} left an amount in flight: {is:?}", i.nonce).into());
            }
            if is.status.is_some() && is.status != Some(open) && is.agent_fee != 0 {
                return Err(format!(
                    "intent {} kept an agent fee after settling: {is:?}",
                    i.nonce
                )
                .into());
            }
            let settled = is.status == Some(Status::Filled as u8);
            if is.status.is_some()
                && (is.filled, is.revision) != if settled { (is.escrowed, 1) } else { (0, 0) }
            {
                return Err(format!("intent {} fill bookkeeping drifted: {is:?}", i.nonce).into());
            }
            if is.status == Some(Status::Cancelled as u8) {
                return Err(format!("intent {} cancelled without its owner", i.nonce).into());
            }
            if was.status == Some(open) && is.status.is_none() {
                let state = state.ok_or("an open intent had no state")?;
                let refunded = self
                    .env
                    .balance(&canonical_refund(&i.owner, &self.market))?
                    .saturating_sub(*refund);
                if now >= state.expires_at && refunded >= was.vault {
                    continue;
                }
                if state.kind == Kind::AttestedResult as u8 {
                    return Err(format!(
                        "open attested intent {} vanished without a refund",
                        i.nonce
                    )
                    .into());
                }
                let required = CoreIntent::decode(state.kind, &state.params)
                    .and_then(|k| k.required_out(state.escrowed, now))
                    .map_err(|e| format!("{e:?}"))?;
                let delivered = is.receiver.saturating_sub(was.receiver);
                if delivered < required {
                    return Err(format!(
                        "open intent {} vanished with {delivered} delivered, {required} required",
                        i.nonce
                    )
                    .into());
                }
                earned = earned
                    .checked_add(was.escrowed)
                    .and_then(|e| e.checked_add(was.agent_fee))
                    .ok_or("overflow")?;
                continue;
            }
            if was.status.is_none() && is.status.is_some() {
                return Err(format!("intent {} reappeared", i.nonce).into());
            }
            let moved = was.status != is.status;
            if moved && was.status != Some(open) && is.status.is_some() {
                return Err(format!(
                    "intent {} left a terminal state: {was:?} -> {is:?}",
                    i.nonce
                )
                .into());
            }
            if moved && was.status == Some(open) && is.status == Some(Status::Expired as u8) {
                let state = self.env.intent(&i.owner, i.nonce)?;
                if now < state.expires_at {
                    return Err(format!("intent {} expired early", i.nonce).into());
                }
            }
            if moved && was.status == Some(open) && is.status == Some(Status::Filled as u8) {
                let state = self.env.intent(&i.owner, i.nonce)?;
                if state.kind != Kind::AttestedResult as u8 {
                    let required = CoreIntent::decode(state.kind, &state.params)
                        .and_then(|k| k.required_out(state.escrowed, now))
                        .map_err(|e| format!("{e:?}"))?;
                    let delivered = is.receiver.saturating_sub(was.receiver);
                    if delivered < required {
                        return Err(format!(
                            "intent {} filled with {delivered} delivered, {required} required",
                            i.nonce
                        )
                        .into());
                    }
                }
                earned = earned
                    .checked_add(was.escrowed)
                    .and_then(|e| e.checked_add(was.agent_fee))
                    .ok_or("overflow")?;
            }
        }
        let gained = self
            .env
            .balance(&self.attacker.input)?
            .checked_add(self.env.balance(&self.agent_fees)?)
            .ok_or("overflow")?
            .saturating_sub(gained_before);
        if gained > earned {
            return Err(format!("attacker gained {gained} but settled only {earned}").into());
        }
        let lamports_gained = self.env.lamports(&me).saturating_sub(lamports_before);
        let released = bounties.checked_add(forfeited).ok_or("overflow")?;
        if lamports_gained > released {
            return Err(format!(
                "attacker gained {lamports_gained} lamports but only {bounties} in bounties and {forfeited} in forfeited rent were released"
            )
            .into());
        }
        for nonce in created {
            let owner = self.trader(VICTIM)?.key.pubkey();
            let receiver = self.trader(VICTIM)?.receiver;
            let intent = intent_pda(&owner, nonce);
            self.pool.extend([intent, vault_pda(&intent)]);
            self.tokens.push(vault_pda(&intent));
            self.tracked.push(Tracked {
                owner,
                nonce,
                receiver,
            });
        }
        Ok(())
    }

    pub fn check_mandated(
        &self,
        created: &[u64],
        now: i64,
        victim_balance: u64,
        before: &intent_engine::state::Mandate,
        victim_user: &intent_engine::state::UserState,
    ) -> TestResult {
        let owner = self.trader(VICTIM)?.key.pubkey();
        let me = self.attacker.key.pubkey();
        let after = self.env.mandate(&self.mandate)?;
        let mut escrowed: u64 = 0;
        let mut drawn: u64 = 0;
        for &nonce in created {
            let state = self.env.intent(&owner, nonce)?;
            let decoded =
                CoreIntent::decode(state.kind, &state.params).map_err(|e| format!("{e:?}"))?;
            let receiver = self
                .env
                .svm
                .get_account(&state.receiver)
                .ok_or("receiver missing")?;
            let receiver_owner = receiver.data.get(32..64).ok_or("receiver too short")?;
            if receiver_owner != owner.as_ref() {
                return Err(
                    format!("agent intent {nonce} pays someone other than the owner").into(),
                );
            }
            if state.rent_payer != me
                || state.owner != owner
                || state.flags != 0
                || state.partner_bps != 0
            {
                return Err(format!("agent intent {nonce} broke its mandate's fixed terms").into());
            }
            let cost = state
                .escrowed
                .checked_add(MANDATE_LIMITS.agent_fee)
                .ok_or("overflow")?;
            let fair = match decoded {
                CoreIntent::SwapExactIn(p) => {
                    u128::from(p.min_out).checked_mul(u128::from(MANDATE_LIMITS.floor_in))
                        >= u128::from(cost).checked_mul(u128::from(MANDATE_LIMITS.floor_out))
                }
                _ => false,
            };
            let lifetime = state
                .expires_at
                .checked_sub(now)
                .ok_or("expiry underflow")?;
            if !fair
                || cost > MANDATE_LIMITS.per_intent
                || lifetime > MANDATE_LIMITS.max_ttl
                || drawn
                    .checked_add(cost)
                    .is_none_or(|t| t > MANDATE_LIMITS.total)
            {
                return Err(format!(
                    "agent intent {nonce} breaks its mandate: escrow {} expires {} kind {}",
                    state.escrowed, state.expires_at, state.kind
                )
                .into());
            }
            if !in_lane(nonce, after.serial) {
                return Err(
                    format!("agent intent {nonce} lies outside its mandate's nonce lane").into(),
                );
            }
            escrowed = escrowed.checked_add(state.escrowed).ok_or("overflow")?;
            drawn = drawn.checked_add(cost).ok_or("overflow")?;
        }
        let spent = after
            .spent
            .checked_sub(before.spent)
            .ok_or("mandate spend fell")?;
        let intents = after
            .intents
            .checked_sub(before.intents)
            .ok_or("mandate count fell")?;
        if spent != drawn || usize::try_from(intents)? != created.len() || after.spent > after.total
        {
            return Err(
                format!("mandate spent {spent} over {intents} intents for {drawn} drawn").into(),
            );
        }
        let keys = |m: &intent_engine::state::Mandate| {
            (m.owner, m.agent, m.input_mint, m.output_mint, m.partner)
        };
        let terms = |m: &intent_engine::state::Mandate| {
            (
                m.id,
                m.epoch,
                m.valid_until,
                m.max_ttl,
                m.per_intent,
                m.total,
                m.floor_out,
                m.floor_in,
                m.max_intents,
                m.partner_bps,
                m.kinds,
                m.agent_fee,
            )
        };
        if keys(&after) != keys(before) || terms(&after) != terms(before) {
            return Err("a mandate's terms changed".into());
        }
        let lost = victim_balance.saturating_sub(self.env.balance(&self.trader(VICTIM)?.input)?);
        if lost > drawn {
            return Err(format!(
                "victim lost {lost} but only {drawn} went into mandated intents and fees"
            )
            .into());
        }
        let user = self.env.user(&owner)?;
        if (user.owner, user.nonce_base, user.epoch, user.nonce_bitmap)
            != (
                victim_user.owner,
                victim_user.nonce_base,
                victim_user.epoch,
                victim_user.nonce_bitmap,
            )
        {
            return Err("the victim's nonce window or epoch changed".into());
        }
        Ok(())
    }
}

use std::collections::BTreeMap;

use anchor_lang::prelude::Pubkey;
use intent_core::fee::split_fees;
use intent_core::kinds::{
    attested_result, dutch_auction, limit_order, swap_exact_in, Kind, ALL_KINDS_MASK,
};
use intent_core::lifecycle::Status;
use intent_core::mandate::{in_lane, MANDATE_NONCE_BIT};
use intent_core::nonce::WINDOW_BITS;
use intent_engine::state::{PAUSE_CREATE, PAUSE_FILL};
use intent_engine::ConfigUpdate;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    agent_lane, attestation_message, ed25519_ix, intent_pda, mandate_pda, mandate_terms,
    partner_ext, vault_pda, Env, IntentSpec, Market, Solver, TestResult, Trader, DOMAIN,
};

const TRADERS: usize = 2;
const NONCES: u64 = 4;
const FUNDED: u64 = 10_000;
const SOLVER_FUNDS: u64 = 1_000;
const SIGNATURE_FEE: u64 = 5_000;
const MODEL_PARTNER_BPS: u16 = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    Swap {
        min_out: u64,
    },
    Limit {
        take: u64,
    },
    Dutch {
        start_out: u64,
        end_out: u64,
        span: i64,
    },
    Attested {
        min_result: u64,
        max_result: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    Direct,
    Signed,
    Stale,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Payer {
    Owner,
    Relayer,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Granted {
    kinds: u8,
    per_intent: u64,
    total: u64,
    max_intents: u32,
    max_ttl: i64,
    valid_until: i64,
    floor_out: u64,
    floor_in: u64,
    epoch: u64,
    spent: u64,
    intents: u32,
    partnered: bool,
    serial: u64,
    agent_fee: u64,
}

const IDS: u64 = 2;

#[derive(Debug, Clone, Copy)]
struct Preset {
    kinds: u8,
    per_intent: u64,
    total: u64,
    max_intents: u32,
    max_ttl: i64,
    floor_out: u64,
    floor_in: u64,
    agent_fee: u64,
}

const PRESETS: [Preset; 5] = [
    Preset {
        kinds: 0b1110,
        per_intent: 4_000,
        total: 20_000,
        max_intents: 6,
        max_ttl: 90,
        floor_out: 1,
        floor_in: 100,
        agent_fee: 0,
    },
    Preset {
        kinds: 0b0010,
        per_intent: 500,
        total: 1_000,
        max_intents: 3,
        max_ttl: 30,
        floor_out: 1,
        floor_in: 10,
        agent_fee: 5,
    },
    Preset {
        kinds: 0b1100,
        per_intent: 2_000,
        total: 3_000,
        max_intents: 2,
        max_ttl: 60,
        floor_out: 1,
        floor_in: 40,
        agent_fee: 0,
    },
    Preset {
        kinds: 0b1110,
        per_intent: 4_000,
        total: 4_000,
        max_intents: 1,
        max_ttl: 90,
        floor_out: 3,
        floor_in: 2,
        agent_fee: 0,
    },
    Preset {
        kinds: 0b1110,
        per_intent: 4_000,
        total: 8_000,
        max_intents: 4,
        max_ttl: 90,
        floor_out: 1,
        floor_in: 100,
        agent_fee: 40,
    },
];

#[derive(Debug, Clone, Copy)]
struct Ask {
    kind: Kind,
    worst: Option<u64>,
    amount: u64,
    ttl: i64,
    now: i64,
    epoch: u64,
    partnered: bool,
}

impl Granted {
    fn allows(&self, ask: &Ask) -> bool {
        let Ask {
            kind,
            worst,
            amount,
            ttl,
            now,
            epoch,
            partnered,
        } = *ask;
        let Some(cost) = amount.checked_add(self.agent_fee) else {
            return false;
        };
        let fair = worst.is_some_and(|w| {
            u128::from(w).checked_mul(u128::from(self.floor_in))
                >= u128::from(cost).checked_mul(u128::from(self.floor_out))
        });
        now < self.valid_until
            && self.epoch == epoch
            && self.partnered == partnered
            && u64::from(self.kinds) & kind.bit() != 0
            && ttl <= self.max_ttl
            && cost <= self.per_intent
            && self
                .spent
                .checked_add(cost)
                .is_some_and(|s| s <= self.total)
            && self.intents < self.max_intents
            && fair
    }
}

#[derive(Debug, Clone)]
enum Op {
    Create {
        trader: usize,
        nonce: u64,
        amount: u64,
        shape: Shape,
        ttl: i64,
        route: Route,
        partnered: bool,
        mandate: u64,
    },
    Grant {
        trader: usize,
        id: u64,
        preset: usize,
        valid_for: i64,
        partnered: bool,
    },
    Revoke {
        trader: usize,
        id: u64,
    },
    Fill {
        trader: usize,
        nonce: u64,
        delta: i64,
        skew: i64,
    },
    Flash {
        trader: usize,
        nonce: u64,
        delta: i64,
        skew: i64,
    },
    Attest {
        trader: usize,
        nonce: u64,
        high: bool,
        offset: i64,
        skew: i64,
    },
    Epoch {
        trader: usize,
        jump: u64,
    },
    AdvanceNonce {
        trader: usize,
        step: u64,
    },
    FeeRate {
        bps: u16,
    },
    KillFills {
        mask: u64,
    },
    Economics {
        bounty: u32,
        fee: u32,
        kind_mask: u8,
        kind_bps: [u16; 4],
        cut: u16,
    },
    Cancel {
        trader: usize,
        nonce: u64,
    },
    Expire {
        trader: usize,
        nonce: u64,
    },
    Close {
        trader: usize,
        nonce: u64,
    },
    Warp {
        secs: i64,
    },
    WarpToExpiry {
        trader: usize,
        nonce: u64,
        offset: i64,
    },
    Pause {
        flags: u8,
    },
    Unpause {
        flags: u8,
    },
    Donate {
        trader: usize,
        nonce: u64,
        amount: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Terms {
    Fixed(u64),
    Dutch {
        start_out: u64,
        end_out: u64,
        start_ts: i64,
        end_ts: i64,
    },
    Attested {
        min_result: u64,
        max_result: u64,
    },
}

impl Terms {
    fn required(self, now: i64) -> Option<u64> {
        match self {
            Terms::Fixed(out) => Some(out),
            Terms::Dutch {
                start_out,
                end_out,
                start_ts,
                end_ts,
            } => {
                let t = now.clamp(start_ts, end_ts);
                let spread = u128::from(start_out.checked_sub(end_out)?);
                let elapsed = u128::from(t.abs_diff(start_ts));
                let span = u128::from(end_ts.abs_diff(start_ts));
                let decay = spread.checked_mul(elapsed)?.checked_div(span)?;
                start_out.checked_sub(u64::try_from(decay).ok()?)
            }
            Terms::Attested { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    Open {
        kind: Kind,
        escrowed: u64,
        terms: Terms,
        expires_at: i64,
        payer: Payer,
        mandate: Option<(u64, u64)>,
        agent_fee: u64,
    },
    Settled {
        status: Status,
        payer: Payer,
        filled: u64,
    },
    Closed,
}

impl Shape {
    fn worst(self) -> Option<u64> {
        match self {
            Shape::Swap { min_out } => Some(min_out),
            Shape::Limit { take } => Some(take),
            Shape::Dutch { end_out, .. } => Some(end_out),
            Shape::Attested { .. } => None,
        }
    }
}

fn shape() -> impl Strategy<Value = Shape> {
    prop_oneof![
        (1..=60u64).prop_map(|min_out| Shape::Swap { min_out }),
        (1..=60u64).prop_map(|take| Shape::Limit { take }),
        (1..=60u64, 0..=59u64, 1..=90i64).prop_map(|(start_out, cut, span)| Shape::Dutch {
            start_out,
            end_out: start_out.saturating_sub(cut).max(1),
            span,
        }),
        (0..=40u64, 0..=20u64).prop_map(|(min_result, width)| Shape::Attested {
            min_result,
            max_result: min_result.saturating_add(width),
        }),
    ]
}

fn slot() -> BoxedStrategy<u64> {
    prop_oneof![
        3 => 0..NONCES,
        2 => (1..=3u64, 0..2u64).prop_map(|(serial, n)| agent_lane(serial, n)),
    ]
    .boxed()
}

fn route() -> impl Strategy<Value = Route> {
    prop_oneof![
        3 => Just(Route::Direct),
        2 => Just(Route::Signed),
        1 => Just(Route::Stale),
        3 => Just(Route::Agent),
    ]
}

fn skew() -> impl Strategy<Value = i64> {
    prop_oneof![
        8 => Just(0i64),
        2 => -2..=2i64,
        1 => Just(i64::MIN),
        1 => Just(i64::MAX),
    ]
}

fn op() -> impl Strategy<Value = Op> {
    let who = 0..TRADERS;
    let nonce = slot();
    prop_oneof![
        3 => (who.clone(), nonce.clone(), 1..=4_000u64, shape(), 1..=90i64, route(), prop::bool::weighted(0.3), 0..IDS).prop_map(
            |(trader, nonce, amount, shape, ttl, route, partnered, mandate)| Op::Create {
                partnered,
                trader,
                nonce,
                amount,
                shape,
                ttl,
                route,
                mandate,
            }
        ),
        1 => (who.clone(), 0..IDS, 0..PRESETS.len(), 1..=120i64, prop::bool::weighted(0.3))
            .prop_map(|(trader, id, preset, valid_for, partnered)| Op::Grant { trader, id, preset, valid_for, partnered }),
        1 => (who.clone(), 0..IDS).prop_map(|(trader, id)| Op::Revoke { trader, id }),
        2 => (who.clone(), nonce.clone(), -3..=3i64, skew())
            .prop_map(|(trader, nonce, delta, skew)| Op::Fill { trader, nonce, delta, skew }),
        2 => (who.clone(), nonce.clone(), -3..=3i64, skew())
            .prop_map(|(trader, nonce, delta, skew)| Op::Flash { trader, nonce, delta, skew }),
        2 => (who.clone(), nonce.clone(), any::<bool>(), -1..=1i64, skew())
            .prop_map(|(trader, nonce, high, offset, skew)| Op::Attest { trader, nonce, high, offset, skew }),
        1 => (who.clone(), 1..=1_000_000u64).prop_map(|(trader, jump)| Op::Epoch { trader, jump }),
        1 => (0..16u64).prop_map(|bits| Op::KillFills { mask: (bits << 1) & ALL_KINDS_MASK }),
        1 => (who.clone(), 1..=6u64).prop_map(|(trader, step)| Op::AdvanceNonce { trader, step }),
        1 => prop::sample::select(vec![0u16, 5, 30, 100]).prop_map(|bps| Op::FeeRate { bps }),
        1 => (prop::sample::select(vec![0u32, 1, 70_000, 10_000_000]), prop::sample::select(vec![0u32, 1, 30_000]))
            .prop_flat_map(|(bounty, fee)| {
                (
                    prop::sample::select(vec![0u8, 0b0_0010, 0b1_0100, 0b1_1110]),
                    prop::array::uniform4(prop::sample::select(vec![0u16, 7, 60])),
                    prop::sample::select(vec![0u16, 2_000, 10_000]),
                )
                    .prop_map(move |(kind_mask, kind_bps, cut)| Op::Economics {
                        bounty,
                        fee,
                        kind_mask,
                        kind_bps,
                        cut,
                    })
            }),
        1 => (who.clone(), nonce.clone()).prop_map(|(trader, nonce)| Op::Cancel { trader, nonce }),
        1 => (who.clone(), nonce.clone()).prop_map(|(trader, nonce)| Op::Expire { trader, nonce }),
        2 => (who.clone(), nonce.clone()).prop_map(|(trader, nonce)| Op::Close { trader, nonce }),
        1 => (0..=60i64).prop_map(|secs| Op::Warp { secs }),
        1 => (who, nonce, -1..=1i64)
            .prop_map(|(trader, nonce, offset)| Op::WarpToExpiry { trader, nonce, offset }),
        1 => (1..=3u8).prop_map(|flags| Op::Pause { flags }),
        1 => (1..=3u8).prop_map(|flags| Op::Unpause { flags }),
        3 => (0..TRADERS, slot(), 1..=50u64)
            .prop_map(|(trader, nonce, amount)| Op::Donate { trader, nonce, amount }),
    ]
}

struct World {
    env: Env,
    market: Market,
    traders: Vec<Trader>,
    solver: Solver,
    relayer: Keypair,
    agent: Keypair,
    agent_fees: Pubkey,
    granted: BTreeMap<(usize, u64), Granted>,
    attestor: Keypair,
    fee_to: Pubkey,
    fee_bps: u16,
    paused: u8,
    fill_disabled: u64,
    bounty: u32,
    create_fee: u32,
    treasury: u64,
    treasury_start: u64,
    bounties: BTreeMap<(usize, u64), u32>,
    kind_mask: u8,
    kind_bps: [u16; 4],
    cut: u16,
    partner: Pubkey,
    partner_to: Pubkey,
    partnered: std::collections::BTreeSet<(usize, u64)>,
    cuts: std::collections::BTreeMap<(usize, u64), u16>,
    epochs: Vec<u64>,
    bases: Vec<u64>,
    grants: Vec<u64>,
    donated: u64,
    slots: BTreeMap<(usize, u64), Slot>,
    balances: BTreeMap<Pubkey, u64>,
}

fn add(map: &mut BTreeMap<Pubkey, u64>, key: Pubkey, amount: u64) -> TestResult {
    let entry = map.entry(key).or_insert(0);
    *entry = entry.checked_add(amount).ok_or("model overflow")?;
    Ok(())
}

fn sub(map: &mut BTreeMap<Pubkey, u64>, key: Pubkey, amount: u64) -> TestResult {
    let entry = map.entry(key).or_insert(0);
    *entry = entry.checked_sub(amount).ok_or("model underflow")?;
    Ok(())
}

impl World {
    fn new(program: Pubkey) -> TestResult<Self> {
        let mut env = Env::new()?;
        env.init_config()?;
        let fee_bps = env.settings().fee_bps;
        let market = env.market(program, &[], program, &[])?;
        let mut traders = Vec::new();
        let mut balances = BTreeMap::new();
        for _ in 0..TRADERS {
            let trader = env.trader(&market, FUNDED)?;
            balances.insert(trader.input, FUNDED);
            balances.insert(trader.receiver, 0);
            traders.push(trader);
        }
        let solver = env.solver(&market, SOLVER_FUNDS)?;
        let fee_to = env.fee_account(&market)?;
        let relayer = env.funded()?;
        let agent = env.funded()?;
        let agent_fees =
            env.create_ata(&agent.pubkey(), &market.input_mint, market.input_program)?;
        balances.insert(agent_fees, 0);
        let treasury_start = env.lamports(&env.fee_recipient);
        balances.insert(solver.input, 0);
        balances.insert(solver.output, SOLVER_FUNDS);
        balances.insert(fee_to, 0);
        let partner = Pubkey::new_unique();
        let partner_to = env.create_ata(&partner, &market.input_mint, market.input_program)?;
        balances.insert(partner_to, 0);
        Ok(Self {
            env,
            market,
            traders,
            solver,
            relayer,
            agent,
            agent_fees,
            granted: BTreeMap::new(),
            attestor: Keypair::new(),
            fee_to,
            fee_bps,
            paused: 0,
            fill_disabled: 0,
            bounty: 0,
            create_fee: 0,
            treasury: 0,
            treasury_start,
            bounties: BTreeMap::new(),
            kind_mask: 0,
            kind_bps: [0; 4],
            cut: 0,
            partner,
            partner_to,
            partnered: std::collections::BTreeSet::new(),
            cuts: std::collections::BTreeMap::new(),
            epochs: vec![0; TRADERS],
            bases: vec![0; TRADERS],
            grants: vec![0; TRADERS],
            donated: 0,
            slots: BTreeMap::new(),
            balances,
        })
    }

    fn trader(&self, index: usize) -> TestResult<&Trader> {
        Ok(self.traders.get(index).ok_or("no such trader")?)
    }

    fn owner(&self, index: usize) -> TestResult<Pubkey> {
        Ok(self.trader(index)?.key.pubkey())
    }

    fn vault(&self, trader: usize, nonce: u64) -> TestResult<Pubkey> {
        Ok(vault_pda(&intent_pda(&self.owner(trader)?, nonce)))
    }

    fn held(&self, key: &Pubkey) -> u64 {
        self.balances.get(key).copied().unwrap_or_default()
    }

    fn apply(&mut self, op: &Op) -> TestResult {
        match *op {
            Op::Create {
                trader,
                nonce,
                amount,
                shape,
                ttl,
                route,
                partnered,
                mandate,
            } => self.create(
                trader,
                nonce,
                amount,
                shape,
                ttl,
                (route, partnered, mandate),
            ),
            Op::Grant {
                trader,
                id,
                preset,
                valid_for,
                partnered,
            } => self.grant(trader, id, preset, valid_for, partnered),
            Op::Revoke { trader, id } => self.revoke(trader, id),
            Op::Fill {
                trader,
                nonce,
                delta,
                skew,
            } => self.fill(trader, nonce, delta, skew, false),
            Op::Flash {
                trader,
                nonce,
                delta,
                skew,
            } => self.fill(trader, nonce, delta, skew, true),
            Op::Attest {
                trader,
                nonce,
                high,
                offset,
                skew,
            } => self.attest(trader, nonce, high, offset, skew),
            Op::Epoch { trader, jump } => {
                let owner = self.owner(trader)?;
                let key = self.trader(trader)?.key.insecure_clone();
                let epoch = self.epochs.get_mut(trader).ok_or("no such trader")?;
                let next = epoch.checked_add(jump).ok_or("model overflow")?;
                *epoch = next;
                let ix = self.env.advance_epoch_ix(&owner, next);
                self.env.send(&key, &[ix], &[])?;
                Ok(())
            }
            Op::AdvanceNonce { trader, step } => {
                let owner = self.owner(trader)?;
                let key = self.trader(trader)?.key.insecure_clone();
                let base = self.bases.get_mut(trader).ok_or("no such trader")?;
                let next = base.checked_add(step).ok_or("model overflow")?;
                *base = next;
                let ix = self.env.advance_ix(&owner, next);
                self.env.send(&key, &[ix], &[])?;
                Ok(())
            }
            Op::FeeRate { bps } => {
                let authority = self.env.authority.insecure_clone();
                let s = self.env.settings();
                let ix = self.env.update_ix(
                    &authority.pubkey(),
                    ConfigUpdate {
                        guardian: s.guardian,
                        fee_recipient: s.fee_recipient,
                        enabled_kinds: s.enabled_kinds,
                        fee_bps: bps,
                        fill_disabled_kinds: self.fill_disabled,
                    },
                );
                self.env.send(&authority, &[ix], &[])?;
                self.fee_bps = bps;
                Ok(())
            }
            Op::Economics {
                bounty,
                fee,
                kind_mask,
                kind_bps,
                cut,
            } => {
                let authority = self.env.authority.insecure_clone();
                let ix = self.env.economics_ix(
                    &authority.pubkey(),
                    intent_engine::Economics {
                        kind_fee_mask: kind_mask,
                        kind_fee_bps: kind_bps,
                        partner_cut_bps: cut,
                        crank_bounty: bounty,
                        create_fee: fee,
                    },
                );
                self.env.send(&authority, &[ix], &[])?;
                self.bounty = bounty;
                self.create_fee = fee;
                self.kind_mask = kind_mask;
                self.kind_bps = kind_bps;
                self.cut = cut;
                Ok(())
            }
            Op::KillFills { mask } => {
                let authority = self.env.authority.insecure_clone();
                let s = self.env.settings();
                let ix = self.env.update_ix(
                    &authority.pubkey(),
                    ConfigUpdate {
                        guardian: s.guardian,
                        fee_recipient: s.fee_recipient,
                        enabled_kinds: s.enabled_kinds,
                        fee_bps: self.fee_bps,
                        fill_disabled_kinds: mask,
                    },
                );
                self.env.send(&authority, &[ix], &[])?;
                self.fill_disabled = mask;
                Ok(())
            }
            Op::WarpToExpiry {
                trader,
                nonce,
                offset,
            } => {
                if let Some(Slot::Open { expires_at, .. }) = self.slots.get(&(trader, nonce)) {
                    let now = expires_at.checked_add(offset).ok_or("clock overflow")?;
                    self.env.set_now(now);
                }
                Ok(())
            }
            Op::Cancel { trader, nonce } => self.refund(trader, nonce, Status::Cancelled),
            Op::Expire { trader, nonce } => self.refund(trader, nonce, Status::Expired),
            Op::Close { trader, nonce } => self.close(trader, nonce),
            Op::Pause { flags } => {
                let authority = self.env.authority.insecure_clone();
                let ix = self.env.raise_pause_ix(&authority.pubkey(), flags);
                self.env.send(&authority, &[ix], &[])?;
                self.paused |= flags;
                Ok(())
            }
            Op::Unpause { flags } => {
                let authority = self.env.authority.insecure_clone();
                let ix = self.env.lower_pause_ix(&authority.pubkey(), flags);
                self.env.send(&authority, &[ix], &[])?;
                self.paused &= !flags;
                Ok(())
            }
            Op::Donate {
                trader,
                nonce,
                amount,
            } => {
                if matches!(
                    self.slots.get(&(trader, nonce)),
                    Some(Slot::Open { .. } | Slot::Settled { .. })
                ) {
                    let vault = self.vault(trader, nonce)?;
                    self.env.mint_to(
                        &self.market.input_mint,
                        &vault,
                        self.market.input_program,
                        amount,
                    )?;
                    add(&mut self.balances, vault, amount)?;
                    self.donated = self.donated.checked_add(amount).ok_or("model overflow")?;
                }
                Ok(())
            }
            Op::Warp { secs } => {
                let now = self.env.now().checked_add(secs).ok_or("clock overflow")?;
                self.env.set_now(now);
                Ok(())
            }
        }
    }

    fn spec(
        &self,
        nonce: u64,
        amount: u64,
        shape: Shape,
        now: i64,
        expires_at: i64,
    ) -> TestResult<(IntentSpec, Kind, Terms)> {
        let err = |e: intent_core::Error| format!("{e:?}");
        let (kind, params, terms) = match shape {
            Shape::Swap { min_out } => (
                Kind::SwapExactIn,
                swap_exact_in::Params {
                    amount_in: amount,
                    min_out,
                }
                .encode()
                .map_err(err)?,
                Terms::Fixed(min_out),
            ),
            Shape::Limit { take } => (
                Kind::LimitOrder,
                limit_order::Params {
                    make_amount: amount,
                    take_amount: take,
                }
                .encode()
                .map_err(err)?,
                Terms::Fixed(take),
            ),
            Shape::Dutch {
                start_out,
                end_out,
                span,
            } => {
                let end_ts = now
                    .checked_add(span.min(expires_at.saturating_sub(now)).max(1))
                    .ok_or("clock overflow")?;
                (
                    Kind::DutchAuction,
                    dutch_auction::Params {
                        amount_in: amount,
                        start_out,
                        end_out,
                        start_ts: now,
                        end_ts,
                    }
                    .encode()
                    .map_err(err)?,
                    Terms::Dutch {
                        start_out,
                        end_out,
                        start_ts: now,
                        end_ts,
                    },
                )
            }
            Shape::Attested {
                min_result,
                max_result,
            } => (
                Kind::AttestedResult,
                attested_result::Params {
                    amount_in: amount,
                    min_result,
                    max_result,
                    attestor: self.attestor.pubkey().to_bytes(),
                }
                .encode()
                .map_err(err)?,
                Terms::Attested {
                    min_result,
                    max_result,
                },
            ),
        };
        Ok((
            IntentSpec {
                nonce,
                kind: kind as u8,
                params,
                expires_at,
                flags: 0,
                ext: Vec::new(),
            },
            kind,
            terms,
        ))
    }

    fn create(
        &mut self,
        trader: usize,
        nonce: u64,
        amount: u64,
        shape: Shape,
        ttl: i64,
        (route, partnered, mandate): (Route, bool, u64),
    ) -> TestResult {
        let now = self.env.now();
        let expires_at = now.checked_add(ttl).ok_or("clock overflow")?;
        let (mut spec, kind, terms) = self.spec(nonce, amount, shape, now, expires_at)?;
        if partnered {
            spec.ext = partner_ext(&self.partner, MODEL_PARTNER_BPS);
        }
        let input = self.trader(trader)?.input;
        let epoch = *self.epochs.get(trader).ok_or("no such trader")?;
        let signed_epoch = if route == Route::Stale {
            epoch.wrapping_add(1)
        } else {
            epoch
        };
        let mandated = self.granted.get(&(trader, mandate)).copied().filter(|m| {
            route == Route::Agent
                && m.allows(&Ask {
                    kind,
                    worst: shape.worst(),
                    amount,
                    ttl,
                    now,
                    epoch,
                    partnered,
                })
        });
        let fee = mandated.map_or(0, |m| m.agent_fee);
        let drawn = amount.checked_add(fee).ok_or("model overflow")?;
        let expected = !self.slots.contains_key(&(trader, nonce))
            && self.held(&input) >= drawn
            && self.paused & PAUSE_CREATE == 0
            && match route {
                Route::Direct | Route::Signed => {
                    let base = *self.bases.get(trader).ok_or("no such trader")?;
                    nonce & MANDATE_NONCE_BIT == 0
                        && nonce >= base
                        && nonce.checked_sub(base).is_some_and(|d| d < WINDOW_BITS)
                }
                Route::Stale => false,
                Route::Agent => mandated.is_some_and(|m| in_lane(nonce, m.serial)),
            };
        let payer = match route {
            Route::Direct => Payer::Owner,
            Route::Signed | Route::Stale => Payer::Relayer,
            Route::Agent => Payer::Agent,
        };
        let outcome = if route == Route::Agent {
            let t = self.traders.get(trader).ok_or("no such trader")?;
            self.env.approve_delegate(t, &self.market, drawn)?;
            let address = mandate_pda(&t.key.pubkey(), &self.agent.pubkey(), mandate);
            let ix =
                self.env
                    .agent_intent_ix(&self.agent.pubkey(), address, t, &self.market, &spec);
            let agent = self.agent.insecure_clone();
            self.env.send(&agent, &[ix], &[])
        } else if payer == Payer::Relayer {
            let t = self.traders.get(trader).ok_or("no such trader")?;
            let key = t.key.insecure_clone();
            self.env.approve_delegate(t, &self.market, amount)?;
            let message = self.env.signed_message_at(
                t,
                &self.market,
                &spec,
                DOMAIN,
                expires_at,
                signed_epoch,
            );
            let ixs = [
                ed25519_ix(&key, &message),
                self.env.create_signed_ix(
                    &self.relayer.pubkey(),
                    t,
                    &self.market,
                    &spec,
                    expires_at,
                ),
            ];
            let relayer = self.relayer.insecure_clone();
            self.env.send(&relayer, &ixs, &[])
        } else {
            let t = self.traders.get(trader).ok_or("no such trader")?;
            self.env.create_intent(t, &self.market, &spec)
        };
        if outcome.is_ok() != expected {
            return Err(format!(
                "create {trader}/{nonce} route={route:?} expected {expected} got {outcome:?}"
            )
            .into());
        }
        if expected {
            if let Some(m) = mandated {
                self.granted.insert(
                    (trader, mandate),
                    Granted {
                        spent: m.spent.checked_add(drawn).ok_or("model overflow")?,
                        intents: m.intents.checked_add(1).ok_or("model overflow")?,
                        ..m
                    },
                );
            }
            sub(&mut self.balances, input, drawn)?;
            let vault = self.vault(trader, nonce)?;
            add(&mut self.balances, vault, drawn)?;
            self.bounties.insert((trader, nonce), self.bounty);
            self.cuts.insert((trader, nonce), self.cut);
            if partnered {
                self.partnered.insert((trader, nonce));
            }
            self.treasury = self
                .treasury
                .checked_add(u64::from(self.create_fee))
                .ok_or("model overflow")?;
            self.slots.insert(
                (trader, nonce),
                Slot::Open {
                    kind,
                    escrowed: amount,
                    terms,
                    expires_at,
                    payer,
                    mandate: mandated.map(|m| (mandate, m.serial)),
                    agent_fee: fee,
                },
            );
        }
        Ok(())
    }

    fn live(&self, trader: usize, mandate: Option<(u64, u64)>) -> bool {
        mandate.is_none_or(|(id, serial)| {
            self.granted
                .get(&(trader, id))
                .is_some_and(|g| g.serial == serial && self.epochs.get(trader) == Some(&g.epoch))
        })
    }

    fn grant(
        &mut self,
        trader: usize,
        id: u64,
        preset: usize,
        valid_for: i64,
        partnered: bool,
    ) -> TestResult {
        let Preset {
            kinds,
            per_intent,
            total,
            max_intents,
            max_ttl,
            floor_out,
            floor_in,
            agent_fee,
        } = *PRESETS.get(preset).ok_or("no such preset")?;
        let now = self.env.now();
        let valid_until = now.checked_add(valid_for).ok_or("clock overflow")?;
        let epoch = *self.epochs.get(trader).ok_or("no such trader")?;
        let expected = !self.granted.contains_key(&(trader, id));
        let (partner, partner_bps) = if partnered {
            (self.partner, MODEL_PARTNER_BPS)
        } else {
            (Pubkey::default(), 0)
        };
        let ix = self.env.create_mandate_ix(
            self.trader(trader)?,
            &self.market,
            intent_engine::MandateArgs {
                kinds,
                per_intent,
                total,
                max_intents,
                max_ttl,
                floor_out,
                floor_in,
                id,
                partner,
                partner_bps,
                agent_fee,
                ..mandate_terms(self.agent.pubkey(), valid_until)
            },
        );
        let key = self.trader(trader)?.key.insecure_clone();
        let outcome = self.env.send(&key, &[ix], &[]);
        if outcome.is_ok() != expected {
            return Err(format!("grant {trader}/{id} expected {expected} got {outcome:?}").into());
        }
        if expected {
            let serial = self.grants.get_mut(trader).ok_or("no such trader")?;
            *serial = serial.checked_add(1).ok_or("model overflow")?;
            let serial = *serial;
            self.granted.insert(
                (trader, id),
                Granted {
                    kinds,
                    per_intent,
                    total,
                    max_intents,
                    max_ttl,
                    valid_until,
                    floor_out,
                    floor_in,
                    epoch,
                    spent: 0,
                    intents: 0,
                    partnered,
                    serial,
                    agent_fee,
                },
            );
        }
        Ok(())
    }

    fn revoke(&mut self, trader: usize, id: u64) -> TestResult {
        let owner = self.owner(trader)?;
        let expected = self.granted.contains_key(&(trader, id));
        let ix = self
            .env
            .revoke_mandate_ix(&owner, mandate_pda(&owner, &self.agent.pubkey(), id));
        let key = self.trader(trader)?.key.insecure_clone();
        let outcome = self.env.send(&key, &[ix], &[]);
        if outcome.is_ok() != expected {
            return Err(format!("revoke {trader}/{id} expected {expected} got {outcome:?}").into());
        }
        self.granted.remove(&(trader, id));
        Ok(())
    }

    fn fee_bps_for(&self, kind: Kind) -> u16 {
        let [swap, limit, dutch, attested] = self.kind_bps;
        if kind.enabled_in(u64::from(self.kind_mask)) {
            match kind {
                Kind::SwapExactIn => swap,
                Kind::LimitOrder => limit,
                Kind::DutchAuction => dutch,
                Kind::AttestedResult => attested,
            }
        } else {
            self.fee_bps
        }
    }

    fn settle(&mut self, trader: usize, nonce: u64, escrowed: u64, payer: Payer) -> TestResult {
        let (kind, agent_fee) = match self.slots.get(&(trader, nonce)) {
            Some(Slot::Open {
                kind, agent_fee, ..
            }) => (*kind, *agent_fee),
            _ => return Err("settling an intent that is not open".into()),
        };
        let partner_bps = if self.partnered.contains(&(trader, nonce)) {
            MODEL_PARTNER_BPS
        } else {
            0
        };
        let split = split_fees(
            escrowed,
            self.fee_bps_for(kind),
            partner_bps,
            self.cut_of((trader, nonce)),
        )
        .map_err(|e| format!("{e:?}"))?;
        let vault = self.vault(trader, nonce)?;
        sub(&mut self.balances, vault, escrowed)?;
        add(&mut self.balances, self.solver.input, split.net)?;
        add(&mut self.balances, self.fee_to, split.protocol)?;
        add(&mut self.balances, self.partner_to, split.partner)?;
        sub(&mut self.balances, vault, agent_fee)?;
        add(&mut self.balances, self.agent_fees, agent_fee)?;
        self.slots.insert(
            (trader, nonce),
            Slot::Settled {
                status: Status::Filled,
                payer,
                filled: escrowed,
            },
        );
        Ok(())
    }

    fn fees_payable(&self, key: (usize, u64), kind: Kind, escrowed: u64) -> bool {
        let partner_bps = if self.partnered.contains(&key) {
            MODEL_PARTNER_BPS
        } else {
            0
        };
        let fee_bps = self.fee_bps_for(kind);
        u32::from(fee_bps).saturating_add(u32::from(partner_bps)) <= u32::from(self.env.max_fee_bps)
            && split_fees(escrowed, fee_bps, partner_bps, self.cut_of(key)).is_ok()
    }

    fn cut_of(&self, key: (usize, u64)) -> u16 {
        self.cuts.get(&key).copied().unwrap_or(self.cut)
    }

    fn fill_allowed(&self, kind: Kind) -> bool {
        self.paused & PAUSE_FILL == 0 && !kind.enabled_in(self.fill_disabled)
    }

    fn taking(&mut self, slot: Option<Slot>, skew: i64, key: (usize, u64)) -> u64 {
        self.env.partner_to = self.partnered.contains(&key).then_some(self.partner_to);
        let remaining = match slot {
            Some(Slot::Open { escrowed, .. }) => escrowed,
            _ => 0,
        };
        let amount_in = remaining.saturating_add_signed(skew);
        self.env.amount_in = Some(amount_in);
        amount_in
    }

    fn fill(
        &mut self,
        trader: usize,
        nonce: u64,
        delta: i64,
        skew: i64,
        flash: bool,
    ) -> TestResult {
        let now = self.env.now();
        let slot = self.slots.get(&(trader, nonce)).copied();
        let required = match slot {
            Some(Slot::Open { terms, .. }) => terms.required(now),
            _ => None,
        };
        let out = required.unwrap_or(1).saturating_add_signed(delta);
        let open = match (slot, required) {
            (
                Some(Slot::Open {
                    kind,
                    escrowed,
                    expires_at,
                    payer,
                    mandate,
                    ..
                }),
                Some(required),
            ) if now < expires_at
                && self.live(trader, mandate)
                && out >= required
                && self.held(&self.solver.output) >= out
                && self.fill_allowed(kind)
                && self.fees_payable((trader, nonce), kind, escrowed)
                && skew == 0 =>
            {
                Some((escrowed, payer))
            }
            _ => None,
        };
        let amount_in = self.taking(slot, skew, (trader, nonce));
        let owner = self.owner(trader)?;
        let receiver = self.trader(trader)?.receiver;
        let ixs = if flash {
            vec![
                self.env.begin_fill_ix(
                    &self.solver.key.pubkey(),
                    &owner,
                    &self.market,
                    nonce,
                    &self.solver.input,
                    Some(&self.fee_to),
                    1,
                ),
                self.env.end_fill_ix(
                    &self.solver.key.pubkey(),
                    &owner,
                    &self.market,
                    nonce,
                    &receiver,
                    &self.solver.output,
                    out,
                ),
            ]
        } else {
            vec![self.env.fill_ix(
                &self.solver,
                &owner,
                &self.market,
                nonce,
                &receiver,
                Some(&self.fee_to),
                out,
            )]
        };
        self.env.amount_in = None;
        let solver = self.solver.key.insecure_clone();
        let outcome = self.env.send(&solver, &ixs, &[]);
        if outcome.is_ok() != open.is_some() {
            return Err(format!(
                "fill {trader}/{nonce} flash={flash} out={out} in={amount_in} model={slot:?} got {outcome:?}"
            )
            .into());
        }
        if let Some((escrowed, payer)) = open {
            sub(&mut self.balances, self.solver.output, out)?;
            add(&mut self.balances, receiver, out)?;
            self.settle(trader, nonce, escrowed, payer)?;
        }
        Ok(())
    }

    fn attest(
        &mut self,
        trader: usize,
        nonce: u64,
        high: bool,
        offset: i64,
        skew: i64,
    ) -> TestResult {
        let now = self.env.now();
        let slot = self.slots.get(&(trader, nonce)).copied();
        let (bounds, escrowed) = match slot {
            Some(Slot::Open {
                terms:
                    Terms::Attested {
                        min_result,
                        max_result,
                    },
                escrowed,
                ..
            }) => ((min_result, max_result), escrowed),
            Some(Slot::Open { escrowed, .. }) => ((0, 0), escrowed),
            _ => ((0, 0), 0),
        };
        let result = (if high { bounds.1 } else { bounds.0 }).saturating_add_signed(offset);
        let open = match slot {
            Some(Slot::Open {
                kind,
                terms: Terms::Attested { .. },
                expires_at,
                payer,
                ..
            }) if now < expires_at
                && result >= bounds.0
                && result <= bounds.1
                && self.fill_allowed(kind)
                && self.fees_payable((trader, nonce), kind, escrowed)
                && skew == 0 =>
            {
                Some(payer)
            }
            _ => None,
        };
        let amount_in = self.taking(slot, skew, (trader, nonce));
        let owner = self.owner(trader)?;
        let payee = self.solver.input;
        let message = attestation_message(
            DOMAIN,
            &self.attestor.pubkey(),
            &intent_pda(&owner, nonce),
            &payee,
            escrowed,
            result,
        );
        let ixs = [
            ed25519_ix(&self.attestor, &message),
            self.env.fill_attested_ix(
                &self.solver.key.pubkey(),
                &owner,
                &self.market,
                nonce,
                &payee,
                Some(&self.fee_to),
                result,
            ),
        ];
        self.env.amount_in = None;
        let solver = self.solver.key.insecure_clone();
        let outcome = self.env.send(&solver, &ixs, &[]);
        if outcome.is_ok() != open.is_some() {
            return Err(format!(
                "attest {trader}/{nonce} result={result} in={amount_in} model={slot:?} got {outcome:?}"
            )
            .into());
        }
        if let Some(payer) = open {
            self.settle(trader, nonce, escrowed, payer)?;
        }
        Ok(())
    }

    fn refund(&mut self, trader: usize, nonce: u64, to: Status) -> TestResult {
        let now = self.env.now();
        let slot = self.slots.get(&(trader, nonce)).copied();
        let open = match slot {
            Some(Slot::Open {
                expires_at, payer, ..
            }) if to == Status::Cancelled || now >= expires_at => Some(payer),
            _ => None,
        };
        let owner = self.owner(trader)?;
        let input = self.trader(trader)?.input;
        let key = self.trader(trader)?.key.insecure_clone();
        let ix = if to == Status::Cancelled {
            self.env.cancel_ix(&owner, &self.market, nonce, &input)
        } else {
            self.env.expire_ix(
                &self.solver.key.pubkey(),
                &owner,
                &self.market,
                nonce,
                &input,
            )
        };
        let earner = self.env.lamports(&self.solver.key.pubkey());
        let outcome = if to == Status::Cancelled {
            self.env.send(&key, &[ix], &[])
        } else {
            let solver = self.solver.key.insecure_clone();
            self.env.send(&solver, &[ix], &[])
        };
        if to == Status::Expired && open.is_some() {
            let bounty = self.bounties.insert((trader, nonce), 0).unwrap_or_default();
            self.earned(earner, bounty)?;
        }
        if outcome.is_ok() != open.is_some() {
            return Err(format!("{to:?} {trader}/{nonce} model={slot:?} got {outcome:?}").into());
        }
        if let Some(payer) = open {
            let vault = self.vault(trader, nonce)?;
            let held = self.held(&vault);
            sub(&mut self.balances, vault, held)?;
            add(&mut self.balances, input, held)?;
            self.slots.insert(
                (trader, nonce),
                Slot::Settled {
                    status: to,
                    payer,
                    filled: 0,
                },
            );
        }
        Ok(())
    }

    fn earned(&self, before: u64, bounty: u32) -> TestResult {
        let after = self.env.lamports(&self.solver.key.pubkey());
        let expected = before
            .checked_add(u64::from(bounty))
            .and_then(|v| v.checked_sub(SIGNATURE_FEE))
            .ok_or("model overflow")?;
        if after != expected {
            return Err(format!("cranker holds {after} lamports, model {expected}").into());
        }
        Ok(())
    }

    fn close(&mut self, trader: usize, nonce: u64) -> TestResult {
        let slot = self.slots.get(&(trader, nonce)).copied();
        let expected = matches!(slot, Some(Slot::Settled { .. }));
        let owner = self.owner(trader)?;
        let input = self.trader(trader)?.input;
        let rent_payer = match slot {
            Some(Slot::Settled {
                payer: Payer::Relayer,
                ..
            }) => self.relayer.pubkey(),
            Some(Slot::Settled {
                payer: Payer::Agent,
                ..
            }) => self.agent.pubkey(),
            _ => owner,
        };
        let ix = self.env.close_ix_with(
            &self.solver.key.pubkey(),
            &owner,
            &rent_payer,
            &self.market,
            nonce,
            &input,
        );
        let earner = self.env.lamports(&self.solver.key.pubkey());
        let solver = self.solver.key.insecure_clone();
        let outcome = self.env.send(&solver, &[ix], &[]);
        if outcome.is_ok() != expected {
            return Err(format!("close {trader}/{nonce} model={slot:?} got {outcome:?}").into());
        }
        if expected {
            let bounty = self.bounties.remove(&(trader, nonce)).unwrap_or_default();
            let cancelled = matches!(
                slot,
                Some(Slot::Settled {
                    status: Status::Cancelled,
                    ..
                })
            );
            self.earned(earner, if cancelled { 0 } else { bounty })?;
            let vault = self.vault(trader, nonce)?;
            let held = self.balances.remove(&vault).unwrap_or_default();
            add(&mut self.balances, input, held)?;
            self.slots.insert((trader, nonce), Slot::Closed);
        }
        Ok(())
    }

    fn check(&self) -> TestResult {
        for (key, expected) in &self.balances {
            let actual = self.env.balance(key)?;
            if actual != *expected {
                return Err(format!("{key} holds {actual}, model {expected}").into());
            }
        }
        let supply = self
            .balances
            .iter()
            .filter(|(key, _)| {
                **key != self.solver.output && !self.traders.iter().any(|t| t.receiver == **key)
            })
            .try_fold(0u64, |sum, (_, v)| sum.checked_add(*v))
            .ok_or("supply overflow")?;
        let minted = FUNDED
            .checked_mul(TRADERS as u64)
            .and_then(|m| m.checked_add(self.donated))
            .ok_or("supply overflow")?;
        if supply != minted {
            return Err(format!("input supply {supply} != {minted}").into());
        }
        for (&(trader, nonce), slot) in &self.slots {
            let owner = self.owner(trader)?;
            let vault = self.vault(trader, nonce)?;
            match slot {
                Slot::Closed => {
                    if self.env.exists(&intent_pda(&owner, nonce)) || self.env.exists(&vault) {
                        return Err(format!("{trader}/{nonce} closed but accounts remain").into());
                    }
                }
                Slot::Open { .. } => self.status_is(trader, nonce, Status::Open, 0)?,
                Slot::Settled { status, filled, .. } => {
                    self.status_is(trader, nonce, *status, *filled)?
                }
            }
        }
        for (trader, epoch) in self.epochs.iter().enumerate() {
            let actual = self.env.user(&self.owner(trader)?)?.epoch;
            if actual != *epoch {
                return Err(format!("trader {trader} epoch {actual}, model {epoch}").into());
            }
        }
        for (trader, grants) in self.grants.iter().enumerate() {
            let actual = self.env.user(&self.owner(trader)?)?.grants;
            if actual != *grants {
                return Err(format!("trader {trader} grants {actual}, model {grants}").into());
            }
        }
        let rent = self
            .env
            .svm
            .minimum_balance_for_rent_exemption(intent_engine::state::Intent::SPACE);
        for (&(trader, nonce), bounty) in &self.bounties {
            let intent = intent_pda(&self.owner(trader)?, nonce);
            let held = self.env.lamports(&intent);
            let stored = self.env.intent(&self.owner(trader)?, nonce)?.bounty;
            if Some(held) != rent.checked_add(u64::from(*bounty)) || stored != *bounty {
                return Err(format!(
                    "{trader}/{nonce} holds {held} lamports and bounty {stored}, model rent {rent} + {bounty}"
                )
                .into());
            }
        }
        let treasury = self
            .env
            .lamports(&self.env.fee_recipient)
            .checked_sub(self.treasury_start)
            .ok_or("treasury lost lamports")?;
        if treasury != self.treasury {
            return Err(format!("treasury earned {treasury}, model {}", self.treasury).into());
        }
        for (trader, id) in (0..TRADERS).flat_map(|t| (0..IDS).map(move |id| (t, id))) {
            let owner = self.owner(trader)?;
            let address = mandate_pda(&owner, &self.agent.pubkey(), id);
            match self.granted.get(&(trader, id)) {
                Some(m) => {
                    let actual = self.env.mandate(&address)?;
                    if (actual.spent, actual.intents) != (m.spent, m.intents) {
                        return Err(format!(
                            "mandate {trader}/{id} spent {} over {} intents, model {} over {}",
                            actual.spent, actual.intents, m.spent, m.intents
                        )
                        .into());
                    }
                }
                None => {
                    if self.env.exists(&address) {
                        return Err(
                            format!("mandate {trader}/{id} revoked but still exists").into()
                        );
                    }
                }
            }
        }
        let disabled = self.env.config()?.fill_disabled_kinds;
        if disabled != self.fill_disabled {
            return Err(
                format!("fill kill switch {disabled}, model {}", self.fill_disabled).into(),
            );
        }
        Ok(())
    }

    fn status_is(&self, trader: usize, nonce: u64, status: Status, filled: u64) -> TestResult {
        let intent = self.env.intent(&self.owner(trader)?, nonce)?;
        if intent.status != status as u8 {
            return Err(format!(
                "{trader}/{nonce} status {}, model {status:?}",
                intent.status
            )
            .into());
        }
        let revision = u32::from(filled > 0);
        if intent.filled != filled || intent.revision != revision || intent.in_flight != 0 {
            return Err(format!(
                "{trader}/{nonce} filled {} revision {} in flight {}, model {filled} {revision} 0",
                intent.filled, intent.revision, intent.in_flight
            )
            .into());
        }
        Ok(())
    }
}

fn run(token_2022: bool, ops: &[Op]) -> TestResult {
    let program = if token_2022 {
        anchor_spl::token_2022::ID
    } else {
        anchor_spl::token::ID
    };
    let mut world = World::new(program)?;
    for (step, op) in ops.iter().enumerate() {
        world
            .apply(op)
            .and_then(|()| world.check())
            .map_err(|e| format!("step {step} {op:?}: {e}"))?;
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(
        std::env::var("MODEL_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(48)
    ))]

    #[test]
    fn the_engine_tracks_a_reference_model(token_2022 in any::<bool>(), ops in prop::collection::vec(op(), 1..40)) {
        run(token_2022, &ops).map_err(|e| TestCaseError::fail(e.to_string()))?;
    }
}

#[test]
fn dutch_fills_track_the_decayed_price_at_every_point() -> TestResult {
    for token_2022 in [false, true] {
        for (warp, delta) in [
            (0, 0),
            (0, -1),
            (30, 0),
            (30, -1),
            (60, 0),
            (90, 0),
            (90, -1),
        ] {
            let ops = [
                Op::Create {
                    trader: 0,
                    nonce: 0,
                    amount: 500,
                    shape: Shape::Dutch {
                        start_out: 60,
                        end_out: 20,
                        span: 60,
                    },
                    ttl: 90,
                    route: Route::Direct,
                    partnered: false,
                    mandate: 0,
                },
                Op::Warp { secs: warp },
                Op::Fill {
                    trader: 0,
                    nonce: 0,
                    delta,
                    skew: 0,
                },
            ];
            run(token_2022, &ops).map_err(|e| format!("warp {warp} delta {delta}: {e}"))?;
        }
    }
    Ok(())
}

#[test]
fn attested_intents_settle_exactly_inside_their_range() -> TestResult {
    for token_2022 in [false, true] {
        for (high, offset) in [(true, 0), (true, 1), (false, 0), (false, -1)] {
            for route in [Route::Direct, Route::Signed] {
                let ops = [
                    Op::Create {
                        trader: 1,
                        nonce: 2,
                        amount: 300,
                        shape: Shape::Attested {
                            min_result: 10,
                            max_result: 20,
                        },
                        ttl: 60,
                        route,
                        partnered: false,
                        mandate: 0,
                    },
                    Op::Attest {
                        trader: 1,
                        nonce: 2,
                        high,
                        offset,
                        skew: 0,
                    },
                    Op::Cancel {
                        trader: 1,
                        nonce: 2,
                    },
                    Op::Close {
                        trader: 1,
                        nonce: 2,
                    },
                ];
                run(token_2022, &ops)
                    .map_err(|e| format!("high {high} offset {offset} route {route:?}: {e}"))?;
            }
        }
    }
    Ok(())
}

#[test]
fn every_delivery_kind_fills_at_its_exact_price_and_not_one_unit_less() -> TestResult {
    let shapes = [
        Shape::Swap { min_out: 37 },
        Shape::Limit { take: 41 },
        Shape::Dutch {
            start_out: 50,
            end_out: 10,
            span: 40,
        },
    ];
    for token_2022 in [false, true] {
        for shape in shapes {
            for route in [Route::Direct, Route::Signed, Route::Agent] {
                let nonce = if route == Route::Agent {
                    agent_lane(1, 1)
                } else {
                    1
                };
                for delta in [0, -1] {
                    for flash in [false, true] {
                        let fill = if flash {
                            Op::Flash {
                                trader: 0,
                                nonce,
                                delta,
                                skew: 0,
                            }
                        } else {
                            Op::Fill {
                                trader: 0,
                                nonce,
                                delta,
                                skew: 0,
                            }
                        };
                        let ops = [
                            Op::Grant {
                                trader: 0,
                                id: 0,
                                preset: 0,
                                valid_for: 120,
                                partnered: false,
                            },
                            Op::Create {
                                trader: 0,
                                nonce,
                                amount: 700,
                                shape,
                                ttl: 80,
                                route,
                                partnered: false,
                                mandate: 0,
                            },
                            Op::Warp { secs: 15 },
                            fill,
                            Op::Close { trader: 0, nonce },
                        ];
                        run(token_2022, &ops).map_err(|e| {
                            format!("{shape:?} route {route:?} delta {delta} flash {flash}: {e}")
                        })?;
                    }
                }
            }
        }
    }
    Ok(())
}

#[test]
fn fills_of_mandated_intents_follow_the_life_of_their_grant() -> TestResult {
    let create = |trader, lane, n, mandate| Op::Create {
        trader,
        nonce: agent_lane(lane, n),
        amount: 400,
        shape: Shape::Swap { min_out: 5 },
        ttl: 80,
        route: Route::Agent,
        partnered: false,
        mandate,
    };
    let grant = |trader, id| Op::Grant {
        trader,
        id,
        preset: 0,
        valid_for: 120,
        partnered: false,
    };
    let fill = |trader, lane, n| Op::Fill {
        trader,
        nonce: agent_lane(lane, n),
        delta: 0,
        skew: 0,
    };
    let flash = |trader, lane, n| Op::Flash {
        trader,
        nonce: agent_lane(lane, n),
        delta: 0,
        skew: 0,
    };
    for token_2022 in [false, true] {
        let ops = [
            Op::Grant {
                trader: 1,
                id: 0,
                preset: 4,
                valid_for: 120,
                partnered: false,
            },
            create(1, 1, 2, 0),
            create(1, 1, 3, 0),
            fill(1, 1, 2),
            grant(0, 0),
            create(0, 1, 0, 0),
            create(0, 1, 1, 0),
            Op::Revoke { trader: 0, id: 0 },
            fill(0, 1, 0),
            flash(0, 1, 0),
            grant(0, 0),
            create(0, 1, 2, 0),
            create(0, 2, 2, 0),
            fill(0, 1, 0),
            flash(0, 1, 1),
            fill(0, 2, 2),
            grant(1, 1),
            create(1, 1, 0, 1),
            create(1, 2, 0, 1),
            fill(1, 2, 0),
            create(1, 2, 1, 1),
            Op::Epoch { trader: 1, jump: 1 },
            flash(1, 2, 1),
            fill(1, 2, 1),
        ];
        run(token_2022, &ops)?;
    }
    Ok(())
}

#[test]
fn stale_signatures_and_stopped_kinds_track_the_model() -> TestResult {
    let swap = Shape::Swap { min_out: 5 };
    let create = |nonce, route| Op::Create {
        trader: 0,
        nonce,
        amount: 400,
        shape: swap,
        ttl: 80,
        route,
        partnered: false,
        mandate: 0,
    };
    let fill = |nonce, skew| Op::Fill {
        trader: 0,
        nonce,
        delta: 0,
        skew,
    };
    for token_2022 in [false, true] {
        let ops = [
            Op::Epoch { trader: 0, jump: 1 },
            create(0, Route::Stale),
            create(0, Route::Signed),
            Op::Epoch { trader: 0, jump: 1 },
            Op::Epoch { trader: 1, jump: 3 },
            create(1, Route::Stale),
            create(1, Route::Direct),
            fill(0, 1),
            fill(0, -1),
            fill(0, i64::MAX),
            Op::KillFills {
                mask: Kind::SwapExactIn.bit(),
            },
            fill(0, 0),
            Op::Flash {
                trader: 0,
                nonce: 1,
                delta: 0,
                skew: 0,
            },
            Op::KillFills {
                mask: Kind::LimitOrder.bit() | Kind::AttestedResult.bit(),
            },
            fill(0, 0),
            Op::Flash {
                trader: 0,
                nonce: 1,
                delta: 0,
                skew: 0,
            },
            Op::Close {
                trader: 0,
                nonce: 0,
            },
            Op::Close {
                trader: 0,
                nonce: 1,
            },
        ];
        run(token_2022, &ops)?;
    }
    Ok(())
}

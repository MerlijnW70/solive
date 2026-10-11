use anchor_lang::prelude::Pubkey;
use anchor_spl::token_2022::spl_token_2022::instruction as token_ix;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::{v0, AddressLookupTableAccount, Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use svm_tests::{intent_pda, swap_spec, vault_pda, Env, Market, Solver, TestResult, Trader};

const PACKET: usize = 1_232;
const ESCROW: u64 = 400;
const OUT: u64 = 300;
const HOPS: usize = 100;
const ROUTE_CAPACITY_WITH_TABLE: usize = 50;
const ROUTE_CAPACITY_WITHOUT_TABLE: usize = 12;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    fee_to: Pubkey,
    hops: Vec<Pubkey>,
}

fn world(program: Pubkey) -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(program, &[], program, &[])?;
    let trader = env.trader(&market, 1_000)?;
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let mut hops = Vec::new();
    for _ in 0..HOPS {
        hops.push(env.create_token_account(&market.output_mint, &solver.key.pubkey(), program)?);
    }
    let first = *hops.first().ok_or("no hops")?;
    env.mint_to(&market.output_mint, &first, program, OUT)?;
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    Ok(World {
        env,
        market,
        trader,
        solver,
        fee_to,
        hops,
    })
}

impl World {
    fn flash(&self, k: usize) -> TestResult<Vec<Instruction>> {
        let me = self.solver.key.pubkey();
        let owner = self.trader.key.pubkey();
        let mut route = Vec::new();
        let chain: Vec<Pubkey> = self
            .hops
            .iter()
            .take(k)
            .copied()
            .chain(std::iter::once(self.solver.output))
            .collect();
        for pair in chain.windows(2) {
            if let [from, to] = pair {
                route.push(token_ix::transfer_checked(
                    &self.market.output_program,
                    from,
                    &self.market.output_mint,
                    to,
                    &me,
                    &[],
                    OUT,
                    9,
                )?);
            }
        }
        let end_index = u16::try_from(route.len().checked_add(1).ok_or("overflow")?)?;
        let mut ixs = vec![self.env.begin_fill_ix(
            &me,
            &owner,
            &self.market,
            0,
            &self.solver.input,
            Some(&self.fee_to),
            end_index,
        )];
        ixs.extend(route);
        ixs.push(self.env.end_fill_ix(
            &me,
            &owner,
            &self.market,
            0,
            &self.trader.receiver,
            &self.solver.output,
            OUT,
        ));
        Ok(ixs)
    }

    fn table(&mut self) -> TestResult<AddressLookupTableAccount> {
        let mut addresses: Vec<Pubkey> = Vec::new();
        for ix in self.flash(HOPS)? {
            for key in std::iter::once(ix.program_id).chain(ix.accounts.iter().map(|m| m.pubkey)) {
                if key != self.solver.key.pubkey() && !addresses.contains(&key) {
                    addresses.push(key);
                }
            }
        }
        let mut data = Vec::new();
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.push(0);
        data.push(0);
        data.extend_from_slice(&[0u8; 32]);
        data.extend_from_slice(&[0u8; 2]);
        for key in &addresses {
            data.extend_from_slice(key.as_ref());
        }
        let key = Pubkey::new_unique();
        let mut account = self
            .env
            .svm
            .get_account(&self.fee_to)
            .ok_or("template account")?;
        account.lamports = 1_000_000_000;
        account.data = data;
        account.owner = solana_address_lookup_table_interface::program::id();
        self.env.svm.set_account(key, account)?;
        self.env.svm.warp_to_slot(10);
        Ok(AddressLookupTableAccount { key, addresses })
    }

    fn versioned(
        &self,
        ixs: &[Instruction],
        table: Option<&AddressLookupTableAccount>,
    ) -> TestResult<VersionedTransaction> {
        let payer: &Keypair = &self.solver.key;
        let blockhash = self.env.svm.latest_blockhash();
        let message = match table {
            Some(table) => VersionedMessage::V0(v0::Message::try_compile(
                &payer.pubkey(),
                ixs,
                std::slice::from_ref(table),
                blockhash,
            )?),
            None => VersionedMessage::Legacy(Message::new_with_blockhash(
                ixs,
                Some(&payer.pubkey()),
                &blockhash,
            )),
        };
        Ok(VersionedTransaction::try_new(message, &[payer])?)
    }

    fn capacity(&self, table: Option<&AddressLookupTableAccount>) -> TestResult<usize> {
        let mut fits = 0;
        for k in 1..=HOPS {
            let tx = self.versioned(&self.flash(k)?, table)?;
            if usize::try_from(bincode::serialized_size(&tx)?)? > PACKET
                || self.env.svm.simulate_transaction(tx).is_err()
            {
                break;
            }
            fits = k;
        }
        Ok(fits)
    }
}

#[test]
fn a_multi_hop_route_fits_between_begin_and_end_and_settles() -> TestResult {
    for program in [anchor_spl::token::ID, anchor_spl::token_2022::ID] {
        let mut w = world(program)?;
        let bare = w.capacity(None)?;
        let table = w.table()?;
        let packed = w.capacity(Some(&table))?;
        assert!(
            bare >= ROUTE_CAPACITY_WITHOUT_TABLE,
            "{program} legacy route capacity {bare}"
        );
        assert!(
            packed >= ROUTE_CAPACITY_WITH_TABLE,
            "{program} table route capacity {packed}"
        );
        assert!(
            packed > bare,
            "{program} the table adds no room: {packed} vs {bare}"
        );
        w.env.svm.expire_blockhash();
        let tx = w.versioned(&w.flash(packed)?, Some(&table))?;
        let meta = w
            .env
            .svm
            .send_transaction(tx)
            .map_err(|f| format!("{:?} {:?}", f.err, f.meta.logs))?;
        assert_eq!(w.env.balance(&w.trader.receiver)?, OUT);
        assert_eq!(
            w.env
                .balance(&vault_pda(&intent_pda(&w.trader.key.pubkey(), 0)))?,
            0
        );
        assert!(
            meta.compute_units_consumed < 1_400_000,
            "{}",
            meta.compute_units_consumed
        );
    }
    Ok(())
}

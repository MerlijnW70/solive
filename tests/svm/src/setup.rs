use super::*;

pub const START_TS: i64 = 1_700_000_000;
pub const DOMAIN: [u8; 32] = [0x11; 32];
pub const FUNDING: u64 = 100_000_000_000;

pub fn engine_program_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/intent_engine.so")
}

pub const RELAY_ID: Pubkey = Pubkey::new_from_array([0x52; 32]);

pub fn relay_program_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/cpi_relay.so")
}

pub fn svm_with_engine() -> Result<LiteSVM, Box<dyn Error>> {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(intent_engine::ID, engine_program_path())?;
    svm.add_program_from_file(RELAY_ID, relay_program_path())?;
    Ok(svm)
}

pub fn relayed(target: Pubkey, inner: Instruction) -> Instruction {
    let mut accounts = vec![solana_instruction::AccountMeta::new_readonly(target, false)];
    accounts.extend(inner.accounts);
    Instruction {
        program_id: RELAY_ID,
        accounts,
        data: inner.data,
    }
}

pub fn engine_ix<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
    Instruction {
        program_id: intent_engine::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MintExt {
    MintCloseAuthority,
    MetadataPointer,
    PermanentDelegate,
    TransferHook,
    TransferFee,
    DefaultFrozen,
    NonTransferable,
    InterestBearing,
    ScaledUi,
    Pausable,
    Freezable,
}

impl MintExt {
    fn extension_type(self) -> Option<ExtensionType> {
        match self {
            Self::MintCloseAuthority => Some(ExtensionType::MintCloseAuthority),
            Self::MetadataPointer => Some(ExtensionType::MetadataPointer),
            Self::PermanentDelegate => Some(ExtensionType::PermanentDelegate),
            Self::TransferHook => Some(ExtensionType::TransferHook),
            Self::TransferFee => Some(ExtensionType::TransferFeeConfig),
            Self::DefaultFrozen => Some(ExtensionType::DefaultAccountState),
            Self::NonTransferable => Some(ExtensionType::NonTransferable),
            Self::InterestBearing => Some(ExtensionType::InterestBearingConfig),
            Self::ScaledUi => Some(ExtensionType::ScaledUiAmount),
            Self::Pausable => Some(ExtensionType::Pausable),
            Self::Freezable => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountExt {
    MemoRequired,
    CpiGuard,
}

pub struct Env {
    pub svm: LiteSVM,
    pub authority: Keypair,
    pub guardian: Keypair,
    pub fee_recipient: Pubkey,
    pub max_fee_bps: u16,
    pub max_create_fee: u32,
    pub max_bounty: u32,
    pub amount_in: Option<u64>,
    pub ext: Vec<u8>,
    pub partner_to: Option<Pubkey>,
    pub mandate_accounts: Option<(Option<Pubkey>, Option<Pubkey>)>,
    pub relayer_fee: u64,
    pub relayer_fee_to: Option<Pubkey>,
    pub agent_to: Option<Option<Pubkey>>,
    pub judge_to: Option<Pubkey>,
    pub claims: Option<Pubkey>,
    pub stake_to: Option<Pubkey>,
    pub mint_cap: Option<Pubkey>,
    pub committee: Option<Pubkey>,
    pub announcement: Option<Pubkey>,
    pub opening: intent_engine::Opening,
}

impl Env {
    pub fn new() -> TestResult<Self> {
        let mut svm = svm_with_engine()?;
        let authority = Keypair::new();
        let guardian = Keypair::new();
        let fee_recipient = Pubkey::new_unique();
        for who in [authority.pubkey(), guardian.pubkey(), fee_recipient] {
            svm.airdrop(&who, FUNDING)
                .map_err(|f| format!("airdrop: {:?}", f.err))?;
        }
        let mut env = Self {
            svm,
            authority,
            guardian,
            fee_recipient,
            max_fee_bps: intent_engine::state::MAX_FEE_BPS,
            max_create_fee: intent_engine::state::MAX_CREATE_FEE,
            max_bounty: intent_engine::state::MAX_CRANK_BOUNTY,
            amount_in: None,
            ext: Vec::new(),
            partner_to: None,
            mandate_accounts: None,
            relayer_fee: 0,
            relayer_fee_to: None,
            agent_to: None,
            judge_to: None,
            claims: None,
            stake_to: None,
            mint_cap: None,
            committee: None,
            announcement: None,
            opening: intent_engine::Opening::default(),
        };
        env.set_now(START_TS);
        let key = env.authority.pubkey();
        env.set_upgrade_authority(Some(key))?;
        Ok(env)
    }

    pub fn settings(&self) -> ConfigSettings {
        ConfigSettings {
            guardian: self.guardian.pubkey(),
            fee_recipient: self.fee_recipient,
            enabled_kinds: intent_core::kinds::ALL_KINDS_MASK,
            fee_bps: 5,
            paused: 0,
        }
    }

    pub fn funded(&mut self) -> TestResult<Keypair> {
        let kp = Keypair::new();
        self.svm
            .airdrop(&kp.pubkey(), FUNDING)
            .map_err(|f| format!("airdrop: {:?}", f.err))?;
        Ok(kp)
    }

    pub fn send(
        &mut self,
        payer: &Keypair,
        ixs: &[Instruction],
        extra: &[&Keypair],
    ) -> Result<TransactionMetadata, TransactionError> {
        self.svm.expire_blockhash();
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra);
        let message = Message::new(ixs, Some(&payer.pubkey()));
        let tx = Transaction::new(&signers, message, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map_err(|f| f.err)
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn set_now(&mut self, ts: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = ts;
        self.svm.set_sysvar(&clock);
    }

    pub fn set_upgrade_authority(&mut self, key: Option<Pubkey>) -> TestResult {
        let address = program_data_address();
        let mut account = self
            .svm
            .get_account(&address)
            .ok_or("program data missing")?;
        let tag = account.data.get_mut(12).ok_or("program data too short")?;
        *tag = u8::from(key.is_some());
        let slot = account
            .data
            .get_mut(13..45)
            .ok_or("program data too short")?;
        slot.copy_from_slice(key.unwrap_or_default().as_ref());
        self.svm.set_account(address, account)?;
        Ok(())
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map_or(0, |a| a.lamports)
    }

    pub fn exists(&self, key: &Pubkey) -> bool {
        self.lamports(key) > 0
    }

    pub fn init_config_ix(&self, authority: &Pubkey, settings: ConfigSettings) -> Instruction {
        engine_ix(
            intent_engine::accounts::InitConfig {
                authority: *authority,
                config: config_pda(),
                engine_program: intent_engine::ID,
                program_data: program_data_address(),
                system_program: anchor_lang::system_program::ID,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::InitConfig {
                args: settings,
                domain: DOMAIN,
            },
        )
    }

    pub fn init_config(&mut self) -> TestResult {
        let ix = self.init_config_ix(&self.authority.pubkey(), self.settings());
        let authority = self.authority.insecure_clone();
        self.send(&authority, &[ix], &[])?;
        Ok(())
    }

    pub fn init_user(&mut self, owner: &Keypair) -> Result<TransactionMetadata, TransactionError> {
        let ix = engine_ix(
            intent_engine::accounts::InitUser {
                owner: owner.pubkey(),
                user_state: user_pda(&owner.pubkey()),
                system_program: anchor_lang::system_program::ID,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::InitUser {},
        );
        self.send(owner, &[ix], &[])
    }

    pub fn create_mint(&mut self, token_program: Pubkey, exts: &[MintExt]) -> TestResult<Pubkey> {
        self.create_mint_with_decimals(token_program, exts, 6)
    }

    pub fn decimals(&self, mint: &Pubkey) -> TestResult<u8> {
        let data = self.svm.get_account(mint).ok_or("mint missing")?.data;
        Ok(StateWithExtensions::<MintState>::unpack(&data)?
            .base
            .decimals)
    }

    pub fn create_mint_with_decimals(
        &mut self,
        token_program: Pubkey,
        exts: &[MintExt],
        decimals: u8,
    ) -> TestResult<Pubkey> {
        let mint = Keypair::new();
        let types: Vec<ExtensionType> = exts.iter().filter_map(|e| e.extension_type()).collect();
        let len = ExtensionType::try_calculate_account_len::<MintState>(&types)?;
        let lamports = self.svm.minimum_balance_for_rent_exemption(len);
        let payer = self.authority.insecure_clone();
        let mut ixs = vec![solana_system_interface::instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            lamports,
            u64::try_from(len)?,
            &token_program,
        )];
        for ext in exts {
            ixs.push(match ext {
                MintExt::MintCloseAuthority => token_ix::initialize_mint_close_authority(
                    &token_program,
                    &mint.pubkey(),
                    Some(&payer.pubkey()),
                )?,
                MintExt::MetadataPointer => metadata_pointer::instruction::initialize(
                    &token_program,
                    &mint.pubkey(),
                    Some(payer.pubkey()),
                    Some(mint.pubkey()),
                )?,
                MintExt::PermanentDelegate => token_ix::initialize_permanent_delegate(
                    &token_program,
                    &mint.pubkey(),
                    &payer.pubkey(),
                )?,
                MintExt::TransferHook => transfer_hook::instruction::initialize(
                    &token_program,
                    &mint.pubkey(),
                    Some(payer.pubkey()),
                    Some(Pubkey::new_unique()),
                )?,
                MintExt::TransferFee => transfer_fee::instruction::initialize_transfer_fee_config(
                    &token_program,
                    &mint.pubkey(),
                    Some(&payer.pubkey()),
                    Some(&payer.pubkey()),
                    100,
                    u64::MAX,
                )?,
                MintExt::DefaultFrozen => {
                    default_account_state::instruction::initialize_default_account_state(
                        &token_program,
                        &mint.pubkey(),
                        &AccountState::Frozen,
                    )?
                }
                MintExt::NonTransferable => {
                    token_ix::initialize_non_transferable_mint(&token_program, &mint.pubkey())?
                }
                MintExt::InterestBearing => interest_bearing_mint::instruction::initialize(
                    &token_program,
                    &mint.pubkey(),
                    Some(payer.pubkey()),
                    500,
                )?,
                MintExt::ScaledUi => scaled_ui_amount::instruction::initialize(
                    &token_program,
                    &mint.pubkey(),
                    Some(payer.pubkey()),
                    2.5,
                )?,
                MintExt::Pausable => pausable::instruction::initialize(
                    &token_program,
                    &mint.pubkey(),
                    &payer.pubkey(),
                )?,
                MintExt::Freezable => continue,
            });
        }
        let freezer = payer.pubkey();
        ixs.push(token_ix::initialize_mint2(
            &token_program,
            &mint.pubkey(),
            &payer.pubkey(),
            (exts.contains(&MintExt::Freezable) || exts.contains(&MintExt::DefaultFrozen))
                .then_some(&freezer),
            decimals,
        )?);
        self.send(&payer, &ixs, &[&mint])?;
        Ok(mint.pubkey())
    }

    pub fn create_token_account(
        &mut self,
        mint: &Pubkey,
        owner: &Pubkey,
        token_program: Pubkey,
    ) -> TestResult<Pubkey> {
        let account = Keypair::new();
        let mint_data = self.svm.get_account(mint).ok_or("mint missing")?.data;
        let mint_types =
            StateWithExtensions::<MintState>::unpack(&mint_data)?.get_extension_types()?;
        let types = ExtensionType::get_required_init_account_extensions(&mint_types);
        let len = ExtensionType::try_calculate_account_len::<TokenState>(&types)?;
        let lamports = self.svm.minimum_balance_for_rent_exemption(len);
        let payer = self.authority.insecure_clone();
        let ixs = [
            solana_system_interface::instruction::create_account(
                &payer.pubkey(),
                &account.pubkey(),
                lamports,
                u64::try_from(len)?,
                &token_program,
            ),
            token_ix::initialize_account3(&token_program, &account.pubkey(), mint, owner)?,
        ];
        self.send(&payer, &ixs, &[&account])?;
        Ok(account.pubkey())
    }

    pub fn create_ata(
        &mut self,
        owner: &Pubkey,
        mint: &Pubkey,
        token_program: Pubkey,
    ) -> TestResult<Pubkey> {
        let payer = self.authority.insecure_clone();
        let ix = anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
            &payer.pubkey(),
            owner,
            mint,
            &token_program,
        );
        self.send(&payer, &[ix], &[])?;
        Ok(
            anchor_spl::associated_token::get_associated_token_address_with_program_id(
                owner,
                mint,
                &token_program,
            ),
        )
    }

    pub fn set_frozen(
        &mut self,
        account: &Pubkey,
        mint: &Pubkey,
        token_program: Pubkey,
        frozen: bool,
    ) -> TestResult {
        let issuer = self.authority.insecure_clone();
        let ix = if frozen {
            token_ix::freeze_account(&token_program, account, mint, &issuer.pubkey(), &[])?
        } else {
            token_ix::thaw_account(&token_program, account, mint, &issuer.pubkey(), &[])?
        };
        self.send(&issuer, &[ix], &[])?;
        Ok(())
    }

    pub fn add_account_ext(
        &mut self,
        owner: &Keypair,
        account: &Pubkey,
        token_program: Pubkey,
        ext: AccountExt,
    ) -> TestResult {
        let (kind, enable) = match ext {
            AccountExt::MemoRequired => (
                ExtensionType::MemoTransfer,
                memo_transfer::instruction::enable_required_transfer_memos(
                    &token_program,
                    account,
                    &owner.pubkey(),
                    &[],
                )?,
            ),
            AccountExt::CpiGuard => (
                ExtensionType::CpiGuard,
                cpi_guard::instruction::enable_cpi_guard(
                    &token_program,
                    account,
                    &owner.pubkey(),
                    &[],
                )?,
            ),
        };
        let realloc = token_ix::reallocate(
            &token_program,
            account,
            &owner.pubkey(),
            &owner.pubkey(),
            &[],
            &[kind],
        )?;
        self.send(owner, &[realloc, enable], &[])?;
        Ok(())
    }

    pub fn reassign_owner(
        &mut self,
        owner: &Keypair,
        account: &Pubkey,
        new_owner: &Pubkey,
        token_program: Pubkey,
    ) -> TestResult {
        let ix = token_ix::set_authority(
            &token_program,
            account,
            Some(new_owner),
            token_ix::AuthorityType::AccountOwner,
            &owner.pubkey(),
            &[],
        )?;
        self.send(owner, &[ix], &[])?;
        Ok(())
    }

    pub fn mint_to(
        &mut self,
        mint: &Pubkey,
        to: &Pubkey,
        token_program: Pubkey,
        amount: u64,
    ) -> TestResult {
        let decimals = self.decimals(mint)?;
        let payer = self.authority.insecure_clone();
        let ix = token_ix::mint_to_checked(
            &token_program,
            mint,
            to,
            &payer.pubkey(),
            &[],
            amount,
            decimals,
        )?;
        self.send(&payer, &[ix], &[])?;
        Ok(())
    }

    pub fn transfer(
        &mut self,
        owner: &Keypair,
        from: &Pubkey,
        mint: &Pubkey,
        to: &Pubkey,
        token_program: Pubkey,
        amount: u64,
    ) -> TestResult {
        let decimals = self.decimals(mint)?;
        let ix = token_ix::transfer_checked(
            &token_program,
            from,
            mint,
            to,
            &owner.pubkey(),
            &[],
            amount,
            decimals,
        )?;
        self.send(owner, &[ix], &[])?;
        Ok(())
    }

    pub fn balance(&self, account: &Pubkey) -> TestResult<u64> {
        let data = self
            .svm
            .get_account(account)
            .ok_or("token account missing")?
            .data;
        Ok(StateWithExtensions::<TokenState>::unpack(&data)?
            .base
            .amount)
    }
}

pub fn events<T: anchor_lang::AnchorDeserialize + anchor_lang::Discriminator>(
    meta: &TransactionMetadata,
) -> Vec<T> {
    meta.inner_instructions
        .iter()
        .flatten()
        .filter_map(|inner| {
            let data = inner.instruction.data.as_slice();
            let rest = data.strip_prefix(anchor_lang::event::EVENT_IX_TAG_LE)?;
            let mut body = rest.strip_prefix(T::DISCRIMINATOR)?;
            T::deserialize(&mut body).ok()
        })
        .collect()
}

pub fn token_transfers(meta: &TransactionMetadata) -> usize {
    const TRANSFER_CHECKED: u8 = 12;
    meta.inner_instructions
        .iter()
        .flatten()
        .filter(|inner| inner.instruction.data.first() == Some(&TRANSFER_CHECKED))
        .count()
}

pub fn load<T: bytemuck::Pod>(svm: &LiteSVM, key: &Pubkey) -> TestResult<T> {
    let account = svm.get_account(key).ok_or("account missing")?;
    let body = account.data.get(8..).ok_or("account too short")?;
    let bytes = body
        .get(..core::mem::size_of::<T>())
        .ok_or("account too short")?;
    Ok(bytemuck::pod_read_unaligned(bytes))
}

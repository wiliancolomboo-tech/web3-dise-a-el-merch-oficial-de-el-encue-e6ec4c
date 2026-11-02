use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;

declare_id!("EncuentroMerch11111111111111111111111111111");

pub const MAX_ITEM_NAME_LEN: usize = 32;
pub const MAX_URI_LEN: usize = 96;
pub const MAX_ALLOWED_TIMESTAMP_DRIFT: i64 = 180; // 3 minutes validity window

#[program]
pub mod el_encuentro_merch {
    use super::*;

    /// Initializes master configuration for El Encuentro 2026 merch collection
    pub fn initialize_collection(
        ctx: Context<InitializeCollection>,
        collection_name: String,
        max_supply: u32,
    ) -> Result<()> {
        require!(collection_name.len() <= MAX_ITEM_NAME_LEN, MerchError::NameTooLong);
        require!(max_supply > 0, MerchError::InvalidMaxSupply);

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.collection_name = collection_name;
        config.total_registered = 0;
        config.total_claimed = 0;
        config.max_supply = max_supply;
        config.is_paused = false;
        config.bump = ctx.bumps.config;

        emit!(CollectionInitializedEvent {
            admin: config.admin,
            max_supply,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Factory-level registration of physical goods prior to distribution
    pub fn register_physical_item(
        ctx: Context<RegisterPhysicalItem>,
        item_id: u32,
        chip_pubkey: Pubkey,
        apparel_type: ApparelType,
        size: ApparelSize,
        metadata_uri: String,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.is_paused, MerchError::ProtocolPaused);
        require!(config.total_registered < config.max_supply, MerchError::SupplyCapReached);
        require!(metadata_uri.len() <= MAX_URI_LEN, MerchError::UriTooLong);

        let item = &mut ctx.accounts.item;
        item.item_id = item_id;
        item.chip_pubkey = chip_pubkey;
        item.claimed_by = Pubkey::default();
        item.apparel_type = apparel_type;
        item.size = size;
        item.metadata_uri = metadata_uri;
        item.interaction_xp = 0;
        item.is_claimed = false;
        item.registered_at = Clock::get()?.unix_timestamp;
        item.bump = ctx.bumps.item;

        config.total_registered = config.total_registered.checked_add(1).ok_or(MerchError::ArithmeticOverflow)?;

        emit!(ItemRegisteredEvent {
            item_id,
            chip_pubkey,
            apparel_type,
            size,
        });

        Ok(())
    }

    /// Verifies physical NFC signature via pre-instruction or instruction inspection and transfers digital state
    pub fn verify_and_claim(
        ctx: Context<VerifyAndClaim>,
        item_id: u32,
        claim_timestamp: i64,
        _signature: [u8; 64],
    ) -> Result<()> {
        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;

        // Anti-replay: Ensure timestamp is within the acceptable freshness window
        require!(
            (current_time - claim_timestamp).abs() <= MAX_ALLOWED_TIMESTAMP_DRIFT,
            MerchError::SignatureExpired
        );

        let config = &mut ctx.accounts.config;
        require!(!config.is_paused, MerchError::ProtocolPaused);

        let item = &mut ctx.accounts.item;
        require!(!item.is_claimed, MerchError::ItemAlreadyClaimed);
        require!(item.item_id == item_id, MerchError::ItemIdMismatch);

        // Verify ed25519 signature instruction was executed immediately before this instruction
        verify_ed25519_ix(&ctx.accounts.ix_sysvar, &item.chip_pubkey, claim_timestamp, ctx.accounts.claimant.key())?;

        // State update
        item.is_claimed = true;
        item.claimed_by = ctx.accounts.claimant.key();

        let receipt = &mut ctx.accounts.claim_receipt;
        receipt.item_id = item_id;
        receipt.claimant = ctx.accounts.claimant.key();
        receipt.claimed_timestamp = current_time;
        receipt.bump = ctx.bumps.claim_receipt;

        config.total_claimed = config.total_claimed.checked_add(1).ok_or(MerchError::ArithmeticOverflow)?;

        emit!(ItemClaimedEvent {
            item_id,
            claimant: ctx.accounts.claimant.key(),
            timestamp: current_time,
        });

        Ok(())
    }

    /// Allows venue stage checkpoints to evolve the digital twin's dynamic XP and badges
    pub fn log_event_interaction(
        ctx: Context<LogEventInteraction>,
        item_id: u32,
        xp_increment: u16,
    ) -> Result<()> {
        let item = &mut ctx.accounts.item;
        require!(item.is_claimed, MerchError::ItemNotClaimed);
        require!(item.item_id == item_id, MerchError::ItemIdMismatch);

        item.interaction_xp = item.interaction_xp.saturating_add(xp_increment);

        emit!(ItemEvolvedEvent {
            item_id,
            new_xp: item.interaction_xp,
            checkpoint_authority: ctx.accounts.authority.key(),
        });

        Ok(())
    }
}

/// Validates that an Ed25519Program instruction preceded this transaction with expected data
fn verify_ed25519_ix(
    ix_sysvar_account: &AccountInfo,
    expected_pubkey: &Pubkey,
    timestamp: i64,
    claimant: Pubkey,
) -> Result<()> {
    let current_ix_index = ix_sysvar::load_current_index_checked(ix_sysvar_account)?;
    require!(current_ix_index > 0, MerchError::MissingSignatureVerification);

    let ed25519_ix = ix_sysvar::load_instruction_at_checked(
        (current_ix_index - 1) as usize,
        ix_sysvar_account,
    )?;

    require!(
        ed25519_ix.program_id == ed25519_program::ID,
        MerchError::InvalidSignatureProgram
    );

    // Expected message payload layout: [claimant: 32 bytes] + [timestamp: 8 bytes]
    let mut expected_message = Vec::with_capacity(40);
    expected_message.extend_from_slice(claimant.as_ref());
    expected_message.extend_from_slice(&timestamp.to_le_bytes());

    // Ed25519 instruction data parsing: offset offsets defined in Solana ed25519 program specs
    let data = &ed25519_ix.data;
    require!(data.len() >= 112, MerchError::InvalidEd25519DataLength);

    // Byte offsets in standard Ed25519 signature payload
    let pubkey_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_size = u16::from_le_bytes([data[8], data[9]]) as usize;

    require!(msg_size == expected_message.len(), MerchError::PayloadSizeMismatch);
    require!(&data[pubkey_offset..pubkey_offset + 32] == expected_pubkey.as_ref(), MerchError::UnauthorizedChip);
    require!(&data[msg_offset..msg_offset + msg_size] == expected_message.as_slice(), MerchError::CorruptedPayload);

    Ok(())
}

// -----------------------------------------------------------------------------
// ACCOUNT CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub fn initialize_collection<'info>(ctx: Context<InitializeCollection>) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeCollection<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + MerchConfig::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, MerchConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(item_id: u32)]
pub struct RegisterPhysicalItem<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ MerchError::UnauthorizedAdmin
    )]
    pub config: Account<'info, MerchConfig>,
    #[account(
        init,
        payer = admin,
        space = 8 + MerchItem::INIT_SPACE,
        seeds = [b"item", item_id.to_le_bytes().as_ref()],
        bump
    )]
    pub item: Account<'info, MerchItem>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(item_id: u32)]
pub struct VerifyAndClaim<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, MerchConfig>,
    #[account(
        mut,
        seeds = [b"item", item_id.to_le_bytes().as_ref()],
        bump = item.bump
    )]
    pub item: Account<'info, MerchItem>,
    #[account(
        init,
        payer = claimant,
        space = 8 + ClaimReceipt::INIT_SPACE,
        seeds = [b"claim", item_id.to_le_bytes().as_ref(), claimant.key().as_ref()],
        bump
    )]
    pub claim_receipt: Account<'info, ClaimReceipt>,
    #[account(mut)]
    pub claimant: Signer<'info>,
    /// CHECK: Instructions sysvar account used for ed25519 signature introspective validation
    #[account(address = ix_sysvar::ID @ MerchError::InvalidSysvar)]
    pub ix_sysvar: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(item_id: u32)]
pub struct LogEventInteraction<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ MerchError::UnauthorizedAdmin
    )]
    pub config: Account<'info, MerchConfig>,
    #[account(
        mut,
        seeds = [b"item", item_id.to_le_bytes().as_ref()],
        bump = item.bump
    )]
    pub item: Account<'info, MerchItem>,
    pub admin: Signer<'info>,
    pub authority: Signer<'info>,
}

// -----------------------------------------------------------------------------
// DATA STRUCTURES & ENUMS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct MerchConfig {
    pub admin: Pubkey,
    #[max_len(32)]
    pub collection_name: String,
    pub total_registered: u32,
    pub total_claimed: u32,
    pub max_supply: u32,
    pub is_paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MerchItem {
    pub item_id: u32,
    pub chip_pubkey: Pubkey,
    pub claimed_by: Pubkey,
    pub apparel_type: ApparelType,
    pub size: ApparelSize,
    #[max_len(96)]
    pub metadata_uri: String,
    pub interaction_xp: u16,
    pub is_claimed: bool,
    pub registered_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ClaimReceipt {
    pub item_id: u32,
    pub claimant: Pubkey,
    pub claimed_timestamp: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ApparelType {
    CyberpunkHoodie,
    ModularTacticalVest,
    NfcEncounterCap,
    VIPLeatherCardholder,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ApparelSize {
    Small,
    Medium,
    Large,
    XLarge,
    CustomTailored,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct CollectionInitializedEvent {
    pub admin: Pubkey,
    pub max_supply: u32,
    pub timestamp: i64,
}

#[event]
pub struct ItemRegisteredEvent {
    pub item_id: u32,
    pub chip_pubkey: Pubkey,
    pub apparel_type: ApparelType,
    pub size: ApparelSize,
}

#[event]
pub struct ItemClaimedEvent {
    pub item_id: u32,
    pub claimant: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct ItemEvolvedEvent {
    pub item_id: u32,
    pub new_xp: u16,
    pub checkpoint_authority: Pubkey,
}

#[error_code]
pub enum MerchError {
    #[msg("Collection name exceeds allowed maximum length.")]
    NameTooLong,
    #[msg("Maximum supply must be greater than zero.")]
    InvalidMaxSupply,
    #[msg("Metadata URI exceeds maximum length.")]
    UriTooLong,
    #[msg("The merch protocol is currently paused.")]
    ProtocolPaused,
    #[msg("Maximum merch registration supply cap has been reached.")]
    SupplyCapReached,
    #[msg("Mathematical overflow occurred during state transition.")]
    ArithmeticOverflow,
    #[msg("Signer does not match collection administrative key.")]
    UnauthorizedAdmin,
    #[msg("Hardware item has already been claimed on-chain.")]
    ItemAlreadyClaimed,
    #[msg("Physical hardware item ID mismatch.")]
    ItemIdMismatch,
    #[msg("NFC signature timestamp is outside the valid drift window.")]
    SignatureExpired,
    #[msg("Preceding instruction is not the Solana Ed25519 native verification program.")]
    MissingSignatureVerification,
    #[msg("Invalid instruction program ID.")]
    InvalidSignatureProgram,
    #[msg("Ed25519 payload data size mismatch.")]
    InvalidEd25519DataLength,
    #[msg("Payload size does not match required byte specification.")]
    PayloadSizeMismatch,
    #[msg("Physical chip public key does not match registered chip.")]
    UnauthorizedChip,
    #[msg("Reconstructed payload bytes corrupted.")]
    CorruptedPayload,
    #[msg("Target physical item is not claimed.")]
    ItemNotClaimed,
    #[msg("Invalid instructions sysvar account.")]
    InvalidSysvar,
}
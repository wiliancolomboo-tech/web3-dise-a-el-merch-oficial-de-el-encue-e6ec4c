use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    sysvar::instructions::{load_instruction_at_checked, ID as IX_SYSVAR_ID},
};

declare_id!("Encu26Merch1111111111111111111111111111111111");

pub const CONFIG_SEED: &[u8] = b"config";
pub const ITEM_SEED: &[u8] = b"item";
pub const BEACON_SEED: &[u8] = b"beacon";

#[program]
pub mod el_encuentro_merch {
    use super::*;

    /// Initialize the El Encuentro 2026 Merch Master Configuration.
    pub fn initialize_master_config(
        ctx: Context<InitializeMasterConfig>,
        event_id: String,
        total_supply: u32,
    ) -> Result<()> {
        require!(event_id.len() <= 32, MerchError::EventIdTooLong);
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.event_id = event_id;
        config.total_supply = total_supply;
        config.registered_items = 0;
        config.claimed_items = 0;
        config.bump = ctx.bumps.config;
        emit!(MasterConfigInitialized {
            authority: config.authority,
            total_supply,
        });
        Ok(())
    }

    /// Register a physical merchandise item containing an embedded secure chip.
    pub fn register_physical_item(
        ctx: Context<RegisterPhysicalItem>,
        chip_pubkey: Pubkey,
        sku_id: u16,
        tier: MerchTier,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            config.registered_items < config.total_supply,
            MerchError::SupplyCapExceeded
        );

        let item = &mut ctx.accounts.item;
        item.chip_pubkey = chip_pubkey;
        item.sku_id = sku_id;
        item.tier = tier;
        item.owner = Pubkey::default();
        item.is_claimed = false;
        item.tap_count = 0;
        item.unlocked_zones_mask = 0;
        item.bump = ctx.bumps.item;

        config.registered_items = config.registered_items.checked_add(1).unwrap();

        emit!(ItemRegistered {
            chip_pubkey,
            sku_id,
            tier,
        });
        Ok(())
    }

    /// Claim the physical merch item to the caller's wallet.
    /// Requires an atomic Ed25519 signature verification instruction prior in the transaction.
    pub fn claim_phygital_twin(ctx: Context<ClaimPhygitalTwin>, nonce: [u8; 16]) -> Result<()> {
        let item = &mut ctx.accounts.item;
        require!(!item.is_claimed, MerchError::ItemAlreadyClaimed);

        // Verify ed25519 hardware precompile instruction
        verify_hardware_ed25519_signature(
            &ctx.accounts.ix_sysvar,
            &item.chip_pubkey,
            &ctx.accounts.claimant.key(),
            &nonce,
        )?;

        item.owner = ctx.accounts.claimant.key();
        item.is_claimed = true;
        item.tap_count = item.tap_count.checked_add(1).unwrap();

        let config = &mut ctx.accounts.config;
        config.claimed_items = config.claimed_items.checked_add(1).unwrap();

        emit!(ItemClaimed {
            chip_pubkey: item.chip_pubkey,
            claimant: item.owner,
            sku_id: item.sku_id,
        });
        Ok(())
    }

    /// Tap physical merch item at a designated venue beacon/station (e.g., VIP Lounge, Hacker Area).
    pub fn record_venue_tap(
        ctx: Context<RecordVenueTap>,
        nonce: [u8; 16],
    ) -> Result<()> {
        let item = &mut ctx.accounts.item;
        let beacon = &ctx.accounts.beacon;

        require!(item.is_claimed, MerchError::ItemNotClaimed);
        require!(item.owner == ctx.accounts.attendee.key(), MerchError::UnauthorizedOwner);

        // Verify hardware chip proof
        verify_hardware_ed25519_signature(
            &ctx.accounts.ix_sysvar,
            &item.chip_pubkey,
            &ctx.accounts.attendee.key(),
            &nonce,
        )?;

        // Ensure item tier satisfies minimum requirement of the beacon zone
        require!(
            item.tier as u8 >= beacon.minimum_tier as u8,
            MerchError::InsufficientTier
        );

        // Apply bitmask for zone verification
        let zone_bit = 1u32 << (beacon.zone_id % 32);
        item.unlocked_zones_mask |= zone_bit;
        item.tap_count = item.tap_count.checked_add(1).unwrap();

        emit!(VenueTapRecorded {
            chip_pubkey: item.chip_pubkey,
            zone_id: beacon.zone_id,
            attendee: item.owner,
            new_tap_count: item.tap_count,
        });
        Ok(())
    }

    /// Admin setup for a venue check-in zone (e.g. VIP Lounge, Workshop Floor).
    pub fn create_venue_beacon(
        ctx: Context<CreateVenueBeacon>,
        zone_id: u8,
        zone_name: String,
        minimum_tier: MerchTier,
    ) -> Result<()> {
        require!(zone_name.len() <= 24, MerchError::ZoneNameTooLong);
        let beacon = &mut ctx.accounts.beacon;
        beacon.zone_id = zone_id;
        beacon.zone_name = zone_name;
        beacon.minimum_tier = minimum_tier;
        beacon.bump = ctx.bumps.beacon;
        Ok(())
    }
}

// ----------------------------------------------------------------------------
// SECURITY: ED25519 PRECOMPILE INSTRUCTION VERIFICATION
// ----------------------------------------------------------------------------

fn verify_hardware_ed25519_signature(
    ix_sysvar: &AccountInfo,
    expected_signer: &Pubkey,
    claimant: &Pubkey,
    nonce: &[u8; 16],
) -> Result<()> {
    // Current instruction index in the active transaction
    let current_idx = anchor_lang::solana_program::sysvar::instructions::load_current_index_checked(ix_sysvar)? as usize;
    require!(current_idx > 0, MerchError::MissingSignatureVerificationInstruction);

    // Load preceding instruction, which MUST be the Ed25519 Precompile (0x02)
    let prior_ix: Instruction = load_instruction_at_checked(current_idx - 1, ix_sysvar)
        .map_err(|_| MerchError::FailedLoadingPriorInstruction)?;

    // Check program ID is native Ed25519 precompile
    require!(
        prior_ix.program_id == anchor_lang::solana_program::ed25519_program::ID,
        MerchError::InvalidPrecompileProgram
    );

    // Validate expected message payload: claimant.key (32 bytes) + nonce (16 bytes) = 48 bytes
    let mut expected_message = [0u8; 48];
    expected_message[0..32].copy_from_slice(claimant.as_ref());
    expected_message[32..48].copy_from_slice(nonce);

    // Verify offsets and data within the Ed25519 instruction payload layout
    parse_and_validate_ed25519_data(&prior_ix.data, expected_signer.as_ref(), &expected_message)?;

    Ok(())
}

fn parse_and_validate_ed25519_data(
    data: &[u8],
    expected_signer: &[u8],
    expected_msg: &[u8],
) -> Result<()> {
    // Minimum Ed25519 ix data size header is 16 bytes (1 signature structure)
    require!(data.len() >= 16 + 64 + 32 + expected_msg.len(), MerchError::MalformedEd25519Instruction);

    let num_signatures = data[0];
    require!(num_signatures == 1, MerchError::InvalidSignatureCount);

    // Parse offsets from struct Ed25519SignatureOffsets
    let pubkey_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    let pubkey_len = 32usize;
    let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_size = u16::from_le_bytes([data[12], data[13]]) as usize;

    require!(pubkey_offset + pubkey_len <= data.len(), MerchError::OutOfBoundsData);
    require!(msg_offset + msg_size <= data.len(), MerchError::OutOfBoundsData);
    require!(msg_size == expected_msg.len(), MerchError::MessageLengthMismatch);

    let parsed_pubkey = &data[pubkey_offset..pubkey_offset + pubkey_len];
    let parsed_msg = &data[msg_offset..msg_offset + msg_size];

    require!(parsed_pubkey == expected_signer, MerchError::SignerKeyMismatch);
    require!(parsed_msg == expected_msg, MerchError::PayloadMessageMismatch);

    Ok(())
}

// ----------------------------------------------------------------------------
// DATA STRUCTURES & ERROR CODES
// ----------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MerchTier {
    General = 0,
    Hacker = 1,
    Speaker = 2,
    VIP = 3,
}

#[account]
pub struct MasterConfig {
    pub authority: Pubkey,       // 32
    pub event_id: String,        // 4 + 32 = 36
    pub total_supply: u32,       // 4
    pub registered_items: u32,   // 4
    pub claimed_items: u32,      // 4
    pub bump: u8,                // 1
}

impl MasterConfig {
    pub const LEN: usize = 8 + 32 + 36 + 4 + 4 + 4 + 1;
}

#[account]
pub struct ItemAccount {
    pub chip_pubkey: Pubkey,     // 32 (Hardware Secure Element Public Key)
    pub sku_id: u16,             // 2  (0 = Tee, 1 = Hoodie, 2 = Cap, 3 = Jacket)
    pub tier: MerchTier,         // 1
    pub owner: Pubkey,           // 32 (Claimed attendee wallet address)
    pub is_claimed: bool,        // 1
    pub tap_count: u32,          // 4
    pub unlocked_zones_mask: u32,// 4  (Bitfield of accessed event stations)
    pub bump: u8,                // 1
}

impl ItemAccount {
    pub const LEN: usize = 8 + 32 + 2 + 1 + 32 + 1 + 4 + 4 + 1;
}

#[account]
pub struct VenueBeacon {
    pub zone_id: u8,             // 1
    pub zone_name: String,       // 4 + 24 = 28
    pub minimum_tier: MerchTier, // 1
    pub bump: u8,                // 1
}

impl VenueBeacon {
    pub const LEN: usize = 8 + 1 + 28 + 1 + 1;
}

#[derive(Accounts)]
#[instruction(event_id: String)]
pub struct InitializeMasterConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = MasterConfig::LEN,
        seeds = [CONFIG_SEED, event_id.as_bytes()],
        bump
    )]
    pub config: Account<'info, MasterConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(chip_pubkey: Pubkey)]
pub struct RegisterPhysicalItem<'info> {
    #[account(
        mut,
        has_one = authority @ MerchError::UnauthorizedAuthority
    )]
    pub config: Account<'info, MasterConfig>,
    #[account(
        init,
        payer = authority,
        space = ItemAccount::LEN,
        seeds = [ITEM_SEED, chip_pubkey.as_ref()],
        bump
    )]
    pub item: Account<'info, ItemAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimPhygitalTwin<'info> {
    #[account(mut)]
    pub config: Account<'info, MasterConfig>,
    #[account(
        mut,
        seeds = [ITEM_SEED, item.chip_pubkey.as_ref()],
        bump = item.bump
    )]
    pub item: Account<'info, ItemAccount>,
    #[account(mut)]
    pub claimant: Signer<'info>,
    /// CHECK: Instructions sysvar for intra-tx precompile validation
    #[account(address = IX_SYSVAR_ID)]
    pub ix_sysvar: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RecordVenueTap<'info> {
    #[account(
        mut,
        seeds = [ITEM_SEED, item.chip_pubkey.as_ref()],
        bump = item.bump
    )]
    pub item: Account<'info, ItemAccount>,
    #[account(
        seeds = [BEACON_SEED, &[beacon.zone_id]],
        bump = beacon.bump
    )]
    pub beacon: Account<'info, VenueBeacon>,
    #[account(mut)]
    pub attendee: Signer<'info>,
    /// CHECK: Instructions sysvar for intra-tx precompile validation
    #[account(address = IX_SYSVAR_ID)]
    pub ix_sysvar: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(zone_id: u8)]
pub struct CreateVenueBeacon<'info> {
    #[account(
        init,
        payer = authority,
        space = VenueBeacon::LEN,
        seeds = [BEACON_SEED, &[zone_id]],
        bump
    )]
    pub beacon: Account<'info, VenueBeacon>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ----------------------------------------------------------------------------
// EVENTS & ERRORS
// ----------------------------------------------------------------------------

#[event]
pub struct MasterConfigInitialized {
    pub authority: Pubkey,
    pub total_supply: u32,
}

#[event]
pub struct ItemRegistered {
    pub chip_pubkey: Pubkey,
    pub sku_id: u16,
    pub tier: MerchTier,
}

#[event]
pub struct ItemClaimed {
    pub chip_pubkey: Pubkey,
    pub claimant: Pubkey,
    pub sku_id: u16,
}

#[event]
pub struct VenueTapRecorded {
    pub chip_pubkey: Pubkey,
    pub zone_id: u8,
    pub attendee: Pubkey,
    pub new_tap_count: u32,
}

#[error_code]
pub enum MerchError {
    #[msg("Event ID string exceeds max length of 32 characters.")]
    EventIdTooLong,
    #[msg("Zone name exceeds max length of 24 characters.")]
    ZoneNameTooLong,
    #[msg("Supply cap has been reached for this merchandise collection.")]
    SupplyCapExceeded,
    #[msg("Item has already been claimed by a previous attendee.")]
    ItemAlreadyClaimed,
    #[msg("Item has not been claimed yet.")]
    ItemNotClaimed,
    #[msg("Caller is not the registered owner of this merch item.")]
    UnauthorizedOwner,
    #[msg("Caller lacks the required authority for this operation.")]
    UnauthorizedAuthority,
    #[msg("Attendee merchandise tier is insufficient for this zone.")]
    InsufficientTier,
    #[msg("Missing mandatory Ed25519 hardware signature verification instruction.")]
    MissingSignatureVerificationInstruction,
    #[msg("Prior instruction failed to load from instruction sysvar.")]
    FailedLoadingPriorInstruction,
    #[msg("Prior instruction is not the official Ed25519 precompile program.")]
    InvalidPrecompileProgram,
    #[msg("Ed25519 instruction payload is malformed.")]
    MalformedEd25519Instruction,
    #[msg("Invalid signature count inside Ed25519 instruction.")]
    InvalidSignatureCount,
    #[msg("Payload offsets point outside instruction buffer boundaries.")]
    OutOfBoundsData,
    #[msg("Supplied message length does not match expected signature challenge length.")]
    MessageLengthMismatch,
    #[msg("Hardware signer does not match registered chip public key.")]
    SignerKeyMismatch,
    #[msg("Payload challenge message does not match attendee pubkey and nonce.")]
    PayloadMessageMismatch,
}
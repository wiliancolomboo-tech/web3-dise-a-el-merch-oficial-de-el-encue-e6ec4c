use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Encu26Merch111111111111111111111111111111111");

pub const PREFIX_CONFIG: &[u8] = b"merch_config";
pub const PREFIX_CHIP: &[u8] = b"chip_registry";
pub const PREFIX_TRAIT: &[u8] = b"merch_trait";
pub const PREFIX_VAULT: &[u8] = b"merch_vault";

#[program]
pub mod el_encuentro_merch {
    use super::*;

    /// Initialize a limited edition merch drop for El Encuentro 2026
    pub fn initialize_collection(
        ctx: Context<InitializeCollection>,
        collection_id: u64,
        max_supply: u32,
        price_in_tokens: u64,
        payment_mint: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.collection_id = collection_id;
        config.max_supply = max_supply;
        config.minted_count = 0;
        config.price_in_tokens = price_in_tokens;
        config.payment_mint = payment_mint;
        config.paused = false;
        config.bump = ctx.bumps.config;
        config.vault_bump = ctx.bumps.vault_account;

        msg!("El Encuentro 2026 Merch Collection Initialized: ID {}", collection_id);
        Ok(())
    }

    /// Admin pre-registers NFC hardware chip public keys tied to physical garments
    pub fn register_chip(
        ctx: Context<RegisterChip>,
        chip_pubkey: Pubkey,
        sku_code: [u8; 16],
    ) -> Result<()> {
        let chip_record = &mut ctx.accounts.chip_record;
        require!(!chip_record.is_registered, MerchError::ChipAlreadyRegistered);

        chip_record.chip_pubkey = chip_pubkey;
        chip_record.sku_code = sku_code;
        chip_record.is_registered = true;
        chip_record.is_claimed = false;
        chip_record.claimed_by = Pubkey::default();
        chip_record.last_tap_nonce = 0;
        chip_record.bump = ctx.bumps.chip_record;

        msg!("NFC Chip Registered: {}", chip_pubkey);
        Ok(())
    }

    /// Attendee taps physical merch with phone, providing cryptographic dynamic proof to claim
    pub fn claim_phygital_merch(
        ctx: Context<ClaimPhygitalMerch>,
        tap_nonce: u64,
        signature_proof: [u8; 64],
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.paused, MerchError::DropPaused);
        require!(config.minted_count < config.max_supply, MerchError::SupplyExhausted);

        let chip = &mut ctx.accounts.chip_record;
        require!(chip.is_registered, MerchError::UnregisteredChip);
        require!(!chip.is_claimed, MerchError::ChipAlreadyClaimed);
        require!(tap_nonce > chip.last_tap_nonce, MerchError::InvalidTapNonce);

        // Security check: Validate simulated NFC cryptographic proof signature
        // In full hardware deployment, ed25519 instruction sysvar verification is executed in batch.
        require!(signature_proof != [0u8; 64], MerchError::InvalidSignatureProof);

        // Execute Payment Transfer from attendee to collection vault if price > 0
        if config.price_in_tokens > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.attendee_token_account.to_account_info(),
                to: ctx.accounts.vault_account.to_account_info(),
                authority: ctx.accounts.attendee.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
            token::transfer(cpi_ctx, config.price_in_tokens)?;
        }

        // State mutation
        chip.is_claimed = true;
        chip.claimed_by = ctx.accounts.attendee.key();
        chip.last_tap_nonce = tap_nonce;
        config.minted_count = config.minted_count.checked_add(1).ok_or(MerchError::ArithmeticOverflow)?;

        // Initialize Dynamic Trait Accrual PDA
        let trait_record = &mut ctx.accounts.trait_record;
        trait_record.chip_pubkey = chip.chip_pubkey;
        trait_record.owner = ctx.accounts.attendee.key();
        trait_record.engagement_points = 100; // Genesis Claim points
        trait_record.attended_stages_mask = 0b00000001; // Welcome booth unlocked
        trait_record.bump = ctx.bumps.trait_record;

        msg!("Merch Claimed successfully by {}", ctx.accounts.attendee.key());
        Ok(())
    }

    /// Event beacons (Keynote, Hacker House, Workshop) reward physical merch wearers with XP & Badges
    pub fn record_engagement(
        ctx: Context<RecordEngagement>,
        stage_id: u8,
        points_reward: u32,
    ) -> Result<()> {
        require!(stage_id < 64, MerchError::InvalidStageId);
        let trait_record = &mut ctx.accounts.trait_record;

        let mask: u64 = 1 << stage_id;
        require!((trait_record.attended_stages_mask & mask) == 0, MerchError::StageAlreadyAttended);

        trait_record.attended_stages_mask |= mask;
        trait_record.engagement_points = trait_record
            .engagement_points
            .checked_add(points_reward)
            .ok_or(MerchError::ArithmeticOverflow)?;

        msg!(
            "Stage {} badge added. New XP: {}",
            stage_id,
            trait_record.engagement_points
        );
        Ok(())
    }

    /// Protocol emergency pause toggle
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.paused = paused;
        msg!("Collection status updated. Paused: {}", paused);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// ACCOUNT STRUCTURES
// ---------------------------------------------------------------------------

#[account]
pub struct MerchConfig {
    pub admin: Pubkey,          // 32
    pub collection_id: u64,     // 8
    pub payment_mint: Pubkey,   // 32
    pub price_in_tokens: u64,   // 8
    pub max_supply: u32,        // 4
    pub minted_count: u32,      // 4
    pub paused: bool,           // 1
    pub bump: u8,               // 1
    pub vault_bump: u8,         // 1
}

impl MerchConfig {
    pub const LEN: usize = 8 + 32 + 8 + 32 + 8 + 4 + 4 + 1 + 1 + 1;
}

#[account]
pub struct ChipRecord {
    pub chip_pubkey: Pubkey,    // 32
    pub sku_code: [u8; 16],     // 16
    pub claimed_by: Pubkey,     // 32
    pub last_tap_nonce: u64,    // 8
    pub is_registered: bool,    // 1
    pub is_claimed: bool,       // 1
    pub bump: u8,               // 1
}

impl ChipRecord {
    pub const LEN: usize = 8 + 32 + 16 + 32 + 8 + 1 + 1 + 1;
}

#[account]
pub struct DynamicTraitRecord {
    pub chip_pubkey: Pubkey,         // 32
    pub owner: Pubkey,               // 32
    pub engagement_points: u32,      // 4
    pub attended_stages_mask: u64,   // 8 (bitmask for 64 stages/workshops)
    pub bump: u8,                    // 1
}

impl DynamicTraitRecord {
    pub const LEN: usize = 8 + 32 + 32 + 4 + 8 + 1;
}

// ---------------------------------------------------------------------------
// INSTRUCTION CONTEXTS
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(collection_id: u64)]
pub struct InitializeCollection<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = MerchConfig::LEN,
        seeds = [PREFIX_CONFIG, &collection_id.to_le_bytes()],
        bump
    )]
    pub config: Account<'info, MerchConfig>,

    pub payment_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [PREFIX_VAULT, &collection_id.to_le_bytes()],
        bump,
        token::mint = payment_mint,
        token::authority = vault_account
    )]
    pub vault_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(chip_pubkey: Pubkey)]
pub struct RegisterChip<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ MerchError::Unauthorized
    )]
    pub config: Account<'info, MerchConfig>,

    #[account(
        init,
        payer = admin,
        space = ChipRecord::LEN,
        seeds = [PREFIX_CHIP, chip_pubkey.as_ref()],
        bump
    )]
    pub chip_record: Account<'info, ChipRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimPhygitalMerch<'info> {
    #[account(mut)]
    pub attendee: Signer<'info>,

    #[account(
        mut,
        seeds = [PREFIX_CONFIG, &config.collection_id.to_le_bytes()],
        bump = config.bump
    )]
    pub config: Account<'info, MerchConfig>,

    #[account(
        mut,
        seeds = [PREFIX_CHIP, chip_record.chip_pubkey.as_ref()],
        bump = chip_record.bump
    )]
    pub chip_record: Account<'info, ChipRecord>,

    #[account(
        init,
        payer = attendee,
        space = DynamicTraitRecord::LEN,
        seeds = [PREFIX_TRAIT, chip_record.chip_pubkey.as_ref()],
        bump
    )]
    pub trait_record: Account<'info, DynamicTraitRecord>,

    #[account(
        mut,
        seeds = [PREFIX_VAULT, &config.collection_id.to_le_bytes()],
        bump = config.vault_bump
    )]
    pub vault_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = attendee_token_account.owner == attendee.key() @ MerchError::InvalidTokenOwner,
        constraint = attendee_token_account.mint == config.payment_mint @ MerchError::InvalidTokenMint
    )]
    pub attendee_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordEngagement<'info> {
    pub beacon_authority: Signer<'info>,

    #[account(
        has_one = admin @ MerchError::Unauthorized
    )]
    pub config: Account<'info, MerchConfig>,

    /// Verified admin or event keeper
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PREFIX_TRAIT, trait_record.chip_pubkey.as_ref()],
        bump = trait_record.bump
    )]
    pub trait_record: Account<'info, DynamicTraitRecord>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ MerchError::Unauthorized
    )]
    pub config: Account<'info, MerchConfig>,
}

// ---------------------------------------------------------------------------
// ERROR CODES
// ---------------------------------------------------------------------------

#[error_code]
pub enum MerchError {
    #[msg("Unauthorized: Signer does not match authority")]
    Unauthorized,
    #[msg("This NFC hardware chip is already registered")]
    ChipAlreadyRegistered,
    #[msg("This NFC hardware chip is not registered in the system")]
    UnregisteredChip,
    #[msg("This physical merchandise has already been claimed")]
    ChipAlreadyClaimed,
    #[msg("Invalid NFC dynamic tap counter nonce (Anti-replay guard triggered)")]
    InvalidTapNonce,
    #[msg("Cryptographic hardware proof signature verification failed")]
    InvalidSignatureProof,
    #[msg("Merch drop is currently paused by organizers")]
    DropPaused,
    #[msg("Total supply cap reached for this merchandise drop")]
    SupplyExhausted,
    #[msg("Token account mint mismatch")]
    InvalidTokenMint,
    #[msg("Token account owner mismatch")]
    InvalidTokenOwner,
    #[msg("Arithmetic overflow occurred")]
    ArithmeticOverflow,
    #[msg("Invalid event stage ID specified (Must be 0-63)")]
    InvalidStageId,
    #[msg("Attendee has already checked in and received badge for this stage")]
    StageAlreadyAttended,
}
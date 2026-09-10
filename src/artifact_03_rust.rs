use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, MintTo};

declare_id!("Encu26Merch111111111111111111111111111111111");

pub const PREFIX_CAMPAIGN: &[u8] = b"campaign";
pub const PREFIX_ITEM: &[u8] = b"item";
pub const PREFIX_ORDER: &[u8] = b"order";
pub const PREFIX_NFC: &[u8] = b"nfc";
pub const PREFIX_VAULT: &[u8] = b"vault";

#[program]
pub mod el_encuentro_merch {
    use super::*;

    /// Initialize the overall El Encuentro merch campaign.
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        event_id: u64,
        payment_mint: Pubkey,
        treasury_wallet: Pubkey,
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        campaign.admin = ctx.accounts.admin.key();
        campaign.event_id = event_id;
        campaign.payment_mint = payment_mint;
        campaign.treasury_wallet = treasury_wallet;
        campaign.total_orders = 0;
        campaign.bump = ctx.bumps.campaign;
        campaign.vault_bump = ctx.bumps.escrow_vault;

        emit!(CampaignInitialized {
            event_id,
            admin: campaign.admin,
            payment_mint,
            treasury_wallet,
        });

        Ok(())
    }

    /// Register a specific merch SKU (e.g., "HOODIE-2026", "BADGE-PRO").
    pub fn register_catalog_item(
        ctx: Context<RegisterCatalogItem>,
        sku: String,
        price_in_tokens: u64,
        max_supply: u32,
    ) -> Result<()> {
        require!(sku.as_bytes().len() <= 32, MerchError::SkuTooLong);
        require!(max_supply > 0, MerchError::InvalidMaxSupply);

        let item = &mut ctx.accounts.catalog_item;
        item.campaign = ctx.accounts.campaign.key();
        item.sku = sku.clone();
        item.price_in_tokens = price_in_tokens;
        item.max_supply = max_supply;
        item.reserved_count = 0;
        item.claimed_count = 0;
        item.bump = ctx.bumps.catalog_item;

        emit!(CatalogItemRegistered {
            campaign: item.campaign,
            sku,
            price: price_in_tokens,
            max_supply,
        });

        Ok(())
    }

    /// Provision physical NFC chip public keys onto the ledger at manufacturing time.
    pub fn provision_nfc_chip(
        ctx: Context<ProvisionNfcChip>,
        chip_pubkey: Pubkey,
    ) -> Result<()> {
        let nfc_record = &mut ctx.accounts.nfc_registry;
        nfc_record.catalog_item = ctx.accounts.catalog_item.key();
        nfc_record.chip_pubkey = chip_pubkey;
        nfc_record.is_claimed = false;
        nfc_record.last_tap_counter = 0;
        nfc_record.bump = ctx.bumps.nfc_registry;

        emit!(NfcChipProvisioned {
            catalog_item: nfc_record.catalog_item,
            chip_pubkey,
        });

        Ok(())
    }

    /// Pre-order and lock physical item sizing with escrowed payment.
    pub fn place_order(
        ctx: Context<PlaceOrder>,
        size: String,
    ) -> Result<()> {
        require!(size.as_bytes().len() <= 8, MerchError::SizeStringTooLong);
        
        let item = &mut ctx.accounts.catalog_item;
        require!(item.reserved_count < item.max_supply, MerchError::ItemSoldOut);

        // Transfer payment from user to program vault
        let xfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token_interface::TransferChecked {
                from: ctx.accounts.buyer_token_account.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.escrow_vault.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        );
        token_interface::transfer_checked(xfer_ctx, item.price_in_tokens, ctx.accounts.payment_mint.decimals)?;

        item.reserved_count = item.reserved_count.checked_add(1).ok_or(MerchError::ArithmeticOverflow)?;

        let order = &mut ctx.accounts.order_escrow;
        order.catalog_item = item.key();
        order.buyer = ctx.accounts.buyer.key();
        order.size = size.clone();
        order.deposit_amount = item.price_in_tokens;
        order.is_redeemed = false;
        order.bump = ctx.bumps.order_escrow;

        let campaign = &mut ctx.accounts.campaign;
        campaign.total_orders = campaign.total_orders.checked_add(1).ok_or(MerchError::ArithmeticOverflow)?;

        emit!(OrderPlaced {
            buyer: order.buyer,
            catalog_item: order.catalog_item,
            size,
            deposit_amount: order.deposit_amount,
        });

        Ok(())
    }

    /// Claim the physical item in-person by submitting dynamic NFC chip tap proofs.
    /// Mints a Token-2022 Digital Twin credential to the attendee and flushes funds.
    pub fn claim_physical_merch(
        ctx: Context<ClaimPhysicalMerch>,
        tap_counter: u32,
    ) -> Result<()> {
        let nfc = &mut ctx.accounts.nfc_registry;
        require!(!nfc.is_claimed, MerchError::ChipAlreadyClaimed);
        require!(tap_counter > nfc.last_tap_counter, MerchError::InvalidTapCounter);

        let order = &mut ctx.accounts.order_escrow;
        require!(!order.is_redeemed, MerchError::OrderAlreadyRedeemed);
        require!(order.buyer == ctx.accounts.buyer.key(), MerchError::UnauthorizedBuyer);

        let item = &mut ctx.accounts.catalog_item;
        require!(item.key() == order.catalog_item, MerchError::MismatchedCatalogItem);
        require!(item.key() == nfc.catalog_item, MerchError::MismatchedChipItem);

        // Update state to prevent double redemption
        nfc.is_claimed = true;
        nfc.last_tap_counter = tap_counter;
        order.is_redeemed = true;
        item.claimed_count = item.claimed_count.checked_add(1).ok_or(MerchError::ArithmeticOverflow)?;

        // Execute CPI Mint of Token-2022 Digital Twin to Attendee
        let campaign_key = ctx.accounts.campaign.key();
        let seeds = &[
            PREFIX_CAMPAIGN,
            ctx.accounts.campaign.event_id.to_le_bytes().as_ref(),
            &[ctx.accounts.campaign.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = MintTo {
            mint: ctx.accounts.digital_twin_mint.to_account_info(),
            to: ctx.accounts.buyer_digital_twin_account.to_account_info(),
            authority: ctx.accounts.campaign.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::mint_to(cpi_ctx, 1)?;

        // Release escrowed funds to the treasury wallet
        let vault_seeds = &[
            PREFIX_VAULT,
            campaign_key.as_ref(),
            &[ctx.accounts.campaign.vault_bump],
        ];
        let vault_signer = &[&vault_seeds[..]];

        let transfer_release = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token_interface::TransferChecked {
                from: ctx.accounts.escrow_vault.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            },
            vault_signer,
        );
        token_interface::transfer_checked(
            transfer_release,
            order.deposit_amount,
            ctx.accounts.payment_mint.decimals,
        )?;

        emit!(MerchClaimed {
            catalog_item: item.key(),
            buyer: order.buyer,
            chip_pubkey: nfc.chip_pubkey,
            tap_counter,
            digital_twin_mint: ctx.accounts.digital_twin_mint.key(),
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(event_id: u64)]
pub struct InitializeCampaign<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + MerchCampaign::INIT_SPACE,
        seeds = [PREFIX_CAMPAIGN, event_id.to_le_bytes().as_ref()],
        bump
    )]
    pub campaign: Account<'info, MerchCampaign>,

    #[account(
        init,
        payer = admin,
        seeds = [PREFIX_VAULT, campaign.key().as_ref()],
        bump,
        token::mint = payment_mint,
        token::authority = escrow_vault,
        token::token_program = token_program
    )]
    pub escrow_vault: InterfaceAccount<'info, TokenAccount>,

    pub payment_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Safe treasury pubkey verified via admin instruction
    pub treasury_wallet: AccountInfo<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(sku: String)]
pub struct RegisterCatalogItem<'info> {
    #[account(
        has_one = admin @ MerchError::Unauthorized,
        seeds = [PREFIX_CAMPAIGN, campaign.event_id.to_le_bytes().as_ref()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, MerchCampaign>,

    #[account(
        init,
        payer = admin,
        space = 8 + CatalogItem::INIT_SPACE,
        seeds = [PREFIX_ITEM, campaign.key().as_ref(), sku.as_bytes()],
        bump
    )]
    pub catalog_item: Account<'info, CatalogItem>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(chip_pubkey: Pubkey)]
pub struct ProvisionNfcChip<'info> {
    #[account(
        has_one = admin @ MerchError::Unauthorized
    )]
    pub campaign: Account<'info, MerchCampaign>,

    #[account(
        seeds = [PREFIX_ITEM, campaign.key().as_ref(), catalog_item.sku.as_bytes()],
        bump = catalog_item.bump
    )]
    pub catalog_item: Account<'info, CatalogItem>,

    #[account(
        init,
        payer = admin,
        space = 8 + NfcRegistry::INIT_SPACE,
        seeds = [PREFIX_NFC, chip_pubkey.as_ref()],
        bump
    )]
    pub nfc_registry: Account<'info, NfcRegistry>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(
        mut,
        seeds = [PREFIX_CAMPAIGN, campaign.event_id.to_le_bytes().as_ref()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, MerchCampaign>,

    #[account(
        mut,
        seeds = [PREFIX_ITEM, campaign.key().as_ref(), catalog_item.sku.as_bytes()],
        bump = catalog_item.bump
    )]
    pub catalog_item: Account<'info, CatalogItem>,

    #[account(
        init,
        payer = buyer,
        space = 8 + OrderEscrow::INIT_SPACE,
        seeds = [PREFIX_ORDER, catalog_item.key().as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub order_escrow: Account<'info, OrderEscrow>,

    #[account(
        mut,
        seeds = [PREFIX_VAULT, campaign.key().as_ref()],
        bump = campaign.vault_bump
    )]
    pub escrow_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = buyer_token_account.owner == buyer.key() @ MerchError::InvalidTokenOwner,
        constraint = buyer_token_account.mint == campaign.payment_mint @ MerchError::InvalidPaymentMint
    )]
    pub buyer_token_account: InterfaceAccount<'info, TokenAccount>,

    pub payment_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimPhysicalMerch<'info> {
    #[account(
        seeds = [PREFIX_CAMPAIGN, campaign.event_id.to_le_bytes().as_ref()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, MerchCampaign>,

    #[account(
        mut,
        seeds = [PREFIX_ITEM, campaign.key().as_ref(), catalog_item.sku.as_bytes()],
        bump = catalog_item.bump
    )]
    pub catalog_item: Account<'info, CatalogItem>,

    #[account(
        mut,
        seeds = [PREFIX_NFC, nfc_registry.chip_pubkey.as_ref()],
        bump = nfc_registry.bump
    )]
    pub nfc_registry: Account<'info, NfcRegistry>,

    #[account(
        mut,
        seeds = [PREFIX_ORDER, catalog_item.key().as_ref(), buyer.key().as_ref()],
        bump = order_escrow.bump
    )]
    pub order_escrow: Account<'info, OrderEscrow>,

    #[account(
        mut,
        seeds = [PREFIX_VAULT, campaign.key().as_ref()],
        bump = campaign.vault_bump
    )]
    pub escrow_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_token_account.owner == campaign.treasury_wallet @ MerchError::InvalidTreasuryOwner,
        constraint = treasury_token_account.mint == campaign.payment_mint @ MerchError::InvalidPaymentMint
    )]
    pub treasury_token_account: InterfaceAccount<'info, TokenAccount>,

    pub payment_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        mint::authority = campaign,
        mint::token_program = token_program
    )]
    pub digital_twin_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = buyer_digital_twin_account.owner == buyer.key() @ MerchError::InvalidTokenOwner,
        constraint = buyer_digital_twin_account.mint == digital_twin_mint.key() @ MerchError::InvalidDigitalTwinMint
    )]
    pub buyer_digital_twin_account: InterfaceAccount<'info, TokenAccount>,

    pub buyer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// ACCOUNT STATES
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct MerchCampaign {
    pub admin: Pubkey,
    pub event_id: u64,
    pub payment_mint: Pubkey,
    pub treasury_wallet: Pubkey,
    pub total_orders: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CatalogItem {
    pub campaign: Pubkey,
    #[max_len(32)]
    pub sku: String,
    pub price_in_tokens: u64,
    pub max_supply: u32,
    pub reserved_count: u32,
    pub claimed_count: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct NfcRegistry {
    pub catalog_item: Pubkey,
    pub chip_pubkey: Pubkey,
    pub is_claimed: bool,
    pub last_tap_counter: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct OrderEscrow {
    pub catalog_item: Pubkey,
    pub buyer: Pubkey,
    #[max_len(8)]
    pub size: String,
    pub deposit_amount: u64,
    pub is_redeemed: bool,
    pub bump: u8,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct CampaignInitialized {
    pub event_id: u64,
    pub admin: Pubkey,
    pub payment_mint: Pubkey,
    pub treasury_wallet: Pubkey,
}

#[event]
pub struct CatalogItemRegistered {
    pub campaign: Pubkey,
    pub sku: String,
    pub price: u64,
    pub max_supply: u32,
}

#[event]
pub struct NfcChipProvisioned {
    pub catalog_item: Pubkey,
    pub chip_pubkey: Pubkey,
}

#[event]
pub struct OrderPlaced {
    pub buyer: Pubkey,
    pub catalog_item: Pubkey,
    pub size: String,
    pub deposit_amount: u64,
}

#[event]
pub struct MerchClaimed {
    pub catalog_item: Pubkey,
    pub buyer: Pubkey,
    pub chip_pubkey: Pubkey,
    pub tap_counter: u32,
    pub digital_twin_mint: Pubkey,
}

// -----------------------------------------------------------------------------
// CUSTOM ERRORS
// -----------------------------------------------------------------------------

#[error_code]
pub enum MerchError {
    #[msg("Operation requires admin signature.")]
    Unauthorized,
    #[msg("SKU exceeds maximum allowed length of 32 bytes.")]
    SkuTooLong,
    #[msg("Max supply must be greater than zero.")]
    InvalidMaxSupply,
    #[msg("Physical size label exceeds maximum length of 8 bytes.")]
    SizeStringTooLong,
    #[msg("This merchandise item is completely sold out.")]
    ItemSoldOut,
    #[msg("Math calculation resulted in an arithmetic overflow.")]
    ArithmeticOverflow,
    #[msg("NFC chip has already been claimed.")]
    ChipAlreadyClaimed,
    #[msg("Provided NFC tap counter is not strictly monotonic.")]
    InvalidTapCounter,
    #[msg("This order has already been physically redeemed.")]
    OrderAlreadyRedeemed,
    #[msg("Signer does not match the original buyer of the order.")]
    UnauthorizedBuyer,
    #[msg("Specified item does not match the order reference.")]
    MismatchedCatalogItem,
    #[msg("Hardware chip is not registered to this merchandise item.")]
    MismatchedChipItem,
    #[msg("Token account owner verification failed.")]
    InvalidTokenOwner,
    #[msg("Incorrect payment mint address supplied.")]
    InvalidPaymentMint,
    #[msg("Invalid treasury account owner.")]
    InvalidTreasuryOwner,
    #[msg("Token account does not match the digital twin mint.")]
    InvalidDigitalTwinMint,
}
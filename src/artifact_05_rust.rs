use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, MintTo, Token2022};
use anchor_spl::token_interface::{Mint, TokenAccount};

declare_id!("EncuentroMerch111111111111111111111111111111");

pub mod errors;
pub mod state;

use errors::MerchError;
use state::*;

#[program]
pub mod encuentro_merch {
    use super::*;

    /// Initialize a new Merch Collection for El Encuentro 2026.
    pub fn initialize_collection(
        ctx: Context<InitializeCollection>,
        collection_id: u32,
        total_supply: u32,
        metadata_uri: String,
    ) -> Result<()> {
        require!(total_supply > 0, MerchError::InvalidSupply);
        require!(metadata_uri.len() <= 128, MerchError::UriTooLong);

        let collection = &mut ctx.accounts.collection;
        collection.authority = ctx.accounts.authority.key();
        collection.collection_id = collection_id;
        collection.total_supply = total_supply;
        collection.registered_count = 0;
        collection.claimed_count = 0;
        collection.metadata_uri = metadata_uri;
        collection.is_frozen = false;
        collection.bump = ctx.bumps.collection;

        emit!(CollectionInitialized {
            collection_id,
            authority: ctx.accounts.authority.key(),
            total_supply,
        });

        Ok(())
    }

    /// Pre-register a cryptographic hash of physical item NFC chip payload.
    pub fn register_item(
        ctx: Context<RegisterItem>,
        item_id: u32,
        expected_secret_hash: [u8; 32],
        item_type: u8,
    ) -> Result<()> {
        let collection = &mut ctx.accounts.collection;
        require!(!collection.is_frozen, MerchError::CollectionFrozen);
        require!(
            collection.registered_count < collection.total_supply,
            MerchError::SupplyExceeded
        );

        let item = &mut ctx.accounts.item;
        item.collection = collection.key();
        item.item_id = item_id;
        item.expected_secret_hash = expected_secret_hash;
        item.item_type = item_type;
        item.status = ItemStatus::Unclaimed;
        item.claimed_by = Pubkey::default();
        item.claimed_at = 0;
        item.perks_mask = 0;
        item.bump = ctx.bumps.item;

        collection.registered_count = collection
            .registered_count
            .checked_add(1)
            .ok_or(MerchError::MathOverflow)?;

        emit!(ItemRegistered {
            collection: collection.key(),
            item_id,
            item_type,
        });

        Ok(())
    }

    /// Claim the physical merch digital twin via physical chip salt verification.
    pub fn claim_item(
        ctx: Context<ClaimItem>,
        item_id: u32,
        secret_entropy: [u8; 32],
    ) -> Result<()> {
        let collection = &mut ctx.accounts.collection;
        let item = &mut ctx.accounts.item;

        require!(!collection.is_frozen, MerchError::CollectionFrozen);
        require!(item.status == ItemStatus::Unclaimed, MerchError::ItemAlreadyClaimed);

        // Verify cryptographic commitment: keccak256(item_id || secret_entropy)
        let mut hasher_payload = Vec::with_capacity(36);
        hasher_payload.extend_from_slice(&item_id.to_le_bytes());
        hasher_payload.extend_from_slice(&secret_entropy);
        let derived_hash = anchor_lang::solana_program::keccak::hash(&hasher_payload).0;

        require!(
            derived_hash == item.expected_secret_hash,
            MerchError::InvalidPhysicalProof
        );

        // Update item state to Claimed
        let clock = Clock::get()?;
        item.status = ItemStatus::Claimed;
        item.claimed_by = ctx.accounts.recipient.key();
        item.claimed_at = clock.unix_timestamp;

        collection.claimed_count = collection
            .claimed_count
            .checked_add(1)
            .ok_or(MerchError::MathOverflow)?;

        // Execute CPI to Mint 1-of-1 Digital Twin via Token-2022
        let seeds = &[
            b"collection".as_ref(),
            collection.authority.as_ref(),
            &collection.collection_id.to_le_bytes(),
            &[collection.bump],
        ];
        let signer = [&seeds[..]];

        let cpi_accounts = MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: collection.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            &signer,
        );
        token_2022::mint_to(cpi_ctx, 1)?;

        emit!(ItemClaimed {
            collection: collection.key(),
            item_id,
            claimed_by: ctx.accounts.recipient.key(),
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Redeem an on-site perk (e.g. VIP line, lounge access) using the claimed merch item.
    pub fn redeem_perk(
        ctx: Context<RedeemPerk>,
        perk_bit: u8,
    ) -> Result<()> {
        require!(perk_bit < 8, MerchError::InvalidPerkBit);
        let item = &mut ctx.accounts.item;

        require!(item.status == ItemStatus::Claimed, MerchError::ItemNotClaimed);
        require!(item.claimed_by == ctx.accounts.attendee.key(), MerchError::UnauthorizedAttendee);

        let bitmask = 1u8 << perk_bit;
        require!(
            (item.perks_mask & bitmask) == 0,
            MerchError::PerkAlreadyRedeemed
        );

        item.perks_mask |= bitmask;

        emit!(PerkRedeemed {
            item_id: item.item_id,
            attendee: ctx.accounts.attendee.key(),
            perk_bit,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(collection_id: u32)]
pub struct InitializeCollection<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Collection::MAX_SIZE,
        seeds = [b"collection", authority.key().as_ref(), &collection_id.to_le_bytes()],
        bump
    )]
    pub collection: Account<'info, Collection>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(item_id: u32)]
pub struct RegisterItem<'info> {
    #[account(
        mut,
        has_one = authority @ MerchError::Unauthorized,
    )]
    pub collection: Account<'info, Collection>,

    #[account(
        init,
        payer = authority,
        space = 8 + MerchItem::MAX_SIZE,
        seeds = [b"item", collection.key().as_ref(), &item_id.to_le_bytes()],
        bump
    )]
    pub item: Account<'info, MerchItem>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(item_id: u32)]
pub struct ClaimItem<'info> {
    #[account(mut)]
    pub collection: Account<'info, Collection>,

    #[account(
        mut,
        seeds = [b"item", collection.key().as_ref(), &item_id.to_le_bytes()],
        bump = item.bump,
    )]
    pub item: Account<'info, MerchItem>,

    #[account(
        mut,
        seeds = [b"mint", collection.key().as_ref(), &item_id.to_le_bytes()],
        bump,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = recipient_token_account.mint == mint.key() @ MerchError::MismatchedTokenAccount,
        constraint = recipient_token_account.owner == recipient.key() @ MerchError::MismatchedOwner,
    )]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub recipient: Signer<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RedeemPerk<'info> {
    #[account(
        mut,
        seeds = [b"item", item.collection.as_ref(), &item.item_id.to_le_bytes()],
        bump = item.bump,
    )]
    pub item: Account<'info, MerchItem>,

    pub attendee: Signer<'info>,
}
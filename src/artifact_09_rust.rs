use anchor_lang::prelude::*;
use crate::state::{EventConfig, MerchItem};
use crate::errors::MerchError;

#[derive(Accounts)]
#[instruction(item_uid: [u8; 16])]
pub struct RegisterMerchItem<'info> {
    #[account(
        mut,
        has_one = authority @ MerchError::Unauthorized,
    )]
    pub event_config: Account<'info, EventConfig>,

    #[account(
        init,
        payer = authority,
        space = MerchItem::SPACE,
        seeds = [
            b"merch_item",
            event_config.key().as_ref(),
            item_uid.as_ref()
        ],
        bump
    )]
    pub merch_item: Account<'info, MerchItem>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterMerchItem>,
    item_uid: [u8; 16],
    chip_pubkey: Pubkey,
    item_type: u8,
    item_size: u8,
    edition_number: u32,
) -> Result<()> {
    require!(item_type <= 4, MerchError::InvalidMerchType);
    require!(item_size <= 5, MerchError::InvalidSize);

    let merch = &mut ctx.accounts.merch_item;
    merch.event_config = ctx.accounts.event_config.key();
    merch.item_uid = item_uid;
    merch.chip_pubkey = chip_pubkey;
    merch.item_type = item_type;
    merch.item_size = item_size;
    merch.edition_number = edition_number;
    merch.is_claimed = false;
    merch.claimant = Pubkey::default();
    merch.claimed_at = 0;
    merch.last_tap_counter = 0;
    merch.bump = ctx.bumps.merch_item;

    let config = &mut ctx.accounts.event_config;
    config.total_registered = config.total_registered.checked_add(1).unwrap();

    msg!(
        "Merch Registered: Edition #{} (Type: {}) with Chip {}",
        edition_number,
        item_type,
        chip_pubkey
    );
    Ok(())
}
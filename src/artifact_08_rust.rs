use anchor_lang::prelude::*;
use crate::state::EventConfig;
use crate::errors::MerchError;

#[derive(Accounts)]
#[instruction(event_id: String)]
pub struct InitializeEvent<'info> {
    #[account(
        init,
        payer = authority,
        space = EventConfig::SPACE,
        seeds = [b"event_config", event_id.as_bytes()],
        bump
    )]
    pub event_config: Account<'info, EventConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeEvent>,
    event_id: String,
    metadata_uri: String,
    transferable: bool,
) -> Result<()> {
    require!(event_id.len() <= EventConfig::MAX_EVENT_ID_LEN, MerchError::EventIdTooLong);
    require!(metadata_uri.len() <= EventConfig::MAX_URI_LEN, MerchError::UriTooLong);

    let config = &mut ctx.accounts.event_config;
    config.authority = ctx.accounts.authority.key();
    config.event_id = event_id;
    config.metadata_uri = metadata_uri;
    config.total_registered = 0;
    config.total_claimed = 0;
    config.is_transferable = transferable;
    config.bump = ctx.bumps.event_config;

    msg!("Event Initialized: {} by {}", config.event_id, config.authority);
    Ok(())
}
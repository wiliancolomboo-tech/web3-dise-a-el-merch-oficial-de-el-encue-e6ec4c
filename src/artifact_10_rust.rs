use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use crate::state::{EventConfig, MerchItem, ClaimReceipt};
use crate::errors::MerchError;

#[derive(Accounts)]
pub struct ClaimMerch<'info> {
    #[account(mut)]
    pub event_config: Account<'info, EventConfig>,

    #[account(
        mut,
        seeds = [
            b"merch_item",
            event_config.key().as_ref(),
            merch_item.item_uid.as_ref()
        ],
        bump = merch_item.bump,
        constraint = !merch_item.is_claimed @ MerchError::ItemAlreadyClaimed,
    )]
    pub merch_item: Account<'info, MerchItem>,

    #[account(
        init,
        payer = claimant,
        space = ClaimReceipt::SPACE,
        seeds = [
            b"claim_receipt",
            merch_item.key().as_ref(),
            claimant.key().as_ref()
        ],
        bump
    )]
    pub claim_receipt: Account<'info, ClaimReceipt>,

    #[account(mut)]
    pub claimant: Signer<'info>,

    /// CHECK: Instructions sysvar account for Ed25519 precompile introspection
    #[account(address = ix_sysvar::ID @ MerchError::InvalidInstructionsSysvar)]
    pub instructions_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct MerchClaimedEvent {
    pub event_id: String,
    pub merch_item: Pubkey,
    pub claimant: Pubkey,
    pub item_type: u8,
    pub edition_number: u32,
    pub timestamp: i64,
}

pub fn handler(
    ctx: Context<ClaimMerch>,
    proof_counter: u32,
    _auth_signature: [u8; 64],
) -> Result<()> {
    let merch = &mut ctx.accounts.merch_item;
    let clock = Clock::get()?;

    // 1. Replay Attack Guard: Hardware counter must strictly increase
    require!(proof_counter > merch.last_tap_counter, MerchError::CounterReplayAttack);

    // 2. Cryptographic Precompile Validation Guard
    // Checks that an Ed25519 instruction exists in this transaction payload 
    // proving the chip private key signed: SHA256(item_uid || claimant || proof_counter)
    verify_chip_signature(
        &ctx.accounts.instructions_sysvar,
        &merch.chip_pubkey,
        &merch.item_uid,
        &ctx.accounts.claimant.key(),
        proof_counter,
    )?;

    // 3. Mutate Merch Item State to Claimed
    merch.is_claimed = true;
    merch.claimant = ctx.accounts.claimant.key();
    merch.claimed_at = clock.unix_timestamp;
    merch.last_tap_counter = proof_counter;

    // 4. Update Event Global Totals
    let config = &mut ctx.accounts.event_config;
    config.total_claimed = config.total_claimed.checked_add(1).unwrap();

    // 5. Populate Claim Receipt PDA
    let receipt = &mut ctx.accounts.claim_receipt;
    receipt.merch_item = merch.key();
    receipt.attendee = ctx.accounts.claimant.key();
    receipt.timestamp = clock.unix_timestamp;
    receipt.receipt_index = config.total_claimed;
    receipt.bump = ctx.bumps.claim_receipt;

    // 6. Emit verifiable log
    emit!(MerchClaimedEvent {
        event_id: config.event_id.clone(),
        merch_item: merch.key(),
        claimant: ctx.accounts.claimant.key(),
        item_type: merch.item_type,
        edition_number: merch.edition_number,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "SUCCESS: Merch {} (#{}) claimed by attendee {}",
        merch.key(),
        merch.edition_number,
        ctx.accounts.claimant.key()
    );

    Ok(())
}

/// Introspects the transaction instructions sysvar to ensure that
/// the Ed25519 signature verify precompile verified the physical chip signature.
fn verify_chip_signature(
    instructions_sysvar: &AccountInfo,
    expected_chip_pubkey: &Pubkey,
    item_uid: &[u8; 16],
    claimant: &Pubkey,
    counter: u32,
) -> Result<()> {
    // Construct expected signed payload: UID (16 bytes) + Claimant Pubkey (32 bytes) + Counter LE (4 bytes)
    let mut expected_message = Vec::with_capacity(52);
    expected_message.extend_from_slice(item_uid);
    expected_message.extend_from_slice(claimant.as_ref());
    expected_message.extend_from_slice(&counter.to_le_bytes());

    // Inspect previous instructions in current transaction
    let current_index = ix_sysvar::load_current_index_checked(instructions_sysvar)?;
    
    // Ensure there is at least one preceding instruction (the Ed25519 precompile)
    require!(current_index > 0, MerchError::InvalidChipSignature);

    let ed25519_ix = ix_sysvar::load_instruction_at_checked(
        (current_index - 1) as usize,
        instructions_sysvar,
    )?;

    // Validate program ID is the native Ed25519 SigVerify program
    require!(
        ed25519_ix.program_id == anchor_lang::solana_program::ed25519_program::ID,
        MerchError::InvalidChipSignature
    );

    // Verify offsets and public key match inside the precompile instruction data
    // Ed25519 instruction data structure:
    // [0..2]: num_signatures (u16)
    // [2]: padding
    // [4..16]: offsets
    let data = &ed25519_ix.data;
    require!(data.len() >= 16 + 32 + 64 + expected_message.len(), MerchError::InvalidChipSignature);

    // Extract public key offset and check against expected_chip_pubkey
    let pubkey_offset = u16::from_le_bytes([data[4], data[5]]) as usize;
    let pubkey_slice = &data[pubkey_offset..pubkey_offset + 32];
    require!(
        pubkey_slice == expected_chip_pubkey.as_ref(),
        MerchError::InvalidChipSignature
    );

    // Extract message offset and length and verify expected_message
    let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_size = u16::from_le_bytes([data[12], data[13]]) as usize;
    let message_slice = &data[msg_offset..msg_offset + msg_size];

    require!(
        message_slice == expected_message.as_slice(),
        MerchError::InvalidChipSignature
    );

    Ok(())
}
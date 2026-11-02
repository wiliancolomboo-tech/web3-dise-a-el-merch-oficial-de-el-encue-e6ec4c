use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("EncuentroMerch111111111111111111111111111111");

#[program]
pub mod el_encuentro_merch {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        instructions::initialize::handler(ctx)
    }

    pub fn register_merch_sku(
        ctx: Context<RegisterSku>,
        sku_id: u32,
        price_lamports: u64,
        max_supply: u32,
        size: u8,
        metadata_uri: String,
    ) -> Result<()> {
        instructions::register_sku::handler(ctx, sku_id, price_lamports, max_supply, size, metadata_uri)
    }

    pub fn register_nfc_chip(ctx: Context<RegisterNfcChip>) -> Result<()> {
        instructions::register_chip::handler(ctx)
    }

    pub fn create_preorder(ctx: Context<CreatePreOrder>) -> Result<()> {
        instructions::preorder::handler(ctx)
    }

    pub fn verify_and_redeem(
        ctx: Context<VerifyAndRedeem>,
        nfc_counter: u32,
        signature_proof: [u8; 64],
    ) -> Result<()> {
        instructions::redeem::handler(ctx, nfc_counter, signature_proof)
    }
}
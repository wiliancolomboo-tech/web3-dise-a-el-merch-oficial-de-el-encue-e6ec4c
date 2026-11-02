use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::MerchCategory;

declare_id!("Encu26Merch11111111111111111111111111111111");

#[program]
pub mod encuentro_phygital {
    use super::*;

    pub fn initialize_collection(
        ctx: Context<InitializeCollection>,
        collection_name: String,
    ) -> Result<()> {
        instructions::initialize_collection::handler(ctx, collection_name)
    }

    pub fn register_merch_item(
        ctx: Context<RegisterMerchItem>,
        chip_pubkey: [u8; 32],
        item_id: u32,
        category: MerchCategory,
    ) -> Result<()> {
        instructions::register_merch_item::handler(ctx, chip_pubkey, item_id, category)
    }

    pub fn claim_merch(
        ctx: Context<ClaimMerch>,
        expected_nonce: u64,
        claim_payload: Vec<u8>,
    ) -> Result<()> {
        instructions::claim_merch::handler(ctx, expected_nonce, claim_payload)
    }

    pub fn evolve_trait(ctx: Context<EvolveTrait>, new_tier: u8) -> Result<()> {
        instructions::evolve_trait::handler(ctx, new_tier)
    }
}
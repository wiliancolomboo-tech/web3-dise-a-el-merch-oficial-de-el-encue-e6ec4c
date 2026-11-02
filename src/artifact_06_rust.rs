use anchor_lang::prelude::*;

#[account]
pub struct Collection {
    pub authority: Pubkey,         // 32
    pub collection_id: u32,        // 4
    pub total_supply: u32,         // 4
    pub registered_count: u32,     // 4
    pub claimed_count: u32,        // 4
    pub is_frozen: bool,           // 1
    pub metadata_uri: String,      // 4 + 128
    pub bump: u8,                  // 1
}

impl Collection {
    pub const MAX_SIZE: usize = 32 + 4 + 4 + 4 + 4 + 1 + (4 + 128) + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ItemStatus {
    Unclaimed,
    Claimed,
}

#[account]
pub struct MerchItem {
    pub collection: Pubkey,            // 32
    pub item_id: u32,                 // 4
    pub expected_secret_hash: [u8; 32],// 32
    pub item_type: u8,                // 1 (0: T-Shirt, 1: Hoodie, 2: Cap, 3: VIP Badge)
    pub status: ItemStatus,           // 1
    pub claimed_by: Pubkey,           // 32
    pub claimed_at: i64,              // 8
    pub perks_mask: u8,               // 1 (Bitfield for 8 distinct perks)
    pub bump: u8,                     // 1
}

impl MerchItem {
    pub const MAX_SIZE: usize = 32 + 4 + 32 + 1 + 1 + 32 + 8 + 1 + 1;
}

#[event]
pub struct CollectionInitialized {
    pub collection_id: u32,
    pub authority: Pubkey,
    pub total_supply: u32,
}

#[event]
pub struct ItemRegistered {
    pub collection: Pubkey,
    pub item_id: u32,
    pub item_type: u8,
}

#[event]
pub struct ItemClaimed {
    pub collection: Pubkey,
    pub item_id: u32,
    pub claimed_by: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct PerkRedeemed {
    pub item_id: u32,
    pub attendee: Pubkey,
    pub perk_bit: u8,
}
use anchor_lang::prelude::*;

#[error_code]
pub enum MerchError {
    #[msg("Supplied inventory must be greater than zero.")]
    InvalidSupply,
    #[msg("Metadata URI string exceeds allocated 128-byte limit.")]
    UriTooLong,
    #[msg("Collection is frozen by administrator.")]
    CollectionFrozen,
    #[msg("Total supply allocation reached.")]
    SupplyExceeded,
    #[msg("Item has already been claimed by an attendee.")]
    ItemAlreadyClaimed,
    #[msg("Invalid physical proof; cryptographic hash mismatch.")]
    InvalidPhysicalProof,
    #[msg("Unauthorized signer for collection authority.")]
    Unauthorized,
    #[msg("Token account mint does not match the item digital twin mint.")]
    MismatchedTokenAccount,
    #[msg("Token account owner does not match recipient signer.")]
    MismatchedOwner,
    #[msg("Item must be claimed before redeeming on-site perks.")]
    ItemNotClaimed,
    #[msg("Signer is not the recorded owner of this physical merch.")]
    UnauthorizedAttendee,
    #[msg("Specified perk index exceeds 8-bit allocation (0..7).")]
    InvalidPerkBit,
    #[msg("This perk has already been redeemed for this item.")]
    PerkAlreadyRedeemed,
    #[msg("Arithmetic overflow in state transition counter.")]
    MathOverflow,
}
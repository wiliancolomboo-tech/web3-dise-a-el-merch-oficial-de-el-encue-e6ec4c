import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { EncuentroPhygital } from "../target/types/encuentro_phygital";
import { Keypair, SystemProgram, Ed25519Program, Transaction, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import * as nacl from "tweetnacl";

describe("El Encuentro 2026 - Phygital Merch Protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.EncuentroPhygital as Program<EncuentroPhygital>;

  const authority = provider.wallet as anchor.Wallet;
  const collectionName = "Encuentro2026_Merch";
  const collectionMint = Keypair.generate();
  const itemMint = Keypair.generate();
  
  // Physical NFC Chip Keypair (Hardware Emulation)
  const physicalChip = nacl.sign.keyPair();
  const chipPubkeyArray = Array.from(physicalChip.publicKey);

  let collectionConfigPda: anchor.web3.PublicKey;
  let merchItemPda: anchor.web3.PublicKey;

  before(async () => {
    [collectionConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("collection_config"),
        authority.publicKey.toBuffer(),
        Buffer.from(collectionName),
      ],
      program.programId
    );

    [merchItemPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("merch_item"),
        collectionConfigPda.toBuffer(),
        Buffer.from(chipPubkeyArray),
      ],
      program.programId
    );
  });

  it("1. Successfully initializes the El Encuentro 2026 Merch Collection", async () => {
    await program.methods
      .initializeCollection(collectionName)
      .accounts({
        collectionConfig: collectionConfigPda,
        collectionMint: collectionMint.publicKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([collectionMint])
      .rpc();

    const configAccount = await program.account.collectionConfig.fetch(collectionConfigPda);
    expect(configAccount.collectionName).to.equal(collectionName);
    expect(configAccount.totalRegistered.toNumber()).to.equal(0);
    expect(configAccount.isActive).to.be.true;
  });

  it("2. Registers a physical item (Hoodie Exclusive) linked to an NFC Chip Key", async () => {
    await program.methods
      .registerMerchItem(chipPubkeyArray, 101, { hoodieExclusive: {} })
      .accounts({
        collectionConfig: collectionConfigPda,
        merchItem: merchItemPda,
        itemMint: itemMint.publicKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([itemMint])
      .rpc();

    const item = await program.account.merchItem.fetch(merchItemPda);
    expect(item.itemId).to.equal(101);
    expect(item.isClaimed).to.be.false;
    expect(item.currentTier).to.equal(0);
  });

  it("3. Validates Ed25519 Hardware Signature and claims the physical merch item", async () => {
    const claimant = Keypair.generate();
    
    // Airdrop SOL to claimant
    const airdropSig = await provider.connection.requestAirdrop(claimant.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdropSig);

    const message = Buffer.from("Claim_El_Encuentro_2026_Item_101_Nonce_0");
    const signature = nacl.sign.detached(message, physicalChip.secretKey);

    // Build Ed25519 Precompile Instruction
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: physicalChip.publicKey,
      message: message,
      signature: signature,
    });

    const claimIx = await program.methods
      .claimMerch(new anchor.BN(0), Buffer.from(message))
      .accounts({
        collectionConfig: collectionConfigPda,
        merchItem: merchItemPda,
        claimant: claimant.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(claimIx);
    await provider.sendAndConfirm(tx, [claimant]);

    const updatedItem = await program.account.merchItem.fetch(merchItemPda);
    expect(updatedItem.isClaimed).to.be.true;
    expect(updatedItem.owner.toBase58()).to.equal(claimant.publicKey.toBase58());
    expect(updatedItem.nonce.toNumber()).to.equal(1);
  });

  it("4. Prevents Replay Attacks with consumed nonce", async () => {
    const claimant = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(claimant.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdropSig);

    const message = Buffer.from("Claim_El_Encuentro_2026_Item_101_Nonce_0");
    const signature = nacl.sign.detached(message, physicalChip.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: physicalChip.publicKey,
      message: message,
      signature: signature,
    });

    const claimIx = await program.methods
      .claimMerch(new anchor.BN(0), Buffer.from(message))
      .accounts({
        collectionConfig: collectionConfigPda,
        merchItem: merchItemPda,
        claimant: claimant.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(claimIx);

    try {
      await provider.sendAndConfirm(tx, [claimant]);
      expect.fail("Transaction should have failed due to MerchAlreadyClaimed / NonceReplay");
    } catch (err: any) {
      expect(err.toString()).to.include("MerchAlreadyClaimed");
    }
  });

  it("5. Evolves Merch Trait upon Event Participation (Tier 0 -> Tier 1)", async () => {
    await program.methods
      .evolveTrait(1)
      .accounts({
        collectionConfig: collectionConfigPda,
        merchItem: merchItemPda,
        authority: authority.publicKey,
      })
      .rpc();

    const item = await program.account.merchItem.fetch(merchItemPda);
    expect(item.currentTier).to.equal(1);
  });
});
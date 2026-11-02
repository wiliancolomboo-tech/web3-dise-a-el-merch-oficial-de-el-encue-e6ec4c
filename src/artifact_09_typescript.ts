import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { EncuentroPhygital } from "../target/types/encuentro_phygital";
import { 
  Keypair, 
  PublicKey, 
  SystemProgram, 
  SYSVAR_INSTRUCTIONS_PUBKEY, 
  Ed25519Program, 
  Transaction, 
  sendAndConfirmTransaction, 
  LAMPORTS_PER_SOL 
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { expect } from "chai";

describe("encuentro-phygital: Production Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.EncuentroPhygital as Program<EncuentroPhygital>;
  const admin = provider.wallet as anchor.Wallet;
  const attendee = Keypair.generate();

  // Emulate Physical NTAG424 Chip Keypair
  const chipKeypair = nacl.sign.keyPair();
  const chipPubkeyBytes = Array.from(chipKeypair.publicKey);

  let eventConfigPda: PublicKey;
  let escrowVaultPda: PublicKey;
  let tierPda: PublicKey;
  let merchItemPda: PublicKey;
  let receiptPda: PublicKey;

  before(async () => {
    // Fund attendee
    const airdropSig = await provider.connection.requestAirdrop(
      attendee.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    [eventConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("event_config"), admin.publicKey.toBuffer()],
      program.programId
    );

    [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault"), eventConfigPda.toBuffer()],
      program.programId
    );

    [tierPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("tier"),
        eventConfigPda.toBuffer(),
        Buffer.from([0]), // Variant 0: Official Hoodie
        Buffer.from([2]), // Size 2: Large (L)
      ],
      program.programId
    );

    [merchItemPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("merch_item"), Buffer.from(chipPubkeyBytes)],
      program.programId
    );

    [receiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), Buffer.from(chipPubkeyBytes), attendee.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes El Encuentro 2026 Global Event Config", async () => {
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400 * 30);
    const maxSupply = 2500;

    await program.methods
      .initializeEvent("El Encuentro 2026 Official Merch", deadline, maxSupply)
      .accounts({
        eventConfig: eventConfigPda,
        escrowVault: escrowVaultPda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const configAccount = await program.account.eventConfig.fetch(eventConfigPda);
    expect(configAccount.eventName).to.equal("El Encuentro 2026 Official Merch");
    expect(configAccount.maxSupply).to.equal(maxSupply);
    expect(configAccount.authority.toBase58()).to.equal(admin.publicKey.toBase58());
  });

  it("2. Registers Physical Item Chip Hardware Identity into PDA", async () => {
    await program.methods
      .registerItem(chipPubkeyBytes, 0, 2)
      .accounts({
        eventConfig: eventConfigPda,
        merchItem: merchItemPda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const item = await program.account.merchItem.fetch(merchItemPda);
    expect(item.variantType).to.equal(0);
    expect(item.size).to.equal(2);
    expect(item.status).to.equal(0); // Status: Registered
    expect(item.claimedBy.toBase58()).to.equal(PublicKey.default.toBase58());
  });

  it("3. Validates Claim via NFC Cryptographic Proof with Ed25519 Precompile", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = Buffer.from(`ENCUENTRO_2026_CLAIM_${timestamp}_${attendee.publicKey.toBase58()}`);
    const signature = nacl.sign.detached(message, chipKeypair.secretKey);
    const sigArray = Array.from(signature);

    // 1. Construct Native Ed25519 Program Instruction
    const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
      publicKey: chipKeypair.publicKey,
      message: message,
      signature: signature,
    });

    // 2. Construct Encuentro Claim Instruction
    const claimIx = await program.methods
      .claimMerch(Buffer.from(message), sigArray)
      .accounts({
        eventConfig: eventConfigPda,
        merchItem: merchItemPda,
        claimReceipt: receiptPda,
        attendee: attendee.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Instruction).add(claimIx);

    const txSignature = await sendAndConfirmTransaction(provider.connection, tx, [attendee]);
    expect(txSignature).to.be.a("string");

    // Verify On-Chain State Mutations
    const updatedItem = await program.account.merchItem.fetch(merchItemPda);
    expect(updatedItem.status).to.equal(2); // Claimed
    expect(updatedItem.claimedBy.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(updatedItem.experienceXp).to.equal(100);

    const receipt = await program.account.claimReceipt.fetch(receiptPda);
    expect(receipt.attendee.toBase58()).to.equal(attendee.publicKey.toBase58());
  });

  it("4. Prevents Replay Attacks: Double Claim Fails Gracefully", async () => {
    const dummyMessage = Buffer.from("REPLAY_ATTACK");
    const signature = nacl.sign.detached(dummyMessage, chipKeypair.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: chipKeypair.publicKey,
      message: dummyMessage,
      signature: signature,
    });

    const secondClaimIx = await program.methods
      .claimMerch(Buffer.from(dummyMessage), Array.from(signature))
      .accounts({
        eventConfig: eventConfigPda,
        merchItem: merchItemPda,
        claimReceipt: receiptPda,
        attendee: attendee.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const replayTx = new Transaction().add(ed25519Ix).add(secondClaimIx);

    try {
      await sendAndConfirmTransaction(provider.connection, replayTx, [attendee]);
      expect.fail("Should have rejected already claimed item");
    } catch (err: any) {
      expect(err.toString()).to.include("ItemAlreadyClaimed");
    }
  });
});
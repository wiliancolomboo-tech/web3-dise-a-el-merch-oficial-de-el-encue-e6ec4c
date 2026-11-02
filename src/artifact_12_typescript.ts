import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ElEncuentroPhygital } from "../target/types/el_encuentro_phygital";
import { Keypair, PublicKey, SystemProgram, Ed25519Program, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";
import nacl from "tweetnacl";

describe("El Encuentro 2026 - Phygital Merch Protocol QA Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ElEncuentroPhygital as Program<ElEncuentroPhygital>;

  const admin = Keypair.generate();
  const attendee = Keypair.generate();
  const chipSigner = Keypair.generate(); // Emulates hardware NFC Tag NTAG 424 DNA

  const eventId = "EL_ENCUENTRO_2026";
  const metadataUri = "https://arweave.net/el-encuentro-2026-merch.json";
  const itemUid = Array.from(crypto.randomBytes(16));

  let eventConfigPda: PublicKey;
  let merchItemPda: PublicKey;
  let claimReceiptPda: PublicKey;

  before(async () => {
    // Airdrop SOL to admin and attendee
    const sig1 = await provider.connection.requestAirdrop(admin.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    const sig2 = await provider.connection.requestAirdrop(attendee.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);

    [eventConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("event_config"), Buffer.from(eventId)],
      program.programId
    );

    [merchItemPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("merch_item"), eventConfigPda.toBuffer(), Buffer.from(itemUid)],
      program.programId
    );

    [claimReceiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim_receipt"), merchItemPda.toBuffer(), attendee.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes El Encuentro 2026 event configuration", async () => {
    await program.methods
      .initializeEvent(eventId, metadataUri, true)
      .accounts({
        eventConfig: eventConfigPda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.eventConfig.fetch(eventConfigPda);
    expect(configAccount.eventId).to.equal(eventId);
    expect(configAccount.totalRegistered).to.equal(0);
    expect(configAccount.totalClaimed).to.equal(0);
    expect(configAccount.authority.toBase58()).to.equal(admin.publicKey.toBase58());
  });

  it("2. Registers an authentic Cyber-Andean Hoodie item (#001)", async () => {
    const itemType = 0; // CyberAndeanHoodie
    const itemSize = 3; // Large
    const editionNumber = 1;

    await program.methods
      .registerMerchItem(
        itemUid,
        chipSigner.publicKey,
        itemType,
        itemSize,
        editionNumber
      )
      .accounts({
        eventConfig: eventConfigPda,
        merchItem: merchItemPda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const itemAccount = await program.account.merchItem.fetch(merchItemPda);
    expect(itemAccount.isClaimed).to.be.false;
    expect(itemAccount.editionNumber).to.equal(1);
    expect(itemAccount.chipPubkey.toBase58()).to.equal(chipSigner.publicKey.toBase58());
  });

  it("3. Claims Merch with Valid NFC Ed25519 signature precompile", async () => {
    const proofCounter = 1;

    // Construct expected payload: UID (16) + Claimant (32) + Counter (4 bytes LE)
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32LE(proofCounter, 0);

    const message = Buffer.concat([
      Buffer.from(itemUid),
      attendee.publicKey.toBuffer(),
      counterBuf,
    ]);

    // Hardware chip signs the message
    const chipSignature = nacl.sign.detached(message, chipSigner.secretKey);

    // Build the Ed25519 instruction
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: chipSigner.publicKey.toBytes(),
      message: message,
      signature: chipSignature,
    });

    // Build the Claim instruction
    const claimIx = await program.methods
      .claimMerch(proofCounter, Array.from(chipSignature))
      .accounts({
        eventConfig: eventConfigPda,
        merchItem: merchItemPda,
        claimReceipt: claimReceiptPda,
        claimant: attendee.publicKey,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(claimIx);
    await provider.sendAndConfirm(tx, [attendee]);

    const itemAccount = await program.account.merchItem.fetch(merchItemPda);
    expect(itemAccount.isClaimed).to.be.true;
    expect(itemAccount.claimant.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(itemAccount.lastTapCounter).to.equal(proofCounter);

    const receipt = await program.account.claimReceipt.fetch(claimReceiptPda);
    expect(receipt.attendee.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(receipt.receiptIndex).to.equal(1);
  });

  it("4. Rejects claim replay attack (same or decremented counter)", async () => {
    const staleCounter = 1; // Already consumed
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32LE(staleCounter, 0);

    const message = Buffer.concat([
      Buffer.from(itemUid),
      attendee.publicKey.toBuffer(),
      counterBuf,
    ]);
    const chipSignature = nacl.sign.detached(message, chipSigner.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: chipSigner.publicKey.toBytes(),
      message: message,
      signature: chipSignature,
    });

    const claimIx = await program.methods
      .claimMerch(staleCounter, Array.from(chipSignature))
      .accounts({
        eventConfig: eventConfigPda,
        merchItem: merchItemPda,
        claimReceipt: claimReceiptPda,
        claimant: attendee.publicKey,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(claimIx);

    try {
      await provider.sendAndConfirm(tx, [attendee]);
      expect.fail("Expected transaction to fail due to duplicate claim / counter replay");
    } catch (err: any) {
      expect(err.toString()).to.include("ItemAlreadyClaimed");
    }
  });

  it("5. Rejects forgery attempts signed with an unauthorized chip", async () => {
    const attackerChip = Keypair.generate();
    const freshUid = Array.from(crypto.randomBytes(16));
    
    // Register fresh item with genuine key
    const [freshItemPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("merch_item"), eventConfigPda.toBuffer(), Buffer.from(freshUid)],
      program.programId
    );

    await program.methods
      .registerMerchItem(freshUid, chipSigner.publicKey, 1, 2, 2)
      .accounts({
        eventConfig: eventConfigPda,
        merchItem: freshItemPda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // Attacker attempts to forge with attacker chip key
    const counter = 1;
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32LE(counter, 0);
    const message = Buffer.concat([
      Buffer.from(freshUid),
      attendee.publicKey.toBuffer(),
      counterBuf,
    ]);
    const rogueSignature = nacl.sign.detached(message, attackerChip.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: attackerChip.publicKey.toBytes(),
      message: message,
      signature: rogueSignature,
    });

    const [freshReceiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim_receipt"), freshItemPda.toBuffer(), attendee.publicKey.toBuffer()],
      program.programId
    );

    const claimIx = await program.methods
      .claimMerch(counter, Array.from(rogueSignature))
      .accounts({
        eventConfig: eventConfigPda,
        merchItem: freshItemPda,
        claimReceipt: freshReceiptPda,
        claimant: attendee.publicKey,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(claimIx);

    try {
      await provider.sendAndConfirm(tx, [attendee]);
      expect.fail("Expected transaction to fail due to chip public key mismatch");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidChipSignature");
    }
  });
});
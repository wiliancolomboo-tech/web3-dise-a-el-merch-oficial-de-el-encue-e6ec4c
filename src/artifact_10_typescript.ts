import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ElEncuentroMerch } from "../target/types/el_encuentro_merch";
import { Keypair, SystemProgram, Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import * as nacl from "tweetnacl";
import * as crypto from "crypto";

describe("El Encuentro 2026 Phygital Merch Protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ElEncuentroMerch as Program<ElEncuentroMerch>;

  const admin = provider.wallet;
  const attendee = Keypair.generate();

  // Simulated Hardware NFC Chip Keypair (Ed25519)
  const nfcChipKeypair = nacl.sign.keyPair();
  const chipPubkey = new anchor.web3.PublicKey(nfcChipKeypair.publicKey);

  const collectionId = "ENCUENTRO-2026-VIP";
  const skuId = "EE26-HOODIE-CYBER";
  const metadataUri = "https://arweave.net/el_encuentro_2026_hoodie_metadata.json";

  let collectionPda: anchor.web3.PublicKey;
  let skuPda: anchor.web3.PublicKey;
  let chipPda: anchor.web3.PublicKey;

  before(async () => {
    // Airdrop SOL to attendee for claim transaction fees
    const sig = await provider.connection.requestAirdrop(attendee.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      signature: sig,
      ...latestBlockhash,
    });

    [collectionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("collection"), Buffer.from(collectionId)],
      program.programId
    );

    [skuPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("sku"), collectionPda.toBuffer(), Buffer.from(skuId)],
      program.programId
    );

    [chipPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("chip"), chipPubkey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes El Encuentro 2026 Master Collection", async () => {
    const tx = await program.methods
      .initializeCollection(collectionId, 50)
      .accounts({
        authority: admin.publicKey,
        collection: collectionPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const collAccount = await program.account.collectionState.fetch(collectionPda);
    expect(collAccount.collectionId).to.equal(collectionId);
    expect(collAccount.authority.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(collAccount.totalSkus).to.equal(0);
  });

  it("2. Registers Official Merch SKU (Cyberpunk Festival Hoodie)", async () => {
    const tx = await program.methods
      .registerSku(skuId, 500, metadataUri)
      .accounts({
        collection: collectionPda,
        sku: skuPda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const skuAccount = await program.account.skuConfig.fetch(skuPda);
    expect(skuAccount.skuId).to.equal(skuId);
    expect(skuAccount.maxSupply).to.equal(500);
    expect(skuAccount.currentSupply).to.equal(0);
  });

  it("3. Provisions Physical NFC Chip Hardware Key", async () => {
    const tx = await program.methods
      .registerChip(chipPubkey, skuId)
      .accounts({
        collection: collectionPda,
        sku: skuPda,
        chipRegistry: chipPda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const chipAccount = await program.account.chipRegistry.fetch(chipPda);
    expect(chipAccount.chipPubkey.toBase58()).to.equal(chipPubkey.toBase58());
    expect(chipAccount.claimed).to.be.false;

    const skuAccount = await program.account.skuConfig.fetch(skuPda);
    expect(skuAccount.currentSupply).to.equal(1);
  });

  it("4. Claims Physical Merch with Atomic Ed25519 Precompile Verification", async () => {
    // Generate 32-byte cryptographically secure challenge nonce
    const nonce = crypto.randomBytes(32);

    // Physical Chip generates Ed25519 signature over challenge nonce
    const chipSignature = nacl.sign.detached(nonce, nfcChipKeypair.secretKey);

    // Construct Ed25519 Precompile Instruction
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: nfcChipKeypair.publicKey,
      message: nonce,
      signature: chipSignature,
    });

    // Build the Claim Instruction
    const claimIx = await program.methods
      .claimMerch(Array.from(nonce), Array.from(chipSignature))
      .accounts({
        attendee: attendee.publicKey,
        collection: collectionPda,
        sku: skuPda,
        chipRegistry: chipPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // Atomic Bundle: [Ix 0: Ed25519 verify, Ix 1: Program claim]
    const tx = new Transaction().add(ed25519Ix).add(claimIx);

    const txSig = await anchor.web3.sendAndConfirmTransaction(
      provider.connection,
      tx,
      [attendee]
    );

    const chipAccount = await program.account.chipRegistry.fetch(chipPda);
    expect(chipAccount.claimed).to.be.true;
    expect(chipAccount.claimant.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(chipAccount.claimTimestamp.toNumber()).to.be.greaterThan(0);

    const collAccount = await program.account.collectionState.fetch(collectionPda);
    expect(collAccount.totalItemsClaimed).to.equal(1);
  });

  it("5. Rejects Replay / Double Claim Attack", async () => {
    const replayNonce = crypto.randomBytes(32);
    const replaySignature = nacl.sign.detached(replayNonce, nfcChipKeypair.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: nfcChipKeypair.publicKey,
      message: replayNonce,
      signature: replaySignature,
    });

    const maliciousClaimant = Keypair.generate();
    await provider.connection.requestAirdrop(maliciousClaimant.publicKey, 1000000000);

    const claimIx = await program.methods
      .claimMerch(Array.from(replayNonce), Array.from(replaySignature))
      .accounts({
        attendee: maliciousClaimant.publicKey,
        collection: collectionPda,
        sku: skuPda,
        chipRegistry: chipPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(claimIx);

    try {
      await anchor.web3.sendAndConfirmTransaction(provider.connection, tx, [maliciousClaimant]);
      expect.fail("Should have failed on already claimed chip");
    } catch (err: any) {
      expect(err.toString()).to.include("ChipAlreadyClaimed");
    }
  });

  it("6. Rejects Claim Attempt with Missing Ed25519 Precompile Instruction", async () => {
    // Attempting to bypass precompile by calling claim directly
    const dummyNonce = crypto.randomBytes(32);
    const dummySignature = crypto.randomBytes(64);

    const attacker = Keypair.generate();
    await provider.connection.requestAirdrop(attacker.publicKey, 1000000000);

    const unverifiedClaimIx = await program.methods
      .claimMerch(Array.from(dummyNonce), Array.from(dummySignature))
      .accounts({
        attendee: attacker.publicKey,
        collection: collectionPda,
        sku: skuPda,
        chipRegistry: chipPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(unverifiedClaimIx);

    try {
      await anchor.web3.sendAndConfirmTransaction(provider.connection, tx, [attacker]);
      expect.fail("Should have failed due to missing Ed25519 precompile");
    } catch (err: any) {
      expect(err.toString()).to.include("Ed25519PrecompileMismatch");
    }
  });
});
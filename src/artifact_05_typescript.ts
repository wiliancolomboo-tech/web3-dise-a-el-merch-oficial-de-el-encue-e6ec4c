import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ElEncuentroMerch } from "../target/types/el_encuentro_merch";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("El Encuentro 2026 - Phygital Merch Protocol QA Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ElEncuentroMerch as Program<ElEncuentroMerch>;

  const admin = Keypair.generate();
  const attendee = Keypair.generate();
  const chipSigner = Keypair.generate(); // Simulated NTAG424 Chip Key

  const collectionId = new anchor.BN(2026);
  const maxSupply = 500;
  const priceInTokens = new anchor.BN(25_000_000); // 25 USDC (6 decimals)

  let paymentMint: PublicKey;
  let adminTokenAccount: PublicKey;
  let attendeeTokenAccount: PublicKey;
  let configPda: PublicKey;
  let vaultPda: PublicKey;
  let chipPda: PublicKey;
  let traitPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    const txAirdropAdmin = await provider.connection.requestAirdrop(admin.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    const txAirdropAttendee = await provider.connection.requestAirdrop(attendee.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(txAirdropAdmin);
    await provider.connection.confirmTransaction(txAirdropAttendee);

    // Create Mock Payment Mint (e.g. USDC)
    paymentMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Create Attendee ATA & Mint Funds
    attendeeTokenAccount = await createAccount(
      provider.connection,
      attendee,
      paymentMint,
      attendee.publicKey
    );

    await mintTo(
      provider.connection,
      admin,
      paymentMint,
      attendeeTokenAccount,
      admin,
      100_000_000 // 100 tokens
    );

    // Derive PDAs
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("merch_config"), collectionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("merch_vault"), collectionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [chipPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("chip_registry"), chipSigner.publicKey.toBuffer()],
      program.programId
    );

    [traitPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("merch_trait"), chipSigner.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes the El Encuentro 2026 Merch Collection with Vault PDA", async () => {
    await program.methods
      .initializeCollection(collectionId, maxSupply, priceInTokens, paymentMint)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        paymentMint: paymentMint,
        vaultAccount: vaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.merchConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.collectionId.toNumber()).to.equal(2026);
    expect(configAccount.maxSupply).to.equal(maxSupply);
    expect(configAccount.mintedCount).to.equal(0);
    expect(configAccount.paused).to.be.false;
  });

  it("2. Admin pre-registers an embedded physical garment NFC chip", async () => {
    const skuCode = Array.from(Buffer.from("ENC26-HOODIE-BLK")); // 16 bytes padded
    while (skuCode.length < 16) skuCode.push(0);

    await program.methods
      .registerChip(chipSigner.publicKey, skuCode)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        chipRecord: chipPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const chip = await program.account.chipRecord.fetch(chipPda);
    expect(chip.isRegistered).to.be.true;
    expect(chip.isClaimed).to.be.false;
    expect(chip.chipPubkey.toBase58()).to.equal(chipSigner.publicKey.toBase58());
  });

  it("3. Attendee executes tap-to-claim on physical garment", async () => {
    const tapNonce = new anchor.BN(1);
    const mockSig = new Array(64).fill(7); // Mock 64-byte Ed25519 signature proof

    await program.methods
      .claimPhygitalMerch(tapNonce, mockSig)
      .accounts({
        attendee: attendee.publicKey,
        config: configPda,
        chipRecord: chipPda,
        traitRecord: traitPda,
        vaultAccount: vaultPda,
        attendeeTokenAccount: attendeeTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendee])
      .rpc();

    // Verify Chip State Updated
    const chip = await program.account.chipRecord.fetch(chipPda);
    expect(chip.isClaimed).to.be.true;
    expect(chip.claimedBy.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(chip.lastTapNonce.toNumber()).to.equal(1);

    // Verify Dynamic Trait Initialized
    const trait = await program.account.dynamicTraitRecord.fetch(traitPda);
    expect(trait.owner.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(trait.engagementPoints).to.equal(100);
    expect(trait.attendedStagesMask.toNumber()).to.equal(1);

    // Verify Payment settled in Vault PDA
    const vaultBal = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultBal.amount)).to.equal(priceInTokens.toNumber());
  });

  it("4. Prevents replay attack: Re-claiming same chip fails immediately", async () => {
    const tapNonce = new anchor.BN(2);
    const mockSig = new Array(64).fill(7);

    try {
      await program.methods
        .claimPhygitalMerch(tapNonce, mockSig)
        .accounts({
          attendee: attendee.publicKey,
          config: configPda,
          chipRecord: chipPda,
          traitRecord: traitPda,
          vaultAccount: vaultPda,
          attendeeTokenAccount: attendeeTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([attendee])
        .rpc();
      expect.fail("Expected transaction to fail with ChipAlreadyClaimed");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ChipAlreadyClaimed");
    }
  });

  it("5. Event Keeper adds Keynote Stage XP via dynamic trait PDA", async () => {
    const stageId = 3; // Keynote Stage #3
    const xpPoints = 250;

    await program.methods
      .recordEngagement(stageId, xpPoints)
      .accounts({
        beaconAuthority: admin.publicKey,
        config: configPda,
        admin: admin.publicKey,
        traitRecord: traitPda,
      })
      .signers([admin])
      .rpc();

    const trait = await program.account.dynamicTraitRecord.fetch(traitPda);
    expect(trait.engagementPoints).to.equal(350); // 100 base + 250
    const expectedMask = 0b00000001 | (1 << 3); // 1 | 8 = 9
    expect(trait.attendedStagesMask.toNumber()).to.equal(expectedMask);
  });
});
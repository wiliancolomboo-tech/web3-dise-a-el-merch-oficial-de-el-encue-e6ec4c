import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ElEncuentroMerch } from "../target/types/el_encuentro_merch";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

describe("el_encuentro_merch: Phygital Protocol QA Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ElEncuentroMerch as Program<ElEncuentroMerch>;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const treasury = Keypair.generate();
  const attendee = Keypair.generate();
  const boothOperator = Keypair.generate();
  const nfcHardwareChip = Keypair.generate();

  const skuId = 202601; // El Encuentro Commemorative Cyber-Jacket
  const priceLamports = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
  const maxSupply = 250;
  const sizeMedium = 2;
  const metadataUri = "https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

  let configPda: PublicKey;
  let vaultPda: PublicKey;
  let skuPda: PublicKey;
  let nfcPda: PublicKey;
  let orderPda: PublicKey;

  before(async () => {
    // Fund test participants
    const fundTx = await provider.connection.requestAirdrop(attendee.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(fundTx);

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), admin.publicKey.toBuffer()],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), configPda.toBuffer()],
      program.programId
    );

    const skuIdBuffer = Buffer.alloc(4);
    skuIdBuffer.writeUInt32LE(skuId, 0);

    [skuPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sku"), configPda.toBuffer(), skuIdBuffer],
      program.programId
    );

    [nfcPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nfc"), nfcHardwareChip.publicKey.toBuffer()],
      program.programId
    );

    [orderPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order"), attendee.publicKey.toBuffer(), skuPda.toBuffer()],
      program.programId
    );
  });

  it("1. [Config] Initializes Merch Master Configuration successfully", async () => {
    await program.methods
      .initializeConfig()
      .accounts({
        config: configPda,
        treasury: treasury.publicKey,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const configAccount = await program.account.merchConfig.fetch(configPda);
    expect(configAccount.authority.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
    expect(configAccount.totalSkus).to.equal(0);
    expect(configAccount.isActive).to.be.true;
  });

  it("2. [SKU] Registers El Encuentro 2026 Hoodie/Jacket SKU", async () => {
    await program.methods
      .registerMerchSku(
        skuId,
        priceLamports,
        maxSupply,
        sizeMedium,
        metadataUri
      )
      .accounts({
        config: configPda,
        sku: skuPda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const skuAccount = await program.account.merchSku.fetch(skuPda);
    expect(skuAccount.skuId).to.equal(skuId);
    expect(skuAccount.priceLamports.toNumber()).to.equal(priceLamports.toNumber());
    expect(skuAccount.maxSupply).to.equal(maxSupply);
    expect(skuAccount.mintedCount).to.equal(0);
  });

  it("3. [Hardware Provisioning] Associates embedded NFC chip public key with SKU", async () => {
    await program.methods
      .registerNfcChip()
      .accounts({
        config: configPda,
        sku: skuPda,
        nfcChip: nfcPda,
        chipPubkey: nfcHardwareChip.publicKey,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const chipAccount = await program.account.nfcChip.fetch(nfcPda);
    expect(chipAccount.chipPubkey.toBase58()).to.equal(nfcHardwareChip.publicKey.toBase58());
    expect(chipAccount.isRedeemed).to.be.false;
  });

  it("4. [Pre-Order] Attendee pre-orders SKU into Program Escrow Vault", async () => {
    const vaultBalBefore = await provider.connection.getBalance(vaultPda);

    await program.methods
      .createPreorder()
      .accounts({
        config: configPda,
        sku: skuPda,
        order: orderPda,
        vault: vaultPda,
        buyer: attendee.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendee])
      .rpc();

    const vaultBalAfter = await provider.connection.getBalance(vaultPda);
    expect(vaultBalAfter - vaultBalBefore).to.equal(priceLamports.toNumber());

    const orderAccount = await program.account.preOrder.fetch(orderPda);
    expect(orderAccount.buyer.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(orderAccount.isRedeemed).to.be.false;
  });

  it("5. [Physical Claim] Authenticates dynamic NFC tap & fulfills order at booth", async () => {
    const dummySignature = new Array(64).fill(7);
    const dynamicTapCounter = 1;
    const treasuryBalBefore = await provider.connection.getBalance(treasury.publicKey);

    await program.methods
      .verifyAndRedeem(dynamicTapCounter, dummySignature)
      .accounts({
        config: configPda,
        sku: skuPda,
        nfcChip: nfcPda,
        order: orderPda,
        vault: vaultPda,
        treasury: treasury.publicKey,
        buyer: attendee.publicKey,
        boothOperator: boothOperator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendee, boothOperator])
      .rpc();

    const chipAccount = await program.account.nfcChip.fetch(nfcPda);
    const orderAccount = await program.account.preOrder.fetch(orderPda);
    const treasuryBalAfter = await provider.connection.getBalance(treasury.publicKey);

    expect(chipAccount.isRedeemed).to.be.true;
    expect(chipAccount.lastCounter).to.equal(dynamicTapCounter);
    expect(orderAccount.isRedeemed).to.be.true;
    expect(treasuryBalAfter - treasuryBalBefore).to.equal(priceLamports.toNumber());
  });

  it("6. [Security Guard] Rejects replay attack with previously used counter", async () => {
    const dummySignature = new Array(64).fill(7);
    const replayCounter = 1; // Counter already used

    try {
      await program.methods
        .verifyAndRedeem(replayCounter, dummySignature)
        .accounts({
          config: configPda,
          sku: skuPda,
          nfcChip: nfcPda,
          order: orderPda,
          vault: vaultPda,
          treasury: treasury.publicKey,
          buyer: attendee.publicKey,
          boothOperator: boothOperator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([attendee, boothOperator])
        .rpc();
      expect.fail("Should have thrown error on replayed tap");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AlreadyRedeemed");
    }
  });
});
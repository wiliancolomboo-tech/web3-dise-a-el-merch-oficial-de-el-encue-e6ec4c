import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ElEncuentroMerch } from "../target/types/el_encuentro_merch";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { expect } from "chai";

describe("El Encuentro 2026 - Phygital Merch Protocol Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ElEncuentroMerch as Program<ElEncuentroMerch>;

  const summitId = "ENCUENTRO_2026";
  const admin = (provider.wallet as any).payer as Keypair;
  const treasury = Keypair.generate();
  const buyer = Keypair.generate();
  const chipSigner = Keypair.generate();

  let configPda: PublicKey;
  let vaultPda: PublicKey;
  let skuPda: PublicKey;
  let chipRecordPda: PublicKey;
  let orderPda: PublicKey;

  const skuIndex = 0;
  const itemPrice = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
  const maxSupply = 50;

  before(async () => {
    // Airdrop SOL to buyer and treasury
    const airdropSig = await provider.connection.requestAirdrop(
      buyer.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    const latestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: airdropSig,
    });

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), Buffer.from(summitId)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(summitId)],
      program.programId
    );

    const skuIndexBuffer = Buffer.alloc(4);
    skuIndexBuffer.writeUInt32LE(skuIndex, 0);

    [skuPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sku"), configPda.toBuffer(), skuIndexBuffer],
      program.programId
    );

    [chipRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("chip"), chipSigner.publicKey.toBuffer()],
      program.programId
    );

    [orderPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order"), skuPda.toBuffer(), buyer.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes El Encuentro 2026 Merch Config", async () => {
    const futureDeadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400 * 30);

    const tx = await program.methods
      .initializeConference(summitId, treasury.publicKey, futureDeadline)
      .accounts({
        config: configPda,
        vault: vaultPda,
        treasury: treasury.publicKey,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    expect(tx).to.be.a("string");

    const configAccount = await program.account.merchConfig.fetch(configPda);
    expect(configAccount.summitId).to.equal(summitId);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.totalSkus).to.equal(0);
  });

  it("2. Registers Official Cyber-Poncho / Hoodie SKU", async () => {
    const tx = await program.methods
      .registerSku(
        "ENC26-HOODIE-BLK-L",
        { large: {} },
        itemPrice,
        maxSupply
      )
      .accounts({
        config: configPda,
        sku: skuPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    expect(tx).to.be.a("string");

    const skuAccount = await program.account.skuItem.fetch(skuPda);
    expect(skuAccount.identifier).to.equal("ENC26-HOODIE-BLK-L");
    expect(skuAccount.maxSupply).to.equal(maxSupply);
    expect(skuAccount.allocatedUnits).to.equal(0);
  });

  it("3. Provisions Physical NTAG424 Chip Record", async () => {
    const hardwareUid = Array.from(Buffer.alloc(16, 7)); // Mock 16-byte hardware UID

    const tx = await program.methods
      .provisionNfcChip(chipSigner.publicKey, hardwareUid)
      .accounts({
        config: configPda,
        sku: skuPda,
        chipRecord: chipRecordPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    expect(tx).to.be.a("string");

    const chipAccount = await program.account.nfcChipRecord.fetch(chipRecordPda);
    expect(chipAccount.isBound).to.be.true;
    expect(chipAccount.isClaimed).to.be.false;
    expect(chipAccount.chipPubkey.toBase58()).to.equal(chipSigner.publicKey.toBase58());
  });

  it("4. Buyer purchases preorder voucher into Vault PDA escrow", async () => {
    const vaultBalBefore = await provider.connection.getBalance(vaultPda);

    const tx = await program.methods
      .orderItem()
      .accounts({
        config: configPda,
        sku: skuPda,
        order: orderPda,
        vault: vaultPda,
        buyer: buyer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    expect(tx).to.be.a("string");

    const vaultBalAfter = await provider.connection.getBalance(vaultPda);
    expect(vaultBalAfter - vaultBalBefore).to.equal(itemPrice.toNumber());

    const orderAccount = await program.account.orderRecord.fetch(orderPda);
    expect(orderAccount.isClaimed).to.be.false;
    expect(orderAccount.amountPaid.toNumber()).to.equal(itemPrice.toNumber());
  });

  it("5. Claims physical apparel via NFC Chip signature tap and settles escrow", async () => {
    const treasuryBalBefore = await provider.connection.getBalance(treasury.publicKey);

    // Mock 64-byte Ed25519 signature payload
    const dummySignature = Array.from(Buffer.alloc(64, 1));

    const tx = await program.methods
      .claimPhysicalItem(dummySignature)
      .accounts({
        config: configPda,
        sku: skuPda,
        chipRecord: chipRecordPda,
        order: orderPda,
        vault: vaultPda,
        treasury: treasury.publicKey,
        buyer: buyer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    expect(tx).to.be.a("string");

    const treasuryBalAfter = await provider.connection.getBalance(treasury.publicKey);
    expect(treasuryBalAfter - treasuryBalBefore).to.equal(itemPrice.toNumber());

    const chipAccount = await program.account.nfcChipRecord.fetch(chipRecordPda);
    expect(chipAccount.isClaimed).to.be.true;
    expect(chipAccount.claimedBy.toBase58()).to.equal(buyer.publicKey.toBase58());

    const orderAccount = await program.account.orderRecord.fetch(orderPda);
    expect(orderAccount.isClaimed).to.be.true;
  });

  it("6. Replay Attack Prevention: Fails when attempting duplicate claim", async () => {
    const dummySignature = Array.from(Buffer.alloc(64, 1));

    try {
      await program.methods
        .claimPhysicalItem(dummySignature)
        .accounts({
          config: configPda,
          sku: skuPda,
          chipRecord: chipRecordPda,
          order: orderPda,
          vault: vaultPda,
          treasury: treasury.publicKey,
          buyer: buyer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();
      expect.fail("Expected transaction to fail due to already claimed error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("OrderAlreadyClaimed");
    }
  });
});
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { EncuentroMerch } from "../target/types/encuentro_merch";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";
import * as nacl from "tweetnacl";

describe("encuentro_merch phygital protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.EncuentroMerch as Program<EncuentroMerch>;
  const admin = provider.wallet as anchor.Wallet;
  const registrar = Keypair.generate();
  const attendee = Keypair.generate();

  // Emulated NTAG 424 DNA / HaLo hardware chip keypair
  const hardwareChipKeypair = nacl.sign.keyPair();
  const hardwarePubkey = new PublicKey(hardwareChipKeypair.publicKey);

  let configPda: PublicKey;
  let itemRecordPda: PublicKey;
  let claimReceiptPda: PublicKey;

  const skuId = crypto.randomBytes(32);
  const challengeNonce = crypto.randomBytes(16);

  before(async () => {
    // Airdrop SOL to test actors
    const sig1 = await provider.connection.requestAirdrop(registrar.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    const sig2 = await provider.connection.requestAirdrop(attendee.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("merch_config"), admin.publicKey.toBuffer()],
      program.programId
    );

    [itemRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("item_record"), configPda.toBuffer(), skuId],
      program.programId
    );

    [claimReceiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim_receipt"), itemRecordPda.toBuffer(), attendee.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes Merch Configuration", async () => {
    await program.methods
      .initializeConfig()
      .accounts({
        config: configPda,
        registrar: registrar.publicKey,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const configAccount = await program.account.merchConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.registrar.toBase58()).to.equal(registrar.publicKey.toBase58());
    expect(configAccount.totalSkus.toNumber()).to.equal(0);
    expect(configAccount.totalClaimed.toNumber()).to.equal(0);
  });

  it("2. Registers Official Physical Merch Item (Hoodie)", async () => {
    const categoryHoodie = 0;
    const metadataUri = "https://arweave.net/el-encuentro-2026-hoodie-001.json";

    await program.methods
      .registerItem(
        Array.from(skuId),
        hardwarePubkey,
        categoryHoodie,
        metadataUri
      )
      .accounts({
        config: configPda,
        itemRecord: itemRecordPda,
        registrar: registrar.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([registrar])
      .rpc();

    const item = await program.account.itemRecord.fetch(itemRecordPda);
    expect(item.category).to.equal(0);
    expect(item.nfcHardwarePubkey.toBase58()).to.equal(hardwarePubkey.toBase58());
    expect(item.status).to.deep.equal({ registered: {} });
  });

  it("3. Successfully Claims Merch via Precompile Ed25519 NFC Signature", async () => {
    // Construct challenge payload matching Rust verification: [sku_id (32B) || claimant_pubkey (32B) || challenge_nonce (16B)]
    const messagePayload = Buffer.concat([
      skuId,
      attendee.publicKey.toBuffer(),
      challengeNonce,
    ]);

    // Hardware chip generates Ed25519 signature over challenge payload
    const hardwareSignature = nacl.sign.detached(
      messagePayload,
      hardwareChipKeypair.secretKey
    );

    // Build the atomic Ed25519 Precompile Instruction
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: hardwareChipKeypair.publicKey,
      message: messagePayload,
      signature: hardwareSignature,
    });

    // Build the program claim instruction
    const claimIx = await program.methods
      .verifyAndClaim(Array.from(challengeNonce))
      .accounts({
        config: configPda,
        itemRecord: itemRecordPda,
        claimReceipt: claimReceiptPda,
        claimant: attendee.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // Package into an atomic transaction: [Ed25519 Precompile, verify_and_claim]
    const tx = new Transaction().add(ed25519Ix).add(claimIx);

    const txSig = await sendAndConfirmTransaction(
      provider.connection,
      tx,
      [attendee],
      { skipPreflight: false, commitment: "confirmed" }
    );

    expect(txSig).to.be.a("string");

    // Assert states
    const item = await program.account.itemRecord.fetch(itemRecordPda);
    expect(item.status).to.deep.equal({ claimed: {} });
    expect(item.claimedBy.toBase58()).to.equal(attendee.publicKey.toBase58());

    const receipt = await program.account.claimReceipt.fetch(claimReceiptPda);
    expect(receipt.claimant.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(receipt.claimIndex.toNumber()).to.equal(0);

    const config = await program.account.merchConfig.fetch(configPda);
    expect(config.totalClaimed.toNumber()).to.equal(1);
  });

  it("4. Rejects Duplicate Claim Attempt (Anti-Double Claim)", async () => {
    const messagePayload = Buffer.concat([
      skuId,
      attendee.publicKey.toBuffer(),
      challengeNonce,
    ]);
    const hardwareSignature = nacl.sign.detached(messagePayload, hardwareChipKeypair.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: hardwareChipKeypair.publicKey,
      message: messagePayload,
      signature: hardwareSignature,
    });

    const claimIx = await program.methods
      .verifyAndClaim(Array.from(challengeNonce))
      .accounts({
        config: configPda,
        itemRecord: itemRecordPda,
        claimReceipt: claimReceiptPda,
        claimant: attendee.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(claimIx);

    try {
      await sendAndConfirmTransaction(provider.connection, tx, [attendee]);
      expect.fail("Should have failed with ItemAlreadyClaimed");
    } catch (err: any) {
      expect(err.toString()).to.include("ItemAlreadyClaimed");
    }
  });

  it("5. Rejects Forged Hardware Signature (Tamper Attack)", async () => {
    const attacker = Keypair.generate();
    const forgedChip = nacl.sign.keyPair();
    const forgedMessage = Buffer.concat([skuId, attacker.publicKey.toBuffer(), challengeNonce]);
    const forgedSignature = nacl.sign.detached(forgedMessage, forgedChip.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: forgedChip.publicKey,
      message: forgedMessage,
      signature: forgedSignature,
    });

    const [forgedReceipt] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim_receipt"), itemRecordPda.toBuffer(), attacker.publicKey.toBuffer()],
      program.programId
    );

    const claimIx = await program.methods
      .verifyAndClaim(Array.from(challengeNonce))
      .accounts({
        config: configPda,
        itemRecord: itemRecordPda,
        claimReceipt: forgedReceipt,
        claimant: attacker.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(claimIx);

    try {
      await sendAndConfirmTransaction(provider.connection, tx, [attacker]);
      expect.fail("Should have failed with HardwareKeyMismatch");
    } catch (err: any) {
      expect(err.toString()).to.include("HardwareKeyMismatch");
    }
  });
});
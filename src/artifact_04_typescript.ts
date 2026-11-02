import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ElEncuentroMerch } from "../target/types/el_encuentro_merch";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";
import * as nacl from "tweetnacl";

describe("El Encuentro 2026 - Phygital Merch Protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ElEncuentroMerch as Program<ElEncuentroMerch>;
  const admin = (provider.wallet as any).payer as Keypair;

  const attendee = Keypair.generate();
  const hardwareChip = Keypair.generate(); // Emulates the NTAG 424 DNA hardware keypair

  const itemId = 202601;
  const maxSupply = 5000;

  let configPda: PublicKey;
  let itemPda: PublicKey;
  let receiptPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test claimant
    const sig = await provider.connection.requestAirdrop(
      attendee.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const itemIdBuffer = Buffer.alloc(4);
    itemIdBuffer.writeUInt32LE(itemId, 0);

    [itemPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("item"), itemIdBuffer],
      program.programId
    );

    [receiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), itemIdBuffer, attendee.publicKey.toBuffer()],
      program.programId
    );
  });

  it("Initializes the El Encuentro 2026 Master Merch Collection", async () => {
    const tx = await program.methods
      .initializeCollection("El Encuentro 2026 Official", maxSupply)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    expect(tx).to.be.a("string");

    const configAccount = await program.account.merchConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.maxSupply).to.equal(maxSupply);
    expect(configAccount.totalRegistered).to.equal(0);
    expect(configAccount.totalClaimed).to.equal(0);
  });

  it("Registers an Official Physical Cyberpunk Hoodie with embedded Chip Pubkey", async () => {
    const uri = "https://arweave.net/el-encuentro-2026/cyberpunk-hoodie-001.json";

    await program.methods
      .registerPhysicalItem(
        itemId,
        hardwareChip.publicKey,
        { cyberpunkHoodie: {} },
        { large: {} },
        uri
      )
      .accounts({
        config: configPda,
        item: itemPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const itemAccount = await program.account.merchItem.fetch(itemPda);
    expect(itemAccount.itemId).to.equal(itemId);
    expect(itemAccount.chipPubkey.toBase58()).to.equal(hardwareChip.publicKey.toBase58());
    expect(itemAccount.isClaimed).to.be.false;
    expect(itemAccount.interactionXp).to.equal(0);
  });

  it("Executes NFC Tap Claim with native Ed25519 pre-instruction validation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const timestamp = new anchor.BN(now);

    // Construct the expected payload: [Claimant Pubkey: 32 bytes] + [Timestamp LE: 8 bytes]
    const timestampBuffer = Buffer.alloc(8);
    timestampBuffer.writeBigInt64LE(BigInt(now), 0);
    const message = Buffer.concat([attendee.publicKey.toBuffer(), timestampBuffer]);

    // Sign with physical chip simulated hardware keypair
    const signature = nacl.sign.detached(message, hardwareChip.secretKey);

    // Build the atomic Ed25519 verification instruction
    const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
      publicKey: hardwareChip.publicKey.toBytes(),
      message: message,
      signature: signature,
    });

    const claimTx = new Transaction();
    claimTx.add(ed25519Instruction);

    const claimIx = await program.methods
      .verifyAndClaim(itemId, timestamp, Array.from(signature))
      .accounts({
        config: configPda,
        item: itemPda,
        claimReceipt: receiptPda,
        claimant: attendee.publicKey,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    claimTx.add(claimIx);

    const txSig = await anchor.web3.sendAndConfirmTransaction(
      provider.connection,
      claimTx,
      [attendee]
    );

    expect(txSig).to.be.a("string");

    const claimedItem = await program.account.merchItem.fetch(itemPda);
    expect(claimedItem.isClaimed).to.be.true;
    expect(claimedItem.claimedBy.toBase58()).to.equal(attendee.publicKey.toBase58());

    const receipt = await program.account.claimReceipt.fetch(receiptPda);
    expect(receipt.itemId).to.equal(itemId);
    expect(receipt.claimant.toBase58()).to.equal(attendee.publicKey.toBase58());
  });

  it("Rejects replay / double-claim attack attempts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const timestamp = new anchor.BN(now);

    const timestampBuffer = Buffer.alloc(8);
    timestampBuffer.writeBigInt64LE(BigInt(now), 0);
    const message = Buffer.concat([attendee.publicKey.toBuffer(), timestampBuffer]);
    const signature = nacl.sign.detached(message, hardwareChip.secretKey);

    const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
      publicKey: hardwareChip.publicKey.toBytes(),
      message: message,
      signature: signature,
    });

    const duplicateTx = new Transaction().add(ed25519Instruction).add(
      await program.methods
        .verifyAndClaim(itemId, timestamp, Array.from(signature))
        .accounts({
          config: configPda,
          item: itemPda,
          claimReceipt: receiptPda,
          claimant: attendee.publicKey,
          ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );

    try {
      await anchor.web3.sendAndConfirmTransaction(provider.connection, duplicateTx, [attendee]);
      expect.fail("Should have failed double claim");
    } catch (err: any) {
      expect(err.toString()).to.include("ItemAlreadyClaimed");
    }
  });

  it("Evolves Merch XP when attendee scans at Main Keynote Stage checkpoint", async () => {
    const checkpointAuthority = Keypair.generate();

    await program.methods
      .logEventInteraction(itemId, 150)
      .accounts({
        config: configPda,
        item: itemPda,
        admin: admin.publicKey,
        authority: checkpointAuthority.publicKey,
      })
      .signers([admin, checkpointAuthority])
      .rpc();

    const evolvedItem = await program.account.merchItem.fetch(itemPda);
    expect(evolvedItem.interactionXp).to.equal(150);
  });
});
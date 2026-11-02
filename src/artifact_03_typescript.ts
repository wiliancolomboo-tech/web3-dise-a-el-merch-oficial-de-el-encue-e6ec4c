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
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";
import * as nacl from "tweetnacl";
import * as crypto from "crypto";

describe("El Encuentro 2026 - Phygital Merch Protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ElEncuentroMerch as Program<ElEncuentroMerch>;
  const admin = (provider.wallet as anchor.Wallet).payer;

  // Test Entities
  const attendee = Keypair.generate();
  const chipKeypair = nacl.sign.keyPair(); // Simulated physical NFC ed25519 chip
  const chipPubkey = new PublicKey(chipKeypair.publicKey);

  const eventId = "ENCUENTRO_2026_BOGOTA";
  const skuHoodie = 101; // Official Hacker Hoodie
  const zoneVipId = 7;

  let configPda: PublicKey;
  let itemPda: PublicKey;
  let beaconPda: PublicKey;

  before(async () => {
    // Fund attendee wallet
    const airdropSig = await provider.connection.requestAirdrop(
      attendee.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), Buffer.from(eventId)],
      program.programId
    );

    [itemPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("item"), chipPubkey.toBuffer()],
      program.programId
    );

    [beaconPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("beacon"), Buffer.from([zoneVipId])],
      program.programId
    );
  });

  it("1. Initializes El Encuentro 2026 Master Merch Config", async () => {
    const tx = await program.methods
      .initializeMasterConfig(eventId, 2500)
      .accounts({
        config: configPda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const configAccount = await program.account.masterConfig.fetch(configPda);
    expect(configAccount.eventId).to.equal(eventId);
    expect(configAccount.totalSupply).to.equal(2500);
    expect(configAccount.registeredItems).to.equal(0);
    expect(configAccount.claimedItems).to.equal(0);
  });

  it("2. Registers Physical Merchandise Item (Embedded NFC Chip)", async () => {
    await program.methods
      .registerPhysicalItem(chipPubkey, skuHoodie, { hacker: {} })
      .accounts({
        config: configPda,
        item: itemPda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const itemAccount = await program.account.itemAccount.fetch(itemPda);
    expect(itemAccount.chipPubkey.toBase58()).to.equal(chipPubkey.toBase58());
    expect(itemAccount.skuId).to.equal(skuHoodie);
    expect(itemAccount.isClaimed).to.be.false;
    expect(itemAccount.owner.toBase58()).to.equal(PublicKey.default.toBase58());
  });

  it("3. Creates Venue Check-in Beacon (VIP Stage Area)", async () => {
    await program.methods
      .createVenueBeacon(zoneVipId, "Hacker Arena Stage", { hacker: {} })
      .accounts({
        beacon: beaconPda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const beaconAccount = await program.account.venueBeacon.fetch(beaconPda);
    expect(beaconAccount.zoneId).to.equal(zoneVipId);
    expect(beaconAccount.zoneName).to.equal("Hacker Arena Stage");
  });

  it("4. Successfully claims Phygital Twin using hardware Ed25519 signature precompile", async () => {
    const nonce = crypto.randomBytes(16);
    
    // Construct Hardware Signature Payload: attendee.pubkey (32 bytes) + nonce (16 bytes)
    const challengeMessage = Buffer.concat([attendee.publicKey.toBuffer(), nonce]);
    const hardwareSignature = nacl.sign.detached(challengeMessage, chipKeypair.secretKey);

    // 1. Ed25519 precompile instruction
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: chipKeypair.publicKey,
      message: challengeMessage,
      signature: hardwareSignature,
    });

    // 2. Anchor claim instruction
    const claimIx = await program.methods
      .claimPhygitalTwin(Array.from(nonce))
      .accounts({
        config: configPda,
        item: itemPda,
        claimant: attendee.publicKey,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const atomicTx = new Transaction().add(ed25519Ix).add(claimIx);

    const sig = await sendAndConfirmTransaction(provider.connection, atomicTx, [attendee]);
    expect(sig).to.be.ok;

    const updatedItem = await program.account.itemAccount.fetch(itemPda);
    expect(updatedItem.isClaimed).to.be.true;
    expect(updatedItem.owner.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(updatedItem.tapCount).to.equal(1);
  });

  it("5. Rejects duplicate claim attempts (Anti-Sybil replay defense)", async () => {
    const nonce = crypto.randomBytes(16);
    const challengeMessage = Buffer.concat([attendee.publicKey.toBuffer(), nonce]);
    const hardwareSignature = nacl.sign.detached(challengeMessage, chipKeypair.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: chipKeypair.publicKey,
      message: challengeMessage,
      signature: hardwareSignature,
    });

    const claimIx = await program.methods
      .claimPhygitalTwin(Array.from(nonce))
      .accounts({
        config: configPda,
        item: itemPda,
        claimant: attendee.publicKey,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(claimIx);

    try {
      await sendAndConfirmTransaction(provider.connection, tx, [attendee]);
      expect.fail("Transaction should have failed because the item was already claimed.");
    } catch (err: any) {
      expect(err.toString()).to.include("ItemAlreadyClaimed");
    }
  });

  it("6. Records venue tap and unlocks venue zone", async () => {
    const nonce = crypto.randomBytes(16);
    const challengeMessage = Buffer.concat([attendee.publicKey.toBuffer(), nonce]);
    const hardwareSignature = nacl.sign.detached(challengeMessage, chipKeypair.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: chipKeypair.publicKey,
      message: challengeMessage,
      signature: hardwareSignature,
    });

    const tapIx = await program.methods
      .recordVenueTap(Array.from(nonce))
      .accounts({
        item: itemPda,
        beacon: beaconPda,
        attendee: attendee.publicKey,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(tapIx);
    await sendAndConfirmTransaction(provider.connection, tx, [attendee]);

    const tappedItem = await program.account.itemAccount.fetch(itemPda);
    expect(tappedItem.tapCount).to.equal(2);
    // Bitmask check: zone 7 => bit 7 is set (1 << 7 = 128)
    expect(tappedItem.unlockedZonesMask & (1 << zoneVipId)).to.equal(128);
  });
});
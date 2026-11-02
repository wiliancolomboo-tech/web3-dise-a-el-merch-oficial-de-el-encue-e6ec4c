import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ElEncuentroMerch } from "../target/types/el_encuentro_merch";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("El Encuentro 2026 - Phygital Merch System", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ElEncuentroMerch as Program<ElEncuentroMerch>;
  const authority = Keypair.generate();
  const attendee = Keypair.generate();
  const mockChip = Keypair.generate();

  let configPda: PublicKey;
  let configBump: number;
  let itemPda: PublicKey;
  let itemBump: number;

  const itemId = 42;
  const collectionName = "El Encuentro 2026";
  const baseUri = "https://arweave.net/encuentro2026-metadata/";
  const maxSupply = 500;

  before(async () => {
    // Airdrop SOL to test participants
    const airdropAuth = await provider.connection.requestAirdrop(
      authority.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropAuth);

    const airdropAttendee = await provider.connection.requestAirdrop(
      attendee.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropAttendee);

    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("collection"), authority.publicKey.toBuffer()],
      program.programId
    );

    [itemPda, itemBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("item"),
        configPda.toBuffer(),
        Buffer.from(new Uint32Array([itemId]).buffer),
      ],
      program.programId
    );
  });

  it("1. Initializes Collection Config PDA successfully", async () => {
    await program.methods
      .initializeCollection(collectionName, maxSupply, baseUri)
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const configAccount = await program.account.collectionConfig.fetch(configPda);
    expect(configAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(configAccount.collectionName).to.equal(collectionName);
    expect(configAccount.maxSupply).to.equal(maxSupply);
    expect(configAccount.registeredCount).to.equal(0);
    expect(configAccount.claimedCount).to.equal(0);
  });

  it("2. Registers a physical hoodie item with embedded hardware chip", async () => {
    // 0: Hoodie, 3: Large
    const itemType = 0;
    const size = 3;

    await program.methods
      .registerPhygitalItem(itemId, mockChip.publicKey, size, itemType)
      .accounts({
        config: configPda,
        item: itemPda,
        authority: authority.publicKey,
        initialRecipient: attendee.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const itemAccount = await program.account.phygitalItem.fetch(itemPda);
    expect(itemAccount.itemId).to.equal(itemId);
    expect(itemAccount.chipPubkey.toBase58()).to.equal(mockChip.publicKey.toBase58());
    expect(itemAccount.status).to.equal(0); // Manufactured
    expect(itemAccount.tapCount).to.equal(0);

    const configAccount = await program.account.collectionConfig.fetch(configPda);
    expect(configAccount.registeredCount).to.equal(1);
  });

  it("3. Prevents tap interactions before physical venue pickup", async () => {
    try {
      await program.methods
        .tapToVerify(1)
        .accounts({
          config: configPda,
          item: itemPda,
          scanner: attendee.publicKey,
        })
        .signers([attendee])
        .rpc();
      expect.fail("Should have thrown ItemNotClaimed");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ItemNotClaimed");
    }
  });

  it("4. Claims physical merch at El Encuentro booth", async () => {
    const dummyPasscode = new Array(16).fill(7);

    await program.methods
      .claimPhysicalItem(dummyPasscode)
      .accounts({
        config: configPda,
        item: itemPda,
        authority: authority.publicKey,
        recipient: attendee.publicKey,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([authority, attendee])
      .rpc();

    const itemAccount = await program.account.phygitalItem.fetch(itemPda);
    expect(itemAccount.status).to.equal(1); // ClaimedAtVenue
    expect(itemAccount.currentOwner.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(itemAccount.claimedTimestamp.toNumber()).to.be.greaterThan(0);

    const configAccount = await program.account.collectionConfig.fetch(configPda);
    expect(configAccount.claimedCount).to.equal(1);
  });

  it("5. Fails when attempting to double-claim the same garment", async () => {
    const dummyPasscode = new Array(16).fill(7);
    try {
      await program.methods
        .claimPhysicalItem(dummyPasscode)
        .accounts({
          config: configPda,
          item: itemPda,
          authority: authority.publicKey,
          recipient: attendee.publicKey,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        })
        .signers([authority, attendee])
        .rpc();
      expect.fail("Should have failed with AlreadyClaimed");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AlreadyClaimed");
    }
  });

  it("6. Successfully validates physical NFC tap and protects against nonce replay", async () => {
    // First valid tap: nonce = 1
    await program.methods
      .tapToVerify(1)
      .accounts({
        config: configPda,
        item: itemPda,
        scanner: attendee.publicKey,
      })
      .signers([attendee])
      .rpc();

    let itemAccount = await program.account.phygitalItem.fetch(itemPda);
    expect(itemAccount.tapCount).to.equal(1);

    // Replay attack: submitting stale or lower nonce = 1 must fail
    try {
      await program.methods
        .tapToVerify(1)
        .accounts({
          config: configPda,
          item: itemPda,
          scanner: attendee.publicKey,
        })
        .signers([attendee])
        .rpc();
      expect.fail("Should have failed with InvalidTapNonce");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidTapNonce");
    }

    // Advancing nonce = 2 succeeds
    await program.methods
      .tapToVerify(2)
      .accounts({
        config: configPda,
        item: itemPda,
        scanner: attendee.publicKey,
      })
      .signers([attendee])
      .rpc();

    itemAccount = await program.account.phygitalItem.fetch(itemPda);
    expect(itemAccount.tapCount).to.equal(2);
  });
});
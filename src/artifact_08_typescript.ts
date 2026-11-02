import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { EncuentroMerch } from "../target/types/encuentro_merch";
import { 
  Keypair, 
  PublicKey, 
  SystemProgram, 
  Transaction, 
  sendAndConfirmTransaction 
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  ExtensionType,
  getMintLen
} from "@solana/spl-token";
import { expect } from "chai";
import { keccak_256 } from "@noble/hashes/sha3";

describe("encuentro_merch: Phygital Architecture Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.EncuentroMerch as Program<EncuentroMerch>;
  const authority = provider.wallet as anchor.Wallet;

  const collectionId = 2026;
  const totalSupply = 500;
  const metadataUri = "https://arweave.net/el-encuentro-2026-official-merch.json";

  const itemId = 101;
  const itemTypeHoodie = 1;
  
  // Deterministic physical chip entropy
  const physicalEntropy = Buffer.from(
    "3f7a1c905b23d90f84a1e9483017bbcc546a100412354789abcdef0123456789", 
    "hex"
  );

  let collectionPda: PublicKey;
  let itemPda: PublicKey;
  let mintPda: PublicKey;
  let recipient: Keypair;
  let recipientAta: PublicKey;
  let expectedSecretHash: Uint8Array;

  before(async () => {
    recipient = Keypair.generate();

    // Airdrop SOL to test recipient
    const sig = await provider.connection.requestAirdrop(recipient.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");

    [collectionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("collection"),
        authority.publicKey.toBuffer(),
        new anchor.BN(collectionId).toArrayLike(Buffer, "le", 4)
      ],
      program.programId
    );

    [itemPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("item"),
        collectionPda.toBuffer(),
        new anchor.BN(itemId).toArrayLike(Buffer, "le", 4)
      ],
      program.programId
    );

    [mintPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("mint"),
        collectionPda.toBuffer(),
        new anchor.BN(itemId).toArrayLike(Buffer, "le", 4)
      ],
      program.programId
    );

    recipientAta = getAssociatedTokenAddressSync(
      mintPda,
      recipient.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    // Compute expected secret hash: keccak256(item_id (le u32) || physicalEntropy)
    const packed = Buffer.concat([
      new anchor.BN(itemId).toArrayLike(Buffer, "le", 4),
      physicalEntropy
    ]);
    expectedSecretHash = keccak_256(packed);
  });

  it("1. Initializes Collection for El Encuentro 2026", async () => {
    await program.methods
      .initializeCollection(collectionId, totalSupply, metadataUri)
      .accounts({
        collection: collectionPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const collectionAccount = await program.account.collection.fetch(collectionPda);
    expect(collectionAccount.collectionId).to.equal(collectionId);
    expect(collectionAccount.totalSupply).to.equal(totalSupply);
    expect(collectionAccount.claimedCount).to.equal(0);
    expect(collectionAccount.registeredCount).to.equal(0);
  });

  it("2. Registers Physical Item with NFC Secret Commitment", async () => {
    await program.methods
      .registerItem(itemId, Array.from(expectedSecretHash), itemTypeHoodie)
      .accounts({
        collection: collectionPda,
        item: itemPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const itemAccount = await program.account.merchItem.fetch(itemPda);
    expect(itemAccount.itemId).to.equal(itemId);
    expect(itemAccount.itemType).to.equal(itemTypeHoodie);
    expect(itemAccount.status).to.deep.equal({ unclaimed: {} });
  });

  it("3. Creates Token-2022 Mint PDA and ATA for Recipient", async () => {
    const mintLen = getMintLen([ExtensionType.NonTransferable]);
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(mintLen);

    // Initialize Mint under Collection PDA as Mint Authority
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: mintPda,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        mintPda,
        0,
        collectionPda, // Mint authority is Collection PDA
        null,
        TOKEN_2022_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        authority.publicKey,
        recipientAta,
        recipient.publicKey,
        mintPda,
        TOKEN_2022_PROGRAM_ID
      )
    );

    // Send with authority as fee payer
    await provider.sendAndConfirm(tx, []);
  });

  it("4. Prevents Front-Running: Claim Fails with Invalid Secret Entropy", async () => {
    const forgedEntropy = new Uint8Array(32).fill(0xee);

    try {
      await program.methods
        .claimItem(itemId, Array.from(forgedEntropy))
        .accounts({
          collection: collectionPda,
          item: itemPda,
          mint: mintPda,
          recipientTokenAccount: recipientAta,
          recipient: recipient.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([recipient])
        .rpc();
      expect.fail("Transaction should have failed with InvalidPhysicalProof");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidPhysicalProof");
    }
  });

  it("5. Successfully Claims Merch with Valid Physical Tap Proof", async () => {
    await program.methods
      .claimItem(itemId, Array.from(physicalEntropy))
      .accounts({
        collection: collectionPda,
        item: itemPda,
        mint: mintPda,
        recipientTokenAccount: recipientAta,
        recipient: recipient.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([recipient])
      .rpc();

    const itemAccount = await program.account.merchItem.fetch(itemPda);
    expect(itemAccount.status).to.deep.equal({ claimed: {} });
    expect(itemAccount.claimedBy.toBase58()).to.equal(recipient.publicKey.toBase58());

    const tokenBalance = await provider.connection.getTokenAccountBalance(recipientAta);
    expect(tokenBalance.value.amount).to.equal("1");
  });

  it("6. Replay Attack Prevention: Claim Fails on Already-Claimed Item", async () => {
    try {
      await program.methods
        .claimItem(itemId, Array.from(physicalEntropy))
        .accounts({
          collection: collectionPda,
          item: itemPda,
          mint: mintPda,
          recipientTokenAccount: recipientAta,
          recipient: recipient.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([recipient])
        .rpc();
      expect.fail("Replay attack succeeded when it must fail");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ItemAlreadyClaimed");
    }
  });

  it("7. Redeems On-Site Perk (VIP Lounge Entry - Bit 0)", async () => {
    const perkBit = 0; // VIP Lounge

    await program.methods
      .redeemPerk(perkBit)
      .accounts({
        item: itemPda,
        attendee: recipient.publicKey,
      })
      .signers([recipient])
      .rpc();

    const itemAccount = await program.account.merchItem.fetch(itemPda);
    expect(itemAccount.perksMask & (1 << perkBit)).to.equal(1);
  });

  it("8. Perk Double-Redeem Prevention", async () => {
    const perkBit = 0;

    try {
      await program.methods
        .redeemPerk(perkBit)
        .accounts({
          item: itemPda,
          attendee: recipient.publicKey,
        })
        .signers([recipient])
        .rpc();
      expect.fail("Should not allow redeeming the same perk twice");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("PerkAlreadyRedeemed");
    }
  });
});
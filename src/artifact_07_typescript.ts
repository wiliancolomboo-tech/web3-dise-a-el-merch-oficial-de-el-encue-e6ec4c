import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ElEncuentroMerch } from "../target/types/el_encuentro_merch";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("el_encuentro_merch: Phygital Merch Protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ElEncuentroMerch as Program<ElEncuentroMerch>;

  const admin = provider.wallet as anchor.Wallet;
  const dispensaryGatekeeper = Keypair.generate();
  const attendeeBuyer = Keypair.generate();
  const nfcChipHardware = Keypair.generate();

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("merch_config")],
    program.programId
  );

  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    program.programId
  );

  const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    program.programId
  );

  const itemId = 101; // El Encuentro 2026 Founder Hoodie
  const itemPrice = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
  const maxSupply = 250;

  const [catalogItemPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("catalog"), new anchor.BN(itemId).toArrayLike(Buffer, "le", 4)],
    program.programId
  );

  const [nfcChipRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("chip"), nfcChipHardware.publicKey.toBuffer()],
    program.programId
  );

  const [orderEscrowPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("order"),
      attendeeBuyer.publicKey.toBuffer(),
      new anchor.BN(itemId).toArrayLike(Buffer, "le", 4),
    ],
    program.programId
  );

  let digitalTwinMint: PublicKey;
  let buyerAta: PublicKey;

  before(async () => {
    // Airdrop SOL to test participants
    const sig1 = await provider.connection.requestAirdrop(
      attendeeBuyer.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig1);

    const sig2 = await provider.connection.requestAirdrop(
      dispensaryGatekeeper.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig2);

    // Initialize Token-2022 Digital Twin Mint with PDA authority
    digitalTwinMint = await createMint(
      provider.connection,
      (admin.payer as any),
      mintAuthorityPda,
      null,
      0,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Create Buyer Associated Token Account under Token-2022
    buyerAta = await createAccount(
      provider.connection,
      (admin.payer as any),
      digitalTwinMint,
      attendeeBuyer.publicKey,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
  });

  it("1. Initializes Merch Protocol Configuration", async () => {
    const tx = await program.methods
      .initializeConfig(dispensaryGatekeeper.publicKey)
      .accountsStrict({
        admin: admin.publicKey,
        config: configPda,
        treasury: treasuryPda,
        mintAuthority: mintAuthorityPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    expect(tx).to.be.a("string");

    const configAccount = await program.account.merchConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.dispensaryAuthority.toBase58()).to.equal(
      dispensaryGatekeeper.publicKey.toBase58()
    );
    expect(configAccount.isPaused).to.be.false;
  });

  it("2. Creates Catalog Item: El Encuentro Founder Hoodie (Size L)", async () => {
    await program.methods
      .createCatalogItem(
        itemId,
        "ENC26-HD-BLK-L",
        itemPrice,
        maxSupply,
        { large: {} }
      )
      .accountsStrict({
        admin: admin.publicKey,
        config: configPda,
        catalogItem: catalogItemPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const catalog = await program.account.catalogItem.fetch(catalogItemPda);
    expect(catalog.sku).to.equal("ENC26-HD-BLK-L");
    expect(catalog.priceLamports.toString()).to.equal(itemPrice.toString());
    expect(catalog.maxSupply).to.equal(maxSupply);
    expect(catalog.mintedCount).to.equal(0);
  });

  it("3. Factory Provisions NFC Chip Hardware into Registry", async () => {
    await program.methods
      .registerNfcChip(nfcChipHardware.publicKey, itemId)
      .accountsStrict({
        admin: admin.publicKey,
        config: configPda,
        catalogItem: catalogItemPda,
        chipRecord: nfcChipRecordPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const chip = await program.account.physicalChipRecord.fetch(nfcChipRecordPda);
    expect(chip.chipPubkey.toBase58()).to.equal(
      nfcChipHardware.publicKey.toBase58()
    );
    expect(chip.isLinked).to.be.false;
  });

  it("4. Attendee Pre-orders Hoodie into Escrow", async () => {
    const balanceBefore = await provider.connection.getBalance(attendeeBuyer.publicKey);

    await program.methods
      .orderMerchEscrow(itemId)
      .accountsStrict({
        buyer: attendeeBuyer.publicKey,
        config: configPda,
        catalogItem: catalogItemPda,
        orderEscrow: orderEscrowPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendeeBuyer])
      .rpc();

    const order = await program.account.orderEscrow.fetch(orderEscrowPda);
    expect(order.buyer.toBase58()).to.equal(attendeeBuyer.publicKey.toBase58());
    expect(order.isFulfilled).to.be.false;

    const catalog = await program.account.catalogItem.fetch(catalogItemPda);
    expect(catalog.mintedCount).to.equal(1);

    const escrowBalance = await provider.connection.getBalance(orderEscrowPda);
    expect(escrowBalance).to.equal(itemPrice.toNumber());
  });

  it("5. Completes Physical Venue Pickup & Mints Token-2022 Digital Twin", async () => {
    const treasuryBalanceBefore = await provider.connection.getBalance(treasuryPda);

    await program.methods
      .claimVenuePickup(itemId, nfcChipHardware.publicKey)
      .accountsStrict({
        buyer: attendeeBuyer.publicKey,
        dispensarySigner: dispensaryGatekeeper.publicKey,
        config: configPda,
        catalogItem: catalogItemPda,
        chipRecord: nfcChipRecordPda,
        orderEscrow: orderEscrowPda,
        treasury: treasuryPda,
        mintAuthority: mintAuthorityPda,
        digitalTwinMint: digitalTwinMint,
        buyerTokenAccount: buyerAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendeeBuyer, dispensaryGatekeeper])
      .rpc();

    // Verify order marked fulfilled
    const order = await program.account.orderEscrow.fetch(orderEscrowPda);
    expect(order.isFulfilled).to.be.true;

    // Verify Chip linked to attendee
    const chip = await program.account.physicalChipRecord.fetch(nfcChipRecordPda);
    expect(chip.isLinked).to.be.true;
    expect(chip.claimedBy.toBase58()).to.equal(attendeeBuyer.publicKey.toBase58());

    // Verify funds moved from Escrow to Treasury
    const treasuryBalanceAfter = await provider.connection.getBalance(treasuryPda);
    expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(itemPrice.toNumber());

    // Verify Digital Twin Minted to Buyer ATA
    const tokenBalance = await provider.connection.getTokenAccountBalance(buyerAta);
    expect(tokenBalance.value.uiAmount).to.equal(1);
  });

  it("6. Rejects Duplicate Pickup Claim (Anti-Double Claim Guard)", async () => {
    try {
      await program.methods
        .claimVenuePickup(itemId, nfcChipHardware.publicKey)
        .accountsStrict({
          buyer: attendeeBuyer.publicKey,
          dispensarySigner: dispensaryGatekeeper.publicKey,
          config: configPda,
          catalogItem: catalogItemPda,
          chipRecord: nfcChipRecordPda,
          orderEscrow: orderEscrowPda,
          treasury: treasuryPda,
          mintAuthority: mintAuthorityPda,
          digitalTwinMint: digitalTwinMint,
          buyerTokenAccount: buyerAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([attendeeBuyer, dispensaryGatekeeper])
        .rpc();
      expect.fail("Transaction should have failed with ChipAlreadyLinked or OrderAlreadyFulfilled");
    } catch (err: any) {
      expect(err.toString()).to.contain("ChipAlreadyLinked");
    }
  });
});
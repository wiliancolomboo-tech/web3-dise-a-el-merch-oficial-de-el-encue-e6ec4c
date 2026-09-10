import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ElEncuentroMerch } from "../target/types/el_encuentro_merch";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("El Encuentro 2026 - Phygital Merch Protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ElEncuentroMerch as Program<ElEncuentroMerch>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const buyer = Keypair.generate();
  const treasury = Keypair.generate();
  const hardwareChip = Keypair.generate();

  const eventId = new anchor.BN(2026);
  const sku = "ENCUENTRO-HOODIE-LTD";
  const itemPrice = new anchor.BN(50_000_000); // 50 USDC (6 decimals)
  const maxSupply = 500;

  let paymentMint: PublicKey;
  let buyerPaymentAccount: PublicKey;
  let treasuryPaymentAccount: PublicKey;
  let campaignPda: PublicKey;
  let escrowVaultPda: PublicKey;
  let catalogItemPda: PublicKey;
  let nfcRegistryPda: PublicKey;
  let orderEscrowPda: PublicKey;
  let digitalTwinMint: PublicKey;
  let buyerDigitalTwinAccount: PublicKey;

  before(async () => {
    // 1. Airdrop SOL to buyer
    const sig = await provider.connection.requestAirdrop(buyer.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    // 2. Setup mock USDC mint
    paymentMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // 3. Setup token accounts
    buyerPaymentAccount = await createAccount(
      provider.connection,
      buyer,
      paymentMint,
      buyer.publicKey
    );

    treasuryPaymentAccount = await createAccount(
      provider.connection,
      admin,
      paymentMint,
      treasury.publicKey
    );

    // 4. Fund buyer token account
    await mintTo(
      provider.connection,
      admin,
      paymentMint,
      buyerPaymentAccount,
      admin,
      200_000_000
    );

    // 5. Derive PDAs
    [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), eventId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), campaignPda.toBuffer()],
      program.programId
    );

    [catalogItemPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("item"), campaignPda.toBuffer(), Buffer.from(sku)],
      program.programId
    );

    [nfcRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nfc"), hardwareChip.publicKey.toBuffer()],
      program.programId
    );

    [orderEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order"), catalogItemPda.toBuffer(), buyer.publicKey.toBuffer()],
      program.programId
    );

    // 6. Setup Digital Twin Mint (PDA Campaign is Mint Authority)
    digitalTwinMint = await createMint(
      provider.connection,
      admin,
      campaignPda, // Mint authority is Campaign PDA
      null,
      0
    );

    buyerDigitalTwinAccount = await createAccount(
      provider.connection,
      buyer,
      digitalTwinMint,
      buyer.publicKey
    );
  });

  it("1. Initializes Campaign & Escrow Vault", async () => {
    await program.methods
      .initializeCampaign(eventId, paymentMint, treasury.publicKey)
      .accounts({
        campaign: campaignPda,
        escrowVault: escrowVaultPda,
        paymentMint: paymentMint,
        treasuryWallet: treasury.publicKey,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const campaignState = await program.account.merchCampaign.fetch(campaignPda);
    expect(campaignState.eventId.toNumber()).to.equal(2026);
    expect(campaignState.admin.toBase58()).to.equal(admin.publicKey.toBase58());
  });

  it("2. Registers Catalog SKU (Hoodie Ltd)", async () => {
    await program.methods
      .registerCatalogItem(sku, itemPrice, maxSupply)
      .accounts({
        campaign: campaignPda,
        catalogItem: catalogItemPda,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const itemState = await program.account.catalogItem.fetch(catalogItemPda);
    expect(itemState.sku).to.equal(sku);
    expect(itemState.priceInTokens.toNumber()).to.equal(itemPrice.toNumber());
    expect(itemState.maxSupply).to.equal(maxSupply);
    expect(itemState.reservedCount).to.equal(0);
  });

  it("3. Provisions Physical NFC Secure Element Chip", async () => {
    await program.methods
      .provisionNfcChip(hardwareChip.publicKey)
      .accounts({
        campaign: campaignPda,
        catalogItem: catalogItemPda,
        nfcRegistry: nfcRegistryPda,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const nfcState = await program.account.nfcRegistry.fetch(nfcRegistryPda);
    expect(nfcState.chipPubkey.toBase58()).to.equal(hardwareChip.publicKey.toBase58());
    expect(nfcState.isClaimed).to.be.false;
  });

  it("4. Attendee pre-orders merch item with sizing lock (Size XL)", async () => {
    await program.methods
      .placeOrder("XL")
      .accounts({
        campaign: campaignPda,
        catalogItem: catalogItemPda,
        orderEscrow: orderEscrowPda,
        escrowVault: escrowVaultPda,
        buyerTokenAccount: buyerPaymentAccount,
        paymentMint: paymentMint,
        buyer: buyer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const orderState = await program.account.orderEscrow.fetch(orderEscrowPda);
    expect(orderState.size).to.equal("XL");
    expect(orderState.isRedeemed).to.be.false;

    const vaultInfo = await getAccount(provider.connection, escrowVaultPda);
    expect(Number(vaultInfo.amount)).to.equal(50_000_000);
  });

  it("5. Claims physical item in-person: mints digital twin & flushes funds", async () => {
    const tapCounter = 1;

    await program.methods
      .claimPhysicalMerch(tapCounter)
      .accounts({
        campaign: campaignPda,
        catalogItem: catalogItemPda,
        nfcRegistry: nfcRegistryPda,
        orderEscrow: orderEscrowPda,
        escrowVault: escrowVaultPda,
        treasuryTokenAccount: treasuryPaymentAccount,
        paymentMint: paymentMint,
        digitalTwinMint: digitalTwinMint,
        buyerDigitalTwinAccount: buyerDigitalTwinAccount,
        buyer: buyer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    // Verify NFC is marked claimed
    const nfcState = await program.account.nfcRegistry.fetch(nfcRegistryPda);
    expect(nfcState.isClaimed).to.be.true;
    expect(nfcState.lastTapCounter).to.equal(1);

    // Verify Order is redeemed
    const orderState = await program.account.orderEscrow.fetch(orderEscrowPda);
    expect(orderState.isRedeemed).to.be.true;

    // Verify Digital Twin balance
    const twinBalance = await getAccount(provider.connection, buyerDigitalTwinAccount);
    expect(Number(twinBalance.amount)).to.equal(1);

    // Verify Treasury received funds
    const treasuryBalance = await getAccount(provider.connection, treasuryPaymentAccount);
    expect(Number(treasuryBalance.amount)).to.equal(50_000_000);
  });

  it("6. Exploit Defense: Replay attack fails on claimed NFC chip", async () => {
    try {
      await program.methods
        .claimPhysicalMerch(2)
        .accounts({
          campaign: campaignPda,
          catalogItem: catalogItemPda,
          nfcRegistry: nfcRegistryPda,
          orderEscrow: orderEscrowPda,
          escrowVault: escrowVaultPda,
          treasuryTokenAccount: treasuryPaymentAccount,
          paymentMint: paymentMint,
          digitalTwinMint: digitalTwinMint,
          buyerDigitalTwinAccount: buyerDigitalTwinAccount,
          buyer: buyer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();
      expect.fail("Should have reverted on duplicate chip claim");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ChipAlreadyClaimed");
    }
  });
});
# Switch to Devnet for final staging verification
solana config set --url devnet
solana airdrop 2

# Deploy to Devnet
anchor deploy --provider.cluster devnet
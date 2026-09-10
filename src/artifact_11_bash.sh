# Switch CLI to devnet
solana config set --url https://api.devnet.solana.com

# Ensure deployer wallet is funded
solana airdrop 2

# Deploy the compiled program
anchor deploy --provider.cluster devnet

# Verify program deployment on Solana Explorer
solana program show Encu26Merch111111111111111111111111111111111
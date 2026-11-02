# Switch CLI to devnet
solana config set --url https://api.devnet.solana.com

# Fund deployer account
solana airdrop 2

# Deploy program
anchor deploy --provider.cluster devnet
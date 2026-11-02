# Configure CLI to Devnet
solana config set --url https://api.devnet.solana.com

# Fund deployer address
solana airdrop 2

# Deploy program
anchor deploy --provider.cluster Devnet
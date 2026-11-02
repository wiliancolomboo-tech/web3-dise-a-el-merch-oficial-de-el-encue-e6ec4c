# Set Solana CLI to Devnet
solana config set --url https://api.devnet.solana.com

# Ensure you have devnet SOL
solana airdrop 2

# Deploy the program binary
anchor deploy --provider.cluster devnet
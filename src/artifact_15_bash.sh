# 1. Set Solana CLI config to Devnet
solana config set --url https://api.devnet.solana.com

# 2. Fund deployment authority
solana airdrop 2

# 3. Deploy to Devnet
anchor deploy --provider.cluster devnet

# 4. Verify deployment program account
solana program show Encu26Merch111111111111111111111111111111111
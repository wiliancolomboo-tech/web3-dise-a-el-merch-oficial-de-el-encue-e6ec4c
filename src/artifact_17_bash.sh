# Set Solana configuration to Localnet
solana config set --url localhost

# Generate default local validator keypair if not present
solana-keygen new --no-bip39-passphrase -s --force
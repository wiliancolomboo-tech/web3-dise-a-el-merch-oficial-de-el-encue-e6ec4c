# Get the generated program ID
solana address -k target/deploy/el_encuentro_merch-keypair.json

# Update declare_id! in src/lib.rs and Anchor.toml with the printed address
anchor keys sync
# 1. Clone or initialize the repository
git clone https://github.com/solana-bounties/el-encuentro-2026-merch.git
cd el-encuentro-2026-merch

# 2. Install dependencies
yarn install

# 3. Synchronize program keys
anchor keys sync

# 4. Build Anchor Program
anchor build

# 5. Run the complete test matrix with local Solana validator
anchor test
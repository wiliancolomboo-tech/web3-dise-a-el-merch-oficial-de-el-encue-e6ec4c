import nacl.signing
import struct

def provision_merch_item(item_id: int):
    # Generates ed25519 keypair for NXP DNA chip simulation
    signing_key = nacl.signing.SigningKey.generate()
    verify_key = signing_key.verify_key
    
    print(f"[FABRICATION] Item ID: {item_id}")
    print(f"Chip Pubkey (Hex): {verify_key.encode().hex()}")
    print(f"Burn to Chip Private Key: {signing_key.encode().hex()}")
    
    return signing_key, verify_key

if __name__ == "__main__":
    provision_merch_item(101)
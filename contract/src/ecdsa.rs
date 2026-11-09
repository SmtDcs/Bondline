//! FALLBACK ONLY (enable with `--features ecdsa`): verify a NEAR AI `signing_algo=ecdsa` signature.
//! EIP-191: digest = keccak256("\x19Ethereum Signed Message:\n" + decimal(len(text)) + text)
use near_sdk::env;

/// `signature_hex`: 65 bytes r||s||v (0x prefix optional), v in {0,1,27,28}.
/// `address_hex`: 20-byte Ethereum address (0x prefix optional).
pub fn verify_eip191(text: &str, signature_hex: &str, address_hex: &str) -> bool {
    let sig: [u8; 65] = match crate::parse::decode_hex_fixed::<65>(signature_hex) { Ok(s) => s, Err(_) => return false };
    let addr: [u8; 20] = match crate::parse::decode_hex_fixed::<20>(&address_hex.to_lowercase()) { Ok(a) => a, Err(_) => return false };
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    let digest = env::keccak256_array(&msg);
    let v = if sig[64] >= 27 { sig[64] - 27 } else { sig[64] };
    if v > 1 { return false; }
    // malleability_flag = true rejects high-s signatures
    let pubkey = match env::ecrecover(&digest, &sig[..64], v, true) { Some(p) => p, None => return false };
    let h = env::keccak256_array(&pubkey);
    h[12..] == addr
}

#[cfg(test)]
mod tests {
    // REAL vector: tee-receipts fixtures/testnet/receipt-bundle.json (MIT), NEAR AI provider_tee, Qwen/Qwen3.8-27B, 2026-11-01
    const TEXT: &str = "Qwen/Qwen3.8-27B:75947b824e6dc3ecc863c82a6ee32601806d8247a6fcbdc819063700efac3031:2ff07dd89fbb69f49578f026bb1f132f9082a772619e40c9cdb9ff548d451283";
    const SIG: &str = "0x66528b8b195b6ce203147826cb7348778234a15b9b66e61d9350dfedbf30b0db4af05e90705aad29c17188ba0bad77caf1d739e19a4a2fd06f2a28b70af230511c";
    const ADDR: &str = "0x835ab53d20294ef795906dff21ae4c045336aa26";
    #[test]
    fn real_near_ai_ecdsa_vector() {
        assert!(super::verify_eip191(TEXT, SIG, ADDR));
        assert!(!super::verify_eip191(&TEXT.replace("2ff0", "2ff1"), SIG, ADDR));
    }
}

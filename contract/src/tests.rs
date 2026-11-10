use super::*;
use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_sdk::serde_json::Value;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const VECTORS: &str = include_str!("../tests/vectors.json");
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const NOW_MS: u64 = 1_794_200_000_000;

fn v() -> Value {
    near_sdk::serde_json::from_str(VECTORS).unwrap()
}
fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_string()
}
fn acc(a: &str) -> AccountId {
    a.parse().unwrap()
}
fn ctx(predecessor: &str, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("promises.testnet"))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(100))
        .block_timestamp(NOW_MS * 1_000_000);
    testing_env!(b.build());
}
fn b64(v: &Value, k: &str) -> Base64VecU8 {
    Base64VecU8(STANDARD.decode(s(v, k)).unwrap())
}

/// owner + signer + merchant with 3 NEAR bond + orders A123, A124 (2 NEAR each, max 30%) + both receipts
fn setup() -> Contract {
    let vec = v();
    ctx("owner.testnet", 0);
    let mut c = Contract::new(acc("owner.testnet"));
    c.add_signer(
        s(&vec["honest"], "signer_public_key_hex"),
        "provider_tee".into(),
        Some("z-ai/glm-5.3-flash".into()),
        "fd320d9f17de6c99f28c168ffd429af6859cd0e6a81e1a31c813aeca07810672".into(),
        U64(NOW_MS + 86_400_000),
    );
    ctx("shop.testnet", 3 * NEAR);
    c.register_merchant();
    ctx("shop.testnet", 0);
    c.register_order("A123".into(), acc("alice.testnet"), U128(2 * NEAR), 3000);
    c.register_order("A124".into(), acc("alice.testnet"), U128(2 * NEAR), 3000);
    for name in ["honest", "injection"] {
        let x = &vec[name];
        c.register_receipt(s(x, "order_id"), s(x, "signed_text"), s(x, "signature_hex"), s(x, "signer_public_key_hex"));
    }
    c
}

#[test]
fn honest_claim_pays_20_percent() {
    let mut c = setup();
    let vec = v();
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().reserved, U128(12 * NEAR / 10));
    ctx("alice.testnet", 0);
    let p = c.claim("A123".into(), b64(&vec["honest"], "response_b64"));
    assert!(p.ok);
    assert_eq!(p.token_bps, 2000);
    assert_eq!(p.paid_bps, 2000);
    assert_eq!(p.payout, U128(4 * NEAR / 10));
    let m = c.get_merchant(acc("shop.testnet")).unwrap();
    assert_eq!(m.bond, U128(3 * NEAR - 4 * NEAR / 10));
    assert_eq!(m.reserved, U128(6 * NEAR / 10));
    // replay
    let again = c.preview_claim("A123".into(), b64(&vec["honest"], "response_b64"));
    assert_eq!(again.error.as_deref(), Some("ERR_ALREADY_CLAIMED"));
}

#[test]
fn injection_is_clipped_to_max_bps() {
    let mut c = setup();
    ctx("alice.testnet", 0);
    let p = c.claim("A124".into(), b64(&v()["injection"], "response_b64"));
    assert_eq!(p.token_bps, 10000);
    assert_eq!(p.paid_bps, 3000);
    assert_eq!(p.payout, U128(6 * NEAR / 10));
}

#[test]
fn tampered_bytes_have_no_receipt() {
    let c = setup();
    let mut bytes = b64(&v()["honest"], "response_b64").0;
    let pos = bytes.windows(4).position(|w| w == b"2000").unwrap();
    bytes[pos] = b'3'; // 2000 -> 3000
    let p = c.preview_claim("A123".into(), Base64VecU8(bytes));
    assert_eq!(p.error.as_deref(), Some("ERR_NO_RECEIPT_FOR_BYTES"));
}

#[test]
fn receipt_for_other_order_rejected() {
    let c = setup();
    let p = c.preview_claim("A124".into(), b64(&v()["honest"], "response_b64"));
    assert_eq!(p.error.as_deref(), Some("ERR_RECEIPT_ORDER_MISMATCH"));
}

#[test]
#[should_panic(expected = "ERR_BAD_SIGNATURE")]
fn edited_signed_text_fails_signature() {
    let vec = v();
    ctx("owner.testnet", 0);
    let mut c = Contract::new(acc("owner.testnet"));
    let x = &vec["honest"];
    c.add_signer(s(x, "signer_public_key_hex"), "provider_tee".into(), Some("z-ai/glm-5.3-flash".into()), "00".repeat(32), U64(NOW_MS + 1000));
    ctx("shop.testnet", 3 * NEAR);
    c.register_merchant();
    ctx("shop.testnet", 0);
    c.register_order("A123".into(), acc("alice.testnet"), U128(2 * NEAR), 3000);
    // merchant swaps in the hash of an edited reply: the TEE never signed this text
    let edited = s(x, "signed_text").replace(&s(x, "response_hash"), &"ab".repeat(32));
    c.register_receipt("A123".into(), edited, s(x, "signature_hex"), s(x, "signer_public_key_hex"));
}

#[test]
#[should_panic(expected = "ERR_NOT_ORDER_MERCHANT")]
fn shopper_cannot_register_receipt() {
    let vec = v();
    let mut c = setup();
    ctx("alice.testnet", 0);
    let x = &vec["honest"];
    c.register_receipt("A123".into(), s(x, "signed_text"), s(x, "signature_hex"), s(x, "signer_public_key_hex"));
}

#[test]
#[should_panic(expected = "ERR_NOT_BUYER")]
fn only_buyer_can_claim() {
    let mut c = setup();
    ctx("mallory.testnet", 0);
    c.claim("A123".into(), b64(&v()["honest"], "response_b64"));
}

#[test]
#[should_panic(expected = "ERR_WITHDRAW_EXCEEDS_FREE_BOND")]
fn reserved_bond_cannot_be_withdrawn() {
    let mut c = setup();
    ctx("shop.testnet", 0);
    let _ = c.withdraw_bond(U128(2 * NEAR)); // free = 3 - 1.2 = 1.8 NEAR
}

#[test]
#[should_panic(expected = "ERR_SIGNER_EXPIRED")]
fn expired_signer_rejected() {
    let vec = v();
    let mut c = setup();
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(acc("shop.testnet")).block_timestamp((NOW_MS + 86_400_001) * 1_000_000);
    testing_env!(b.build());
    c.register_order("A125".into(), acc("alice.testnet"), U128(NEAR), 1000);
    let x = &vec["honest"];
    c.register_receipt("A125".into(), s(x, "signed_text"), s(x, "signature_hex"), s(x, "signer_public_key_hex"));
}

const LIVE: &str = include_str!("../tests/live_vector.json");

/// Contract with the REAL S1 vector registered as signer, plus one 2 NEAR order with a 30% cap for it.
fn live_setup() -> (Contract, Value) {
    let x: Value = near_sdk::serde_json::from_str(LIVE).unwrap();
    ctx("owner.testnet", 0);
    let mut c = Contract::new(acc("owner.testnet"));
    c.add_signer(s(&x, "signer_public_key_hex"), "provider_tee".into(), Some(s(&x, "model")), "00".repeat(32), U64(NOW_MS + 1000));
    ctx("shop.testnet", 3 * NEAR);
    c.register_merchant();
    ctx("shop.testnet", 0);
    c.register_order(s(&x, "order_id"), acc("alice.testnet"), U128(2 * NEAR), 3000);
    (c, x)
}

fn register_live_receipt(c: &mut Contract, x: &Value) -> Receipt {
    c.register_receipt(s(x, "order_id"), s(x, "signed_text"), s(x, "signature_hex"), s(x, "signer_public_key_hex"))
}

#[test]
fn real_near_ai_ed25519_receipt_registers() {
    let (mut c, x) = live_setup();
    let r = register_live_receipt(&mut c, &x);
    assert_eq!(r.signature_kind, "provider_tee");
    // the stored key is the hash of the exact bytes the shopper will claim with
    assert_eq!(r.response_hash, hex::encode(env::sha256_array(&b64(&x, "response_b64").0)));
    ctx("alice.testnet", 0);
    let p = c.preview_claim(s(&x, "order_id"), b64(&x, "response_b64"));
    // the reply ends with exactly one "PROMISE|refund|order=A123|bps=2000", so a broken parser,
    // a wrong order match or wrong payout maths on the REAL bytes would show up here
    assert!(p.ok, "{:?}", p);
    assert_eq!(p.token_bps, 2000);
    assert_eq!(p.paid_bps, 2000);
    assert_eq!(p.payout.0, 400_000_000_000_000_000_000_000u128);
}

#[test]
fn real_near_ai_one_changed_byte_has_no_receipt() {
    let (mut c, x) = live_setup();
    register_live_receipt(&mut c, &x);
    let mut bytes = b64(&x, "response_b64").0;
    let pos = bytes.windows(8).position(|w| w == b"bps=2000").unwrap();
    bytes[pos + 4] = b'1'; // bps=2000 -> bps=1000: still a valid token, different bytes
    ctx("alice.testnet", 0);
    let p = c.preview_claim(s(&x, "order_id"), Base64VecU8(bytes));
    assert_eq!(p.error.as_deref(), Some("ERR_NO_RECEIPT_FOR_BYTES"));
}

#[test]
#[should_panic(expected = "ERR_BAD_SIGNATURE")]
fn real_near_ai_receipt_with_edited_hash_fails() {
    let (mut c, x) = live_setup();
    let mut text = s(&x, "signed_text");
    let last = text.pop().unwrap();
    text.push(if last == '0' { '1' } else { '0' }); // still valid hex, different hash
    c.register_receipt(s(&x, "order_id"), text, s(&x, "signature_hex"), s(&x, "signer_public_key_hex"));
}

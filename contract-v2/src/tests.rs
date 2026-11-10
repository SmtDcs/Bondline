use super::*;
use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, testing_env_with_promise_results, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const VECTORS: &str = include_str!("../tests/vectors.json");
const LIVE: &str = include_str!("../tests/live_vector.json");
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const NOW_MS: u64 = 1_794_200_000_000;
const DAY_MS: u64 = 86_400_000;
const TUSDC: &str = "tusdc.testnet";
const TUSDT: &str = "tusdt.testnet";
const CONTRACT: &str = "promises.testnet";

fn v() -> Value {
    near_sdk::serde_json::from_str(VECTORS).unwrap()
}
fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_string()
}
fn acc(a: &str) -> AccountId {
    a.parse().unwrap()
}
fn b64(v: &Value, k: &str) -> Base64VecU8 {
    Base64VecU8(STANDARD.decode(s(v, k)).unwrap())
}
fn build_ctx(predecessor: &str, deposit: u128, ts_ms: u64, tgas: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(100))
        .block_timestamp(ts_ms * 1_000_000)
        .prepaid_gas(Gas::from_tgas(tgas));
    b
}
fn ctx(predecessor: &str, deposit: u128) {
    testing_env!(build_ctx(predecessor, deposit, NOW_MS, 300).build());
}
fn ctx_gas(predecessor: &str, deposit: u128, tgas: u64) {
    testing_env!(build_ctx(predecessor, deposit, NOW_MS, tgas).build());
}
/// Change the clock (or the gas) without losing the mocked storage.
fn ctx_at(predecessor: &str, deposit: u128, ts_ms: u64) {
    testing_env_with_promise_results(build_ctx(predecessor, deposit, ts_ms, 300).build(), PromiseResult::Successful(vec![]));
}
fn ctx_result(result: PromiseResult) {
    testing_env_with_promise_results(build_ctx(CONTRACT, 0, NOW_MS, 300).build(), result);
}

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:").map(|j| near_sdk::serde_json::from_str::<Value>(j).unwrap()))
        .collect()
}
fn event_names() -> Vec<String> {
    events().iter().map(|e| e["event"].as_str().unwrap().to_string()).collect()
}
fn byte_cost() -> u128 {
    env::storage_byte_cost().as_yoctonear()
}
/// The unused amount that `ft_on_transfer` returns (a Promise here would be a bug).
fn unused(p: PromiseOrValue<U128>) -> u128 {
    match p {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("ft_on_transfer returned a promise"),
    }
}
fn new_contract(tokens: Vec<&str>) -> Contract {
    ctx("owner.testnet", 0);
    Contract::new(
        acc("owner.testnet"),
        Some(tokens.iter().map(|t| acc(t)).collect()),
        Some(U64(1000)),
    )
}
fn add_honest_signer(c: &mut Contract) {
    let vec = v();
    ctx("owner.testnet", 1);
    c.add_signer(
        s(&vec["honest"], "signer_public_key_hex"),
        "provider_tee".into(),
        Some("z-ai/glm-5.3-flash".into()),
        "fd320d9f17de6c99f28c168ffd429af6859cd0e6a81e1a31c813aeca07810672".into(),
        U64(NOW_MS + DAY_MS),
    );
}
/// NEAR bond of exactly `bond`, then a storage balance.
fn merchant(c: &mut Contract, name: &str, bond: u128, storage: u128) {
    ctx(name, bond);
    c.register_merchant();
    let got = c.get_merchant(acc(name)).unwrap().bond.0;
    if bond > got {
        ctx(name, bond - got);
        c.add_bond();
    }
    ctx(name, storage);
    c.storage_deposit(None);
}
fn token_bond(c: &mut Contract, merchant: &str, token: &str, amount: u128) {
    ctx(token, 0);
    assert_eq!(unused(c.ft_on_transfer(acc(merchant), U128(amount), "{\"add_bond\":{}}".into())), 0);
}
fn register_order(c: &mut Contract, merchant: &str, id: &str, buyer: &str, amount: u128, max_bps: u16, token: Option<&str>, ttl_ms: Option<u64>) -> Order {
    ctx(merchant, 1);
    c.register_order(id.into(), acc(buyer), U128(amount), max_bps, token.map(acc), ttl_ms.map(U64))
}
fn register_receipt(c: &mut Contract, merchant: &str, order: &str, x: &Value) -> Receipt {
    ctx(merchant, 0);
    c.register_receipt(order.into(), s(x, "signed_text"), s(x, "signature_hex"), s(x, "signer_public_key_hex"))
}

/// owner + signer + merchant with exactly 3 NEAR bond + orders A123, A124 (2 NEAR each, max 30%) + both receipts
fn setup() -> Contract {
    let vec = v();
    ctx("owner.testnet", 0);
    let mut c = Contract::new(acc("owner.testnet"), None, Some(U64(1000)));
    add_honest_signer(&mut c);
    merchant(&mut c, "shop.testnet", 3 * NEAR, NEAR);
    register_order(&mut c, "shop.testnet", "A123", "alice.testnet", 2 * NEAR, 3000, None, None);
    register_order(&mut c, "shop.testnet", "A124", "alice.testnet", 2 * NEAR, 3000, None, None);
    for name in ["honest", "injection"] {
        register_receipt(&mut c, "shop.testnet", s(&vec[name], "order_id").as_str(), &vec[name]);
    }
    c
}

/// Run claim as the buyer, then run the callback with the given transfer result.
fn claim_and_callback(c: &mut Contract, merchant: &str, buyer: &str, order: &str, response_b64: &str, ok: bool) -> ClaimPreview {
    ctx(buyer, 0);
    let bytes = Base64VecU8(STANDARD.decode(response_b64).unwrap());
    let pre = c.preview_claim(acc(merchant), order.into(), bytes.clone());
    let p = c.claim(acc(merchant), order.into(), bytes);
    drop(p);
    ctx_result(if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed });
    c.on_claim_paid(acc(merchant), order.into(), pre.payout, pre.token_bps, pre.paid_bps, pre.response_hash)
}

fn first_receipt() -> near_sdk::mock::Receipt {
    get_created_receipts().into_iter().next().unwrap()
}
fn function_call(receipt: &near_sdk::mock::Receipt) -> (&str, Value, u128, u64) {
    for a in &receipt.actions {
        if let MockAction::FunctionCallWeight { method_name, args, attached_deposit, prepaid_gas, .. } = a {
            let name = String::from_utf8(method_name.clone()).unwrap();
            let args: Value = near_sdk::serde_json::from_slice(args).unwrap();
            return (Box::leak(name.into_boxed_str()), args, attached_deposit.as_yoctonear(), prepaid_gas.as_gas() / 1_000_000_000_000);
        }
    }
    panic!("no function call action: {:?}", receipt.actions);
}
fn transfer_deposit(receipt: &near_sdk::mock::Receipt) -> u128 {
    for a in &receipt.actions {
        if let MockAction::Transfer { deposit, .. } = a {
            return deposit.as_yoctonear();
        }
    }
    panic!("no transfer action: {:?}", receipt.actions);
}

// ======================= A. ported v1 tests =======================

#[test]
fn honest_claim_pays_20_percent() {
    let mut c = setup();
    let vec = v();
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().reserved, U128(12 * NEAR / 10));
    let p = claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &s(&vec["honest"], "response_b64"), true);
    assert!(p.ok);
    assert_eq!(p.token_bps, 2000);
    assert_eq!(p.paid_bps, 2000);
    assert_eq!(p.payout, U128(4 * NEAR / 10));
    let m = c.get_merchant(acc("shop.testnet")).unwrap();
    assert_eq!(m.bond, U128(3 * NEAR - 4 * NEAR / 10));
    assert_eq!(m.reserved, U128(6 * NEAR / 10));
    let again = c.preview_claim(acc("shop.testnet"), "A123".into(), b64(&vec["honest"], "response_b64"));
    assert_eq!(again.error.as_deref(), Some("ERR_ALREADY_CLAIMED"));
}

#[test]
fn injection_is_clipped_to_max_bps() {
    let mut c = setup();
    let vec = v();
    let p = claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A124", &s(&vec["injection"], "response_b64"), true);
    assert!(p.ok);
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
    let p = c.preview_claim(acc("shop.testnet"), "A123".into(), Base64VecU8(bytes));
    assert_eq!(p.error.as_deref(), Some("ERR_NO_RECEIPT_FOR_BYTES"));
}

#[test]
fn receipt_for_other_order_rejected() {
    let c = setup();
    let p = c.preview_claim(acc("shop.testnet"), "A124".into(), b64(&v()["honest"], "response_b64"));
    assert_eq!(p.error.as_deref(), Some("ERR_RECEIPT_ORDER_MISMATCH"));
}

#[test]
#[should_panic(expected = "ERR_BAD_SIGNATURE")]
fn edited_signed_text_fails_signature() {
    let vec = v();
    ctx("owner.testnet", 1);
    let mut c = Contract::new(acc("owner.testnet"), None, Some(U64(1000)));
    let x = &vec["honest"];
    c.add_signer(s(x, "signer_public_key_hex"), "provider_tee".into(), Some("z-ai/glm-5.3-flash".into()), "00".repeat(32), U64(NOW_MS + 1000));
    merchant(&mut c, "shop.testnet", 3 * NEAR, NEAR);
    register_order(&mut c, "shop.testnet", "A123", "alice.testnet", 2 * NEAR, 3000, None, None);
    // merchant swaps in the hash of an edited reply: the TEE never signed this text
    let edited = s(x, "signed_text").replace(&s(x, "response_hash"), &"ab".repeat(32));
    ctx("shop.testnet", 0);
    c.register_receipt("A123".into(), edited, s(x, "signature_hex"), s(x, "signer_public_key_hex"));
}

#[test]
#[should_panic(expected = "ERR_NO_ORDER")]
fn shopper_cannot_register_receipt() {
    // v2: a shopper has no order under its own name, so the per-merchant lookup answers ERR_NO_ORDER.
    // (v1 answered ERR_NOT_ORDER_MERCHANT; that string is no longer reachable, docs/STABLECOIN.md 13.5.)
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
    c.claim(acc("shop.testnet"), "A123".into(), b64(&v()["honest"], "response_b64"));
}

#[test]
#[should_panic(expected = "ERR_WITHDRAW_EXCEEDS_FREE_BOND")]
fn reserved_bond_cannot_be_withdrawn() {
    let mut c = setup();
    ctx("shop.testnet", 1);
    let _ = c.withdraw_bond(U128(2 * NEAR), None); // free = 3 - 1.2 = 1.8 NEAR
}

#[test]
#[should_panic(expected = "ERR_SIGNER_EXPIRED")]
fn expired_signer_rejected() {
    let vec = v();
    let mut c = setup();
    ctx("shop.testnet", 0);
    ctx_at("shop.testnet", 1, NOW_MS + DAY_MS + 1);
    c.register_order("A125".into(), acc("alice.testnet"), U128(NEAR), 1000, None, None);
    let x = &vec["honest"];
    c.register_receipt("A125".into(), s(x, "signed_text"), s(x, "signature_hex"), s(x, "signer_public_key_hex"));
}

/// Contract with the REAL S1 vector registered as signer, plus one 2 NEAR order with a 30% cap for it.
fn live_setup() -> (Contract, Value) {
    let x: Value = near_sdk::serde_json::from_str(LIVE).unwrap();
    ctx("owner.testnet", 1);
    let mut c = Contract::new(acc("owner.testnet"), None, Some(U64(1000)));
    c.add_signer(s(&x, "signer_public_key_hex"), "provider_tee".into(), Some(s(&x, "model")), "00".repeat(32), U64(NOW_MS + 1000));
    merchant(&mut c, "shop.testnet", 3 * NEAR, NEAR);
    register_order(&mut c, "shop.testnet", &s(&x, "order_id"), "alice.testnet", 2 * NEAR, 3000, None, None);
    (c, x)
}
fn register_live_receipt(c: &mut Contract, x: &Value) -> Receipt {
    register_receipt(c, "shop.testnet", &s(x, "order_id"), x)
}

#[test]
fn real_near_ai_ed25519_receipt_registers() {
    let (mut c, x) = live_setup();
    let r = register_live_receipt(&mut c, &x);
    assert_eq!(r.signature_kind, "provider_tee");
    // the stored key is the hash of the exact bytes the shopper will claim with
    assert_eq!(r.response_hash, hex::encode(env::sha256_array(&b64(&x, "response_b64").0)));
    let p = c.preview_claim(acc("shop.testnet"), s(&x, "order_id"), b64(&x, "response_b64"));
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
    let p = c.preview_claim(acc("shop.testnet"), s(&x, "order_id"), Base64VecU8(bytes));
    assert_eq!(p.error.as_deref(), Some("ERR_NO_RECEIPT_FOR_BYTES"));
}

#[test]
#[should_panic(expected = "ERR_BAD_SIGNATURE")]
fn real_near_ai_receipt_with_edited_hash_fails() {
    let (mut c, x) = live_setup();
    let mut text = s(&x, "signed_text");
    let last = text.pop().unwrap();
    text.push(if last == '0' { '1' } else { '0' }); // still valid hex, different hash
    ctx("shop.testnet", 0);
    c.register_receipt(s(&x, "order_id"), text, s(&x, "signature_hex"), s(&x, "signer_public_key_hex"));
}

// ======================= B. init and allow-list =======================

#[test]
fn init_without_tokens_still_runs_the_near_flow() {
    ctx("owner.testnet", 0);
    let mut c = Contract::new(acc("owner.testnet"), None, None);
    let cfg = c.get_config();
    assert_eq!(cfg.api, 2);
    assert!(cfg.allowed_tokens.is_empty());
    assert_eq!(cfg.min_order_ttl_ms, U64(DEFAULT_MIN_ORDER_TTL_MS));
    merchant(&mut c, "shop.testnet", 3 * NEAR, NEAR);
    register_order(&mut c, "shop.testnet", "N1", "alice.testnet", NEAR, 1000, None, None);
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().reserved, U128(NEAR / 10));
}

#[test]
fn init_stores_the_allowed_token_list() {
    let c = new_contract(vec![TUSDC]);
    assert_eq!(c.get_config().allowed_tokens, vec![acc(TUSDC)]);
}

#[test]
#[should_panic(expected = "ERR_TOKEN_LIST")]
fn duplicate_token_rejected() {
    new_contract(vec![TUSDC, TUSDC]);
}

#[test]
#[should_panic(expected = "ERR_TOKEN_LIST")]
fn more_than_eight_tokens_rejected() {
    new_contract(vec!["t0.testnet", "t1.testnet", "t2.testnet", "t3.testnet", "t4.testnet", "t5.testnet", "t6.testnet", "t7.testnet", "t8.testnet"]);
}

#[test]
#[should_panic(expected = "ERR_TTL")]
fn zero_min_ttl_rejected() {
    ctx("owner.testnet", 0);
    Contract::new(acc("owner.testnet"), None, Some(U64(0)));
}

#[test]
#[should_panic(expected = "ERR_TTL")]
fn min_ttl_above_max_rejected() {
    ctx("owner.testnet", 0);
    Contract::new(acc("owner.testnet"), None, Some(U64(MAX_ORDER_TTL_MS + 1)));
}

#[test]
fn get_config_reports_api_2_and_the_defaults() {
    let c = new_contract(vec![TUSDC]);
    let cfg = c.get_config();
    assert_eq!(cfg.api, 2);
    assert_eq!(cfg.owner, acc("owner.testnet"));
    assert_eq!(cfg.max_order_ttl_ms, U64(MAX_ORDER_TTL_MS));
    assert_eq!(cfg.default_order_ttl_ms, U64(DEFAULT_ORDER_TTL_MS));
}

// ======================= C. ft_on_transfer =======================

fn token_deposit_setup() -> Contract {
    let mut c = new_contract(vec![TUSDC, TUSDT]);
    merchant(&mut c, "shop.testnet", 3 * NEAR, NEAR);
    c
}

#[test]
fn ft_deposit_creates_the_bond_and_emits_token_event() {
    let mut c = token_deposit_setup();
    ctx(TUSDC, 0);
    assert_eq!(unused(c.ft_on_transfer(acc("shop.testnet"), U128(5_000_000), "{\"add_bond\":{}}".into())), 0);
    let b = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    assert_eq!(b.token, Some(acc(TUSDC)));
    assert_eq!(b.bond, U128(5_000_000));
    assert_eq!(b.reserved, U128(0));
    assert_eq!(b.paid_out, U128(0));
    let e = events();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["event"], "bond_added");
    assert_eq!(e[0]["data"][0]["token"], TUSDC);
    assert_eq!(e[0]["data"][0]["amount"], "5000000");
}

#[test]
fn second_deposit_adds_and_keeps_reserved_and_paid_out() {
    let mut c = token_deposit_setup();
    token_bond(&mut c, "shop.testnet", TUSDC, 5_000_000);
    register_order(&mut c, "shop.testnet", "C2", "alice.testnet", 10_000_000, 3000, Some(TUSDC), None);
    token_bond(&mut c, "shop.testnet", TUSDC, 7_000_000);
    let b = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    assert_eq!(b.bond, U128(12_000_000));
    assert_eq!(b.reserved, U128(3_000_000));
    assert_eq!(b.paid_out, U128(0));
}

#[test]
fn wrong_token_is_refunded_and_changes_nothing() {
    let mut c = token_deposit_setup();
    ctx("evil.testnet", 0);
    let before = env::storage_usage();
    assert_eq!(unused(c.ft_on_transfer(acc("shop.testnet"), U128(1000), "{\"add_bond\":{}}".into())), 1000);
    assert_eq!(env::storage_usage(), before);
    assert!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).is_none());
    assert_eq!(c.get_bonds(acc("shop.testnet")).len(), 1, "the NEAR bond is untouched");
    assert!(events().is_empty());
}

#[test]
fn a_user_calling_ft_on_transfer_directly_gets_nothing_credited() {
    let mut c = token_deposit_setup();
    ctx("mallory.testnet", 0);
    assert_eq!(unused(c.ft_on_transfer(acc("victim.testnet"), U128(1000), "{\"add_bond\":{}}".into())), 1000);
    assert!(c.get_bonds(acc("victim.testnet")).is_empty());
    assert!(c.get_bonds(acc("mallory.testnet")).is_empty());
}

#[test]
fn bad_messages_are_refunded_in_full() {
    let mut c = token_deposit_setup();
    let long = format!("{{\"add_bond\":{{}},\"x\":\"{}\"}}", "a".repeat(300));
    for msg in ["", "not json", "{}", "{\"pay_invoice\":{}}", "{\"add_bond\":1}", "{\"add_bond\":{},\"x\":1}", &long] {
        ctx(TUSDC, 0);
        let before = env::storage_usage();
        assert_eq!(unused(c.ft_on_transfer(acc("shop.testnet"), U128(1000), msg.into())), 1000, "{}", msg);
        assert_eq!(env::storage_usage(), before, "{}", msg);
        assert!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).is_none(), "{}", msg);
        assert!(events().is_empty(), "{}", msg);
    }
}

#[test]
fn the_msg_cannot_choose_the_beneficiary_or_the_amount() {
    let mut c = token_deposit_setup();
    for msg in ["{\"add_bond\":{\"sender_id\":\"victim.testnet\",\"amount\":\"999\"}}", "{\"add_bond\":{\"merchant\":\"victim.testnet\"}}"] {
        ctx(TUSDC, 0);
        assert_eq!(unused(c.ft_on_transfer(acc("shop.testnet"), U128(1000), msg.into())), 1000, "{}", msg);
        assert!(c.get_bonds(acc("victim.testnet")).is_empty());
        assert!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).is_none());
    }
    // The arguments are the only source: sender_id is credited, the amount argument is used.
    ctx(TUSDC, 0);
    assert_eq!(unused(c.ft_on_transfer(acc("shop.testnet"), U128(777), "{\"add_bond\":{}}".into())), 0);
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(777));
}

#[test]
fn zero_amount_is_a_no_op() {
    let mut c = token_deposit_setup();
    ctx(TUSDC, 0);
    let before = env::storage_usage();
    assert_eq!(unused(c.ft_on_transfer(acc("shop.testnet"), U128(0), "{\"add_bond\":{}}".into())), 0);
    assert_eq!(env::storage_usage(), before);
    assert!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).is_none());
    assert_eq!(get_logs(), vec!["REFUND:ZERO_AMOUNT".to_string()]);
}

#[test]
fn first_token_bond_without_storage_balance_is_refunded_and_undone() {
    let mut c = new_contract(vec![TUSDC]);
    // no storage_deposit for carol
    ctx(TUSDC, 0);
    let before = env::storage_usage();
    assert_eq!(unused(c.ft_on_transfer(acc("carol.testnet"), U128(1000), "{\"add_bond\":{}}".into())), 1000);
    assert_eq!(env::storage_usage(), before, "the first insert must be undone");
    assert!(c.get_bond(acc("carol.testnet"), Some(acc(TUSDC))).is_none());
    assert_eq!(get_logs(), vec!["REFUND:NO_STORAGE".to_string()]);
}

#[test]
fn overflow_is_refunded_and_the_bond_stays() {
    let mut c = token_deposit_setup();
    token_bond(&mut c, "shop.testnet", TUSDC, u128::MAX - 10);
    ctx(TUSDC, 0);
    assert_eq!(unused(c.ft_on_transfer(acc("shop.testnet"), U128(100), "{\"add_bond\":{}}".into())), 100);
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(u128::MAX - 10));
    assert_eq!(get_logs(), vec!["REFUND:OVERFLOW".to_string()]);
}

#[test]
fn two_allowed_tokens_keep_separate_bonds() {
    let mut c = token_deposit_setup();
    token_bond(&mut c, "shop.testnet", TUSDC, 5_000_000);
    token_bond(&mut c, "shop.testnet", TUSDT, 9_000_000);
    token_bond(&mut c, "shop.testnet", TUSDC, 1_000_000);
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(6_000_000));
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDT))).unwrap().bond, U128(9_000_000));
    // the NEAR bond is untouched by token deposits
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().bond, U128(3 * NEAR));
}

#[test]
fn get_bonds_lists_near_then_existing_tokens_only() {
    let mut c = token_deposit_setup();
    assert_eq!(c.get_bonds(acc("shop.testnet")).len(), 1); // NEAR only
    token_bond(&mut c, "shop.testnet", TUSDT, 1000);
    let bonds = c.get_bonds(acc("shop.testnet"));
    assert_eq!(bonds.len(), 2);
    assert_eq!(bonds[0].token, None);
    assert_eq!(bonds[1].token, Some(acc(TUSDT)));
    assert!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).is_none());
}

// ======================= D. orders with tokens =======================

fn token_merchant() -> Contract {
    let mut c = token_deposit_setup();
    add_honest_signer(&mut c);
    token_bond(&mut c, "shop.testnet", TUSDC, 20_000_000);
    c
}

#[test]
#[should_panic(expected = "ERR_TOKEN_NOT_ALLOWED")]
fn unlisted_token_order_rejected() {
    let mut c = token_merchant();
    register_order(&mut c, "shop.testnet", "D1", "alice.testnet", 1000, 1000, Some("other.testnet"), None);
}

#[test]
#[should_panic(expected = "ERR_NOT_MERCHANT")]
fn order_without_a_bond_for_that_token_rejected() {
    let mut c = token_merchant();
    register_order(&mut c, "shop.testnet", "D2", "alice.testnet", 1000, 1000, Some(TUSDT), None);
}

#[test]
fn a_token_order_reserves_only_in_the_token_bond() {
    let mut c = token_merchant();
    register_order(&mut c, "shop.testnet", "D3", "alice.testnet", 10_000_000, 3000, Some(TUSDC), None);
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().reserved, U128(3_000_000));
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().reserved, U128(0));
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_FREE_BOND")]
fn free_bond_is_judged_against_the_token_bond() {
    let mut c = token_merchant();
    // the NEAR bond (3 NEAR) could cover it, the 20 tUSDC bond cannot
    register_order(&mut c, "shop.testnet", "D4", "alice.testnet", 30_000_000, 10_000, Some(TUSDC), None);
}

#[test]
fn order_and_receipt_store_the_token_and_amount() {
    let mut c = token_merchant();
    let o = register_order(&mut c, "shop.testnet", "D5", "alice.testnet", 20_000_000, 3000, Some(TUSDC), None);
    assert_eq!(o.token, Some(acc(TUSDC)));
    assert_eq!(o.amount, U128(20_000_000));
    let e = events();
    assert_eq!(e[0]["event"], "order_registered");
    assert_eq!(e[0]["data"][0]["token"], TUSDC);
    assert_eq!(e[0]["data"][0]["amount"], "20000000");
    let r = register_receipt(&mut c, "shop.testnet", "D5", &v()["honest"]);
    assert_eq!(r.token, Some(acc(TUSDC)));
    assert_eq!(r.order_amount, U128(20_000_000));
    let e = events();
    assert_eq!(e[0]["event"], "receipt_registered");
    assert_eq!(e[0]["data"][0]["token"], TUSDC);
    assert_eq!(e[0]["data"][0]["order_amount"], "20000000");
}

#[test]
fn near_and_token_orders_keep_separate_reserved_amounts() {
    let mut c = token_merchant();
    register_order(&mut c, "shop.testnet", "D6N", "alice.testnet", 2 * NEAR, 3000, None, None);
    register_order(&mut c, "shop.testnet", "D6T", "alice.testnet", 10_000_000, 3000, Some(TUSDC), None);
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().reserved, U128(6 * NEAR / 10));
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().reserved, U128(3_000_000));
}

#[test]
#[should_panic(expected = "ERR_LIABILITY_ZERO")]
fn liability_zero_rejected() {
    let mut c = token_merchant();
    register_order(&mut c, "shop.testnet", "D7", "alice.testnet", 1, 1, Some(TUSDC), None);
}

#[test]
#[should_panic(expected = "ERR_AMOUNT")]
fn amount_times_bps_overflow_rejected() {
    let mut c = token_merchant();
    register_order(&mut c, "shop.testnet", "D8", "alice.testnet", u128::MAX, 10_000, Some(TUSDC), None);
}

#[test]
fn v1_register_order_call_still_works_with_the_default_ttl() {
    let mut c = setup();
    let o = register_order(&mut c, "shop.testnet", "D9", "alice.testnet", 2 * NEAR, 1000, None, None);
    assert_eq!(o.token, None);
    assert_eq!(o.expires_at_ms, U64(NOW_MS + DEFAULT_ORDER_TTL_MS));
    assert_eq!(o.status, "open");
}

#[test]
fn register_receipt_refuses_order_that_is_not_open_or_is_expired() {
    let mut c = token_merchant();
    let x = v();
    register_order(&mut c, "shop.testnet", "A123", "alice.testnet", 20_000_000, 3000, Some(TUSDC), None);
    register_receipt(&mut c, "shop.testnet", "A123", &x["honest"]);
    // paying
    ctx("alice.testnet", 0);
    let p = c.claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    drop(p);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("shop.testnet", 0);
        c.register_receipt("A123".into(), s(&x["honest"], "signed_text"), s(&x["honest"], "signature_hex"), s(&x["honest"], "signer_public_key_hex"))
    })).is_err());
    // claimed
    ctx_result(PromiseResult::Successful(vec![]));
    c.on_claim_paid(acc("shop.testnet"), "A123".into(), U128(4_000_000), 2000, 2000, s(&x["honest"], "response_hash"));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("shop.testnet", 0);
        c.register_receipt("A123".into(), s(&x["honest"], "signed_text"), s(&x["honest"], "signature_hex"), s(&x["honest"], "signer_public_key_hex"))
    })).is_err());
    // past expires_at_ms while still open
    let o = register_order(&mut c, "shop.testnet", "D10X", "alice.testnet", 20_000_000, 3000, Some(TUSDC), Some(1000));
    ctx_at("shop.testnet", 0, o.expires_at_ms.0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.register_receipt("D10X".into(), s(&x["honest"], "signed_text"), s(&x["honest"], "signature_hex"), s(&x["honest"], "signer_public_key_hex"))
    })).is_err());
}

// ======================= E. storage accounting =======================

#[test]
fn storage_deposit_credits_deposit_minus_its_own_record() {
    let mut c = new_contract(vec![]);
    ctx("shop.testnet", NEAR);
    let before = env::storage_usage();
    let view = c.storage_deposit(None);
    let cost = (env::storage_usage() - before) as u128 * byte_cost();
    assert_eq!(view.total, U128(NEAR - cost));
    assert_eq!(view.available, U128(NEAR - cost));
    assert_eq!(c.storage_balance_of(acc("shop.testnet")), Some(StorageBalanceView { total: U128(NEAR - cost), available: U128(NEAR - cost) }));
    assert_eq!(c.storage_balance_of(acc("nobody.testnet")), None);
}

#[test]
fn a_third_party_can_fund_an_account() {
    let mut c = new_contract(vec![]);
    ctx("alice.testnet", NEAR);
    let before = env::storage_usage();
    let v1 = c.storage_deposit(Some(acc("shop.testnet")));
    let cost = (env::storage_usage() - before) as u128 * byte_cost();
    assert_eq!(v1.total, U128(NEAR - cost));
    let before = v1.total.0;
    ctx("mallory.testnet", NEAR / 10);
    let v2 = c.storage_deposit(Some(acc("shop.testnet")));
    assert_eq!(v2.total, U128(before + NEAR / 10));
    assert_eq!(v2.available, U128(before + NEAR / 10));
    assert_eq!(c.storage_balance_of(acc("mallory.testnet")), None);
}

#[test]
fn register_order_charges_exactly_the_measured_bytes() {
    let mut c = token_merchant();
    let avail_before = c.storage_balance_of(acc("shop.testnet")).unwrap().available.0;
    ctx("shop.testnet", 1);
    let before = env::storage_usage();
    c.register_order("E3".into(), acc("alice.testnet"), U128(1000), 1000, Some(acc(TUSDC)), None);
    let cost = (env::storage_usage() - before) as u128 * byte_cost();
    assert!(cost > 0);
    let avail_after = c.storage_balance_of(acc("shop.testnet")).unwrap().available.0;
    assert_eq!(avail_before - avail_after, cost);
}

#[test]
fn register_receipt_charges_the_merchant() {
    let mut c = token_merchant();
    register_order(&mut c, "shop.testnet", "E4", "alice.testnet", 20_000_000, 3000, Some(TUSDC), None);
    let avail_before = c.storage_balance_of(acc("shop.testnet")).unwrap().available.0;
    ctx("shop.testnet", 0);
    let before = env::storage_usage();
    let x = v();
    c.register_receipt("E4".into(), s(&x["honest"], "signed_text"), s(&x["honest"], "signature_hex"), s(&x["honest"], "signer_public_key_hex"));
    let cost = (env::storage_usage() - before) as u128 * byte_cost();
    assert!(cost > 0);
    assert_eq!(avail_before - c.storage_balance_of(acc("shop.testnet")).unwrap().available.0, cost);
}

#[test]
fn short_balance_panics_and_leaves_no_order() {
    let mut c = new_contract(vec![]);
    ctx("shop.testnet", 3 * NEAR);
    c.register_merchant(); // bond only: no storage balance at all
    ctx("shop.testnet", 1);
    let before = env::storage_usage();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.register_order("E5".into(), acc("alice.testnet"), U128(NEAR), 1000, None, None);
    }));
    assert!(r.is_err());
    assert_eq!(env::storage_usage(), before, "the order record must be removed again");
    assert!(c.get_order(acc("shop.testnet"), "E5".into()).is_none());
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().reserved, U128(0));
}

#[test]
fn short_balance_panics_on_receipt_too() {
    let mut c = token_merchant();
    register_order(&mut c, "shop.testnet", "E5R", "alice.testnet", 20_000_000, 3000, Some(TUSDC), None);
    // spend the balance down to almost nothing by withdrawing the free part
    let avail = c.storage_balance_of(acc("shop.testnet")).unwrap().available.0;
    ctx("shop.testnet", 1);
    c.storage_withdraw(Some(U128(avail - 1)));
    ctx("shop.testnet", 0);
    let before = env::storage_usage();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let x = v();
        c.register_receipt("E5R".into(), s(&x["honest"], "signed_text"), s(&x["honest"], "signature_hex"), s(&x["honest"], "signer_public_key_hex"));
    }));
    assert!(r.is_err());
    assert_eq!(env::storage_usage(), before);
    assert!(c.get_receipt(acc("shop.testnet"), s(&v()["honest"], "response_hash")).is_none());
    assert_eq!(c.get_order(acc("shop.testnet"), "E5R".into()).unwrap().receipt_count, 0);
}

#[test]
fn storage_withdraw_takes_only_the_available_part() {
    let mut c = token_merchant();
    let view = c.storage_balance_of(acc("shop.testnet")).unwrap();
    let used = view.total.0 - view.available.0;
    // above available: panic; exactly available: works, the used part stays
    let available = view.available.0;
    ctx("shop.testnet", 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.storage_withdraw(Some(U128(available + 1))))).is_err());
    let after = c.storage_withdraw(Some(U128(available)));
    assert_eq!(after.total, U128(used));
    assert_eq!(after.available, U128(0));
    assert_eq!(c.storage_balance_of(acc("shop.testnet")).unwrap().total, U128(used));
}

#[test]
#[should_panic(expected = "ERR_BOND_TOO_SMALL")]
fn register_merchant_needs_more_than_one_near_because_of_the_record() {
    let mut c = new_contract(vec![]);
    ctx("shop.testnet", NEAR);
    c.register_merchant();
}

#[test]
fn register_merchant_keeps_the_record_cost_out_of_the_bond() {
    let mut c = new_contract(vec![]);
    ctx("shop.testnet", 3 * NEAR);
    let before = env::storage_usage();
    let b = c.register_merchant();
    let cost = (env::storage_usage() - before) as u128 * byte_cost();
    assert_eq!(b.bond, U128(3 * NEAR - cost));
}

#[test]
fn spam_loop_stops_when_the_storage_balance_runs_out() {
    let mut c = token_merchant();
    // measure one order's charge, then fund exactly five more
    ctx("shop.testnet", 1);
    let before = env::storage_usage();
    c.register_order("S0".into(), acc("alice.testnet"), U128(1000), 1000, Some(acc(TUSDC)), None);
    let unit = (env::storage_usage() - before) as u128 * byte_cost();
    let leftover = c.storage_balance_of(acc("shop.testnet")).unwrap().available.0;
    ctx("shop.testnet", 1);
    c.storage_withdraw(Some(U128(leftover)));
    ctx("shop.testnet", 5 * unit);
    c.storage_deposit(None);
    let free = c.storage_balance_of(acc("shop.testnet")).unwrap().available.0;
    assert_eq!(free, 5 * unit);
    let mut decreased = 0u128;
    let mut growth = 0u128;
    ctx("shop.testnet", 1);
    for i in 1..=5 {
        let avail = c.storage_balance_of(acc("shop.testnet")).unwrap().available.0;
        let usage = env::storage_usage();
        c.register_order(format!("S{}", i), acc("alice.testnet"), U128(1000), 1000, Some(acc(TUSDC)), None);
        decreased += avail - c.storage_balance_of(acc("shop.testnet")).unwrap().available.0;
        growth += (env::storage_usage() - usage) as u128 * byte_cost();
    }
    assert_eq!(decreased, growth);
    assert_eq!(c.storage_balance_of(acc("shop.testnet")).unwrap().available.0, free - decreased);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_order(&mut c, "shop.testnet", "S6", "alice.testnet", 1000, 1000, Some(TUSDC), None);
    }));
    assert!(r.is_err(), "the sixth order must not fit");
    assert!(c.get_order(acc("shop.testnet"), "S6".into()).is_none());
    // the NEAR bond and the token bond are untouched by the spam (only the storage balance paid)
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().bond, U128(3 * NEAR));
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(20_000_000));
}

#[test]
fn first_token_bond_is_charged_to_the_sender_only() {
    let mut c = new_contract(vec![TUSDC]);
    for name in ["shop.testnet", "other.testnet"] {
        ctx(name, NEAR);
        c.storage_deposit(None);
    }
    let shop_before = c.storage_balance_of(acc("shop.testnet")).unwrap().available.0;
    let other_before = c.storage_balance_of(acc("other.testnet")).unwrap().available.0;
    ctx(TUSDC, 0);
    let usage = env::storage_usage();
    c.ft_on_transfer(acc("shop.testnet"), U128(1000), "{\"add_bond\":{}}".into());
    let cost = (env::storage_usage() - usage) as u128 * byte_cost();
    assert_eq!(shop_before - c.storage_balance_of(acc("shop.testnet")).unwrap().available.0, cost);
    assert_eq!(c.storage_balance_of(acc("other.testnet")).unwrap().available.0, other_before);
}

// ======================= F. order-id namespace =======================

#[test]
fn two_merchants_can_use_the_same_order_id() {
    let mut c = token_merchant();
    merchant(&mut c, "second.testnet", 3 * NEAR, NEAR);
    register_order(&mut c, "shop.testnet", "F1", "alice.testnet", NEAR, 1000, None, None);
    register_order(&mut c, "second.testnet", "F1", "bob.testnet", 2 * NEAR, 1000, None, None);
    assert_eq!(c.get_order(acc("shop.testnet"), "F1".into()).unwrap().buyer, acc("alice.testnet"));
    assert_eq!(c.get_order(acc("second.testnet"), "F1".into()).unwrap().buyer, acc("bob.testnet"));
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().reserved, U128(NEAR / 10));
    assert_eq!(c.get_merchant(acc("second.testnet")).unwrap().reserved, U128(2 * NEAR / 10));
}

#[test]
fn an_id_taken_by_another_merchant_does_not_block() {
    let mut c = token_merchant();
    merchant(&mut c, "second.testnet", 3 * NEAR, NEAR);
    register_order(&mut c, "shop.testnet", "F2", "alice.testnet", NEAR, 1000, None, None);
    register_order(&mut c, "second.testnet", "F2", "bob.testnet", NEAR, 1000, None, None);
}

#[test]
#[should_panic(expected = "ERR_ORDER_EXISTS")]
fn the_same_merchant_cannot_reuse_an_id() {
    let mut c = token_merchant();
    register_order(&mut c, "shop.testnet", "F3", "alice.testnet", NEAR, 1000, None, None);
    register_order(&mut c, "shop.testnet", "F3", "alice.testnet", NEAR, 1000, None, None);
}

#[test]
fn a_receipt_cannot_satisfy_another_merchants_order() {
    let mut c = token_merchant();
    merchant(&mut c, "second.testnet", 3 * NEAR, NEAR);
    let x = v();
    register_order(&mut c, "shop.testnet", "A123", "alice.testnet", 2 * NEAR, 3000, None, None);
    register_order(&mut c, "second.testnet", "A123", "bob.testnet", 2 * NEAR, 3000, None, None);
    register_receipt(&mut c, "shop.testnet", "A123", &x["honest"]);
    let p = c.preview_claim(acc("second.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    assert_eq!(p.error.as_deref(), Some("ERR_NO_RECEIPT_FOR_BYTES"));
    // the second merchant can register the same signed text in its own namespace
    let r = register_receipt(&mut c, "second.testnet", "A123", &x["honest"]);
    assert_eq!(r.merchant, acc("second.testnet"));
    let p = c.preview_claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    assert!(p.ok);
}

#[test]
#[should_panic(expected = "ERR_NO_ORDER")]
fn claim_with_the_wrong_merchant_is_no_order() {
    let mut c = token_merchant();
    merchant(&mut c, "second.testnet", 3 * NEAR, NEAR);
    register_order(&mut c, "shop.testnet", "F5", "alice.testnet", 2 * NEAR, 3000, None, None);
    ctx("alice.testnet", 0);
    c.claim(acc("second.testnet"), "F5".into(), b64(&v()["honest"], "response_b64"));
}

#[test]
#[should_panic(expected = "ERR_NO_ORDER")]
fn a_non_merchant_cannot_register_a_receipt() {
    let mut c = token_merchant();
    let x = v();
    ctx("mallory.testnet", 0);
    c.register_receipt("F6".into(), s(&x["honest"], "signed_text"), s(&x["honest"], "signature_hex"), s(&x["honest"], "signer_public_key_hex"));
}

// ======================= G. expiry =======================

#[test]
fn ttl_defaults_and_bounds() {
    let mut c = setup();
    let o = register_order(&mut c, "shop.testnet", "G1", "alice.testnet", NEAR, 1000, None, None);
    assert_eq!(o.expires_at_ms, U64(NOW_MS + DEFAULT_ORDER_TTL_MS));
    let o = register_order(&mut c, "shop.testnet", "G2", "alice.testnet", NEAR, 1000, None, Some(DAY_MS));
    assert_eq!(o.expires_at_ms, U64(NOW_MS + DAY_MS));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_order(&mut c, "shop.testnet", "G3", "alice.testnet", NEAR, 1000, None, Some(999));
    }));
    assert!(r.is_err());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_order(&mut c, "shop.testnet", "G4", "alice.testnet", NEAR, 1000, None, Some(MAX_ORDER_TTL_MS + 1));
    }));
    assert!(r.is_err());
}

#[test]
fn claim_and_register_receipt_stop_at_the_expiry_boundary() {
    let mut c = setup();
    let vec = v();
    let o = register_order(&mut c, "shop.testnet", "G2A", "alice.testnet", 2 * NEAR, 3000, None, Some(1000));
    ctx_at("alice.testnet", 0, o.expires_at_ms.0);
    // preview and claim at exactly expires_at_ms
    let p = c.preview_claim(acc("shop.testnet"), "G2A".into(), b64(&vec["honest"], "response_b64"));
    assert_eq!(p.error.as_deref(), Some("ERR_ORDER_EXPIRED"));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.claim(acc("shop.testnet"), "G2A".into(), b64(&vec["honest"], "response_b64"));
    }));
    assert!(r.is_err());
    // register_receipt after expiry (same clock, no helper that resets it)
    ctx_at("shop.testnet", 0, o.expires_at_ms.0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.register_receipt("G2A".into(), s(&vec["honest"], "signed_text"), s(&vec["honest"], "signature_hex"), s(&vec["honest"], "signer_public_key_hex"));
    }));
    assert!(r.is_err());
    // just before the boundary a fresh order is fine
    let o2 = register_order(&mut c, "shop.testnet", "G2B", "alice.testnet", 2 * NEAR, 3000, None, Some(1000));
    ctx_at("alice.testnet", 0, o2.expires_at_ms.0 - 1);
    let p = c.preview_claim(acc("shop.testnet"), "G2B".into(), b64(&vec["honest"], "response_b64"));
    // before the boundary the order is not expired: the receipt lookup runs and finds A123's receipt for another order
    assert_eq!(p.error.as_deref(), Some("ERR_RECEIPT_ORDER_MISMATCH"));
}

#[test]
#[should_panic(expected = "ERR_ORDER_NOT_EXPIRED")]
fn release_before_expiry_rejected() {
    let mut c = setup();
    register_order(&mut c, "shop.testnet", "G3", "alice.testnet", 2 * NEAR, 3000, None, Some(1000));
    ctx("bob.testnet", 0);
    c.release_expired(acc("shop.testnet"), "G3".into());
}

#[test]
fn a_third_account_can_release_an_expired_reservation() {
    let mut c = setup();
    let o = register_order(&mut c, "shop.testnet", "G4", "alice.testnet", 2 * NEAR, 3000, None, Some(1000));
    let reserved_before = c.get_merchant(acc("shop.testnet")).unwrap().reserved.0;
    ctx_at("bob.testnet", 0, o.expires_at_ms.0);
    let rel = c.release_expired(acc("shop.testnet"), "G4".into());
    assert_eq!(rel.status, "expired");
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().reserved, U128(reserved_before - o.liability.0));
    let e = events();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["event"], "order_expired");
    assert_eq!(e[0]["data"][0]["released"], o.liability.0.to_string());
    assert_eq!(e[0]["data"][0]["token"], Value::Null);
    // the released amount is free again
    ctx("shop.testnet", 1);
    let free = c.get_merchant(acc("shop.testnet")).unwrap();
    let _ = c.withdraw_bond(U128(free.bond.0 - free.reserved.0), None);
}

#[test]
fn release_checks_status_and_never_double_releases() {
    let mut c = setup();
    let vec = v();
    let a123 = c.get_order(acc("shop.testnet"), "A123".into()).unwrap();
    claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &s(&vec["honest"], "response_b64"), true);
    ctx_at("bob.testnet", 0, a123.expires_at_ms.0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.release_expired(acc("shop.testnet"), "A123".into());
    }));
    assert!(r.is_err(), "a claimed order cannot be released");
    // a released order cannot be released again
    let o2 = register_order(&mut c, "shop.testnet", "G5B", "alice.testnet", 2 * NEAR, 3000, None, Some(1000));
    ctx_at("bob.testnet", 0, o2.expires_at_ms.0);
    c.release_expired(acc("shop.testnet"), "G5B".into());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.release_expired(acc("shop.testnet"), "G5B".into());
    }));
    assert!(r.is_err());
    // A123 was claimed (its reservation is gone), A124 is still reserved
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().reserved, U128(6 * NEAR / 10));
}

#[test]
fn paying_order_cannot_be_released() {
    let mut c = setup();
    let vec = v();
    let o = c.get_order(acc("shop.testnet"), "A123".into()).unwrap();
    ctx("alice.testnet", 0);
    let p = c.claim(acc("shop.testnet"), "A123".into(), b64(&vec["honest"], "response_b64"));
    drop(p);
    ctx_at("bob.testnet", 0, o.expires_at_ms.0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.release_expired(acc("shop.testnet"), "A123".into());
    }));
    assert!(r.is_err());
    assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().status, "paying");
}

// ======================= H. claim and payout =======================

fn token_order_setup() -> Contract {
    let mut c = new_contract(vec![TUSDC]);
    add_honest_signer(&mut c);
    merchant(&mut c, "shop.testnet", 3 * NEAR, 2 * NEAR);
    token_bond(&mut c, "shop.testnet", TUSDC, 20_000_000);
    register_order(&mut c, "shop.testnet", "A123", "alice.testnet", 20_000_000, 3000, Some(TUSDC), None);
    register_order(&mut c, "shop.testnet", "A124", "alice.testnet", 20_000_000, 3000, Some(TUSDC), None);
    let x = v();
    register_receipt(&mut c, "shop.testnet", "A123", &x["honest"]);
    register_receipt(&mut c, "shop.testnet", "A124", &x["injection"]);
    c
}

#[test]
fn token_claim_creates_ft_transfer_and_callback() {
    let mut c = token_order_setup();
    let x = v();
    ctx("alice.testnet", 0);
    let p = c.claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    drop(p);
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, acc(TUSDC));
    let (method, args, deposit, gas) = function_call(&receipts[0]);
    assert_eq!(method, "ft_transfer");
    assert_eq!(args, json!({"receiver_id": "alice.testnet", "amount": "4000000"}));
    assert_eq!(deposit, 1);
    assert_eq!(gas, GAS_FT_TRANSFER);
    assert_eq!(receipts[1].receiver_id, acc(CONTRACT));
    assert_eq!(receipts[1].receipt_indices, vec![0]);
    let (method, args, deposit, gas) = function_call(&receipts[1]);
    assert_eq!(method, "on_claim_paid");
    assert_eq!(args["merchant"], "shop.testnet");
    assert_eq!(args["order_id"], "A123");
    assert_eq!(args["payout"], "4000000");
    assert_eq!(deposit, 0);
    assert_eq!(gas, GAS_CALLBACK);
    // state right after the claim
    let o = c.get_order(acc("shop.testnet"), "A123".into()).unwrap();
    assert_eq!(o.status, "paying");
    let b = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    assert_eq!(b.bond, U128(20_000_000));
    assert_eq!(b.reserved, U128(12_000_000), "H1 and H2 reservations stay while H1 pays");
    assert_eq!(b.paid_out, U128(0));
    assert!(!event_names().contains(&"promise_claimed".to_string()));
}

#[test]
fn near_claim_creates_transfer_and_callback() {
    let mut c = setup();
    let x = v();
    ctx("alice.testnet", 0);
    let p = c.claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    drop(p);
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, acc("alice.testnet"));
    assert_eq!(transfer_deposit(&receipts[0]), 4 * NEAR / 10);
    assert_eq!(receipts[1].receiver_id, acc(CONTRACT));
    assert_eq!(function_call(&receipts[1]).0, "on_claim_paid");
}

#[test]
fn successful_callback_moves_the_books_once() {
    let mut c = token_order_setup();
    let x = v();
    let p = claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &s(&x["honest"], "response_b64"), true);
    assert!(p.ok);
    assert_eq!(p.payout, U128(4_000_000));
    assert_eq!(p.token, Some(acc(TUSDC)));
    let o = c.get_order(acc("shop.testnet"), "A123".into()).unwrap();
    assert_eq!(o.status, "claimed");
    assert_eq!(o.paid, U128(4_000_000));
    assert_eq!(o.paid_bps, 2000);
    let b = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    assert_eq!(b.bond, U128(16_000_000));
    assert_eq!(b.reserved, U128(6_000_000), "A124's reservation is still there");
    assert_eq!(b.paid_out, U128(4_000_000));
    let claimed: Vec<_> = events().into_iter().filter(|e| e["event"] == "promise_claimed").collect();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0]["data"][0]["token"], TUSDC);
}

#[test]
fn failed_token_payout_restores_open_and_changes_nothing() {
    let mut c = token_order_setup();
    let x = v();
    let before = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    let p = claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &s(&x["honest"], "response_b64"), false);
    assert!(!p.ok);
    assert_eq!(p.error.as_deref(), Some("ERR_PAYOUT_FAILED"));
    assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().status, "open");
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap(), before);
    assert!(get_logs().iter().all(|l| !l.starts_with("EVENT_JSON:")));
    assert!(get_logs().iter().any(|l| l == "PAYOUT_FAILED:A123"));
}

#[test]
fn failed_near_payout_restores_open() {
    let mut c = setup();
    let x = v();
    let before = c.get_merchant(acc("shop.testnet")).unwrap();
    let p = claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &s(&x["honest"], "response_b64"), false);
    assert_eq!(p.error.as_deref(), Some("ERR_PAYOUT_FAILED"));
    assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().status, "open");
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap(), before);
}

#[test]
fn retry_after_a_failure_pays_once() {
    let mut c = token_order_setup();
    let x = v();
    let first = claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &s(&x["honest"], "response_b64"), false);
    assert_eq!(first.error.as_deref(), Some("ERR_PAYOUT_FAILED"));
    let second = claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &s(&x["honest"], "response_b64"), true);
    assert!(second.ok);
    let b = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    assert_eq!(b.paid_out, U128(4_000_000));
    assert_eq!(b.bond, U128(16_000_000));
}

#[test]
fn double_claim_is_refused_and_creates_no_transfer() {
    let mut c = token_order_setup();
    let x = v();
    claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &s(&x["honest"], "response_b64"), true);
    ctx("alice.testnet", 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    }));
    assert!(r.is_err());
    assert!(get_created_receipts().is_empty());
}

#[test]
fn a_second_claim_while_paying_is_refused() {
    let mut c = token_order_setup();
    let x = v();
    ctx("alice.testnet", 0);
    let p = c.claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    drop(p);
    let p2 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    }));
    assert!(p2.is_err());
    assert_eq!(get_created_receipts().len(), 2, "only the first claim's receipts");
}

#[test]
fn a_replayed_callback_does_nothing() {
    let mut c = token_order_setup();
    let x = v();
    let p = claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &s(&x["honest"], "response_b64"), true);
    let books = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    ctx_result(PromiseResult::Successful(vec![]));
    let again = c.on_claim_paid(acc("shop.testnet"), "A123".into(), U128(4_000_000), 2000, 2000, s(&x["honest"], "response_hash"));
    assert_eq!(again.error.as_deref(), Some("ERR_CALLBACK_STATE"));
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap(), books);
    assert_eq!(p.payout, U128(4_000_000));
}

#[test]
#[should_panic(expected = "ERR_NOT_PRIVATE")]
fn callback_not_called_by_the_contract_panics() {
    let mut c = token_order_setup();
    let x = v();
    ctx("alice.testnet", 0);
    let p = c.claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    drop(p);
    testing_env_with_promise_results(
        build_ctx("alice.testnet", 0, NOW_MS, 300).build(),
        PromiseResult::Successful(vec![]),
    );
    c.on_claim_paid(acc("shop.testnet"), "A123".into(), U128(4_000_000), 2000, 2000, s(&x["honest"], "response_hash"));
}

#[test]
fn claim_below_the_gas_guard_is_refused_before_state() {
    let mut c = token_order_setup();
    let x = v();
    ctx_gas("alice.testnet", 0, 30);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    }));
    assert!(r.is_err());
    assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().status, "open");
    assert!(get_created_receipts().is_empty());
}

#[test]
fn payout_zero_is_refused_and_nothing_moves() {
    let mut c = new_contract(vec![TUSDC]);
    add_honest_signer(&mut c);
    merchant(&mut c, "shop.testnet", 3 * NEAR, 2 * NEAR);
    token_bond(&mut c, "shop.testnet", TUSDC, 1000);
    // 4 raw units at 2000 bps = 0.8 -> 0; liability 4*3000/10000 = 1
    register_order(&mut c, "shop.testnet", "A123", "alice.testnet", 4, 3000, Some(TUSDC), None);
    register_receipt(&mut c, "shop.testnet", "A123", &v()["honest"]);
    let before = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    ctx("alice.testnet", 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.claim(acc("shop.testnet"), "A123".into(), b64(&v()["honest"], "response_b64"));
    }));
    assert!(r.is_err());
    assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().status, "open");
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap(), before);
    assert!(get_created_receipts().is_empty());
}

#[test]
fn payout_maths_uses_six_decimals() {
    let mut c = token_order_setup();
    let x = v();
    let honest = claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &s(&x["honest"], "response_b64"), true);
    assert_eq!((honest.token_bps, honest.paid_bps, honest.payout), (2000, 2000, U128(4_000_000)));
    let injection = claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A124", &s(&x["injection"], "response_b64"), true);
    assert_eq!((injection.token_bps, injection.paid_bps, injection.payout), (10000, 3000, U128(6_000_000)));
    let b = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    assert_eq!(b.paid_out, U128(10_000_000));
}

// ======================= I. withdraw =======================

fn near_withdraw_setup() -> Contract {
    let mut c = setup();
    c
}

#[test]
fn token_withdraw_debits_at_once_and_builds_ft_transfer() {
    let mut c = token_order_setup();
    ctx("shop.testnet", 1);
    let p = c.withdraw_bond(U128(5_000_000), Some(acc(TUSDC)));
    drop(p);
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(15_000_000));
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, acc(TUSDC));
    let (method, args, deposit, gas) = function_call(&receipts[0]);
    assert_eq!(method, "ft_transfer");
    assert_eq!(args["receiver_id"], "shop.testnet");
    assert_eq!(args["amount"], "5000000");
    assert_eq!(deposit, 1);
    assert_eq!(gas, GAS_FT_TRANSFER);
    assert_eq!(function_call(&receipts[1]).0, "on_withdraw_resolved");
}

#[test]
fn withdraw_callback_success_emits_and_failure_restores() {
    let mut c = token_order_setup();
    ctx("shop.testnet", 1);
    let p = c.withdraw_bond(U128(2_000_000), Some(acc(TUSDC)));
    drop(p);
    ctx_result(PromiseResult::Successful(vec![]));
    assert!(c.on_withdraw_resolved(acc("shop.testnet"), Some(acc(TUSDC)), U128(2_000_000)));
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(18_000_000));
    let e = events();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["event"], "bond_withdrawn");
    assert_eq!(e[0]["data"][0]["token"], TUSDC);

    ctx("shop.testnet", 1);
    let p = c.withdraw_bond(U128(2_000_000), Some(acc(TUSDC)));
    drop(p);
    ctx_result(PromiseResult::Failed);
    assert!(!c.on_withdraw_resolved(acc("shop.testnet"), Some(acc(TUSDC)), U128(2_000_000)));
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(18_000_000));
    assert!(events().is_empty());
    assert_eq!(get_logs(), vec!["WITHDRAW_FAILED:tusdc.testnet".to_string()]);
}

#[test]
fn two_quick_withdrawals_cannot_exceed_the_free_bond() {
    let mut c = token_order_setup();
    ctx("shop.testnet", 1);
    let free = 20_000_000u128 - 12_000_000;
    let p = c.withdraw_bond(U128(free - 1), Some(acc(TUSDC)));
    drop(p);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.withdraw_bond(U128(2), Some(acc(TUSDC)));
    }));
    assert!(r.is_err());
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(20_000_000 - (free - 1)));
}

#[test]
fn withdraw_checks_the_reserved_part_and_the_existing_record() {
    let mut c = token_order_setup();
    ctx("shop.testnet", 1);
    let free = 20_000_000u128 - 12_000_000;
    for amount in [free + 1, 0, 20_000_000] {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.withdraw_bond(U128(amount), Some(acc(TUSDC)));
        }));
        assert!(r.is_err(), "amount {}", amount);
    }
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.withdraw_bond(U128(1), Some(acc(TUSDT)));
    }));
    assert!(r.is_err());
    // the v1 call without token still withdraws NEAR
    let p = c.withdraw_bond(U128(NEAR), None);
    drop(p);
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().bond, U128(2 * NEAR));
}

#[test]
fn near_withdraw_restores_on_failure() {
    let mut c = near_withdraw_setup();
    ctx("shop.testnet", 1);
    let before = c.get_merchant(acc("shop.testnet")).unwrap();
    let p = c.withdraw_bond(U128(NEAR), None);
    drop(p);
    assert_eq!(transfer_deposit(&first_receipt()), NEAR);
    ctx_result(PromiseResult::Failed);
    assert!(!c.on_withdraw_resolved(acc("shop.testnet"), None, U128(NEAR)));
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap(), before);
    assert_eq!(get_logs(), vec!["WITHDRAW_FAILED:NEAR".to_string()]);
}

// ======================= J. events and views =======================

#[test]
fn every_event_is_json_with_the_token_field_and_version_1_1_0() {
    let mut c = token_order_setup();
    let x = v();
    register_order(&mut c, "shop.testnet", "J1", "alice.testnet", 2 * NEAR, 3000, None, None);
    claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &s(&x["honest"], "response_b64"), true);
    let logs = get_logs();
    assert!(!logs.is_empty());
    for line in logs.iter().filter(|l| l.starts_with("EVENT_JSON:")) {
        let e: Value = near_sdk::serde_json::from_str(&line["EVENT_JSON:".len()..]).unwrap();
        assert_eq!(e["standard"], "botpromise");
        assert_eq!(e["version"], "1.1.0");
        assert!(e["data"][0].get("token").is_some(), "{}", line);
    }
}

#[test]
fn views_keep_the_v1_shapes_and_add_the_token() {
    let mut c = token_order_setup();
    let x = v();
    assert_eq!(
        near_sdk::serde_json::to_value(c.get_merchant(acc("shop.testnet")).unwrap()).unwrap(),
        json!({"bond": (3 * NEAR).to_string(), "reserved": "0", "paid_out": "0"}),
    );
    assert_eq!(
        near_sdk::serde_json::to_value(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap()).unwrap(),
        json!({"token": TUSDC, "bond": "20000000", "reserved": "12000000", "paid_out": "0"}),
    );
    let o = c.get_order(acc("shop.testnet"), "A123".into()).unwrap();
    let ov = near_sdk::serde_json::to_value(&o).unwrap();
    assert_eq!(ov["token"], TUSDC);
    assert_eq!(ov["amount"], "20000000");
    assert_eq!(ov["expires_at_ms"], (o.created_at_ms.0 + DEFAULT_ORDER_TTL_MS).to_string());
    let r = c.get_receipt(acc("shop.testnet"), s(&x["honest"], "response_hash")).unwrap();
    assert_eq!(r.token, Some(acc(TUSDC)));
    assert_eq!(r.order_amount, U128(20_000_000));
    assert_eq!(near_sdk::serde_json::to_value(&r).unwrap()["order_amount"], "20000000");
    let p = c.preview_claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    assert_eq!(p.token, Some(acc(TUSDC)));
}

#[test]
fn preview_claim_never_panics() {
    let mut c = token_order_setup();
    let x = v();
    let unknown = c.preview_claim(acc("shop.testnet"), "NOPE".into(), b64(&x["honest"], "response_b64"));
    assert_eq!(unknown.error.as_deref(), Some("ERR_NO_ORDER"));
    assert_eq!(unknown.token, None);
    assert_eq!(c.preview_claim(acc("nobody.testnet"), "A123".into(), b64(&x["honest"], "response_b64")).error.as_deref(), Some("ERR_NO_ORDER"));
    let bad_json = Base64VecU8(b"not json".to_vec());
    let p = c.preview_claim(acc("shop.testnet"), "A123".into(), bad_json);
    assert_eq!(p.error.as_deref(), Some("ERR_NO_RECEIPT_FOR_BYTES"));
    // wrong bytes: hash has no receipt
    let bytes = Base64VecU8(b"totally different".to_vec());
    assert_eq!(c.preview_claim(acc("shop.testnet"), "A123".into(), bytes).error.as_deref(), Some("ERR_NO_RECEIPT_FOR_BYTES"));
}

// Review fix: a successful transfer that returns data (some tokens, or a wrapped call) is still a
// successful transfer. `promise_result_checked(0, 0)` read any non-empty value as a failure, which
// put the books back after the money had moved.
#[test]
fn claim_callback_treats_a_non_empty_successful_result_as_paid() {
    let mut c = token_order_setup();
    let x = v();
    ctx("alice.testnet", 0);
    let bytes = b64(&x["honest"], "response_b64");
    let pre = c.preview_claim(acc("shop.testnet"), "A123".into(), bytes.clone());
    drop(c.claim(acc("shop.testnet"), "A123".into(), bytes));
    ctx_result(PromiseResult::Successful(b"\"ok\"".to_vec()));
    let r = c.on_claim_paid(acc("shop.testnet"), "A123".into(), pre.payout, pre.token_bps, pre.paid_bps, pre.response_hash);
    assert!(r.ok, "{:?}", r.error);
    assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().status, "claimed");
    let b = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    assert_eq!(b.paid_out, U128(4_000_000));
    assert_eq!(b.bond, U128(16_000_000));
}

#[test]
fn withdraw_callback_treats_a_non_empty_successful_result_as_paid() {
    let mut c = token_order_setup();
    ctx("shop.testnet", 1);
    drop(c.withdraw_bond(U128(2_000_000), Some(acc(TUSDC))));
    ctx_result(PromiseResult::Successful(b"\"ok\"".to_vec()));
    assert!(c.on_withdraw_resolved(acc("shop.testnet"), Some(acc(TUSDC)), U128(2_000_000)));
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(18_000_000));
    assert_eq!(events().len(), 1);
}

// ---- final review F1: money methods need exactly 1 yoctoNEAR (full-access key only) ----

fn panics_with(f: impl FnOnce() + std::panic::UnwindSafe, needle: &str) {
    let err = std::panic::catch_unwind(f).expect_err("must panic");
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(msg.contains(needle), "panic was {:?}, expected {:?}", msg, needle);
}

#[test]
fn register_order_needs_exactly_one_yocto() {
    let mut c = setup();
    for dep in [0u128, 2] {
        ctx("shop.testnet", dep);
        panics_with(
            std::panic::AssertUnwindSafe(|| {
                c.register_order("Y1".into(), acc("alice.testnet"), U128(NEAR), 1000, None, None);
            }),
            "ERR_ONE_YOCTO",
        );
        assert!(c.get_order(acc("shop.testnet"), "Y1".into()).is_none());
    }
    ctx("shop.testnet", 1);
    c.register_order("Y1".into(), acc("alice.testnet"), U128(NEAR), 1000, None, None);
    assert!(c.get_order(acc("shop.testnet"), "Y1".into()).is_some());
}

#[test]
fn withdraw_bond_needs_exactly_one_yocto() {
    let mut c = setup();
    for dep in [0u128, 2] {
        ctx("shop.testnet", dep);
        panics_with(std::panic::AssertUnwindSafe(|| drop(c.withdraw_bond(U128(NEAR), None))), "ERR_ONE_YOCTO");
    }
    // nothing moved
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().bond, U128(3 * NEAR));
    ctx("shop.testnet", 1);
    drop(c.withdraw_bond(U128(NEAR), None));
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().bond, U128(2 * NEAR));
}

#[test]
fn storage_withdraw_needs_exactly_one_yocto() {
    let mut c = setup();
    let before = c.storage_balance_of(acc("shop.testnet")).unwrap();
    for dep in [0u128, 2] {
        ctx("shop.testnet", dep);
        panics_with(std::panic::AssertUnwindSafe(|| drop(c.storage_withdraw(Some(U128(1))))), "ERR_ONE_YOCTO");
    }
    assert_eq!(c.storage_balance_of(acc("shop.testnet")).unwrap().total, before.total);
    ctx("shop.testnet", 1);
    c.storage_withdraw(Some(U128(1)));
    assert_eq!(c.storage_balance_of(acc("shop.testnet")).unwrap().total.0, before.total.0 - 1);
}

#[test]
fn add_and_remove_signer_need_exactly_one_yocto() {
    let mut c = new_contract(vec![]);
    let vec = v();
    let pk = s(&vec["honest"], "signer_public_key_hex");
    for dep in [0u128, 2] {
        ctx("owner.testnet", dep);
        panics_with(
            std::panic::AssertUnwindSafe(|| {
                c.add_signer(pk.clone(), "provider_tee".into(), Some("m".into()), "00".repeat(32), U64(NOW_MS + DAY_MS));
            }),
            "ERR_ONE_YOCTO",
        );
    }
    assert!(c.get_signer(pk.clone()).is_none());
    ctx("owner.testnet", 1);
    c.add_signer(pk.clone(), "provider_tee".into(), Some("m".into()), "00".repeat(32), U64(NOW_MS + DAY_MS));
    assert!(c.get_signer(pk.clone()).is_some());
    for dep in [0u128, 2] {
        ctx("owner.testnet", dep);
        panics_with(std::panic::AssertUnwindSafe(|| drop(c.remove_signer(pk.clone()))), "ERR_ONE_YOCTO");
    }
    assert!(c.get_signer(pk.clone()).is_some());
    ctx("owner.testnet", 1);
    assert!(c.remove_signer(pk.clone()));
}

#[test]
fn register_receipt_and_claim_stay_callable_with_a_zero_deposit() {
    // function-call keys must keep working for these two (the helpers attach 0)
    let vec = v();
    let mut c = setup(); // register_receipt ran with deposit 0 in setup()
    let pre = {
        ctx("alice.testnet", 0);
        c.preview_claim(acc("shop.testnet"), "A123".into(), b64(&vec["honest"], "response_b64"))
    };
    assert!(pre.payout.0 > 0);
    ctx("alice.testnet", 0);
    drop(c.claim(acc("shop.testnet"), "A123".into(), b64(&vec["honest"], "response_b64")));
}

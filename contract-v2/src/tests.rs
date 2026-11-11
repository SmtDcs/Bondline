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

/// The exact JSON the contract puts into the `on_claim_paid` callback. Read back through a typed struct with
/// `deny_unknown_fields`, so a renamed / missing / extra argument fails the test instead of passing silently.
#[near_sdk::near(serializers = [json])]
#[serde(deny_unknown_fields)]
struct ClaimCallbackArgs {
    merchant: AccountId,
    order_id: String,
    payout: U128,
    token_bps: u16,
    paid_bps: u16,
    response_hash: String,
}

#[near_sdk::near(serializers = [json])]
#[serde(deny_unknown_fields)]
struct WithdrawCallbackArgs {
    merchant: AccountId,
    token: Option<AccountId>,
    amount: U128,
}

/// Parse the callback receipt that `claim` just created (created receipts are reset by the next ctx()).
fn claim_callback_args() -> ClaimCallbackArgs {
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2, "claim creates the transfer and the callback");
    assert_eq!(receipts[1].receiver_id, acc(CONTRACT));
    assert_eq!(receipts[1].receipt_indices, vec![0], "the callback must depend on the transfer");
    let (method, args, deposit, gas) = function_call(&receipts[1]);
    assert_eq!(method, "on_claim_paid");
    assert_eq!((deposit, gas), (0, GAS_CALLBACK));
    near_sdk::serde_json::from_value(args).expect("on_claim_paid arguments must deserialize with the exact parameter names")
}

fn withdraw_callback_args() -> WithdrawCallbackArgs {
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2, "withdraw_bond creates the transfer and the callback");
    assert_eq!(receipts[1].receiver_id, acc(CONTRACT));
    assert_eq!(receipts[1].receipt_indices, vec![0], "the callback must depend on the transfer");
    let (method, args, deposit, gas) = function_call(&receipts[1]);
    assert_eq!(method, "on_withdraw_resolved");
    assert_eq!((deposit, gas), (0, GAS_CALLBACK));
    near_sdk::serde_json::from_value(args).expect("on_withdraw_resolved arguments must deserialize with the exact parameter names")
}

/// Run claim as the buyer, then run the callback with the arguments `claim` built (not values re-derived by the test).
fn claim_and_callback(c: &mut Contract, merchant: &str, buyer: &str, order: &str, response_b64: &str, ok: bool) -> ClaimPreview {
    ctx(buyer, 0);
    let bytes = Base64VecU8(STANDARD.decode(response_b64).unwrap());
    let pre = c.preview_claim(acc(merchant), order.into(), bytes.clone());
    let p = c.claim(acc(merchant), order.into(), bytes);
    drop(p);
    let a = claim_callback_args();
    assert_eq!(a.merchant, acc(merchant));
    assert_eq!(a.order_id, order);
    assert_eq!((a.payout, a.token_bps, a.paid_bps, a.response_hash.clone()), (pre.payout, pre.token_bps, pre.paid_bps, pre.response_hash.clone()));
    ctx_result(if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed });
    c.on_claim_paid(a.merchant, a.order_id, a.payout, a.token_bps, a.paid_bps, a.response_hash)
}

/// Run withdraw_bond as the merchant, then the callback with the arguments it built.
fn withdraw_and_callback(c: &mut Contract, merchant: &str, token: Option<&str>, amount: u128, result: PromiseResult) -> bool {
    ctx(merchant, 1);
    drop(c.withdraw_bond(U128(amount), token.map(acc)));
    let a = withdraw_callback_args();
    assert_eq!(a.merchant, acc(merchant));
    assert_eq!(a.token, token.map(acc));
    assert_eq!(a.amount, U128(amount));
    ctx_result(result);
    c.on_withdraw_resolved(a.merchant, a.token, a.amount)
}

/// The solvency invariant for one (merchant, token) bond: reserved <= bond, and the open liabilities
/// (status open or paying) of `order_ids` add up to exactly `reserved`.
fn assert_books(c: &Contract, merchant: &str, token: Option<&str>, order_ids: &[&str]) {
    let bond = c.get_bond(acc(merchant), token.map(acc)).unwrap();
    assert!(bond.reserved.0 <= bond.bond.0, "reserved {} exceeds bond {}", bond.reserved.0, bond.bond.0);
    let open: u128 = order_ids
        .iter()
        .map(|id| c.get_order(acc(merchant), (*id).into()).unwrap())
        .filter(|o| o.token == token.map(acc) && (o.status == "open" || o.status == "paying"))
        .map(|o| o.liability.0)
        .sum();
    assert_eq!(open, bond.reserved.0, "sum of open liabilities must equal reserved");
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
    // (the status guard runs before the duplicate check, so this exact code proves the status guard)
    panics_with(std::panic::AssertUnwindSafe(|| {
        ctx("shop.testnet", 0);
        c.register_receipt("A123".into(), s(&x["honest"], "signed_text"), s(&x["honest"], "signature_hex"), s(&x["honest"], "signer_public_key_hex"));
    }), "ERR_ORDER_NOT_OPEN");
    // claimed
    ctx_result(PromiseResult::Successful(vec![]));
    c.on_claim_paid(acc("shop.testnet"), "A123".into(), U128(4_000_000), 2000, 2000, s(&x["honest"], "response_hash"));
    panics_with(std::panic::AssertUnwindSafe(|| {
        ctx("shop.testnet", 0);
        c.register_receipt("A123".into(), s(&x["honest"], "signed_text"), s(&x["honest"], "signature_hex"), s(&x["honest"], "signer_public_key_hex"));
    }), "ERR_ORDER_NOT_OPEN");
    // past expires_at_ms while still open
    let o = register_order(&mut c, "shop.testnet", "D10X", "alice.testnet", 20_000_000, 3000, Some(TUSDC), Some(1000));
    ctx_at("shop.testnet", 0, o.expires_at_ms.0);
    panics_with(std::panic::AssertUnwindSafe(|| {
        c.register_receipt("D10X".into(), s(&x["honest"], "signed_text"), s(&x["honest"], "signature_hex"), s(&x["honest"], "signer_public_key_hex"));
    }), "ERR_ORDER_EXPIRED");
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
fn register_order_charges_the_measured_bytes_plus_the_status_headroom() {
    let mut c = token_merchant();
    let avail_before = c.storage_balance_of(acc("shop.testnet")).unwrap().available.0;
    ctx("shop.testnet", 1);
    let before = env::storage_usage();
    c.register_order("E3".into(), acc("alice.testnet"), U128(1000), 1000, Some(acc(TUSDC)), None);
    let cost = (env::storage_usage() - before) as u128 * byte_cost();
    assert!(cost > 0);
    let avail_after = c.storage_balance_of(acc("shop.testnet")).unwrap().available.0;
    // measured record + room for the longest later status ("claimed"/"expired" are 3 bytes longer than "open")
    assert_eq!(avail_before - avail_after, cost + 3 * byte_cost());
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
    panics_with(std::panic::AssertUnwindSafe(|| {
        c.register_order("E5".into(), acc("alice.testnet"), U128(NEAR), 1000, None, None);
    }), "ERR_STORAGE_BALANCE");
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
    panics_with(std::panic::AssertUnwindSafe(|| {
        let x = v();
        c.register_receipt("E5R".into(), s(&x["honest"], "signed_text"), s(&x["honest"], "signature_hex"), s(&x["honest"], "signer_public_key_hex"));
    }), "ERR_STORAGE_BALANCE");
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
    panics_with(std::panic::AssertUnwindSafe(|| drop(c.storage_withdraw(Some(U128(available + 1))))), "ERR_STORAGE_BALANCE");
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
    let unit = (env::storage_usage() - before) as u128 * byte_cost() + 3 * byte_cost();
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
    assert_eq!(decreased, growth + 5 * 3 * byte_cost());
    assert_eq!(c.storage_balance_of(acc("shop.testnet")).unwrap().available.0, free - decreased);
    panics_with(std::panic::AssertUnwindSafe(|| {
        register_order(&mut c, "shop.testnet", "S6", "alice.testnet", 1000, 1000, Some(TUSDC), None);
    }), "ERR_STORAGE_BALANCE");
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
    panics_with(std::panic::AssertUnwindSafe(|| {
        register_order(&mut c, "shop.testnet", "G3", "alice.testnet", NEAR, 1000, None, Some(999));
    }), "ERR_TTL");
    panics_with(std::panic::AssertUnwindSafe(|| {
        register_order(&mut c, "shop.testnet", "G4", "alice.testnet", NEAR, 1000, None, Some(MAX_ORDER_TTL_MS + 1));
    }), "ERR_TTL");
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
    panics_with(std::panic::AssertUnwindSafe(|| {
        c.claim(acc("shop.testnet"), "G2A".into(), b64(&vec["honest"], "response_b64"));
    }), "ERR_ORDER_EXPIRED");
    // register_receipt after expiry (same clock, no helper that resets it); the expiry guard runs before the duplicate check
    ctx_at("shop.testnet", 0, o.expires_at_ms.0);
    panics_with(std::panic::AssertUnwindSafe(|| {
        c.register_receipt("G2A".into(), s(&vec["honest"], "signed_text"), s(&vec["honest"], "signature_hex"), s(&vec["honest"], "signer_public_key_hex"));
    }), "ERR_ORDER_EXPIRED");
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
    panics_with(std::panic::AssertUnwindSafe(|| {
        c.release_expired(acc("shop.testnet"), "A123".into());
    }), "ERR_ORDER_NOT_OPEN");
    // a released order cannot be released again
    let o2 = register_order(&mut c, "shop.testnet", "G5B", "alice.testnet", 2 * NEAR, 3000, None, Some(1000));
    ctx_at("bob.testnet", 0, o2.expires_at_ms.0);
    c.release_expired(acc("shop.testnet"), "G5B".into());
    panics_with(std::panic::AssertUnwindSafe(|| {
        c.release_expired(acc("shop.testnet"), "G5B".into());
    }), "ERR_ORDER_NOT_OPEN");
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
    panics_with(std::panic::AssertUnwindSafe(|| {
        c.release_expired(acc("shop.testnet"), "A123".into());
    }), "ERR_CLAIM_IN_PROGRESS");
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
    // the complete argument object, key by key, as the wasm would deserialize it
    assert_eq!(
        args,
        json!({
            "merchant": "shop.testnet", "order_id": "A123", "payout": "4000000",
            "token_bps": 2000, "paid_bps": 2000, "response_hash": s(&x["honest"], "response_hash"),
        })
    );
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
    let a = claim_callback_args();
    assert_eq!((a.payout, a.token_bps, a.paid_bps), (U128(4 * NEAR / 10), 2000, 2000));
    assert_eq!(a.response_hash, s(&x["honest"], "response_hash"));
}

#[test]
fn claim_callback_args_carry_the_clipped_injection_values_under_the_right_names() {
    let mut c = token_order_setup();
    let x = v();
    ctx("alice.testnet", 0);
    drop(c.claim(acc("shop.testnet"), "A124".into(), b64(&x["injection"], "response_b64")));
    let receipts = get_created_receipts();
    let (_, raw, _, _) = function_call(&receipts[1]);
    // token said 100%, the cap is 30%: the two numbers differ, so a swap of the names cannot hide
    assert_eq!(
        raw,
        json!({
            "merchant": "shop.testnet", "order_id": "A124", "payout": "6000000",
            "token_bps": 10000, "paid_bps": 3000, "response_hash": s(&x["injection"], "response_hash"),
        })
    );
    // and the callback, fed with exactly these values, books the 30% the contract promised
    let a = claim_callback_args();
    ctx_result(PromiseResult::Successful(vec![]));
    let p = c.on_claim_paid(a.merchant, a.order_id, a.payout, a.token_bps, a.paid_bps, a.response_hash);
    assert!(p.ok);
    assert_eq!((p.token_bps, p.paid_bps, p.payout), (10000, 3000, U128(6_000_000)));
    assert_eq!(p.response_hash, s(&x["injection"], "response_hash"));
    assert_eq!(c.get_order(acc("shop.testnet"), "A124".into()).unwrap().paid_bps, 3000);
    let ev: Vec<_> = events().into_iter().filter(|e| e["event"] == "promise_claimed").collect();
    assert_eq!(ev[0]["data"][0]["response_hash"], s(&x["injection"], "response_hash"));
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
    panics_with(std::panic::AssertUnwindSafe(|| {
        c.claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    }), "ERR_ALREADY_CLAIMED");
    assert!(get_created_receipts().is_empty());
}

#[test]
fn a_second_claim_while_paying_is_refused() {
    let mut c = token_order_setup();
    let x = v();
    ctx("alice.testnet", 0);
    let p = c.claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    drop(p);
    panics_with(std::panic::AssertUnwindSafe(|| {
        c.claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    }), "ERR_CLAIM_IN_PROGRESS");
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
    panics_with(std::panic::AssertUnwindSafe(|| {
        drop(c.claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64")));
    }), "ERR_NOT_ENOUGH_GAS");
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
    panics_with(std::panic::AssertUnwindSafe(|| {
        c.claim(acc("shop.testnet"), "A123".into(), b64(&v()["honest"], "response_b64"));
    }), "ERR_PAYOUT_ZERO");
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
    assert!(withdraw_and_callback(&mut c, "shop.testnet", Some(TUSDC), 2_000_000, PromiseResult::Successful(vec![])));
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(18_000_000));
    let e = events();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["event"], "bond_withdrawn");
    assert_eq!(e[0]["data"][0]["token"], TUSDC);

    assert!(!withdraw_and_callback(&mut c, "shop.testnet", Some(TUSDC), 2_000_000, PromiseResult::Failed));
    // exactly the debited amount comes back, not a unit more or less
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(18_000_000));
    assert_books(&c, "shop.testnet", Some(TUSDC), &["A123", "A124"]);
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
    panics_with(std::panic::AssertUnwindSafe(|| {
        c.withdraw_bond(U128(2), Some(acc(TUSDC)));
    }), "ERR_WITHDRAW_EXCEEDS_FREE_BOND");
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(20_000_000 - (free - 1)));
}

#[test]
fn withdraw_checks_the_reserved_part_and_the_existing_record() {
    let mut c = token_order_setup();
    ctx("shop.testnet", 1);
    let free = 20_000_000u128 - 12_000_000;
    for amount in [free + 1, 0, 20_000_000] {
        panics_with(std::panic::AssertUnwindSafe(|| {
            c.withdraw_bond(U128(amount), Some(acc(TUSDC)));
        }), "ERR_WITHDRAW_EXCEEDS_FREE_BOND");
    }
    panics_with(std::panic::AssertUnwindSafe(|| {
        c.withdraw_bond(U128(1), Some(acc(TUSDT)));
    }), "ERR_NO_BOND");
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
    // the NEAR callback names no token: the JSON carries an explicit null
    assert_eq!(function_call(&get_created_receipts()[1]).1, json!({"merchant": "shop.testnet", "token": null, "amount": NEAR.to_string()}));
    let a = withdraw_callback_args();
    ctx_result(PromiseResult::Failed);
    assert!(!c.on_withdraw_resolved(a.merchant, a.token, a.amount));
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

// ======================= audit fixes: contract-1 / contract-2 =======================

#[test]
fn signer_keys_are_canonical_so_revocation_works_with_any_spelling() {
    let mut c = new_contract(vec![]);
    let vec = v();
    let bare = s(&vec["honest"], "signer_public_key_hex");
    let prefixed = format!("0x{}", bare.to_uppercase());
    ctx("owner.testnet", 1);
    c.add_signer(prefixed.clone(), "provider_tee".into(), Some("m".into()), "00".repeat(32), U64(NOW_MS + DAY_MS));
    // stored once, under the bare lowercase form; every spelling finds it
    let all = c.get_signers();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].0, bare);
    assert!(c.get_signer(bare.clone()).is_some());
    assert!(c.get_signer(prefixed.clone()).is_some());
    // adding the same key again in another spelling overwrites, never duplicates
    ctx("owner.testnet", 1);
    c.add_signer(bare.clone(), "provider_tee".into(), Some("m".into()), "00".repeat(32), U64(NOW_MS + 2 * DAY_MS));
    assert_eq!(c.get_signers().len(), 1);
    // revoking by the bare form removes it
    ctx("owner.testnet", 1);
    assert!(c.remove_signer(bare.clone()));
    assert!(c.get_signer(prefixed).is_none());
    assert!(c.get_signers().is_empty());
}

#[test]
fn receipts_register_against_a_prefixed_signer_key_and_revocation_stops_them() {
    let mut c = new_contract(vec![]);
    let vec = v();
    let bare = s(&vec["honest"], "signer_public_key_hex");
    ctx("owner.testnet", 1);
    c.add_signer(
        format!("0x{}", bare),
        "provider_tee".into(),
        Some("z-ai/glm-5.3-flash".into()),
        "00".repeat(32),
        U64(NOW_MS + DAY_MS),
    );
    merchant(&mut c, "shop.testnet", 3 * NEAR, NEAR);
    register_order(&mut c, "shop.testnet", "A123", "alice.testnet", 2 * NEAR, 3000, None, None);
    let mut x = vec["honest"].clone();
    x["signer_public_key_hex"] = Value::String(format!("0x{}", bare));
    let r = register_receipt(&mut c, "shop.testnet", "A123", &x);
    assert_eq!(r.signer_public_key_hex, bare, "the receipt records the canonical key");
    ctx("owner.testnet", 1);
    c.remove_signer(bare.clone());
    register_order(&mut c, "shop.testnet", "A124", "alice.testnet", 2 * NEAR, 3000, None, None);
    panics_with(std::panic::AssertUnwindSafe(|| {
        register_receipt(&mut c, "shop.testnet", "A124", &vec["injection"]);
    }), "ERR_UNKNOWN_SIGNER");
}

#[test]
fn removing_an_unknown_signer_panics_instead_of_returning_false() {
    let mut c = new_contract(vec![]);
    ctx("owner.testnet", 1);
    panics_with(std::panic::AssertUnwindSafe(|| drop(c.remove_signer("ab".repeat(32)))), "ERR_UNKNOWN_SIGNER");
}

#[test]
fn no_status_transition_grows_the_order_record_beyond_the_prepaid_headroom() {
    // (testing_env! resets the mock's storage usage between ctx() calls, so compare the stored record itself)
    let size = |c: &Contract, id: &str| near_sdk::borsh::to_vec(&c.get_order(acc("shop.testnet"), id.into()).unwrap()).unwrap().len();
    let headroom = STATUS_HEADROOM_BYTES as usize;

    // paid claim: open -> paying -> claimed
    let mut c = setup();
    let resp = s(&v()["honest"], "response_b64");
    let open_len = size(&c, "A123");
    let p = claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &resp, true);
    assert!(p.ok);
    assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().status, "claimed");
    assert!(size(&c, "A123") - open_len <= headroom, "claim grew the record by more than the pre-paid headroom");

    // expiry: open -> expired (same contract, second order that nobody claims)
    register_order(&mut c, "shop.testnet", "X1", "alice.testnet", NEAR, 1000, None, Some(120_000));
    let open_len = size(&c, "X1");
    ctx_at("anyone.testnet", 0, NOW_MS + 200_000);
    let o = c.release_expired(acc("shop.testnet"), "X1".into());
    assert_eq!(o.status, "expired");
    assert!(size(&c, "X1") - open_len <= headroom, "release_expired grew the record by more than the pre-paid headroom");

    // and the headroom is exactly what the longest status needs (no silent over- or under-charge)
    let longest = ["open", "paying", "claimed", "expired"].iter().map(|x| x.len()).max().unwrap();
    assert_eq!(longest - "open".len(), headroom);
}

// ======================= audit fixes: tests-1 .. tests-6 =======================

/// owner + honest signer + shop.testnet (3 NEAR bond, 1 NEAR storage) + one 2 NEAR / 30% order A123, NO receipt yet.
fn one_order_no_receipt() -> Contract {
    let mut c = new_contract(vec![]);
    add_honest_signer(&mut c);
    merchant(&mut c, "shop.testnet", 3 * NEAR, NEAR);
    register_order(&mut c, "shop.testnet", "A123", "alice.testnet", 2 * NEAR, 3000, None, None);
    c
}

fn try_register(c: &mut Contract, merchant: &str, order: &str, x: &Value) {
    ctx(merchant, 0);
    c.register_receipt(order.into(), s(x, "signed_text"), s(x, "signature_hex"), s(x, "signer_public_key_hex"));
}

// ---- tests-1: the signer registry guards ----

#[test]
fn only_the_owner_can_add_a_signer() {
    let mut c = new_contract(vec![]);
    let vec = v();
    let pk = s(&vec["honest"], "signer_public_key_hex");
    // mallory attaches the 1 yocto, so ONLY the owner check can stop her
    ctx("mallory.testnet", 1);
    panics_with(
        std::panic::AssertUnwindSafe(|| {
            c.add_signer(pk.clone(), "provider_tee".into(), Some("z-ai/glm-5.3-flash".into()), "00".repeat(32), U64(NOW_MS + DAY_MS));
        }),
        "ERR_NOT_OWNER",
    );
    assert!(c.get_signer(pk).is_none());
    assert!(c.get_signers().is_empty());
}

#[test]
fn only_the_owner_can_remove_a_signer() {
    let mut c = new_contract(vec![]);
    add_honest_signer(&mut c);
    let pk = s(&v()["honest"], "signer_public_key_hex");
    let before = c.get_signer(pk.clone()).unwrap();
    ctx("mallory.testnet", 1);
    panics_with(std::panic::AssertUnwindSafe(|| drop(c.remove_signer(pk.clone()))), "ERR_NOT_OWNER");
    assert_eq!(c.get_signer(pk).unwrap(), before, "the signer is untouched");
}

#[test]
fn a_self_generated_key_cannot_register_a_receipt() {
    // nobody registered a signer: the honest vector carries a valid signature, but its key is not on the list
    let mut c = new_contract(vec![]);
    merchant(&mut c, "shop.testnet", 3 * NEAR, NEAR);
    register_order(&mut c, "shop.testnet", "A123", "alice.testnet", 2 * NEAR, 3000, None, None);
    let x = v();
    panics_with(std::panic::AssertUnwindSafe(|| try_register(&mut c, "shop.testnet", "A123", &x["honest"])), "ERR_UNKNOWN_SIGNER");
    assert!(c.get_receipt(acc("shop.testnet"), s(&x["honest"], "response_hash")).is_none());
    assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().receipt_count, 0);
}

#[test]
fn a_removed_signer_can_no_longer_register_receipts() {
    let mut c = one_order_no_receipt();
    let x = v();
    let pk = s(&x["honest"], "signer_public_key_hex");
    ctx("owner.testnet", 1);
    assert!(c.remove_signer(pk));
    panics_with(std::panic::AssertUnwindSafe(|| try_register(&mut c, "shop.testnet", "A123", &x["honest"])), "ERR_UNKNOWN_SIGNER");
    assert!(c.get_receipt(acc("shop.testnet"), s(&x["honest"], "response_hash")).is_none());
}

#[test]
fn a_signer_of_another_model_cannot_vouch_for_this_text() {
    let x = v();
    let pk = s(&x["honest"], "signer_public_key_hex");
    let attest = "fd320d9f17de6c99f28c168ffd429af6859cd0e6a81e1a31c813aeca07810672".to_string();
    // registered for a different model than the signed text names
    let mut c = new_contract(vec![]);
    ctx("owner.testnet", 1);
    c.add_signer(pk.clone(), "provider_tee".into(), Some("other/model".into()), attest.clone(), U64(NOW_MS + DAY_MS));
    merchant(&mut c, "shop.testnet", 3 * NEAR, NEAR);
    register_order(&mut c, "shop.testnet", "A123", "alice.testnet", 2 * NEAR, 3000, None, None);
    panics_with(std::panic::AssertUnwindSafe(|| try_register(&mut c, "shop.testnet", "A123", &x["honest"])), "ERR_MODEL_MISMATCH");
    assert!(c.get_receipt(acc("shop.testnet"), s(&x["honest"], "response_hash")).is_none());
}

#[test]
fn a_gateway_key_cannot_vouch_for_a_text_that_names_a_model() {
    let x = v();
    let pk = s(&x["honest"], "signer_public_key_hex");
    let attest = "fd320d9f17de6c99f28c168ffd429af6859cd0e6a81e1a31c813aeca07810672".to_string();
    let mut c = new_contract(vec![]);
    ctx("owner.testnet", 1);
    c.add_signer(pk, "gateway".into(), None, attest, U64(NOW_MS + DAY_MS));
    merchant(&mut c, "shop.testnet", 3 * NEAR, NEAR);
    register_order(&mut c, "shop.testnet", "A123", "alice.testnet", 2 * NEAR, 3000, None, None);
    panics_with(std::panic::AssertUnwindSafe(|| try_register(&mut c, "shop.testnet", "A123", &x["honest"])), "ERR_MODEL_MISMATCH");
}

#[test]
fn add_signer_validates_kind_model_attestation_and_expiry() {
    let mut c = new_contract(vec![]);
    let pk = s(&v()["honest"], "signer_public_key_hex");
    let att = "00".repeat(32);
    let cases: Vec<(&str, Option<&str>, String, u64, &str)> = vec![
        ("provider_tee", None, att.clone(), NOW_MS + DAY_MS, "ERR_SIGNER_KIND"),
        ("provider_tee", Some(""), att.clone(), NOW_MS + DAY_MS, "ERR_SIGNER_KIND"),
        ("gateway", Some("m"), att.clone(), NOW_MS + DAY_MS, "ERR_SIGNER_KIND"),
        ("whatever", Some("m"), att.clone(), NOW_MS + DAY_MS, "ERR_SIGNER_KIND"),
        ("provider_tee", Some("m"), "zz".into(), NOW_MS + DAY_MS, "ERR_ATTESTATION_HASH"),
        ("provider_tee", Some("m"), att.clone(), NOW_MS, "ERR_EXPIRY_IN_PAST"),
        ("provider_tee", Some("m"), att.clone(), NOW_MS - 1, "ERR_EXPIRY_IN_PAST"),
    ];
    for (kind, model, attestation, expires, code) in cases {
        ctx("owner.testnet", 1);
        panics_with(
            std::panic::AssertUnwindSafe(|| {
                c.add_signer(pk.clone(), kind.into(), model.map(String::from), attestation.clone(), U64(expires));
            }),
            code,
        );
        assert!(c.get_signer(pk.clone()).is_none(), "{}", code);
    }
    // a malformed key is refused too
    ctx("owner.testnet", 1);
    panics_with(
        std::panic::AssertUnwindSafe(|| {
            c.add_signer("abcd".into(), "provider_tee".into(), Some("m".into()), att.clone(), U64(NOW_MS + DAY_MS));
        }),
        "ERR_",
    );
    // a gateway key with no model is accepted
    ctx("owner.testnet", 1);
    c.add_signer(pk.clone(), "gateway".into(), None, att, U64(NOW_MS + DAY_MS));
    assert_eq!(c.get_signer(pk).unwrap().kind, "gateway");
}

// ---- tests-3: solvency, the sum of liabilities never exceeds the bond ----

#[test]
fn token_orders_cannot_reserve_more_than_the_free_token_bond() {
    let mut c = token_merchant(); // 20 tUSDC bond
    register_order(&mut c, "shop.testnet", "T1", "alice.testnet", 20_000_000, 6000, Some(TUSDC), None);
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().reserved, U128(12_000_000));
    // 8_000_001 > the free 8_000_000
    panics_with(
        std::panic::AssertUnwindSafe(|| {
            register_order(&mut c, "shop.testnet", "T2", "alice.testnet", 20_000_000, 4001, Some(TUSDC), None);
        }),
        "ERR_INSUFFICIENT_FREE_BOND",
    );
    let b = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    assert_eq!(b.reserved, U128(12_000_000));
    assert!(c.get_order(acc("shop.testnet"), "T2".into()).is_none());
    // exactly the free 8_000_000 fits and uses the bond up
    register_order(&mut c, "shop.testnet", "T3", "alice.testnet", 20_000_000, 4000, Some(TUSDC), None);
    let b = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    assert_eq!(b.reserved, b.bond);
    assert_books(&c, "shop.testnet", Some(TUSDC), &["T1", "T3"]);
    // one more unit is refused
    panics_with(
        std::panic::AssertUnwindSafe(|| {
            register_order(&mut c, "shop.testnet", "T4", "alice.testnet", 10_000, 10_000, Some(TUSDC), None);
        }),
        "ERR_INSUFFICIENT_FREE_BOND",
    );
}

#[test]
fn near_orders_cannot_reserve_more_than_the_free_near_bond() {
    let mut c = setup(); // 3 NEAR bond, 1.2 NEAR reserved by A123 + A124
    assert_books(&c, "shop.testnet", None, &["A123", "A124"]);
    // free is 1.8 NEAR: 1.8003 does not fit
    panics_with(
        std::panic::AssertUnwindSafe(|| {
            register_order(&mut c, "shop.testnet", "N2", "alice.testnet", 3 * NEAR, 6001, None, None);
        }),
        "ERR_INSUFFICIENT_FREE_BOND",
    );
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().reserved, U128(12 * NEAR / 10 + 0));
    register_order(&mut c, "shop.testnet", "N3", "alice.testnet", 3 * NEAR, 6000, None, None);
    let m = c.get_merchant(acc("shop.testnet")).unwrap();
    assert_eq!(m.reserved, m.bond);
    assert_books(&c, "shop.testnet", None, &["A123", "A124", "N3"]);
}

#[test]
fn the_books_balance_after_claim_failed_payout_withdraw_and_expiry() {
    let mut c = token_order_setup(); // A123 + A124 reserve 6 tUSDC each
    let x = v();
    assert_books(&c, "shop.testnet", Some(TUSDC), &["A123", "A124"]);
    claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &s(&x["honest"], "response_b64"), false);
    assert_books(&c, "shop.testnet", Some(TUSDC), &["A123", "A124"]);
    claim_and_callback(&mut c, "shop.testnet", "alice.testnet", "A123", &s(&x["honest"], "response_b64"), true);
    assert_books(&c, "shop.testnet", Some(TUSDC), &["A123", "A124"]);
    assert!(withdraw_and_callback(&mut c, "shop.testnet", Some(TUSDC), 1_000_000, PromiseResult::Successful(vec![])));
    assert_books(&c, "shop.testnet", Some(TUSDC), &["A123", "A124"]);
    assert!(!withdraw_and_callback(&mut c, "shop.testnet", Some(TUSDC), 1_000_000, PromiseResult::Failed));
    assert_books(&c, "shop.testnet", Some(TUSDC), &["A123", "A124"]);
    let o = c.get_order(acc("shop.testnet"), "A124".into()).unwrap();
    ctx_at("bob.testnet", 0, o.expires_at_ms.0);
    c.release_expired(acc("shop.testnet"), "A124".into());
    assert_books(&c, "shop.testnet", Some(TUSDC), &["A123", "A124"]);
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().reserved, U128(0));
}

// ---- tests-4: receipt binding ----

#[test]
fn a_reply_whose_token_names_another_order_cannot_be_claimed_under_this_one() {
    let mut c = one_order_no_receipt();
    let x = v();
    // the merchant files the INJECTION reply (its token says order=A124) under A123: registering is allowed,
    // the binding is enforced when the shopper claims
    try_register(&mut c, "shop.testnet", "A123", &x["injection"]);
    let bytes = b64(&x["injection"], "response_b64");
    let p = c.preview_claim(acc("shop.testnet"), "A123".into(), bytes.clone());
    assert!(!p.ok);
    assert_eq!(p.error.as_deref(), Some("ERR_TOKEN_ORDER_MISMATCH"));
    assert_eq!(p.token_bps, 10000);
    ctx("alice.testnet", 0);
    panics_with(std::panic::AssertUnwindSafe(|| drop(c.claim(acc("shop.testnet"), "A123".into(), bytes))), "ERR_TOKEN_ORDER_MISMATCH");
    assert!(get_created_receipts().is_empty());
    assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().status, "open");
}

#[test]
fn a_registered_receipt_cannot_be_overwritten_or_moved_to_another_order() {
    let mut c = setup(); // honest is filed under A123
    let x = v();
    let hash = s(&x["honest"], "response_hash");
    let stored = c.get_receipt(acc("shop.testnet"), hash.clone()).unwrap();
    let storage_before = c.storage_balance_of(acc("shop.testnet")).unwrap();
    let count_before = c.get_order(acc("shop.testnet"), "A123".into()).unwrap().receipt_count;
    assert_eq!(count_before, 1);
    // the merchant tries to re-file the same signed text under its other order A124 to revoke the promise
    panics_with(std::panic::AssertUnwindSafe(|| try_register(&mut c, "shop.testnet", "A124", &x["honest"])), "ERR_RECEIPT_EXISTS");
    // and under the same order again
    panics_with(std::panic::AssertUnwindSafe(|| try_register(&mut c, "shop.testnet", "A123", &x["honest"])), "ERR_RECEIPT_EXISTS");
    assert_eq!(c.get_receipt(acc("shop.testnet"), hash).unwrap(), stored);
    assert_eq!(c.get_receipt(acc("shop.testnet"), s(&x["honest"], "response_hash")).unwrap().order_id, "A123");
    assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().receipt_count, 1);
    assert_eq!(c.get_order(acc("shop.testnet"), "A124".into()).unwrap().receipt_count, 1, "A124 only has its own injection receipt");
    assert_eq!(c.storage_balance_of(acc("shop.testnet")).unwrap(), storage_before);
    let p = c.preview_claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64"));
    assert!(p.ok, "{:?}", p);
}

// ---- tests-5: exact error codes, with receipts that are NOT yet stored ----

#[test]
fn register_receipt_needs_an_open_order_each_status_has_its_own_code() {
    let mut c = token_merchant();
    let x = v();
    register_order(&mut c, "shop.testnet", "A123", "alice.testnet", 20_000_000, 3000, Some(TUSDC), None);
    register_receipt(&mut c, "shop.testnet", "A123", &x["honest"]);
    // paying: the injection reply has never been stored, so only the status guard can refuse it
    ctx("alice.testnet", 0);
    drop(c.claim(acc("shop.testnet"), "A123".into(), b64(&x["honest"], "response_b64")));
    assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().status, "paying");
    panics_with(std::panic::AssertUnwindSafe(|| try_register(&mut c, "shop.testnet", "A123", &x["injection"])), "ERR_ORDER_NOT_OPEN");
    // claimed
    ctx_result(PromiseResult::Successful(vec![]));
    c.on_claim_paid(acc("shop.testnet"), "A123".into(), U128(4_000_000), 2000, 2000, s(&x["honest"], "response_hash"));
    assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().status, "claimed");
    panics_with(std::panic::AssertUnwindSafe(|| try_register(&mut c, "shop.testnet", "A123", &x["injection"])), "ERR_ORDER_NOT_OPEN");
    assert!(c.get_receipt(acc("shop.testnet"), s(&x["injection"], "response_hash")).is_none());
}

#[test]
fn register_receipt_on_a_released_order_is_not_open() {
    let mut c = one_order_no_receipt();
    let o = register_order(&mut c, "shop.testnet", "G9", "alice.testnet", 2 * NEAR, 3000, None, Some(1000));
    ctx_at("bob.testnet", 0, o.expires_at_ms.0);
    c.release_expired(acc("shop.testnet"), "G9".into());
    // past the expiry AND expired: the status guard answers first
    panics_with(std::panic::AssertUnwindSafe(|| try_register(&mut c, "shop.testnet", "G9", &v()["honest"])), "ERR_ORDER_NOT_OPEN");
    assert!(c.get_receipt(acc("shop.testnet"), s(&v()["honest"], "response_hash")).is_none());
}

#[test]
fn register_receipt_stops_exactly_at_expires_at_ms() {
    let mut c = one_order_no_receipt();
    let x = v();
    let o = register_order(&mut c, "shop.testnet", "G2A", "alice.testnet", 2 * NEAR, 3000, None, Some(1000));
    // at expires_at_ms the (never stored) honest reply is refused for the expiry, not for a duplicate
    ctx_at("shop.testnet", 0, o.expires_at_ms.0);
    panics_with(
        std::panic::AssertUnwindSafe(|| {
            c.register_receipt("G2A".into(), s(&x["honest"], "signed_text"), s(&x["honest"], "signature_hex"), s(&x["honest"], "signer_public_key_hex"));
        }),
        "ERR_ORDER_EXPIRED",
    );
    assert!(c.get_receipt(acc("shop.testnet"), s(&x["honest"], "response_hash")).is_none());
    // one millisecond earlier the same call succeeds
    ctx_at("shop.testnet", 0, o.expires_at_ms.0 - 1);
    let r = c.register_receipt("G2A".into(), s(&x["honest"], "signed_text"), s(&x["honest"], "signature_hex"), s(&x["honest"], "signer_public_key_hex"));
    assert_eq!(r.order_id, "G2A");
}

#[test]
fn claim_stops_exactly_at_expires_at_ms_with_its_own_code() {
    let mut c = one_order_no_receipt();
    let x = v();
    let o = register_order(&mut c, "shop.testnet", "G2C", "alice.testnet", 2 * NEAR, 3000, None, Some(1000));
    // honest text, bound to G2C (the token says A123, which only matters if the expiry guard is missing)
    ctx_at("shop.testnet", 0, o.expires_at_ms.0 - 1);
    let _ = c.register_receipt("G2C".into(), s(&x["honest"], "signed_text"), s(&x["honest"], "signature_hex"), s(&x["honest"], "signer_public_key_hex"));
    let bytes = b64(&x["honest"], "response_b64");
    // one ms before the expiry the receipt is found and the token check is what answers
    ctx_at("alice.testnet", 0, o.expires_at_ms.0 - 1);
    assert_eq!(c.preview_claim(acc("shop.testnet"), "G2C".into(), bytes.clone()).error.as_deref(), Some("ERR_TOKEN_ORDER_MISMATCH"));
    // at the boundary the expiry answers, first
    ctx_at("alice.testnet", 0, o.expires_at_ms.0);
    assert_eq!(c.preview_claim(acc("shop.testnet"), "G2C".into(), bytes.clone()).error.as_deref(), Some("ERR_ORDER_EXPIRED"));
    panics_with(std::panic::AssertUnwindSafe(|| drop(c.claim(acc("shop.testnet"), "G2C".into(), bytes))), "ERR_ORDER_EXPIRED");
    assert!(get_created_receipts().is_empty());
}

#[test]
fn claim_gas_guard_has_its_own_code_and_a_45_tgas_boundary() {
    let mut c = token_order_setup();
    let x = v();
    let bytes = b64(&x["honest"], "response_b64");
    for tgas in [30u64, 40, GAS_GUARD - 1] {
        ctx_gas("alice.testnet", 0, tgas);
        panics_with(std::panic::AssertUnwindSafe(|| drop(c.claim(acc("shop.testnet"), "A123".into(), bytes.clone()))), "ERR_NOT_ENOUGH_GAS");
        assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().status, "open");
    }
    // (the mock itself meters ~10 Tgas of work before the guard runs, so the passing call needs headroom)
    ctx_gas("alice.testnet", 0, 60);
    drop(c.claim(acc("shop.testnet"), "A123".into(), bytes));
    assert_eq!(c.get_order(acc("shop.testnet"), "A123".into()).unwrap().status, "paying");
}

#[test]
fn withdraw_gas_guard_has_its_own_code_and_leaves_the_bond_alone() {
    let mut c = token_order_setup();
    for tgas in [30u64, 40, GAS_GUARD - 1] {
        ctx_gas("shop.testnet", 1, tgas);
        panics_with(std::panic::AssertUnwindSafe(|| drop(c.withdraw_bond(U128(1_000_000), Some(acc(TUSDC))))), "ERR_NOT_ENOUGH_GAS");
        assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(20_000_000));
        assert!(get_created_receipts().is_empty());
    }
    ctx_gas("shop.testnet", 1, 60);
    drop(c.withdraw_bond(U128(1_000_000), Some(acc(TUSDC))));
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(19_000_000));
}

// ---- tests-6: money paths ----

#[test]
fn storage_withdraw_sends_exactly_the_requested_amount_to_the_caller() {
    let mut c = setup();
    let avail = c.storage_balance_of(acc("shop.testnet")).unwrap().available.0;
    assert!(avail > 1000);
    ctx("shop.testnet", 1);
    c.storage_withdraw(Some(U128(1000)));
    let r = get_created_receipts();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].receiver_id, acc("shop.testnet"));
    assert_eq!(transfer_deposit(&r[0]), 1000);
    // None = everything that is available, no more
    let avail = c.storage_balance_of(acc("shop.testnet")).unwrap().available.0;
    ctx("shop.testnet", 1);
    let after = c.storage_withdraw(None);
    let r = get_created_receipts();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].receiver_id, acc("shop.testnet"));
    assert_eq!(transfer_deposit(&r[0]), avail);
    assert_eq!(after.available, U128(0));
    // nothing left: no transfer is created at all
    ctx("shop.testnet", 1);
    c.storage_withdraw(None);
    assert!(get_created_receipts().is_empty());
    ctx("shop.testnet", 1);
    c.storage_withdraw(Some(U128(0)));
    assert!(get_created_receipts().is_empty());
}

#[test]
fn storage_withdraw_without_a_balance_is_refused() {
    let mut c = new_contract(vec![]);
    ctx("nobody.testnet", 1);
    panics_with(std::panic::AssertUnwindSafe(|| drop(c.storage_withdraw(None))), "ERR_STORAGE_BALANCE");
}

#[test]
fn registering_a_merchant_twice_cannot_reset_the_books() {
    let mut c = setup(); // 1.2 NEAR reserved by two open orders
    let before = c.get_merchant(acc("shop.testnet")).unwrap();
    assert_eq!(before.reserved, U128(12 * NEAR / 10));
    ctx("shop.testnet", 3 * NEAR);
    panics_with(std::panic::AssertUnwindSafe(|| drop(c.register_merchant())), "ERR_MERCHANT_EXISTS");
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap(), before);
}

#[test]
fn release_expired_on_a_token_order_frees_the_token_bond_only() {
    let mut c = token_order_setup();
    let o = register_order(&mut c, "shop.testnet", "TX1", "alice.testnet", 10_000_000, 3000, Some(TUSDC), Some(1000));
    // NEAR order too, so a wrong-bond lookup would touch it
    register_order(&mut c, "shop.testnet", "NX1", "alice.testnet", NEAR, 1000, None, Some(1000));
    let near_before = c.get_merchant(acc("shop.testnet")).unwrap();
    let tok_before = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    assert_eq!(tok_before.reserved, U128(12_000_000 + 3_000_000));
    ctx_at("bob.testnet", 0, o.expires_at_ms.0);
    let rel = c.release_expired(acc("shop.testnet"), "TX1".into());
    assert_eq!(rel.status, "expired");
    let tok_after = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    assert_eq!(tok_after.reserved, U128(tok_before.reserved.0 - o.liability.0));
    assert_eq!((tok_after.bond, tok_after.paid_out), (tok_before.bond, tok_before.paid_out));
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap(), near_before, "the NEAR bond is untouched");
    let e = events();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["event"], "order_expired");
    assert_eq!(e[0]["data"][0]["token"], TUSDC);
    assert_eq!(e[0]["data"][0]["released"], "3000000");
    assert_books(&c, "shop.testnet", Some(TUSDC), &["A123", "A124", "TX1"]);
    // the freed tUSDC can be withdrawn: bond 20, reserved 12 -> 8 free
    ctx("shop.testnet", 1);
    drop(c.withdraw_bond(U128(8_000_000), Some(acc(TUSDC))));
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap().bond, U128(12_000_000));
}

#[test]
fn only_the_contract_itself_may_run_the_withdraw_callback() {
    let mut c = token_order_setup();
    ctx("shop.testnet", 1);
    drop(c.withdraw_bond(U128(2_000_000), Some(acc(TUSDC))));
    let before = c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap();
    // alice calls the callback with a Failed result to mint bond back: the privacy check refuses it
    testing_env_with_promise_results(build_ctx("alice.testnet", 0, NOW_MS, 300).build(), PromiseResult::Failed);
    panics_with(
        std::panic::AssertUnwindSafe(|| {
            c.on_withdraw_resolved(acc("shop.testnet"), Some(acc(TUSDC)), U128(2_000_000));
        }),
        "ERR_NOT_PRIVATE",
    );
    assert_eq!(c.get_bond(acc("shop.testnet"), Some(acc(TUSDC))).unwrap(), before);
}

#[test]
fn near_withdraw_success_callback_emits_one_event_and_changes_nothing_more() {
    let mut c = setup();
    assert!(withdraw_and_callback(&mut c, "shop.testnet", None, NEAR, PromiseResult::Successful(vec![])));
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap().bond, U128(2 * NEAR));
    let e = events();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["event"], "bond_withdrawn");
    assert_eq!(e[0]["data"][0]["token"], Value::Null);
    assert_eq!(e[0]["data"][0]["amount"], NEAR.to_string());
    assert_eq!(e[0]["data"][0]["merchant"], "shop.testnet");
}

#[test]
fn add_bond_needs_a_deposit_and_an_existing_merchant() {
    let mut c = setup();
    let before = c.get_merchant(acc("shop.testnet")).unwrap();
    ctx("shop.testnet", 0);
    panics_with(std::panic::AssertUnwindSafe(|| drop(c.add_bond())), "ERR_ZERO_DEPOSIT");
    assert_eq!(c.get_merchant(acc("shop.testnet")).unwrap(), before);
    ctx("stranger.testnet", NEAR);
    panics_with(std::panic::AssertUnwindSafe(|| drop(c.add_bond())), "ERR_NOT_MERCHANT");
    ctx("shop.testnet", 7);
    assert_eq!(c.add_bond().bond.0, before.bond.0 + 7);
}

#[test]
fn max_bps_must_be_between_1_and_10000() {
    let mut c = setup();
    for bps in [0u16, 10_001, u16::MAX] {
        panics_with(
            std::panic::AssertUnwindSafe(|| {
                register_order(&mut c, "shop.testnet", "B1", "alice.testnet", NEAR, bps, None, None);
            }),
            "ERR_MAX_BPS",
        );
    }
    assert!(c.get_order(acc("shop.testnet"), "B1".into()).is_none());
    register_order(&mut c, "shop.testnet", "B1", "alice.testnet", NEAR, 10_000, None, None);
    register_order(&mut c, "shop.testnet", "B2", "alice.testnet", 20_000, 1, None, None);
}

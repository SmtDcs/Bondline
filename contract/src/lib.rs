//! Bondline: a merchant bond that pays a shopper when the merchant's support bot
//! made a TEE-signed PROMISE token. The interface is docs/INTERFACES.md.

pub mod parse;
#[cfg(feature = "ecdsa")]
pub mod ecdsa;

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

pub const BPS_DENOMINATOR: u128 = 10_000;
pub const MIN_BOND_YOCTO: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR
pub const KIND_PROVIDER_TEE: &str = "provider_tee";
pub const KIND_GATEWAY: &str = "gateway";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
pub enum StorageKey {
    Signers,
    Merchants,
    Orders,
    Receipts,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SignerInfo {
    /// "provider_tee" or "gateway"
    pub kind: String,
    /// Required (Some) for provider_tee, must be None for gateway.
    pub model_id: Option<String>,
    /// sha256 hex of the raw attestation report JSON bytes saved in fixtures/attestation/.
    pub attestation_sha256: String,
    pub added_at_ms: U64,
    pub expires_at_ms: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Merchant {
    pub bond: U128,
    pub reserved: U128,
    pub paid_out: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Order {
    pub order_id: String,
    pub merchant: AccountId,
    pub buyer: AccountId,
    pub amount: U128,
    pub max_bps: u16,
    pub liability: U128,
    pub created_at_ms: U64,
    /// "open" or "claimed"
    pub status: String,
    pub paid: U128,
    pub paid_bps: u16,
    pub receipt_count: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub order_id: String,
    pub merchant: AccountId,
    pub signer_public_key_hex: String,
    pub signature_kind: String,
    pub model_id: Option<String>,
    pub signed_text: String,
    pub signature_hex: String,
    pub request_hash: String,
    pub response_hash: String,
    pub registered_at_ms: U64,
    pub block_height: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ClaimPreview {
    pub ok: bool,
    pub error: Option<String>,
    pub token_bps: u16,
    pub paid_bps: u16,
    pub payout: U128,
    pub response_hash: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    signers: IterableMap<String, SignerInfo>,
    merchants: LookupMap<AccountId, Merchant>,
    orders: LookupMap<String, Order>,
    receipts: LookupMap<String, Receipt>,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let ev = json!({"standard": "botpromise", "version": "1.0.0", "event": event, "data": [data]});
    env::log_str(&format!("EVENT_JSON:{}", ev));
}

fn fail(code: &str) -> ! {
    env::panic_str(code)
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            signers: IterableMap::new(StorageKey::Signers),
            merchants: LookupMap::new(StorageKey::Merchants),
            orders: LookupMap::new(StorageKey::Orders),
            receipts: LookupMap::new(StorageKey::Receipts),
        }
    }

    // ---------------- signer registry (owner only) ----------------

    pub fn add_signer(
        &mut self,
        public_key_hex: String,
        kind: String,
        model_id: Option<String>,
        attestation_sha256: String,
        expires_at_ms: U64,
    ) -> SignerInfo {
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
        let pk = public_key_hex.to_lowercase();
        parse::decode_hex_fixed::<32>(&pk).unwrap_or_else(|e| fail(e));
        match (kind.as_str(), &model_id) {
            (KIND_PROVIDER_TEE, Some(m)) if !m.is_empty() => {}
            (KIND_GATEWAY, None) => {}
            _ => fail("ERR_SIGNER_KIND"),
        }
        require!(parse::decode_hex_fixed::<32>(&attestation_sha256).is_ok(), "ERR_ATTESTATION_HASH");
        let now = env::block_timestamp_ms();
        require!(expires_at_ms.0 > now, "ERR_EXPIRY_IN_PAST");
        let info = SignerInfo { kind, model_id, attestation_sha256, added_at_ms: U64(now), expires_at_ms };
        self.signers.insert(pk.clone(), info.clone());
        emit("signer_added", json!({"public_key_hex": pk, "kind": info.kind, "model_id": info.model_id, "expires_at_ms": info.expires_at_ms}));
        info
    }

    pub fn remove_signer(&mut self, public_key_hex: String) -> bool {
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
        let pk = public_key_hex.to_lowercase();
        let removed = self.signers.remove(&pk).is_some();
        if removed {
            emit("signer_removed", json!({"public_key_hex": pk}));
        }
        removed
    }

    // ---------------- merchant bond ----------------

    #[payable]
    pub fn register_merchant(&mut self) -> Merchant {
        let merchant = env::predecessor_account_id();
        require!(self.merchants.get(&merchant).is_none(), "ERR_MERCHANT_EXISTS");
        let dep = env::attached_deposit().as_yoctonear();
        require!(dep >= MIN_BOND_YOCTO, "ERR_BOND_TOO_SMALL");
        let m = Merchant { bond: U128(dep), reserved: U128(0), paid_out: U128(0) };
        self.merchants.insert(merchant.clone(), m.clone());
        emit("merchant_registered", json!({"merchant": merchant, "bond": U128(dep)}));
        m
    }

    #[payable]
    pub fn add_bond(&mut self) -> Merchant {
        let merchant = env::predecessor_account_id();
        let dep = env::attached_deposit().as_yoctonear();
        require!(dep > 0, "ERR_ZERO_DEPOSIT");
        let m = self.merchants.get_mut(&merchant).unwrap_or_else(|| fail("ERR_NOT_MERCHANT"));
        m.bond = U128(m.bond.0 + dep);
        let out = m.clone();
        emit("bond_added", json!({"merchant": merchant, "amount": U128(dep), "bond": out.bond}));
        out
    }

    pub fn withdraw_bond(&mut self, amount: U128) -> Promise {
        let merchant = env::predecessor_account_id();
        let m = self.merchants.get_mut(&merchant).unwrap_or_else(|| fail("ERR_NOT_MERCHANT"));
        let free = m.bond.0 - m.reserved.0;
        require!(amount.0 > 0 && amount.0 <= free, "ERR_WITHDRAW_EXCEEDS_FREE_BOND");
        m.bond = U128(m.bond.0 - amount.0);
        emit("bond_withdrawn", json!({"merchant": merchant, "amount": amount}));
        Promise::new(merchant).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ---------------- orders ----------------

    pub fn register_order(&mut self, order_id: String, buyer: AccountId, amount: U128, max_bps: u16) -> Order {
        let merchant = env::predecessor_account_id();
        require!(
            !order_id.is_empty() && order_id.len() <= 32 && order_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "ERR_ORDER_ID"
        );
        require!(max_bps >= 1 && max_bps <= 10_000, "ERR_MAX_BPS");
        require!(amount.0 > 0, "ERR_AMOUNT");
        require!(self.orders.get(&order_id).is_none(), "ERR_ORDER_EXISTS");
        let liability = amount.0 * max_bps as u128 / BPS_DENOMINATOR;
        let m = self.merchants.get_mut(&merchant).unwrap_or_else(|| fail("ERR_NOT_MERCHANT"));
        require!(m.bond.0 - m.reserved.0 >= liability, "ERR_INSUFFICIENT_FREE_BOND");
        m.reserved = U128(m.reserved.0 + liability);
        let order = Order {
            order_id: order_id.clone(),
            merchant: merchant.clone(),
            buyer,
            amount,
            max_bps,
            liability: U128(liability),
            created_at_ms: U64(env::block_timestamp_ms()),
            status: "open".to_string(),
            paid: U128(0),
            paid_bps: 0,
            receipt_count: 0,
        };
        self.orders.insert(order_id, order.clone());
        emit("order_registered", json!({"order_id": order.order_id, "merchant": merchant, "buyer": order.buyer, "amount": order.amount, "max_bps": max_bps, "liability": order.liability}));
        order
    }

    // ---------------- receipts (merchant key only) ----------------

    pub fn register_receipt(
        &mut self,
        order_id: String,
        signed_text: String,
        signature_hex: String,
        signer_public_key_hex: String,
    ) -> Receipt {
        let caller = env::predecessor_account_id();
        let order = self.orders.get(&order_id).cloned().unwrap_or_else(|| fail("ERR_NO_ORDER"));
        require!(order.merchant == caller, "ERR_NOT_ORDER_MERCHANT");
        let pk_hex = signer_public_key_hex.to_lowercase();
        let signer = self.signers.get(&pk_hex).cloned().unwrap_or_else(|| fail("ERR_UNKNOWN_SIGNER"));
        require!(env::block_timestamp_ms() < signer.expires_at_ms.0, "ERR_SIGNER_EXPIRED");

        let parsed = parse::parse_signed_text(&signed_text).unwrap_or_else(|e| fail(e));
        require!(parsed.model == signer.model_id, "ERR_MODEL_MISMATCH");

        let sig = parse::decode_hex_fixed::<64>(&signature_hex).unwrap_or_else(|e| fail(e));
        let pk = parse::decode_hex_fixed::<32>(&pk_hex).unwrap_or_else(|e| fail(e));
        require!(env::ed25519_verify(&sig, signed_text.as_bytes(), &pk), "ERR_BAD_SIGNATURE");

        require!(self.receipts.get(&parsed.response_hash_hex).is_none(), "ERR_RECEIPT_EXISTS");
        let r = Receipt {
            order_id: order_id.clone(),
            merchant: caller,
            signer_public_key_hex: pk_hex,
            signature_kind: signer.kind.clone(),
            model_id: parsed.model.clone(),
            signed_text,
            signature_hex: signature_hex.trim_start_matches("0x").to_lowercase(),
            request_hash: parsed.request_hash_hex.clone(),
            response_hash: parsed.response_hash_hex.clone(),
            registered_at_ms: U64(env::block_timestamp_ms()),
            block_height: U64(env::block_height()),
        };
        self.receipts.insert(r.response_hash.clone(), r.clone());
        if let Some(o) = self.orders.get_mut(&order_id) {
            o.receipt_count += 1;
        }
        emit("receipt_registered", json!({"order_id": order_id, "response_hash": r.response_hash, "request_hash": r.request_hash, "signer_public_key_hex": r.signer_public_key_hex, "signature_kind": r.signature_kind}));
        r
    }

    // ---------------- claim (buyer only) ----------------

    pub fn claim(&mut self, order_id: String, response_b64: Base64VecU8) -> ClaimPreview {
        let order = self.orders.get(&order_id).cloned().unwrap_or_else(|| fail("ERR_NO_ORDER"));
        require!(env::predecessor_account_id() == order.buyer, "ERR_NOT_BUYER");
        let p = self.evaluate(&order, &response_b64.0);
        if let Some(e) = &p.error {
            fail(e);
        }
        let payout = p.payout.0;
        let m = self.merchants.get_mut(&order.merchant).unwrap_or_else(|| fail("ERR_NOT_MERCHANT"));
        m.reserved = U128(m.reserved.0 - order.liability.0);
        m.bond = U128(m.bond.0 - payout);
        m.paid_out = U128(m.paid_out.0 + payout);
        let o = self.orders.get_mut(&order_id).unwrap();
        o.status = "claimed".to_string();
        o.paid = U128(payout);
        o.paid_bps = p.paid_bps;
        emit("promise_claimed", json!({"order_id": order_id, "buyer": order.buyer, "token_bps": p.token_bps, "paid_bps": p.paid_bps, "payout": p.payout, "response_hash": p.response_hash}));
        Promise::new(order.buyer.clone()).transfer(NearToken::from_yoctonear(payout)).detach();
        p
    }

    // ---------------- views ----------------

    pub fn preview_claim(&self, order_id: String, response_b64: Base64VecU8) -> ClaimPreview {
        match self.orders.get(&order_id) {
            Some(order) => self.evaluate(order, &response_b64.0),
            None => ClaimPreview { ok: false, error: Some("ERR_NO_ORDER".into()), token_bps: 0, paid_bps: 0, payout: U128(0), response_hash: String::new() },
        }
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }
    pub fn get_signer(&self, public_key_hex: String) -> Option<SignerInfo> {
        self.signers.get(&public_key_hex.to_lowercase()).cloned()
    }
    pub fn get_signers(&self) -> Vec<(String, SignerInfo)> {
        self.signers.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }
    pub fn get_merchant(&self, merchant: AccountId) -> Option<Merchant> {
        self.merchants.get(&merchant).cloned()
    }
    pub fn get_order(&self, order_id: String) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }
    pub fn get_receipt(&self, response_hash: String) -> Option<Receipt> {
        self.receipts.get(&response_hash.to_lowercase()).cloned()
    }
}

impl Contract {
    /// Shared by claim (mutating) and preview_claim (view). Never panics.
    fn evaluate(&self, order: &Order, response_bytes: &[u8]) -> ClaimPreview {
        let response_hash = hex::encode(env::sha256_array(response_bytes));
        let err = |e: &str, token_bps: u16| ClaimPreview {
            ok: false,
            error: Some(e.to_string()),
            token_bps,
            paid_bps: 0,
            payout: U128(0),
            response_hash: response_hash.clone(),
        };
        if order.status != "open" {
            return err("ERR_ALREADY_CLAIMED", 0);
        }
        let receipt = match self.receipts.get(&response_hash) {
            Some(r) => r,
            None => return err("ERR_NO_RECEIPT_FOR_BYTES", 0),
        };
        if receipt.order_id != order.order_id {
            return err("ERR_RECEIPT_ORDER_MISMATCH", 0);
        }
        let content = match parse::extract_content(response_bytes) {
            Ok(c) => c,
            Err(e) => return err(e, 0),
        };
        let promise = match parse::parse_promise(&content) {
            Ok(p) => p,
            Err(e) => return err(e, 0),
        };
        if promise.order_id != order.order_id {
            return err("ERR_TOKEN_ORDER_MISMATCH", promise.bps);
        }
        let paid_bps = promise.bps.min(order.max_bps);
        let payout = order.amount.0 * paid_bps as u128 / BPS_DENOMINATOR;
        ClaimPreview { ok: true, error: None, token_bps: promise.bps, paid_bps, payout: U128(payout), response_hash }
    }
}

#[cfg(test)]
mod tests;

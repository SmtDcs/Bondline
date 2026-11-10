//! Claimable bot promises v2: NEP-141 bonds, measured storage accounting, per-merchant order ids,
//! order expiry and callbacks that put the books back when an outgoing transfer fails.
//! The interface spec is docs/STABLECOIN.md; v1 lives untouched in ../contract.

pub mod parse;
#[cfg(feature = "ecdsa")]
pub mod ecdsa;

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

pub const BPS_DENOMINATOR: u128 = 10_000;
pub const MIN_BOND_YOCTO: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR
pub const MAX_TOKENS: usize = 8;
pub const DEFAULT_MIN_ORDER_TTL_MS: u64 = 60 * 60 * 1000; // 1 hour
pub const DEFAULT_ORDER_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000; // 30 days
pub const MAX_ORDER_TTL_MS: u64 = 365 * 24 * 60 * 60 * 1000; // 365 days
pub const MAX_FT_MSG_BYTES: usize = 256;
/// Gas constants (docs/STABLECOIN.md section 7): tuned with the live run.
pub const GAS_FT_TRANSFER: u64 = 20; // Tgas
pub const GAS_CALLBACK: u64 = 15; // Tgas
pub const GAS_GUARD: u64 = GAS_FT_TRANSFER + GAS_CALLBACK + 10; // Tgas
pub const KIND_PROVIDER_TEE: &str = "provider_tee";
pub const KIND_GATEWAY: &str = "gateway";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
pub enum StorageKey {
    Signers,
    Bonds,
    Orders,
    Receipts,
    Storage,
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

/// The v1 shape, kept for old readers. `get_merchant` returns the NEAR bond in this shape.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Merchant {
    pub bond: U128,
    pub reserved: U128,
    pub paid_out: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Bond {
    /// None = NEAR.
    pub token: Option<AccountId>,
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
    /// "open" | "paying" | "claimed" | "expired"
    pub status: String,
    pub paid: U128,
    pub paid_bps: u16,
    pub receipt_count: u32,
    pub token: Option<AccountId>,
    pub expires_at_ms: U64,
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
    pub token: Option<AccountId>,
    pub order_amount: U128,
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
    pub token: Option<AccountId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StorageBalance {
    pub total: U128,
    pub used: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StorageBalanceView {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub api: u32,
    pub owner: AccountId,
    pub allowed_tokens: Vec<AccountId>,
    pub min_order_ttl_ms: U64,
    pub max_order_ttl_ms: U64,
    pub default_order_ttl_ms: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    allowed_tokens: Vec<AccountId>,
    min_order_ttl_ms: u64,
    signers: IterableMap<String, SignerInfo>,
    bonds: LookupMap<(AccountId, Option<AccountId>), Bond>,
    orders: LookupMap<(AccountId, String), Order>,
    receipts: LookupMap<(AccountId, String), Receipt>,
    storage: LookupMap<AccountId, StorageBalance>,
}

fn emit(token: Option<&AccountId>, event: &str, data: Value) {
    let mut data = data;
    if let Value::Object(map) = &mut data {
        map.insert("token".to_string(), json!(token));
    }
    let ev = json!({"standard": "botpromise", "version": "1.1.0", "event": event, "data": [data]});
    env::log_str(&format!("EVENT_JSON:{}", ev));
}

fn fail(code: &str) -> ! {
    env::panic_str(code)
}

fn log_plain(line: &str) {
    env::log_str(line);
}

fn storage_cost_since(before: u64) -> u128 {
    let after = env::storage_usage();
    (after.saturating_sub(before) as u128) * env::storage_byte_cost().as_yoctonear()
}

/// Does `msg` carry exactly `{"add_bond":{}}`? Anything else is refused by the caller.
fn is_add_bond_msg(msg: &str) -> bool {
    if msg.is_empty() || msg.len() > MAX_FT_MSG_BYTES {
        return false;
    }
    match near_sdk::serde_json::from_str::<Value>(msg) {
        Ok(Value::Object(map)) if map.len() == 1 => {
            matches!(map.get("add_bond"), Some(Value::Object(params)) if params.is_empty())
        }
        _ => false,
    }
}

fn ft_transfer_call(token: &AccountId, receiver: &AccountId, amount: u128) -> Promise {
    let args = json!({"receiver_id": receiver, "amount": U128(amount)}).to_string().into_bytes();
    Promise::new(token.clone()).function_call(
        "ft_transfer".to_string(),
        args,
        NearToken::from_yoctonear(1),
        Gas::from_tgas(GAS_FT_TRANSFER),
    )
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, allowed_tokens: Option<Vec<AccountId>>, min_order_ttl_ms: Option<U64>) -> Self {
        let allowed_tokens = allowed_tokens.unwrap_or_default();
        require!(allowed_tokens.len() <= MAX_TOKENS, "ERR_TOKEN_LIST");
        for (i, t) in allowed_tokens.iter().enumerate() {
            require!(!allowed_tokens[..i].contains(t), "ERR_TOKEN_LIST");
        }
        let min_order_ttl_ms = min_order_ttl_ms.map(|v| v.0).unwrap_or(DEFAULT_MIN_ORDER_TTL_MS);
        require!(min_order_ttl_ms > 0 && min_order_ttl_ms <= MAX_ORDER_TTL_MS, "ERR_TTL");
        Self {
            owner,
            allowed_tokens,
            min_order_ttl_ms,
            signers: IterableMap::new(StorageKey::Signers),
            bonds: LookupMap::new(StorageKey::Bonds),
            orders: LookupMap::new(StorageKey::Orders),
            receipts: LookupMap::new(StorageKey::Receipts),
            storage: LookupMap::new(StorageKey::Storage),
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
        emit(None, "signer_added", json!({"public_key_hex": pk, "kind": info.kind, "model_id": info.model_id, "expires_at_ms": info.expires_at_ms}));
        info
    }

    pub fn remove_signer(&mut self, public_key_hex: String) -> bool {
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
        let pk = public_key_hex.to_lowercase();
        let removed = self.signers.remove(&pk).is_some();
        if removed {
            emit(None, "signer_removed", json!({"public_key_hex": pk}));
        }
        removed
    }

    // ---------------- storage balance (own implementation, shaped like NEP-145) ----------------

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> StorageBalanceView {
        let account = account_id.unwrap_or_else(|| env::predecessor_account_id());
        let dep = env::attached_deposit().as_yoctonear();
        if self.storage.get(&account).is_none() {
            let before = env::storage_usage();
            self.storage.insert(account.clone(), StorageBalance { total: U128(0), used: U128(0) });
            self.storage.flush();
            let cost = storage_cost_since(before);
            if dep < cost {
                self.storage.remove(&account);
                self.storage.flush();
                fail("ERR_STORAGE_BALANCE");
            }
            let b = self.storage.get_mut(&account).unwrap();
            b.total = U128(dep - cost);
        } else {
            let b = self.storage.get_mut(&account).unwrap();
            b.total = U128(b.total.0 + dep);
        }
        self.storage.flush();
        self.storage_view(&account).unwrap()
    }

    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalanceView {
        let account = env::predecessor_account_id();
        let b = self.storage.get_mut(&account).unwrap_or_else(|| fail("ERR_STORAGE_BALANCE"));
        let available = b.total.0 - b.used.0;
        let amount = amount.map(|a| a.0).unwrap_or(available);
        require!(amount <= available, "ERR_STORAGE_BALANCE");
        b.total = U128(b.total.0 - amount);
        self.storage.flush();
        if amount > 0 {
            let _ = Promise::new(account.clone()).transfer(NearToken::from_yoctonear(amount));
        }
        self.storage_view(&account).unwrap()
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalanceView> {
        self.storage_view(&account_id)
    }

    // ---------------- merchant bonds ----------------

    #[payable]
    pub fn register_merchant(&mut self) -> Bond {
        let merchant = env::predecessor_account_id();
        require!(self.bonds.get(&(merchant.clone(), None)).is_none(), "ERR_MERCHANT_EXISTS");
        let dep = env::attached_deposit().as_yoctonear();
        require!(dep >= MIN_BOND_YOCTO, "ERR_BOND_TOO_SMALL");
        let key = (merchant.clone(), None);
        let before = env::storage_usage();
        self.bonds.insert(key.clone(), Bond { token: None, bond: U128(dep), reserved: U128(0), paid_out: U128(0) });
        self.bonds.flush();
        let cost = storage_cost_since(before);
        if dep < cost.saturating_add(MIN_BOND_YOCTO) {
            self.bonds.remove(&key);
            self.bonds.flush();
            fail("ERR_BOND_TOO_SMALL");
        }
        let bond = dep - cost;
        let b = self.bonds.get_mut(&key).unwrap();
        b.bond = U128(bond);
        self.bonds.flush();
        emit(None, "merchant_registered", json!({"merchant": merchant, "bond": U128(bond), "storage_cost": U128(cost)}));
        self.bonds.get(&key).unwrap().clone()
    }

    #[payable]
    pub fn add_bond(&mut self) -> Bond {
        let merchant = env::predecessor_account_id();
        let dep = env::attached_deposit().as_yoctonear();
        require!(dep > 0, "ERR_ZERO_DEPOSIT");
        let key = (merchant.clone(), None);
        let b = self.bonds.get_mut(&key).unwrap_or_else(|| fail("ERR_NOT_MERCHANT"));
        b.bond = U128(b.bond.0 + dep);
        let out = b.clone();
        self.bonds.flush();
        emit(None, "bond_added", json!({"merchant": merchant, "amount": U128(dep), "bond": out.bond}));
        out
    }

    pub fn withdraw_bond(&mut self, amount: U128, token: Option<AccountId>) -> Promise {
        let merchant = env::predecessor_account_id();
        require_gas();
        let key = (merchant.clone(), token.clone());
        let b = self.bonds.get_mut(&key).unwrap_or_else(|| fail("ERR_NO_BOND"));
        let free = b.bond.0 - b.reserved.0;
        require!(amount.0 > 0 && amount.0 <= free, "ERR_WITHDRAW_EXCEEDS_FREE_BOND");
        b.bond = U128(b.bond.0 - amount.0);
        self.bonds.flush();
        let transfer = match &token {
            Some(t) => ft_transfer_call(t, &merchant, amount.0),
            None => Promise::new(merchant.clone()).transfer(NearToken::from_yoctonear(amount.0)),
        };
        let callback_args = json!({"merchant": merchant, "token": token, "amount": amount}).to_string().into_bytes();
        transfer.then(Promise::new(env::current_account_id()).function_call(
            "on_withdraw_resolved".to_string(),
            callback_args,
            NearToken::from_yoctonear(0),
            Gas::from_tgas(GAS_CALLBACK),
        ))
    }

    #[private]
    pub fn on_withdraw_resolved(&mut self, merchant: AccountId, token: Option<AccountId>, amount: U128) -> bool {
        require!(env::predecessor_account_id() == env::current_account_id(), "ERR_NOT_PRIVATE");
        let key = (merchant.clone(), token.clone());
        let succeeded = promise_succeeded();
        if succeeded {
            emit(token.as_ref(), "bond_withdrawn", json!({"merchant": merchant, "amount": amount}));
            true
        } else {
            if let Some(b) = self.bonds.get_mut(&key) {
                b.bond = U128(b.bond.0 + amount.0);
                self.bonds.flush();
            }
            let label = token.as_ref().map(|t| t.to_string()).unwrap_or_else(|| "NEAR".to_string());
            log_plain(&format!("WITHDRAW_FAILED:{}", label));
            false
        }
    }

    // ---------------- incoming NEP-141 deposits ----------------

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        if !self.allowed_tokens.contains(&token) {
            log_plain("REFUND:TOKEN_NOT_ALLOWED");
            return PromiseOrValue::Value(amount);
        }
        if !is_add_bond_msg(&msg) {
            log_plain("REFUND:BAD_MSG");
            return PromiseOrValue::Value(amount);
        }
        if amount.0 == 0 {
            log_plain("REFUND:ZERO_AMOUNT");
            return PromiseOrValue::Value(U128(0));
        }
        let key = (sender_id.clone(), Some(token.clone()));
        if let Some(b) = self.bonds.get(&key) {
            if b.bond.0.checked_add(amount.0).is_none() {
                log_plain("REFUND:OVERFLOW");
                return PromiseOrValue::Value(amount);
            }
        }
        let is_new = self.bonds.get(&key).is_none();
        let before = if is_new { Some(env::storage_usage()) } else { None };
        if is_new {
            self.bonds.insert(key.clone(), Bond {
                token: Some(token.clone()),
                bond: U128(0),
                reserved: U128(0),
                paid_out: U128(0),
            });
        }
        {
            let b = self.bonds.get_mut(&key).unwrap();
            b.bond = U128(b.bond.0 + amount.0);
        }
        self.bonds.flush();
        if let Some(before) = before {
            let cost = storage_cost_since(before);
            if !self.charge_storage(&sender_id, cost) {
                self.bonds.remove(&key);
                self.bonds.flush();
                log_plain("REFUND:NO_STORAGE");
                return PromiseOrValue::Value(amount);
            }
        }
        let bond = self.bonds.get(&key).unwrap().bond;
        emit(Some(&token), "bond_added", json!({"merchant": sender_id, "amount": amount, "bond": bond}));
        PromiseOrValue::Value(U128(0))
    }

    // ---------------- orders ----------------

    pub fn register_order(
        &mut self,
        order_id: String,
        buyer: AccountId,
        amount: U128,
        max_bps: u16,
        token: Option<AccountId>,
        ttl_ms: Option<U64>,
    ) -> Order {
        let merchant = env::predecessor_account_id();
        require!(
            !order_id.is_empty() && order_id.len() <= 32 && order_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "ERR_ORDER_ID"
        );
        require!(max_bps >= 1 && max_bps <= 10_000, "ERR_MAX_BPS");
        require!(amount.0 > 0, "ERR_AMOUNT");
        if let Some(t) = &token {
            require!(self.allowed_tokens.contains(t), "ERR_TOKEN_NOT_ALLOWED");
        }
        let ttl = ttl_ms.map(|v| v.0).unwrap_or(DEFAULT_ORDER_TTL_MS);
        require!(ttl >= self.min_order_ttl_ms && ttl <= MAX_ORDER_TTL_MS, "ERR_TTL");
        let key = (merchant.clone(), order_id.clone());
        require!(self.orders.get(&key).is_none(), "ERR_ORDER_EXISTS");
        let bond_key = (merchant.clone(), token.clone());
        let bond = self.bonds.get(&bond_key).unwrap_or_else(|| fail("ERR_NOT_MERCHANT"));
        let liability = amount
            .0
            .checked_mul(max_bps as u128)
            .map(|v| v / BPS_DENOMINATOR)
            .unwrap_or_else(|| fail("ERR_AMOUNT"));
        require!(liability > 0, "ERR_LIABILITY_ZERO");
        require!(bond.bond.0 - bond.reserved.0 >= liability, "ERR_INSUFFICIENT_FREE_BOND");
        let now = env::block_timestamp_ms();
        let order = Order {
            order_id: order_id.clone(),
            merchant: merchant.clone(),
            buyer,
            amount,
            max_bps,
            liability: U128(liability),
            created_at_ms: U64(now),
            status: "open".to_string(),
            paid: U128(0),
            paid_bps: 0,
            receipt_count: 0,
            token: token.clone(),
            expires_at_ms: U64(now + ttl),
        };
        let before = env::storage_usage();
        self.orders.insert(key.clone(), order.clone());
        self.orders.flush();
        let cost = storage_cost_since(before);
        if !self.charge_storage(&merchant, cost) {
            self.orders.remove(&key);
            self.orders.flush();
            fail("ERR_STORAGE_BALANCE");
        }
        let b = self.bonds.get_mut(&bond_key).unwrap();
        b.reserved = U128(b.reserved.0 + liability);
        self.bonds.flush();
        emit(token.as_ref(), "order_registered", json!({
            "order_id": order.order_id, "merchant": merchant, "buyer": order.buyer,
            "amount": order.amount, "max_bps": max_bps, "liability": order.liability,
            "expires_at_ms": order.expires_at_ms,
        }));
        order
    }

    pub fn release_expired(&mut self, merchant: AccountId, order_id: String) -> Order {
        let key = (merchant.clone(), order_id.clone());
        let order = self.orders.get(&key).cloned().unwrap_or_else(|| fail("ERR_NO_ORDER"));
        match order.status.as_str() {
            "open" => {}
            "paying" => fail("ERR_CLAIM_IN_PROGRESS"),
            _ => fail("ERR_ORDER_NOT_OPEN"),
        }
        require!(env::block_timestamp_ms() >= order.expires_at_ms.0, "ERR_ORDER_NOT_EXPIRED");
        let bond_key = (merchant.clone(), order.token.clone());
        let b = self.bonds.get_mut(&bond_key).unwrap_or_else(|| fail("ERR_NO_BOND"));
        b.reserved = U128(b.reserved.0.checked_sub(order.liability.0).unwrap_or_else(|| fail("ERR_INSUFFICIENT_FREE_BOND")));
        let released = order.liability;
        self.bonds.flush();
        let o = self.orders.get_mut(&key).unwrap();
        o.status = "expired".to_string();
        let out = o.clone();
        self.orders.flush();
        emit(order.token.as_ref(), "order_expired", json!({
            "order_id": order_id, "merchant": merchant, "released": released,
        }));
        out
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
        let key = (caller.clone(), order_id.clone());
        let order = self.orders.get(&key).cloned().unwrap_or_else(|| fail("ERR_NO_ORDER"));
        require!(order.status == "open", "ERR_ORDER_NOT_OPEN");
        require!(env::block_timestamp_ms() < order.expires_at_ms.0, "ERR_ORDER_EXPIRED");
        let pk_hex = signer_public_key_hex.to_lowercase();
        let signer = self.signers.get(&pk_hex).cloned().unwrap_or_else(|| fail("ERR_UNKNOWN_SIGNER"));
        require!(env::block_timestamp_ms() < signer.expires_at_ms.0, "ERR_SIGNER_EXPIRED");

        let parsed = parse::parse_signed_text(&signed_text).unwrap_or_else(|e| fail(e));
        require!(parsed.model == signer.model_id, "ERR_MODEL_MISMATCH");

        let sig = parse::decode_hex_fixed::<64>(&signature_hex).unwrap_or_else(|e| fail(e));
        let pk = parse::decode_hex_fixed::<32>(&pk_hex).unwrap_or_else(|e| fail(e));
        require!(env::ed25519_verify(&sig, signed_text.as_bytes(), &pk), "ERR_BAD_SIGNATURE");

        let receipt_key = (caller.clone(), parsed.response_hash_hex.clone());
        require!(self.receipts.get(&receipt_key).is_none(), "ERR_RECEIPT_EXISTS");
        let r = Receipt {
            order_id: order_id.clone(),
            merchant: caller.clone(),
            signer_public_key_hex: pk_hex,
            signature_kind: signer.kind.clone(),
            model_id: parsed.model.clone(),
            signed_text,
            signature_hex: signature_hex.trim_start_matches("0x").to_lowercase(),
            request_hash: parsed.request_hash_hex.clone(),
            response_hash: parsed.response_hash_hex.clone(),
            registered_at_ms: U64(env::block_timestamp_ms()),
            block_height: U64(env::block_height()),
            token: order.token.clone(),
            order_amount: order.amount,
        };
        let before = env::storage_usage();
        self.receipts.insert(receipt_key.clone(), r.clone());
        self.receipts.flush();
        let cost = storage_cost_since(before);
        if !self.charge_storage(&caller, cost) {
            self.receipts.remove(&receipt_key);
            self.receipts.flush();
            fail("ERR_STORAGE_BALANCE");
        }
        let o = self.orders.get_mut(&key).unwrap();
        o.receipt_count += 1;
        self.orders.flush();
        emit(order.token.as_ref(), "receipt_registered", json!({
            "order_id": order_id, "merchant": caller, "response_hash": r.response_hash,
            "request_hash": r.request_hash, "signer_public_key_hex": r.signer_public_key_hex,
            "signature_kind": r.signature_kind, "order_amount": r.order_amount,
        }));
        r
    }

    // ---------------- claim (buyer only, paid through a callback) ----------------

    pub fn claim(&mut self, merchant: AccountId, order_id: String, response_b64: Base64VecU8) -> Promise {
        let key = (merchant.clone(), order_id.clone());
        let order = self.orders.get(&key).cloned().unwrap_or_else(|| fail("ERR_NO_ORDER"));
        require!(env::predecessor_account_id() == order.buyer, "ERR_NOT_BUYER");
        require_gas();
        let p = self.evaluate(&merchant, &order, &response_b64.0);
        if let Some(e) = &p.error {
            fail(e);
        }
        let o = self.orders.get_mut(&key).unwrap();
        o.status = "paying".to_string();
        self.orders.flush();
        let payout = p.payout.0;
        let transfer = match &order.token {
            Some(t) => ft_transfer_call(t, &order.buyer, payout),
            None => Promise::new(order.buyer.clone()).transfer(NearToken::from_yoctonear(payout)),
        };
        let callback_args = json!({
            "merchant": merchant, "order_id": order_id, "payout": p.payout,
            "token_bps": p.token_bps, "paid_bps": p.paid_bps, "response_hash": p.response_hash,
        }).to_string().into_bytes();
        transfer.then(Promise::new(env::current_account_id()).function_call(
            "on_claim_paid".to_string(),
            callback_args,
            NearToken::from_yoctonear(0),
            Gas::from_tgas(GAS_CALLBACK),
        ))
    }

    /// Money records move only here, after the transfer result is known. Never panics on a failed transfer.
    #[private]
    pub fn on_claim_paid(
        &mut self,
        merchant: AccountId,
        order_id: String,
        payout: U128,
        token_bps: u16,
        paid_bps: u16,
        response_hash: String,
    ) -> ClaimPreview {
        require!(env::predecessor_account_id() == env::current_account_id(), "ERR_NOT_PRIVATE");
        let key = (merchant.clone(), order_id.clone());
        let order = self.orders.get(&key).cloned();
        let token = order.as_ref().and_then(|o| o.token.clone());
        let callback_state = |token: Option<AccountId>| ClaimPreview {
            ok: false,
            error: Some("ERR_CALLBACK_STATE".into()),
            token_bps,
            paid_bps,
            payout,
            response_hash: response_hash.clone(),
            token,
        };
        let Some(order) = order else {
            return callback_state(token);
        };
        if order.status != "paying" {
            return callback_state(token);
        }
        if !promise_succeeded() {
            let o = self.orders.get_mut(&key).unwrap();
            o.status = "open".to_string();
            self.orders.flush();
            log_plain(&format!("PAYOUT_FAILED:{}", order_id));
            return ClaimPreview {
                ok: false,
                error: Some("ERR_PAYOUT_FAILED".into()),
                token_bps,
                paid_bps,
                payout: U128(0),
                response_hash,
                token,
            };
        }
        let bond_key = (merchant.clone(), token.clone());
        if let Some(b) = self.bonds.get_mut(&bond_key) {
            b.reserved = U128(b.reserved.0.saturating_sub(order.liability.0));
            b.bond = U128(b.bond.0.saturating_sub(payout.0));
            b.paid_out = U128(b.paid_out.0 + payout.0);
            self.bonds.flush();
        }
        let o = self.orders.get_mut(&key).unwrap();
        o.status = "claimed".to_string();
        o.paid = payout;
        o.paid_bps = paid_bps;
        self.orders.flush();
        emit(token.as_ref(), "promise_claimed", json!({
            "order_id": order_id, "merchant": merchant, "buyer": order.buyer,
            "token_bps": token_bps, "paid_bps": paid_bps, "payout": payout,
            "response_hash": response_hash,
        }));
        ClaimPreview { ok: true, error: None, token_bps, paid_bps, payout, response_hash, token }
    }

    // ---------------- views ----------------

    pub fn preview_claim(&self, merchant: AccountId, order_id: String, response_b64: Base64VecU8) -> ClaimPreview {
        match self.orders.get(&(merchant.clone(), order_id)) {
            Some(order) => self.evaluate(&merchant, order, &response_b64.0),
            None => ClaimPreview {
                ok: false,
                error: Some("ERR_NO_ORDER".into()),
                token_bps: 0,
                paid_bps: 0,
                payout: U128(0),
                response_hash: String::new(),
                token: None,
            },
        }
    }

    pub fn get_config(&self) -> Config {
        Config {
            api: 2,
            owner: self.owner.clone(),
            allowed_tokens: self.allowed_tokens.clone(),
            min_order_ttl_ms: U64(self.min_order_ttl_ms),
            max_order_ttl_ms: U64(MAX_ORDER_TTL_MS),
            default_order_ttl_ms: U64(DEFAULT_ORDER_TTL_MS),
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
    /// The NEAR bond in the v1 shape, so old readers keep working.
    pub fn get_merchant(&self, merchant: AccountId) -> Option<Merchant> {
        self.bonds.get(&(merchant, None)).map(|b| Merchant { bond: b.bond, reserved: b.reserved, paid_out: b.paid_out })
    }
    pub fn get_bond(&self, merchant: AccountId, token: Option<AccountId>) -> Option<Bond> {
        self.bonds.get(&(merchant, token)).cloned()
    }
    pub fn get_bonds(&self, merchant: AccountId) -> Vec<Bond> {
        let mut out = Vec::new();
        if let Some(b) = self.bonds.get(&(merchant.clone(), None)) {
            out.push(b.clone());
        }
        for t in &self.allowed_tokens {
            if let Some(b) = self.bonds.get(&(merchant.clone(), Some(t.clone()))) {
                out.push(b.clone());
            }
        }
        out
    }
    pub fn get_order(&self, merchant: AccountId, order_id: String) -> Option<Order> {
        self.orders.get(&(merchant, order_id)).cloned()
    }
    pub fn get_receipt(&self, merchant: AccountId, response_hash: String) -> Option<Receipt> {
        self.receipts.get(&(merchant, response_hash.to_lowercase())).cloned()
    }
}

impl Contract {
    fn storage_view(&self, account: &AccountId) -> Option<StorageBalanceView> {
        self.storage.get(account).map(|b| StorageBalanceView {
            total: b.total,
            available: U128(b.total.0 - b.used.0),
        })
    }

    /// Add `cost` to the account's used storage. False (and no change) when the balance is short.
    fn charge_storage(&mut self, account: &AccountId, cost: u128) -> bool {
        match self.storage.get_mut(account) {
            Some(b) if b.total.0.saturating_sub(b.used.0) >= cost => {
                b.used = U128(b.used.0 + cost);
                self.storage.flush();
                true
            }
            _ => false,
        }
    }

    /// Shared by claim (mutating) and preview_claim (view). Never panics.
    fn evaluate(&self, merchant: &AccountId, order: &Order, response_bytes: &[u8]) -> ClaimPreview {
        let response_hash = hex::encode(env::sha256_array(response_bytes));
        let err = |e: &str, token_bps: u16| ClaimPreview {
            ok: false,
            error: Some(e.to_string()),
            token_bps,
            paid_bps: 0,
            payout: U128(0),
            response_hash: response_hash.clone(),
            token: order.token.clone(),
        };
        match order.status.as_str() {
            "claimed" => return err("ERR_ALREADY_CLAIMED", 0),
            "paying" => return err("ERR_CLAIM_IN_PROGRESS", 0),
            "expired" => return err("ERR_ORDER_EXPIRED", 0),
            _ => {}
        }
        if env::block_timestamp_ms() >= order.expires_at_ms.0 {
            return err("ERR_ORDER_EXPIRED", 0);
        }
        let receipt = match self.receipts.get(&(merchant.clone(), response_hash.clone())) {
            Some(r) => r,
            None => return err("ERR_NO_RECEIPT_FOR_BYTES", 0),
        };
        if receipt.order_id != order.order_id || receipt.token != order.token {
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
        let payout = match order.amount.0.checked_mul(paid_bps as u128).map(|v| v / BPS_DENOMINATOR) {
            Some(v) => v,
            None => return err("ERR_AMOUNT", promise.bps),
        };
        if payout == 0 {
            return err("ERR_PAYOUT_ZERO", promise.bps);
        }
        ClaimPreview { ok: true, error: None, token_bps: promise.bps, paid_bps, payout: U128(payout), response_hash, token: order.token.clone() }
    }
}

/// The gas guard: claim / withdraw must leave enough gas for the transfer and its callback.
fn require_gas() {
    let left = env::prepaid_gas().as_gas().saturating_sub(env::used_gas().as_gas());
    require!(left >= GAS_GUARD * 1_000_000_000_000, "ERR_NOT_ENOUGH_GAS");
}

/// Did the first promise this method depends on succeed? Only `Failed` counts as a failure: a
/// successful call that returns data (`TooLong` for a zero-length bound) has still moved the money.
fn promise_succeeded() -> bool {
    !matches!(env::promise_result_checked(0, 0), Err(near_sdk::PromiseError::Failed))
}

#[cfg(test)]
mod tests;

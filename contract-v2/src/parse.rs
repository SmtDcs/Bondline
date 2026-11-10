//! Pure parsing helpers. No blockchain calls here, so every function is unit-testable.

use near_sdk::serde::Deserialize;

/// The fixed token prefix. Grammar (exact bytes, no spaces):
///   PROMISE|refund|order=<ORDER_ID>|bps=<BPS>
///   ORDER_ID = 1..=32 chars of [A-Za-z0-9-]
///   BPS      = 1..=5 ASCII digits, value 1..=10000, followed by end-of-string or a non-digit
pub const TOKEN_PREFIX: &str = "PROMISE|";
const TOKEN_BODY: &str = "PROMISE|refund|order=";
const BPS_SEP: &str = "|bps=";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPromise {
    pub order_id: String,
    pub bps: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSignedText {
    /// `Some(model)` for provider_tee text "<model>:<req>:<resp>", `None` for gateway text "<req>:<resp>".
    pub model: Option<String>,
    pub request_hash_hex: String,
    pub response_hash_hex: String,
}

fn is_lower_hex_64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Parse NEAR AI Cloud signed text. Splits from the RIGHT on ':' (model ids contain '/', never ':').
pub fn parse_signed_text(text: &str) -> Result<ParsedSignedText, &'static str> {
    let mut parts = text.rsplitn(3, ':');
    let resp = parts.next().ok_or("ERR_SIGNED_TEXT_FORMAT")?;
    let req = parts.next().ok_or("ERR_SIGNED_TEXT_FORMAT")?;
    let model = parts.next().map(|m| m.to_string());
    if !is_lower_hex_64(resp) || !is_lower_hex_64(req) {
        return Err("ERR_SIGNED_TEXT_FORMAT");
    }
    if let Some(m) = &model {
        if m.is_empty() {
            return Err("ERR_SIGNED_TEXT_FORMAT");
        }
    }
    Ok(ParsedSignedText {
        model,
        request_hash_hex: req.to_string(),
        response_hash_hex: resp.to_string(),
    })
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ChatResponse {
    choices: Vec<Choice>,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Choice {
    message: Message,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Message {
    content: Option<String>,
}

/// Extract `choices[0].message.content` from the exact Chat Completions response bytes.
/// Only this field is searched; `reasoning_content` and every other field are ignored.
pub fn extract_content(response_bytes: &[u8]) -> Result<String, &'static str> {
    let parsed: ChatResponse =
        near_sdk::serde_json::from_slice(response_bytes).map_err(|_| "ERR_RESPONSE_JSON")?;
    let first = parsed.choices.into_iter().next().ok_or("ERR_RESPONSE_NO_CHOICE")?;
    first.message.content.ok_or("ERR_RESPONSE_NO_CONTENT")
}

/// Find exactly one PROMISE token in `content` and parse it.
pub fn parse_promise(content: &str) -> Result<ParsedPromise, &'static str> {
    let count = content.matches(TOKEN_PREFIX).count();
    if count == 0 {
        return Err("ERR_NO_PROMISE_TOKEN");
    }
    if count > 1 {
        return Err("ERR_MULTIPLE_PROMISE_TOKENS");
    }
    let start = content.find(TOKEN_PREFIX).unwrap();
    let rest = &content[start..];
    let rest = rest.strip_prefix(TOKEN_BODY).ok_or("ERR_TOKEN_GRAMMAR")?;
    let sep = rest.find(BPS_SEP).ok_or("ERR_TOKEN_GRAMMAR")?;
    let order_id = &rest[..sep];
    if order_id.is_empty()
        || order_id.len() > 32
        || !order_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("ERR_TOKEN_ORDER_ID");
    }
    let after = &rest[sep + BPS_SEP.len()..];
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.len() > 5 {
        return Err("ERR_TOKEN_BPS");
    }
    let bps: u32 = digits.parse().map_err(|_| "ERR_TOKEN_BPS")?;
    if bps == 0 || bps > 10_000 {
        return Err("ERR_TOKEN_BPS");
    }
    Ok(ParsedPromise { order_id: order_id.to_string(), bps: bps as u16 })
}

/// Decode hex with optional "0x" prefix into exactly N bytes.
pub fn decode_hex_fixed<const N: usize>(s: &str) -> Result<[u8; N], &'static str> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let v = hex::decode(s).map_err(|_| "ERR_HEX")?;
    v.try_into().map_err(|_| "ERR_HEX_LENGTH")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_ok() {
        let p = parse_promise("Sorry.\nPROMISE|refund|order=A123|bps=2000").unwrap();
        assert_eq!(p, ParsedPromise { order_id: "A123".into(), bps: 2000 });
        let p = parse_promise("x PROMISE|refund|order=A-9|bps=10000\"}").unwrap();
        assert_eq!(p.bps, 10000);
    }

    #[test]
    fn token_errors() {
        assert_eq!(parse_promise("no promise here"), Err("ERR_NO_PROMISE_TOKEN"));
        assert_eq!(
            parse_promise("PROMISE|refund|order=A1|bps=1 PROMISE|refund|order=A1|bps=2"),
            Err("ERR_MULTIPLE_PROMISE_TOKENS")
        );
        assert_eq!(parse_promise("PROMISE|discount|order=A1|bps=1"), Err("ERR_TOKEN_GRAMMAR"));
        assert_eq!(parse_promise("PROMISE|refund|order=A 1|bps=1"), Err("ERR_TOKEN_ORDER_ID"));
        assert_eq!(parse_promise("PROMISE|refund|order=A1|bps=0"), Err("ERR_TOKEN_BPS"));
        assert_eq!(parse_promise("PROMISE|refund|order=A1|bps=10001"), Err("ERR_TOKEN_BPS"));
        assert_eq!(parse_promise("PROMISE|refund|order=A1|bps=123456"), Err("ERR_TOKEN_BPS"));
        assert_eq!(parse_promise("PROMISE|refund|order=A1|bps=x"), Err("ERR_TOKEN_BPS"));
    }

    #[test]
    fn signed_text_forms() {
        let h = "a".repeat(64);
        let t = parse_signed_text(&format!("z-ai/glm-5.3-flash:{h}:{h}")).unwrap();
        assert_eq!(t.model.as_deref(), Some("z-ai/glm-5.3-flash"));
        let g = parse_signed_text(&format!("{h}:{h}")).unwrap();
        assert_eq!(g.model, None);
        assert!(parse_signed_text(&format!("m:{h}:{}", "A".repeat(64))).is_err());
        assert!(parse_signed_text("m:abc:def").is_err());
    }

    #[test]
    fn content_only() {
        let r = br#"{"choices":[{"message":{"content":"PROMISE|refund|order=A1|bps=5","reasoning_content":"PROMISE|refund|order=A1|bps=9"}}]}"#;
        let c = extract_content(r).unwrap();
        assert_eq!(parse_promise(&c).unwrap().bps, 5);
        assert_eq!(extract_content(b"not json"), Err("ERR_RESPONSE_JSON"));
    }
}

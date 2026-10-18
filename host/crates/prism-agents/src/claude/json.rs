//! JavaScript semantics the TypeScript backend relied on, for JSON values:
//! truthiness, `Number.isFinite`, numbers that print like JS ones.

use serde_json::Value;

/// `!!value` in JavaScript.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `Number.isFinite(value) ? value : undefined`.
pub fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|f| f.is_finite())
}

/// A JS number as JSON: integral values print without a fraction, like
/// `JSON.stringify` does, so they compare equal to what the TS emitted.
pub fn js_number(value: f64) -> Value {
    const SAFE: f64 = 9_007_199_254_740_991.0;
    if value.fract() == 0.0 && value.abs() <= SAFE {
        if value == 0.0 {
            return Value::from(0u64);
        }
        return Value::from(value as i64);
    }
    serde_json::Number::from_f64(value).map(Value::Number).unwrap_or(Value::Null)
}

/// A string field, when it is a non-empty string.
pub fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `JSON.stringify(value)`: compact, keys in their original order.
pub fn stringify(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truthiness_follows_javascript() {
        for (v, t) in [(json!(null), false), (json!(false), false), (json!(0), false), (json!(""), false), (json!("x"), true), (json!(1), true), (json!([]), true), (json!({}), true)] {
            assert_eq!(truthy(Some(&v)), t, "{v}");
        }
        assert!(!truthy(None));
    }

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(js_number(60.0), json!(60));
        assert_eq!(js_number(-0.0), json!(0));
        assert_eq!(js_number(0.30000000000000004).to_string(), "0.30000000000000004");
        assert_eq!(js_number(1e300).as_f64(), Some(1e300));
    }
}

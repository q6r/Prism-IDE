//! Per-turn usage from a Claude `result`: port of `claudeTotals` and
//! `claudeTurnUsage` (src/shared/providerUsage.ts). `modelUsage` is the CLI's
//! running total for the process, summed over every model it called (main
//! loop, subagents, compaction); a turn is the difference from the totals
//! before it.

use serde_json::{Map, Value};

use super::json::{finite, js_number};

/// Running totals of one CLI process, summed over every model it called.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClaudeTotals {
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
    /// None when no model reported thinking tokens.
    pub thinking: Option<f64>,
    pub cost: f64,
}

/// A fresh session: nothing spent yet.
pub const NO_CLAUDE_TOTALS: ClaudeTotals = ClaudeTotals { input: 0.0, cache_read: 0.0, cache_write: 0.0, output: 0.0, thinking: None, cost: 0.0 };

/// `modelUsage` summed across models; None when the result carries none.
pub fn claude_totals(result: &Value) -> Option<ClaudeTotals> {
    let models: Vec<&Value> = match result.get("modelUsage")? {
        Value::Object(map) => map.values().collect(),
        Value::Array(items) => items.iter().collect(),
        _ => return None,
    };
    let mut totals = NO_CLAUDE_TOTALS;
    let mut any = false;
    for m in models {
        if !m.is_object() && !m.is_array() {
            continue;
        }
        any = true;
        if let Some(v) = finite(m.get("inputTokens")) {
            totals.input += v;
        }
        if let Some(v) = finite(m.get("cacheReadInputTokens")) {
            totals.cache_read += v;
        }
        if let Some(v) = finite(m.get("cacheCreationInputTokens")) {
            totals.cache_write += v;
        }
        if let Some(v) = finite(m.get("outputTokens")) {
            totals.output += v;
        }
        if let Some(v) = finite(m.get("thinkingTokens")) {
            totals.thinking = Some(totals.thinking.unwrap_or(0.0) + v);
        }
        if let Some(v) = finite(m.get("costUSD")) {
            totals.cost += v;
        }
    }
    if !any {
        return None;
    }
    if let Some(cost) = finite(result.get("total_cost_usd")) {
        totals.cost = cost;
    }
    Some(totals)
}

fn below(a: &ClaudeTotals, b: &ClaudeTotals) -> bool {
    a.input < b.input || a.cache_read < b.cache_read || a.cache_write < b.cache_write || a.output < b.output || a.cost < b.cost
}

fn spent(t: &ClaudeTotals) -> bool {
    t.input + t.cache_read + t.cache_write + t.output + t.cost > 0.0
}

const TURN_KEYS: [&str; 6] = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "costUsd"];

/// A per-turn capture with only finite, non-negative fields, or None.
fn turn_usage(fields: &[(&str, Option<f64>)]) -> Option<Value> {
    let mut out = Map::new();
    for key in TURN_KEYS {
        if let Some((_, Some(v))) = fields.iter().find(|(k, _)| *k == key)
            && v.is_finite()
            && *v >= 0.0
        {
            out.insert(key.to_string(), js_number(*v));
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// This result's own usage and the base for the process's next result.
/// `base`: `NO_CLAUDE_TOTALS` for a fresh session, the previous result's
/// totals within a live process, None when unknown (a resumed session).
/// Without a usable base the tokens fall back to the main loop's `usage`
/// and the cost stays unmeasured rather than guessed.
pub fn claude_turn_usage(result: &Value, base: Option<ClaudeTotals>) -> (Option<Value>, Option<ClaudeTotals>) {
    let totals = claude_totals(result);
    // A crashed or startup-error result can carry zeroed totals: no information.
    let next = match totals {
        Some(t) if spent(&t) || base.is_none() || !base.as_ref().is_some_and(spent) => Some(t),
        _ => base,
    };
    if let (Some(t), Some(b)) = (totals, base)
        && !below(&t, &b)
    {
        let mut fields = vec![
            ("inputTokens", Some(t.input - b.input)),
            ("cacheReadTokens", Some(t.cache_read - b.cache_read)),
            ("cacheWriteTokens", Some(t.cache_write - b.cache_write)),
            ("outputTokens", Some(t.output - b.output)),
            ("costUsd", Some(t.cost - b.cost)),
        ];
        if let Some(thinking) = t.thinking {
            fields.push(("reasoningTokens", Some((thinking - b.thinking.unwrap_or(0.0)).max(0.0))));
        }
        return (turn_usage(&fields), next);
    }
    let fallback = match result.get("usage") {
        Some(u @ Value::Object(_)) => turn_usage(&[
            ("inputTokens", finite(u.get("input_tokens"))),
            ("cacheReadTokens", finite(u.get("cache_read_input_tokens"))),
            ("cacheWriteTokens", finite(u.get("cache_creation_input_tokens"))),
            ("outputTokens", finite(u.get("output_tokens"))),
        ]),
        _ => None,
    };
    (fallback, next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mu(i: f64, o: f64, cr: f64, cw: f64, th: Option<f64>, cost: f64) -> Value {
        let mut m = json!({"inputTokens": i, "outputTokens": o, "cacheReadInputTokens": cr, "cacheCreationInputTokens": cw, "costUSD": cost});
        if let Some(th) = th {
            m["thinkingTokens"] = json!(th);
        }
        m
    }
    fn near(a: &Value, b: f64) {
        assert!((a.as_f64().unwrap() - b).abs() < 1e-9, "{a} != {b}");
    }

    // Mirrors tests/usage-turn.test.cjs (claudeTotals / claudeTurnUsage).
    #[test]
    fn totals_sum_models_and_total_cost_wins() {
        assert_eq!(claude_totals(&json!({})), None);
        assert_eq!(claude_totals(&json!({"modelUsage": null})), None);
        assert_eq!(claude_totals(&json!({"modelUsage": {}})), None);
        let t = claude_totals(&json!({"modelUsage": {"a": mu(100.0, 50.0, 1000.0, 200.0, Some(10.0), 0.5), "b": mu(10.0, 5.0, 100.0, 20.0, Some(4.0), 0.25)}})).unwrap();
        assert_eq!((t.input, t.cache_read, t.cache_write, t.output, t.thinking), (110.0, 1100.0, 220.0, 55.0, Some(14.0)));
        assert!((t.cost - 0.75).abs() < 1e-9);
        assert_eq!(claude_totals(&json!({"modelUsage": {"a": mu(1.0, 1.0, 1.0, 1.0, None, 0.1)}})).unwrap().thinking, None);
        assert_eq!(claude_totals(&json!({"modelUsage": {"a": mu(1.0, 1.0, 1.0, 1.0, None, 0.1), "b": mu(1.0, 1.0, 1.0, 1.0, Some(3.0), 0.1)}})).unwrap().thinking, Some(3.0));
        assert_eq!(claude_totals(&json!({"modelUsage": {"a": mu(1.0, 1.0, 1.0, 1.0, Some(1.0), 0.1)}, "total_cost_usd": 2})).unwrap().cost, 2.0);
    }

    #[test]
    fn fresh_session_turn_is_the_whole_total() {
        let r = json!({"modelUsage": {"a": mu(100.0, 50.0, 1000.0, 200.0, Some(10.0), 0.5)}, "total_cost_usd": 0.5});
        let (turn, next) = claude_turn_usage(&r, Some(NO_CLAUDE_TOTALS));
        assert_eq!(turn.unwrap(), json!({"inputTokens": 100, "cacheReadTokens": 1000, "cacheWriteTokens": 200, "outputTokens": 50, "reasoningTokens": 10, "costUsd": 0.5}));
        assert_eq!(next.unwrap().input, 100.0);
    }

    #[test]
    fn known_base_gives_the_difference() {
        let base = claude_totals(&json!({"modelUsage": {"a": mu(100.0, 50.0, 1000.0, 200.0, Some(10.0), 0.5)}}));
        let (turn, next) = claude_turn_usage(&json!({"modelUsage": {"a": mu(160.0, 90.0, 1500.0, 250.0, Some(14.0), 0.8)}}), base);
        let turn = turn.unwrap();
        assert_eq!(turn["inputTokens"], json!(60));
        assert_eq!(turn["outputTokens"], json!(40));
        assert_eq!(turn["cacheReadTokens"], json!(500));
        assert_eq!(turn["cacheWriteTokens"], json!(50));
        assert_eq!(turn["reasoningTokens"], json!(4));
        near(&turn["costUsd"], 0.3);
        assert!((next.unwrap().cost - 0.8).abs() < 1e-9);
    }

    #[test]
    fn unknown_base_falls_back_without_cost() {
        let r = json!({"modelUsage": {"a": mu(160.0, 90.0, 1500.0, 250.0, Some(14.0), 0.8)}, "usage": {"input_tokens": 7, "cache_read_input_tokens": 8, "cache_creation_input_tokens": 9, "output_tokens": 6}, "total_cost_usd": 0.8});
        let (turn, next) = claude_turn_usage(&r, None);
        assert_eq!(turn.unwrap(), json!({"inputTokens": 7, "cacheReadTokens": 8, "cacheWriteTokens": 9, "outputTokens": 6}));
        assert_eq!(next.unwrap().input, 160.0);
    }

    #[test]
    fn totals_below_base_fall_back_and_replace_the_base() {
        let base = claude_totals(&json!({"modelUsage": {"a": mu(500.0, 500.0, 500.0, 500.0, Some(5.0), 5.0)}}));
        let (turn, next) = claude_turn_usage(&json!({"modelUsage": {"a": mu(10.0, 10.0, 10.0, 10.0, Some(1.0), 0.1)}, "usage": {"input_tokens": 1, "output_tokens": 2}}), base);
        assert_eq!(turn.unwrap(), json!({"inputTokens": 1, "outputTokens": 2}));
        assert_eq!(next.unwrap().input, 10.0);
    }

    #[test]
    fn zeroed_result_after_a_spent_base_keeps_the_base() {
        let base = claude_totals(&json!({"modelUsage": {"a": mu(100.0, 50.0, 0.0, 0.0, Some(0.0), 0.5)}}));
        let (turn, next) = claude_turn_usage(&json!({"modelUsage": {"a": mu(0.0, 0.0, 0.0, 0.0, Some(0.0), 0.0)}}), base);
        assert_eq!(next, base);
        assert_eq!(turn, None);
    }

    #[test]
    fn no_model_usage_keeps_the_base_and_falls_back() {
        let base = claude_totals(&json!({"modelUsage": {"a": mu(100.0, 50.0, 0.0, 0.0, Some(0.0), 0.5)}}));
        let (turn, next) = claude_turn_usage(&json!({"usage": {"input_tokens": 3, "output_tokens": 4}}), base);
        assert_eq!(next, base);
        assert_eq!(turn.unwrap(), json!({"inputTokens": 3, "outputTokens": 4}));
        assert_eq!(claude_turn_usage(&json!({}), None).0, None);
    }
}

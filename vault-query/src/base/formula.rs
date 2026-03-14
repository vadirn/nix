use crate::frontmatter;
use crate::vault::VaultFile;
use std::collections::BTreeMap;

/// Evaluate a formula expression for a given file.
///
/// Supported syntax:
/// - `if(cond, then, else)` with nesting
/// - Arithmetic: `+`, `-`, `*`, `/`
/// - `.round(N)` method
/// - Comparisons: `>`, `<`, `==`, `!=`
/// - String literals: `"text"`
/// - Property references: `field_name`
pub fn evaluate(expr: &str, file: &VaultFile) -> String {
    let ctx = EvalContext { file };
    match eval_expr(expr.trim(), &ctx) {
        EvalResult::Number(n) => format_number(n),
        EvalResult::Str(s) => s,
        EvalResult::Bool(b) => b.to_string(),
        EvalResult::Empty => String::new(),
    }
}

/// Evaluate all formulas defined in a base file for a given vault file.
pub fn evaluate_all(
    formulas: &BTreeMap<String, String>,
    file: &VaultFile,
) -> BTreeMap<String, String> {
    formulas
        .iter()
        .map(|(name, expr)| (name.clone(), evaluate(expr, file)))
        .collect()
}

struct EvalContext<'a> {
    file: &'a VaultFile,
}

#[derive(Debug, Clone)]
enum EvalResult {
    Number(f64),
    Str(String),
    Bool(bool),
    Empty,
}

impl EvalResult {
    fn as_f64(&self) -> Option<f64> {
        match self {
            EvalResult::Number(n) => Some(*n),
            EvalResult::Str(s) => s.parse::<f64>().ok(),
            _ => None,
        }
    }

    fn as_str(&self) -> String {
        match self {
            EvalResult::Number(n) => format_number(*n),
            EvalResult::Str(s) => s.clone(),
            EvalResult::Bool(b) => b.to_string(),
            EvalResult::Empty => String::new(),
        }
    }

    fn is_truthy(&self) -> bool {
        match self {
            EvalResult::Bool(b) => *b,
            EvalResult::Number(n) => *n != 0.0,
            EvalResult::Str(s) => !s.is_empty(),
            EvalResult::Empty => false,
        }
    }
}

fn format_number(n: f64) -> String {
    if n == n.floor() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

fn eval_expr(expr: &str, ctx: &EvalContext) -> EvalResult {
    let expr = expr.trim();

    if expr.is_empty() {
        return EvalResult::Empty;
    }

    // String literal
    if expr.starts_with('"') && expr.ends_with('"') && expr.len() >= 2 {
        return EvalResult::Str(expr[1..expr.len() - 1].to_string());
    }

    // Empty string literal
    if expr == "\"\"" {
        return EvalResult::Str(String::new());
    }

    // if(cond, then, else)
    if expr.starts_with("if(") && expr.ends_with(')') {
        let inner = &expr[3..expr.len() - 1];
        if let Some((cond, then_expr, else_expr)) = split_if_args(inner) {
            let cond_result = eval_condition(cond.trim(), ctx);
            return if cond_result {
                eval_expr(then_expr.trim(), ctx)
            } else {
                eval_expr(else_expr.trim(), ctx)
            };
        }
    }

    // Parenthesized expression with .round(N)
    if let Some(round_pos) = expr.find(".round(") {
        let inner = &expr[..round_pos];
        let round_arg = &expr[round_pos + 7..expr.len() - 1];
        let decimals: u32 = round_arg.parse().unwrap_or(0);
        let result = eval_expr(inner, ctx);
        if let Some(n) = result.as_f64() {
            let factor = 10f64.powi(decimals as i32);
            return EvalResult::Number((n * factor).round() / factor);
        }
        return result;
    }

    // Parenthesized expression
    if expr.starts_with('(') && expr.ends_with(')') {
        return eval_expr(&expr[1..expr.len() - 1], ctx);
    }

    // Arithmetic: find the last +/- at top level, then */
    if let Some(result) = try_arithmetic(expr, ctx) {
        return result;
    }

    // Numeric literal
    if let Ok(n) = expr.parse::<f64>() {
        return EvalResult::Number(n);
    }

    // Boolean literal
    if expr == "true" {
        return EvalResult::Bool(true);
    }
    if expr == "false" {
        return EvalResult::Bool(false);
    }

    // Property reference
    if let Some(n) = frontmatter::get_f64(&ctx.file.frontmatter, expr) {
        return EvalResult::Number(n);
    }
    let s = frontmatter::get_display(&ctx.file.frontmatter, expr);
    if !s.is_empty() {
        return EvalResult::Str(s);
    }

    EvalResult::Empty
}

fn eval_condition(expr: &str, ctx: &EvalContext) -> bool {
    let expr = expr.trim();

    // field == "value"
    if let Some(pos) = expr.find(" == ") {
        let left = eval_expr(&expr[..pos], ctx);
        let right = eval_expr(&expr[pos + 4..], ctx);
        return left.as_str() == right.as_str();
    }

    // field != "value"
    if let Some(pos) = expr.find(" != ") {
        let left = eval_expr(&expr[..pos], ctx);
        let right = eval_expr(&expr[pos + 4..], ctx);
        return left.as_str() != right.as_str();
    }

    // field > N
    if let Some(pos) = expr.find(" > ") {
        let left = eval_expr(&expr[..pos], ctx);
        let right = eval_expr(&expr[pos + 3..], ctx);
        if let (Some(l), Some(r)) = (left.as_f64(), right.as_f64()) {
            return l > r;
        }
    }

    // field < N
    if let Some(pos) = expr.find(" < ") {
        let left = eval_expr(&expr[..pos], ctx);
        let right = eval_expr(&expr[pos + 3..], ctx);
        if let (Some(l), Some(r)) = (left.as_f64(), right.as_f64()) {
            return l < r;
        }
    }

    eval_expr(expr, ctx).is_truthy()
}

/// Split if(cond, then, else) arguments respecting nested parens.
fn split_if_args(s: &str) -> Option<(&str, &str, &str)> {
    let mut depth = 0;
    let mut commas = Vec::new();
    let bytes = s.as_bytes();
    let mut in_string = false;

    for (i, &b) in bytes.iter().enumerate() {
        if b == b'"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match b {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b',' if depth == 0 => commas.push(i),
            _ => {}
        }
    }

    if commas.len() >= 2 {
        Some((&s[..commas[0]], &s[commas[0] + 1..commas[1]], &s[commas[1] + 1..]))
    } else {
        None
    }
}

fn try_arithmetic(expr: &str, ctx: &EvalContext) -> Option<EvalResult> {
    let bytes = expr.as_bytes();
    let mut depth = 0;
    let mut in_string = false;

    // Find last + or - at depth 0 (lowest precedence)
    let mut last_add_sub = None;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match b {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b'+' | b'-' if depth == 0 && i > 0 => last_add_sub = Some(i),
            _ => {}
        }
    }

    if let Some(pos) = last_add_sub {
        let left = eval_expr(&expr[..pos], ctx);
        let right = eval_expr(&expr[pos + 1..], ctx);
        if let (Some(l), Some(r)) = (left.as_f64(), right.as_f64()) {
            return Some(EvalResult::Number(if bytes[pos] == b'+' {
                l + r
            } else {
                l - r
            }));
        }
    }

    // Find last * or / at depth 0
    depth = 0;
    in_string = false;
    let mut last_mul_div = None;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match b {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b'*' | b'/' if depth == 0 => last_mul_div = Some(i),
            _ => {}
        }
    }

    if let Some(pos) = last_mul_div {
        let left = eval_expr(&expr[..pos], ctx);
        let right = eval_expr(&expr[pos + 1..], ctx);
        if let (Some(l), Some(r)) = (left.as_f64(), right.as_f64()) {
            return Some(EvalResult::Number(if bytes[pos] == b'*' {
                l * r
            } else if r != 0.0 {
                l / r
            } else {
                0.0
            }));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_yaml::Value;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn make_file(props: Vec<(&str, Value)>) -> VaultFile {
        let mut fm = BTreeMap::new();
        for (k, v) in props {
            fm.insert(k.to_string(), v);
        }
        VaultFile {
            path: PathBuf::from("/vault/test.md"),
            name: "test".to_string(),
            frontmatter: fm,
            content: String::new(),
        }
    }

    #[test]
    fn test_cost_per_line() {
        let f = make_file(vec![
            ("cost_usd", Value::Number(serde_yaml::Number::from(2.5))),
            ("lines_written", Value::Number(100.into())),
        ]);
        let result = evaluate(
            r#"if(lines_written > 0, (cost_usd / lines_written).round(3), "")"#,
            &f,
        );
        assert_eq!(result, "0.025");
    }

    #[test]
    fn test_cost_per_line_zero_lines() {
        let f = make_file(vec![
            ("cost_usd", Value::Number(serde_yaml::Number::from(2.5))),
            ("lines_written", Value::Number(0.into())),
        ]);
        let result = evaluate(
            r#"if(lines_written > 0, (cost_usd / lines_written).round(3), "")"#,
            &f,
        );
        assert_eq!(result, "");
    }

    #[test]
    fn test_nested_if_status_order() {
        let f = make_file(vec![(
            "status",
            Value::String("in progress".into()),
        )]);
        let result = evaluate(
            r#"if(status == "planned", "1 planned", if(status == "in progress", "2 in progress", if(status == "done", "3 done", "4 archived")))"#,
            &f,
        );
        assert_eq!(result, "2 in progress");
    }

    #[test]
    fn test_nested_if_status_planned() {
        let f = make_file(vec![("status", Value::String("planned".into()))]);
        let result = evaluate(
            r#"if(status == "planned", "1 planned", if(status == "in progress", "2 in progress", if(status == "done", "3 done", "4 archived")))"#,
            &f,
        );
        assert_eq!(result, "1 planned");
    }

    #[test]
    fn test_nested_if_status_done() {
        let f = make_file(vec![("status", Value::String("done".into()))]);
        let result = evaluate(
            r#"if(status == "planned", "1 planned", if(status == "in progress", "2 in progress", if(status == "done", "3 done", "4 archived")))"#,
            &f,
        );
        assert_eq!(result, "3 done");
    }

    #[test]
    fn test_lines_per_turn() {
        let f = make_file(vec![
            ("lines_written", Value::Number(100.into())),
            ("turns_to_edit", Value::Number(10.into())),
        ]);
        let result = evaluate(
            r#"if(turns_to_edit > 0, (lines_written / turns_to_edit).round(1), "")"#,
            &f,
        );
        assert_eq!(result, "10");
    }
}

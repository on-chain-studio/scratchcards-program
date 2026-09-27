//! Refreshes `scripts/prices.json` from a live feed.
//!
//! The balance of the whole sheet is a function of what the payout tokens are worth, and the chain
//! has no idea — so every prize `tools/sheet` solves rests on this file. Fetch before rebalancing,
//! and rebalance again whenever these move far. The devnet mints are throwaways with no market, so
//! prices come from the real tokens they stand in for: this table is the only place a devnet mint
//! is tied to something with a price, and getting one wrong silently mis-values a card.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use casino_ops::{Endpoint, Pubkey};
use serde_json::{json, Map, Value};

use crate::sheet::prices_path;

const API: &str = "https://api.coingecko.com/api/v3";
const MAINNET: &str = "https://api.mainnet-beta.solana.com";

/// Payout token → the real asset it stands in for.
const IDS: [(&str, &str); 14] = [
    ("SOL", "solana"),
    ("BONK", "bonk"),
    ("PENGU", "pudgy-penguins"),
    ("MEW", "cat-in-a-dogs-world"),
    ("WIF", "dogwifcoin"),
    ("PUMP", "pump-fun"),
    ("SKR", "seeker"),
    ("POPCAT", "popcat"),
    ("JTO", "jito-governance-token"),
    ("FART", "fartcoin"),
    ("PYTH", "pyth-network"),
    ("RAY", "raydium"),
    ("JUP", "jupiter-exchange-solana"),
    ("USDC", "usd-coin"),
];

const NOTE: &str = "Written by scratch-ops fetch-prices — run that rather than editing by hand, then re-run \
tools/sheet/rebalance.ts, because every amount on the sheet is set against these. Top level is USD per \
whole token; _decimals and _mints come from the mainnet mint accounts, _mcap and _volume are how liquid a \
payout token is.";

/// Mainnet decimals and mint, per token. A prize is stored in base units, so decimals decide what
/// a stored amount is worth. Decimals are fixed at mint creation, so anything already known is
/// kept; the rest come from CoinGecko's list (the contract address) and then the mint accounts
/// themselves, the only authority that cannot be stale.
async fn decimals(http: &reqwest::Client, before: &Value) -> Result<(Map<String, Value>, Map<String, Value>)> {
    let mut decimals = before["_decimals"].as_object().cloned().unwrap_or_default();
    let mut mints = before["_mints"].as_object().cloned().unwrap_or_default();
    decimals.insert("SOL".into(), json!(9));
    mints.insert("SOL".into(), json!("So11111111111111111111111111111111111111112"));
    let todo: Vec<(&str, &str)> = IDS.iter().copied().filter(|(s, _)| !decimals.get(*s).is_some_and(Value::is_number)).collect();
    if todo.is_empty() {
        return Ok((decimals, mints));
    }
    let list: Vec<Value> = http.get(format!("{API}/coins/list?include_platform=true")).send().await?.json().await?;
    let mut want = Vec::new();
    for (symbol, id) in &todo {
        match list.iter().find(|c| c["id"] == *id).and_then(|c| c["platforms"]["solana"].as_str()) {
            Some(mint) => {
                mints.insert(symbol.to_string(), json!(mint));
                want.push((symbol.to_string(), mint.parse::<Pubkey>().map_err(|e| anyhow::anyhow!("{e:?}"))?));
            }
            None => eprintln!("  {symbol}: no Solana mint on CoinGecko"),
        }
    }
    let keys: Vec<Pubkey> = want.iter().map(|(_, m)| *m).collect();
    let accounts = Endpoint::new(MAINNET, None, false).connection.get_multiple_accounts(&keys).await?;
    for ((symbol, mint), account) in want.iter().zip(accounts) {
        // The mint layout: an authority option (36) and the supply (8), then the decimals — the
        // same in Token-2022.
        match account.and_then(|a| a.data.get(44).copied()) {
            Some(d) => {
                decimals.insert(symbol.clone(), json!(d));
                println!("  {symbol:<7} {d:>2} decimals   {mint}");
            }
            None => eprintln!("  {symbol}: mint {mint} not found"),
        }
    }
    Ok((decimals, mints))
}

pub async fn fetch(http: &reqwest::Client) -> Result<()> {
    let path = prices_path();
    let before: Value = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    let ids: Vec<&str> = IDS.iter().map(|(_, id)| *id).collect();
    let reply = http
        .get(format!("{API}/simple/price?ids={}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true", ids.join(",")))
        .send()
        .await?;
    if !reply.status().is_success() {
        bail!("the price feed returned {}", reply.status());
    }
    let quoted: Value = reply.json().await?;

    let mut out = Map::new();
    out.insert("_note".into(), json!(NOTE));
    out.insert("_fetched".into(), json!(iso_now()));
    let (mut mcap, mut volume, mut missing) = (Map::new(), Map::new(), Vec::new());
    for (symbol, id) in IDS {
        let Some(usd) = quoted[id]["usd"].as_f64() else {
            missing.push(format!("{symbol} ({id})"));
            continue;
        };
        out.insert(symbol.into(), json!(usd));
        if let Some(cap) = quoted[id]["usd_market_cap"].as_f64() {
            mcap.insert(symbol.into(), json!(cap));
        }
        if let Some(vol) = quoted[id]["usd_24h_vol"].as_f64() {
            volume.insert(symbol.into(), json!(vol));
        }
    }
    if !missing.is_empty() {
        bail!("no quote for {} — leaving prices.json alone", missing.join(", "));
    }
    let (decimals, mints) = decimals(http, &before).await.context("reading the mints' decimals")?;
    let unknown: Vec<&str> = IDS.iter().map(|(s, _)| *s).filter(|s| !decimals.contains_key(*s)).collect();
    out.insert("_decimals".into(), Value::Object(decimals));
    out.insert("_mints".into(), Value::Object(mints));
    out.insert("_mcap".into(), Value::Object(mcap.clone()));
    out.insert("_volume".into(), Value::Object(volume.clone()));
    if !unknown.is_empty() {
        eprintln!("\n⚠ no decimals for {} — those payouts cannot be valued", unknown.join(", "));
    }
    std::fs::write(&path, serde_json::to_string_pretty(&Value::Object(out.clone()))? + "\n")?;

    let big = |n: Option<f64>| match n {
        None => "—".to_string(),
        Some(n) if n >= 1e9 => format!("${:.1}B", n / 1e9),
        Some(n) => format!("${:.0}M", n / 1e6),
    };
    for (symbol, _) in IDS {
        let now = out[symbol].as_f64().unwrap_or(0.0);
        let moved = match before[symbol].as_f64() {
            Some(was) if was > 0.0 => format!("{:+.0}%", (now - was) / was * 100.0),
            _ => "new".into(),
        };
        let price = if now >= 0.01 { format!("{now:.4}") } else { format!("{now:.3e}") };
        println!(
            "{symbol:<7} ${price:>10}   {moved:>7}   cap {:>7}   vol {:>7}",
            big(mcap.get(symbol).and_then(Value::as_f64)),
            big(volume.get(symbol).and_then(Value::as_f64))
        );
    }
    println!("\n→ scripts/prices.json   now re-run: (cd tools/sheet && npx vite-node rebalance.ts)");
    Ok(())
}

/// Now as ISO 8601 in UTC with milliseconds — what the sheet tool's age check parses.
fn iso_now() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, millis) = (now.as_secs() as i64, now.subsec_millis());
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_timestamp_reads_as_iso() {
        let now = super::iso_now();
        assert_eq!(now.len(), 24);
        assert!(now.starts_with("20") && now.ends_with('Z') && &now[10..11] == "T");
    }
}

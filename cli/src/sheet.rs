//! The card sheet: `tools/sheet/cards.json` as the balancing tool writes it, the mints its tokens
//! stand for on each cluster, the prices every prize is set against — and the sheet as the chain
//! holds it, which is a different question from what the sheet says it should be.
//!
//! Amounts go on chain exactly as the sheet holds them, in mainnet base units on both clusters:
//! the devnet stand-in mints are 0-decimal throwaways, but publishing the same integers on devnet
//! that mainnet will hold is the whole point of rehearsing there. What differs by cluster is the
//! pool's weights: devnet pays SOL alone, so the house there needs no token float at all.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use casino_ops::Pubkey;
use scratch_cards::instructions::set_card::{InitBlock, InitPay, InitPoolEntry, InitTier, SetCard};
use scratch_cards::state::config::*;
use serde::Deserialize;
use serde_json::Value;

pub fn repo(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(path)
}

pub fn sheet_path() -> PathBuf {
    repo("tools/sheet/cards.json")
}
pub fn prices_path() -> PathBuf {
    repo("scripts/prices.json")
}
pub fn devnet_path() -> PathBuf {
    repo("scripts/devnet.json")
}

#[derive(Deserialize, Debug, Clone)]
pub struct Block {
    pub role: String,
    pub count: u8,
    pub cols: u8,
    #[serde(default)]
    pub flags: u8,
    #[serde(default)]
    pub a: u16,
    #[serde(default)]
    pub b: u16,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Pay {
    pub scope: u32,
    pub weight: u32,
    pub min: u8,
    #[serde(default)]
    pub flags: u8,
    pub mult: u16,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Tier {
    pub factor: u32,
    pub weight: u32,
}

#[derive(Deserialize, Debug, Clone)]
pub struct PoolEntry {
    pub token: String,
    pub weight: u32,
    pub amount: u64,
}

/// One card as the balancing tool writes it.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub mode: String,
    pub roll: String,
    pub price_lamports: u64,
    pub mode_args: [u16; 4],
    pub jackpot_hit_weight: u32,
    pub jackpot_near_weight: u32,
    pub blocks: Vec<Block>,
    pub pays: Vec<Pay>,
    pub tiers: Vec<Tier>,
    pub pool: Vec<PoolEntry>,
}

pub fn load(path: &Path) -> Result<Vec<Card>> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("{} is not a card sheet", path.display()))
}

/// The payout tokens, by the symbol the sheet names them with.
pub const TOKENS: [&str; 12] = ["BONK", "PENGU", "MEW", "WIF", "PUMP", "SKR", "POPCAT", "JTO", "FART", "PYTH", "RAY", "JUP"];

/// Which mint each token is on this cluster: the devnet stand-ins in `scripts/devnet.json`, or the
/// real mints `fetch-prices` read off mainnet into `scripts/prices.json`. SOL is the all-zero mint
/// everywhere and is never looked up.
#[derive(Clone, Debug, Default)]
pub struct Mints(pub BTreeMap<String, Pubkey>);

impl Mints {
    pub fn load(mainnet: bool) -> Result<Self> {
        let (path, field) = if mainnet { (prices_path(), "_mints") } else { (devnet_path(), "mints") };
        let text = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        let json: Value = serde_json::from_str(&text)?;
        let mut mints = BTreeMap::new();
        for (symbol, mint) in json[field].as_object().into_iter().flatten() {
            // Wrapped SOL is in prices.json for the price feed; native SOL is the zero mint.
            if symbol == "SOL" {
                continue;
            }
            if let Some(mint) = mint.as_str().and_then(|m| m.parse().ok()) {
                mints.insert(symbol.clone(), mint);
            }
        }
        Ok(Mints(mints))
    }

    pub fn mint(&self, symbol: &str) -> Result<Pubkey> {
        if symbol == "SOL" {
            return Ok(Pubkey::default());
        }
        self.0.get(symbol).copied().with_context(|| format!("no mint for {symbol} on this cluster"))
    }

    /// The symbol a mint stands for, or its key shortened.
    pub fn symbol(&self, mint: &Pubkey) -> String {
        if *mint == Pubkey::default() {
            return "SOL".into();
        }
        self.0.iter().find(|(_, m)| *m == mint).map(|(s, _)| s.clone()).unwrap_or_else(|| casino_ops::short(mint))
    }
}

/// `scripts/prices.json`: USD per whole token, and each token's mainnet decimals.
#[derive(Clone, Debug, Default)]
pub struct Prices {
    pub usd: BTreeMap<String, f64>,
    pub decimals: BTreeMap<String, u32>,
}

impl Prices {
    pub fn load() -> Result<Self> {
        let path = prices_path();
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?)?;
        let mut prices = Prices::default();
        for (key, value) in json.as_object().into_iter().flatten() {
            if let Some(usd) = value.as_f64() {
                prices.usd.insert(key.clone(), usd);
            }
        }
        for (key, value) in json["_decimals"].as_object().into_iter().flatten() {
            if let Some(decimals) = value.as_u64() {
                prices.decimals.insert(key.clone(), decimals as u32);
            }
        }
        prices.decimals.entry("SOL".into()).or_insert(9);
        Ok(prices)
    }

    /// Base units as whole tokens: the mainnet decimals, on every cluster.
    pub fn whole(&self, symbol: &str, units: u64) -> f64 {
        units as f64 / 10f64.powi(*self.decimals.get(symbol).unwrap_or(&0) as i32)
    }
}

/// The pool's weights as published on this cluster. Mainnet takes the sheet's own. Devnet pays
/// SOL alone: the pool must partition 2^32 exactly and one `u32` cannot hold that, so the SOL rung
/// carries 2^32 − 1 and the first token rung the leftover 1 — a once-in-4.3-billion hit, never
/// funded.
pub fn pool_weights(card: &Card, mainnet: bool) -> Result<Vec<u32>> {
    if mainnet {
        return Ok(card.pool.iter().map(|e| e.weight).collect());
    }
    if !card.pool.iter().any(|e| e.token == "SOL") {
        bail!("{}: no SOL rung to carry the devnet pool", card.id);
    }
    let first_token = card.pool.iter().position(|e| e.token != "SOL");
    Ok(card
        .pool
        .iter()
        .enumerate()
        .map(|(i, e)| if e.token == "SOL" { u32::MAX } else if Some(i) == first_token { 1 } else { 0 })
        .collect())
}

fn role(name: &str) -> Result<u8> {
    Ok(match name {
        "plate" => ROLE_PLATE,
        "number" => ROLE_NUMBER,
        "mark" => ROLE_MARK,
        "jackpot" => ROLE_JACKPOT,
        other => bail!("no block role {other:?}"),
    })
}

impl Card {
    /// The program's `SetCard` for publishing this card at `index` on this cluster.
    pub fn set_card(&self, index: u8, mints: &Mints, mainnet: bool) -> Result<SetCard> {
        let weights = pool_weights(self, mainnet)?;
        Ok(SetCard {
            index,
            mode: match self.mode.as_str() {
                "count" => MODE_COUNT,
                "compare" => MODE_COMPARE,
                other => bail!("{}: no mode {other:?}", self.id),
            },
            roll: match self.roll.as_str() {
                "exclusive" => ROLL_EXCLUSIVE,
                "independent" => ROLL_INDEPENDENT,
                other => bail!("{}: no roll {other:?}", self.id),
            },
            price_lamports: self.price_lamports,
            jackpot_hit: self.jackpot_hit_weight,
            jackpot_near: self.jackpot_near_weight,
            mode_args: self.mode_args,
            blocks: self
                .blocks
                .iter()
                .map(|b| Ok(InitBlock { role: role(&b.role)?, count: b.count, cols: b.cols, flags: b.flags, a: b.a, b: b.b }))
                .collect::<Result<_>>()?,
            pays: self.pays.iter().map(|p| InitPay { scope: p.scope, weight: p.weight, min: p.min, flags: p.flags, mult: p.mult }).collect(),
            tiers: self.tiers.iter().map(|t| InitTier { factor: t.factor, weight: t.weight }).collect(),
            pool: self
                .pool
                .iter()
                .zip(weights)
                .map(|(e, weight)| Ok(InitPoolEntry { mint: mints.mint(&e.token)?.to_bytes(), amount: e.amount, weight }))
                .collect::<Result<_>>()?,
        })
    }
}

/// The card the program writes for `set`, as `SetCard::process` copies it into its slot.
pub fn expected(set: &SetCard) -> CardConfig {
    let mut card: CardConfig = bytemuck::Zeroable::zeroed();
    card.price_lamports = set.price_lamports;
    card.jackpot_hit = set.jackpot_hit;
    card.jackpot_near = set.jackpot_near;
    card.mode = set.mode;
    card.roll = set.roll;
    card.block_len = set.blocks.len() as u8;
    card.pay_len = set.pays.len() as u8;
    card.tier_len = set.tiers.len() as u8;
    card.pool_len = set.pool.len() as u8;
    card.mode_args = set.mode_args;
    for (dst, b) in card.blocks.iter_mut().zip(&set.blocks) {
        *dst = scratch_cards::state::config::Block { role: b.role, count: b.count, cols: b.cols, flags: b.flags, a: b.a, b: b.b };
    }
    for (dst, p) in card.pays.iter_mut().zip(&set.pays) {
        *dst = scratch_cards::state::config::Pay { scope: p.scope, weight: p.weight, min: p.min, flags: p.flags, mult: p.mult };
    }
    for (dst, t) in card.tiers.iter_mut().zip(&set.tiers) {
        *dst = scratch_cards::state::config::Tier { factor: t.factor, weight: t.weight };
    }
    for (dst, e) in card.pool.iter_mut().zip(&set.pool) {
        *dst = scratch_cards::state::config::PoolEntry { mint: e.mint, amount: e.amount, weight: e.weight, _pad: 0 };
    }
    card
}

/// Every field of a card on the chain that differs from the one wanted — every one, not a chosen
/// few: a verifier that only checks the fields someone thought to list gives its most convincing
/// answer exactly when it is wrong.
pub fn differences(chain: &CardConfig, want: &CardConfig, mints: &Mints) -> Vec<String> {
    let mut out = Vec::new();
    let mut check = |name: String, got: String, wanted: String| {
        if got != wanted {
            out.push(format!("{name}: chain {got}, sheet {wanted}"));
        }
    };
    check("price".into(), chain.price_lamports.to_string(), want.price_lamports.to_string());
    check("jackpot hit".into(), chain.jackpot_hit.to_string(), want.jackpot_hit.to_string());
    check("jackpot near".into(), chain.jackpot_near.to_string(), want.jackpot_near.to_string());
    check("mode".into(), chain.mode.to_string(), want.mode.to_string());
    check("roll".into(), chain.roll.to_string(), want.roll.to_string());
    check("mode args".into(), format!("{:?}", chain.mode_args), format!("{:?}", want.mode_args));
    check("blocks".into(), chain.block_len.to_string(), want.block_len.to_string());
    check("pays".into(), chain.pay_len.to_string(), want.pay_len.to_string());
    check("tiers".into(), chain.tier_len.to_string(), want.tier_len.to_string());
    check("pool".into(), chain.pool_len.to_string(), want.pool_len.to_string());
    for (i, (a, b)) in chain.blocks().iter().zip(want.blocks()).enumerate() {
        let show = |x: &scratch_cards::state::config::Block| format!("role {} count {} cols {} flags {} a {} b {}", x.role, x.count, x.cols, x.flags, x.a, x.b);
        check(format!("block {i}"), show(a), show(b));
    }
    for (i, (a, b)) in chain.pays().iter().zip(want.pays()).enumerate() {
        let show = |x: &scratch_cards::state::config::Pay| format!("scope {:#x} weight {} min {} flags {} ×{}", x.scope, x.weight, x.min, x.flags, x.mult);
        check(format!("pay {i}"), show(a), show(b));
    }
    for (i, (a, b)) in chain.tiers().iter().zip(want.tiers()).enumerate() {
        check(format!("tier {i}"), format!("×{} weight {}", a.factor, a.weight), format!("×{} weight {}", b.factor, b.weight));
    }
    for (i, (a, b)) in chain.pool().iter().zip(want.pool()).enumerate() {
        let show = |x: &scratch_cards::state::config::PoolEntry| {
            format!("{} {} weight {}", mints.symbol(&Pubkey::new_from_array(x.mint)), x.amount, x.weight)
        };
        check(format!("pool {i}"), show(a), show(b));
    }
    if out.is_empty() && bytemuck::bytes_of(chain) != bytemuck::bytes_of(want) {
        out.push("bytes differ outside the named fields".into());
    }
    out
}

/// The worst single collect per token — a closed form off the published cards, not a sample.
///
/// An exclusive roll pays one rung, so the worst is the dearest multiplier. An independent roll is
/// one draw per rung, and every rung can hit in the same deal and land the same token, so the
/// worst is the sum of the multipliers — sampling always undershot that tail, which is exactly the
/// wrong direction for sizing a float. Zero-weight rungs and pool entries cannot hit and are left
/// out, which is also what keeps the devnet answer SOL-only.
pub fn worst_cases(cards: &[CardConfig], mints: &Mints) -> BTreeMap<String, u128> {
    let mut worst = BTreeMap::new();
    for card in cards {
        let mults: Vec<u128> = card
            .pays()
            .iter()
            .filter(|p| p.weight > 0)
            .map(|p| p.mult as u128 * if p.flags & PAY_LINEAR != 0 { p.min as u128 } else { 1 })
            .collect();
        if mults.is_empty() {
            continue;
        }
        let factor = if card.roll == ROLL_INDEPENDENT { mults.iter().sum() } else { *mults.iter().max().unwrap() };
        let top_tier = card.tiers().iter().filter(|t| t.weight > 0).map(|t| t.factor as u128).max().unwrap_or(1).max(1);
        for entry in card.pool().iter().filter(|e| e.weight > 0) {
            let symbol = mints.symbol(&Pubkey::new_from_array(entry.mint));
            let amount = entry.amount as u128 * factor * top_tier;
            let slot = worst.entry(symbol).or_insert(0);
            *slot = (*slot).max(amount);
        }
    }
    worst
}

/// Rounds a top-up up to two significant figures, so a float is printed — and bought — as a round
/// number rather than to the last base unit.
pub fn round_up(n: u128) -> u128 {
    if n <= 10 {
        return n;
    }
    let mut step = 1u128;
    while step * 100 < n {
        step *= 10;
    }
    n.div_ceil(step) * step
}

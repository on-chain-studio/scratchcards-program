//! Keeping the house liquid: for every token on the sheet, the house ledger must cover the worst
//! single collect of that token, times a safety factor. A collect must never fail because the house
//! ran out of a token it printed on a card.
//!
//! `top-up` moves what the house is short into it — SOL from the admin's wallet on any cluster,
//! tokens minted on devnet (the admin holds every stand-in's mint authority) and taken from the
//! admin's own token accounts on mainnet, where shortfalls are reported, never conjured. Every row
//! goes the canonical way: deposited to the admin's ledger and settled admin → house.
//! `acquire-float` is the mainnet half before that: it buys the missing tokens with SOL through
//! Jupiter.

use anyhow::{bail, Context, Result};
use base64::Engine;
use casino_core::ids::TOKEN_PROGRAM;
use casino_ops::ops::Deposit;
use casino_ops::vault::{self, Ledger};
use casino_ops::chain::Place;
use casino_ops::{sol, Chain, Instruction, Ops, Pubkey, Signer, Treasury};
use serde_json::{json, Value};
use solana_sdk::transaction::VersionedTransaction;

use crate::sheet::{round_up, worst_cases, Mints, Prices};
use crate::{cards_on_chain, ScratchCards};

/// Kept in the admin's wallet for fees, whatever is being moved.
const FEE_RESERVE: u64 = 50_000_000;

/// SPL Token's `MintTo`: what tops a devnet stand-in up, its mint authority being the admin. The
/// token program is not one of ours, so there is no client to generate for it.
pub fn mint_to(mint: &Pubkey, destination: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![7];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![
            casino_ops::AccountMeta::new(*mint, false),
            casino_ops::AccountMeta::new(*destination, false),
            casino_ops::AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// SPL Token's `InitializeMint2`: a devnet stand-in with the admin as its authority and no freeze
/// authority, right after its account is made.
pub fn initialize_mint(mint: &Pubkey, decimals: u8, authority: &Pubkey) -> Instruction {
    let mut data = vec![20, decimals];
    data.extend_from_slice(authority.as_ref());
    data.push(0);
    Instruction { program_id: TOKEN_PROGRAM, accounts: vec![casino_ops::AccountMeta::new(*mint, false)], data }
}

/// The float for `worst` at `factor`, in base units. Times 100 and back, so a factor like 1.5
/// survives integer arithmetic.
fn target(worst: u128, factor: f64) -> u128 {
    worst * (factor * 100.0).round() as u128 / 100
}

fn held(ledger: &Ledger, mints: &Mints, symbol: &str) -> u128 {
    match mints.mint(symbol) {
        Ok(mint) if symbol != "SOL" => ledger.balance(&mint) as u128,
        _ => ledger.sol as u128,
    }
}

/// Which token program owns `mint`: Token-2022 mints derive different token accounts.
async fn token_program(chain: &Chain, mint: &Pubkey) -> Result<Pubkey> {
    Ok(chain.account(mint).await?.map(|a| a.owner).unwrap_or(TOKEN_PROGRAM))
}

/// A token account's amount, read from the account itself: `getTokenAccountBalance` is an indexed
/// call some public RPCs refuse. No account holds nothing.
async fn token_amount(chain: &Chain, owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Result<u128> {
    let Some(account) = chain.account(&vault::token_account(owner, mint, program)).await? else {
        return Ok(0);
    };
    let amount = account.data.get(64..72).context("not a token account")?;
    Ok(u64::from_le_bytes(amount.try_into()?) as u128)
}

pub async fn top_up(chain: &Chain, factor: f64, fill: bool, check: bool) -> Result<()> {
    let mainnet = chain.net.mainnet;
    let mints = Mints::load(mainnet)?;
    let prices = Prices::load()?;
    let worst = worst_cases(&cards_on_chain(chain).await?, &mints);
    let ops = Ops::<ScratchCards>::new(chain);
    // A plain member read: the house ledger's permission names the admins.
    let house = ops.house_ledger().await?.context("no house ledger — run `setup`")?;

    println!("house ledger vs a float of worst case × {factor} (refilled below {}):", if fill { "target" } else { "half" });
    let mut short = Vec::new();
    for (symbol, worst) in &worst {
        let target = target(*worst, factor);
        let balance = held(&house, &mints, symbol);
        // Refilled below half the target, back to the full target: the half-way trigger is only
        // hysteresis, so runs don't graze the threshold. `--fill` refills anything under target —
        // right after `acquire-float`, which buys exactly up to target, or the tokens it bought
        // would sit in the admin's wallet.
        let is_short = balance < if fill { target } else { target / 2 };
        if is_short {
            short.push((symbol.clone(), round_up(target - balance)));
        }
        let whole = |units: u128| prices.whole(symbol, units as u64);
        println!(
            "  {symbol:<7} holds {:>14}  worst {:>12}  target {:>14}  {}",
            whole(balance), whole(*worst), whole(target), if is_short { "SHORT" } else { "ok" }
        );
    }
    if short.is_empty() {
        println!("\nnothing to do.");
        return Ok(());
    }
    if check {
        println!("\n--check: not topping up.");
        return Ok(());
    }

    // What can actually move — checked before touching any delegation.
    let admin = chain.admin.pubkey();
    let mut deposits = Vec::new();
    for (symbol, amount) in short {
        let amount: u64 = amount.try_into().context("a top-up past u64")?;
        if symbol == "SOL" {
            let spendable = chain.balance(&admin).await?.saturating_sub(FEE_RESERVE);
            if spendable >= amount {
                deposits.push(Deposit { mint: vault::SOL_MINT, amount, token_program: None, before: vec![] });
            } else {
                println!("  SOL: SHORT — the wallet can spend {}, needs {}; fund the admin and run again", sol(spendable), sol(amount));
            }
            continue;
        }
        let mint = mints.mint(&symbol)?;
        let program = token_program(chain, &mint).await?;
        let mut before = vec![
            vault::create_token_account(&admin, &admin, &mint, &program),
            vault::create_token_account(&admin, &vault::reserve(), &mint, &program),
        ];
        if mainnet {
            let available = token_amount(chain, &admin, &mint, &program).await?;
            if available < amount as u128 {
                println!("  {symbol}: SHORT — the admin holds {available}, needs {amount}; acquire it and run again");
                continue;
            }
        } else {
            before.push(mint_to(&mint, &vault::token_account(&admin, &mint, &program), &admin, amount));
        }
        deposits.push(Deposit { mint, amount, token_program: Some(program), before });
    }
    if deposits.is_empty() {
        bail!("nothing fundable from the admin's accounts");
    }
    let before = chain.balance(&admin).await?;
    let funded: Vec<Pubkey> = deposits.iter().map(|d| d.mint).collect();
    println!("\ntopping up {} row(s)", deposits.len());
    ops.float(deposits).await?;

    let after = ops.house_ledger().await?.context("the house ledger vanished")?;
    println!("\nhouse ledger after:");
    for mint in funded {
        let amount = if mint == vault::SOL_MINT { after.sol } else { after.balance(&mint) };
        println!("  {:<7} {amount}", mints.symbol(&mint));
    }
    println!("\nthis run cost {} SOL in fees and rent", sol(before.saturating_sub(chain.balance(&admin).await?)));
    println!("(the admin ledger stays where the house is; the next run brings it home itself)");
    Ok(())
}

/// The treasury per token as one JSON line, for the sheet tool: what the house ledger holds (it
/// pays wins at settle), what the vault's reserve holds on basenet (it pays withdrawals), and the
/// worst single collect — the same worst case `top-up` sizes the float against.
pub async fn balances(chain: &Chain) -> Result<()> {
    let mints = Mints::load(chain.net.mainnet)?;
    let prices = Prices::load()?;
    let worst = worst_cases(&cards_on_chain(chain).await?, &mints);
    let live = chain.live(&Treasury::house::<ScratchCards>().ledger, &chain.admin).await?;
    if live.stale {
        bail!("the house ledger is on a rollup and could not be read there");
    }
    let place = if matches!(live.place, Place::Delegated(_)) { "rollup (live)" } else { "basenet" };
    let house = live.account.and_then(|a| Ledger::decode(&a.data))
        .unwrap_or(Ledger { owner: Pubkey::default(), sol: 0, balances: vec![] });
    let reserve = vault::reserve();
    let row = |symbol: &str, house: u128, pool: u128| {
        json!({
            "house": prices.whole(symbol, house as u64),
            "pool": prices.whole(symbol, pool as u64),
            "worst": prices.whole(symbol, worst.get(symbol).copied().unwrap_or(0) as u64),
            "price": prices.usd.get(symbol).copied().unwrap_or(0.0),
        })
    };

    let sol_row = row("SOL", held(&house, &mints, "SOL"), chain.balance(&reserve).await? as u128);
    let mut tokens = serde_json::Map::new();
    let symbols: std::collections::BTreeSet<&String> = mints.0.keys().chain(worst.keys()).collect();
    for symbol in symbols.into_iter().filter(|s| *s != "SOL") {
        let mint = mints.mint(symbol)?;
        let program = token_program(chain, &mint).await?;
        let (held, pool) = (held(&house, &mints, symbol), token_amount(chain, &reserve, &mint, &program).await?);
        if held > 0 || pool > 0 || worst.contains_key(symbol) {
            tokens.insert(symbol.clone(), row(symbol, held, pool));
        }
    }
    println!("{}", json!({ "ok": true, "where": place, "sol": sol_row, "tokens": tokens }));
    Ok(())
}

const JUPITER: &str = "https://lite-api.jup.ag/swap/v1";
const WSOL: &str = "So11111111111111111111111111111111111111112";

/// Jupiter, retried on rate limits and its own hiccups.
async fn jupiter(request: impl Fn() -> reqwest::RequestBuilder) -> Result<Value> {
    let mut last = String::new();
    for attempt in 0..3u64 {
        match request().send().await {
            Ok(reply) if reply.status().is_success() => return Ok(reply.json().await?),
            Ok(reply) => {
                let status = reply.status().as_u16();
                last = format!("{status} {}", reply.text().await.unwrap_or_default());
                if status != 429 && status < 500 {
                    break;
                }
            }
            Err(e) => last = e.to_string(),
        }
        casino_ops::sleep(800 * (attempt + 1)).await;
    }
    bail!("jupiter: {}", last.chars().take(200).collect::<String>())
}

struct Buy {
    symbol: String,
    mint: Pubkey,
    quote: Value,
}

/// Buys the token float with SOL through Jupiter — mainnet only: the devnet stand-ins are not on
/// any market, and `top-up` mints them. Plans (quotes only) unless `swap`.
pub async fn acquire_float(chain: &Chain, factor: f64, slippage_bps: u32, swap: bool) -> Result<()> {
    if !chain.net.mainnet {
        bail!("mainnet only — devnet float is minted by `top-up`, nothing to buy");
    }
    let mints = Mints::load(true)?;
    let prices = Prices::load()?;
    let worst = worst_cases(&cards_on_chain(chain).await?, &mints);
    let ops = Ops::<ScratchCards>::new(chain);
    let house = ops.house_ledger().await?.context("no house ledger — run `setup`")?;
    let admin = chain.admin.pubkey();

    let mut plan = Vec::new();
    for (symbol, worst) in &worst {
        // SOL comes from the wallet through `top-up`, not a swap.
        if symbol == "SOL" {
            continue;
        }
        let Ok(mint) = mints.mint(symbol) else { continue };
        let in_house = held(&house, &mints, symbol);
        let program = token_program(chain, &mint).await?;
        let in_wallet = token_amount(chain, &admin, &mint, &program).await?;
        // The same rounding `top-up` applies, or the wallet ends one rounding step short of what
        // `top-up` then asks for.
        let need = round_up(target(*worst, factor).saturating_sub(in_house)).saturating_sub(in_wallet);
        if need == 0 {
            println!("  {symbol:<7} covered (house {in_house}, wallet {in_wallet})");
            continue;
        }
        plan.push((symbol.clone(), mint, need));
    }
    if plan.is_empty() {
        println!("\nnothing to buy.");
        return Ok(());
    }

    println!("\nquoting SOL → token:");
    let http = &chain.http;
    let quote = |mint: Pubkey, amount: u128, mode: &'static str| {
        let url = format!(
            "{JUPITER}/quote?inputMint={WSOL}&outputMint={mint}&amount={amount}&swapMode={mode}&slippageBps={slippage_bps}"
        );
        async move { jupiter(|| http.get(&url)).await }
    };
    let mut buys = Vec::new();
    let mut total_in = 0u128;
    for (symbol, mint, need) in plan {
        let (quote, exact) = match quote(mint, need, "ExactOut").await {
            Ok(q) => (q, true),
            Err(e) if e.to_string().contains("NO_ROUTES") => {
                // Some routes only quote exact-in: probe the price with a small quote, then size
                // the input with a small pad — `top-up` moves whatever lands.
                let probe = quote(mint, 100_000_000, "ExactIn").await?;
                let out: u128 = probe["outAmount"].as_str().unwrap_or("0").parse()?;
                if out == 0 {
                    bail!("{symbol}: no route at all");
                }
                (quote(mint, need * 100_000_000 / out * 103 / 100, "ExactIn").await?, false)
            }
            Err(e) => return Err(e),
        };
        let paid: u128 = quote["inAmount"].as_str().unwrap_or("0").parse()?;
        total_in += paid;
        let out: u128 = quote["outAmount"].as_str().and_then(|s| s.parse().ok()).unwrap_or(need);
        let paid_usd = paid as f64 / 1e9 * prices.usd.get("SOL").copied().unwrap_or(0.0);
        let spot_usd = prices.whole(&symbol, out as u64) * prices.usd.get(&symbol).copied().unwrap_or(0.0);
        let premium = if spot_usd > 0.0 { (paid_usd / spot_usd - 1.0) * 100.0 } else { 0.0 };
        let impact = quote["priceImpactPct"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0) * 100.0;
        println!(
            "  {symbol:<7} buy {:>16}  for {} SOL   over spot {premium:+.2}%  impact {impact:.3}%{}",
            prices.whole(&symbol, need as u64), sol(paid as u64), if exact { "" } else { "  (exact-in, ~3% pad)" }
        );
        buys.push(Buy { symbol, mint, quote });
    }
    let balance = chain.balance(&admin).await? as u128;
    println!("\ntotal: {} SOL — the wallet holds {}", sol(total_in as u64), sol(balance as u64));
    if balance < total_in + FEE_RESERVE as u128 {
        println!("⚠ short by {} SOL (keeping a {} SOL fee reserve)", sol((total_in + FEE_RESERVE as u128 - balance) as u64), sol(FEE_RESERVE));
        if swap {
            bail!("not enough SOL to swap");
        }
    }
    if !swap {
        println!("\nplan only — pass --swap to execute, then `top-up --fill` moves it into the house");
        return Ok(());
    }

    let before = chain.balance(&admin).await?;
    for buy in buys {
        let body = json!({
            "quoteResponse": buy.quote,
            "userPublicKey": admin.to_string(),
            "wrapAndUnwrapSol": true,
            "prioritizationFeeLamports": "auto",
        });
        let reply = jupiter(|| http.post(format!("{JUPITER}/swap")).json(&body)).await?;
        let encoded = reply["swapTransaction"].as_str().context("jupiter sent no transaction")?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
        let unsigned: VersionedTransaction = bincode::deserialize(&bytes)?;
        let signed = VersionedTransaction::try_new(unsigned.message, &[&chain.admin])?;
        let signature = chain.base.connection.send_and_confirm_transaction(&signed).await?;
        let program = token_program(chain, &buy.mint).await?;
        let now = token_amount(chain, &admin, &buy.mint, &program).await?;
        println!("  ✅ {:<7} {}  the wallet now holds {now}", buy.symbol, casino_ops::short(signature));
    }
    println!("\nthis run cost {} SOL (swaps included)", sol(before.saturating_sub(chain.balance(&admin).await?)));
    println!("now: scratch-ops top-up --mainnet --factor {factor} --fill");
    Ok(())
}

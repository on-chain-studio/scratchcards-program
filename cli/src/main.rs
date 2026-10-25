//! `scratch-ops`: Scratch Cards, operated. Every instruction of the game is built by the client
//! Solarium generates from the program's `#[program]` block — scratch cards numbers its admin
//! instructions its own way, and the generated client carries those numbers — and every account
//! is read by casting its bytes into the program's own state types. What every game's tooling
//! shares is `casino-ops`.
//!
//! ```text
//! scratch-ops setup                   initialize, open the house and jackpot ledgers, delegate
//! scratch-ops publish [--cards-only]  write tools/sheet/cards.json onto the shelf
//! scratch-ops verify                  every field of every card against the sheet
//! scratch-ops top-up | acquire-float  keep the house able to pay the worst collect
//! scratch-ops play [cards]            buy, reveal and collect real cards
//! scratch-ops close-stray-cards [--go] drop cards of a layout the program no longer reads
//! scratch-ops analytics [--json] [--watch] | fetch-prices | status | cards
//! scratch-ops referral [player] | claim-referral <wallet> | grow-analytics
//! ```
//!
//! Devnet unless `--mainnet`; the TEE unless `--public`; the admin key is `--keypair`,
//! `$CASINO_ADMIN_KEYPAIR` or the Solana CLI's. Scratch cards' admin is the ops key alone
//! (`~/keys/casino_admin.json`): the dev key reads the analytics but signs nothing the program
//! would take from an admin.

mod float;
mod play;
mod prices;
mod probe;
mod sheet;

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use casino_core::ids::{PERMISSION_PROGRAM, TOKEN_PROGRAM};
use casino_core::permission;
use casino_core::Casino;
use casino_ops::chain::{Endpoint, Place};
use casino_ops::magicblock::{EPHEMERAL_VAULT, MAGIC_PROGRAM};
use casino_ops::ops::Setup;
use casino_ops::vault::SYSTEM_PROGRAM;
use casino_ops::{keys, lamports, short, sol, AdminCommand, Chain, Game, Instruction, Keypair, Net, Ops, Player, Pubkey, Signer};
use clap::{Parser, Subcommand};
use casino_core::referral::{self, Referral};
use casino_ops::magicblock::MAGIC_CONTEXT;
use scratch_cards::instructions::{close_card::CloseCard, initialize::Initialize};
use scratch_cards::GrowAnalytics;
use scratch_cards::state::analytics::{self as analytics_state, Analytics};
use scratch_cards::state::card::{self, Card};
use scratch_cards::state::config::CardConfig;
use serde_json::{json, Value};

use crate::sheet::{Mints, Prices};

mod generated {
    solarium_client::generate_client!("scratch-cards");
}

pub use generated::ScratchCards;

casino_ops::admin_instructions!(ScratchCards, grow_config);

impl Game for ScratchCards {
    type Program = scratch_cards::ScratchCards;
    const NAME: &'static str = "scratch cards";
    /// The house pays inside the rollup and the analytics are written there. The jackpot PDA is
    /// never delegated: it only names its ledger in a settle, read-only.
    const ON_ROLLUP: &'static [&'static [u8]] = &[b"house", b"analytics"];
    const SHELF_ITEM: Option<usize> = Some(size_of::<CardConfig>());
    const LOCAL_BUILD: Option<&'static str> = Some(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy/scratch_cards.so"));
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &scratch_cards::ID).0
}
pub fn config() -> Pubkey {
    pda(&[b"config"])
}
pub fn house() -> Pubkey {
    pda(&[b"house"])
}
pub fn jackpot() -> Pubkey {
    pda(&[b"jackpot"])
}
pub fn analytics() -> Pubkey {
    pda(&[b"analytics"])
}
pub fn identity() -> Pubkey {
    pda(&[b"identity"])
}
/// One card per player: a second purchase is refused by the account already existing.
pub fn card_of(user: &Pubkey) -> Pubkey {
    pda(&[b"card", user.as_ref()])
}

#[derive(Parser)]
#[command(name = "scratch-ops", about = "Operates Scratch Cards through its generated client")]
struct Cli {
    #[command(flatten)]
    net: Net,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Stands the program up: initialize, open the house and jackpot ledgers, make the jackpot's
    /// public, fund the house PDA, delegate the house, the analytics and both ledgers. Idempotent.
    /// The float is `top-up`'s job; the shelf is `publish`'s.
    Setup {
        /// SOL on the house PDA, its payer inside the rollup: card rent and the VRF.
        #[arg(long, default_value_t = 0.1)]
        house_fund: f64,
        #[arg(long, default_value_t = 20)]
        house_slots: u16,
        #[arg(long, default_value_t = 4)]
        jackpot_slots: u16,
        /// After an upgrade that changes the shelf's layout: re-stamp the shelf. The program empties
        /// it in the same instruction, so no card is ever read at the wrong stride and nothing can
        /// be bought until `publish` puts the sheet back. Refused on a shelf already at this layout.
        #[arg(long)]
        restamp: bool,
    },
    /// Publishes the card sheet, one card per transaction, and — devnet, unless `--cards-only` —
    /// creates any 0-decimal stand-in mint it names that does not exist yet. Devnet publishes only
    /// `DEVNET_CARDS`. Slots past the sheet are left as they are: the shelf only shrinks when it
    /// is re-stamped.
    Publish {
        #[arg(long)]
        sheet: Option<PathBuf>,
        /// Republish the sheet and touch nothing else.
        #[arg(long)]
        cards_only: bool,
        /// Rewrite cards that already match.
        #[arg(long)]
        force: bool,
    },
    /// Does the published shelf still say what the sheet says? Every field of every card.
    Verify {
        #[arg(long)]
        sheet: Option<PathBuf>,
    },
    /// The cards as published.
    Cards,
    /// A player's referral section — who referred them, what they are owed and have earned as a
    /// referrer — and the program's referral counters. The admin's by default.
    Referral { player: Option<String> },
    /// Asks the house to pay what this wallet is owed as a referrer into its ledger; the wallet signs.
    ClaimReferral { wallet: PathBuf },
    /// Admin, basenet: grows the analytics account to hold the referral counters. Undelegate it
    /// first (`undelegate-pda analytics`) and delegate it again after (`delegate-pda analytics`).
    GrowAnalytics,
    /// The lifetime counters, live off the rollup when delegated (the admins are members there).
    Analytics {
        /// Machine-readable, for the sheet tool: one JSON object and nothing else.
        #[arg(long)]
        json: bool,
        /// Keep watching: one JSON line now and one per change — what the sheet tool records.
        #[arg(long)]
        watch: bool,
    },
    /// The treasury per token as one JSON line, for the sheet tool: house ledger, vault reserve,
    /// worst single collect.
    Balances,
    /// Tops the house up to cover the worst single collect of every token, times a factor.
    TopUp {
        /// The float, as a multiple of the worst case.
        #[arg(long, default_value_t = 1.5)]
        factor: f64,
        /// Refill anything below target, not only below half of it.
        #[arg(long)]
        fill: bool,
        /// Report only.
        #[arg(long)]
        check: bool,
    },
    /// Mainnet: plans (or, with --swap, makes) the SOL → token swaps the float is short.
    AcquireFloat {
        #[arg(long, default_value_t = 1.5)]
        factor: f64,
        /// Slippage in basis points.
        #[arg(long, default_value_t = 100)]
        slippage: u32,
        #[arg(long)]
        swap: bool,
    },
    /// Refreshes scripts/prices.json from CoinGecko and the mainnet mint accounts.
    FetchPrices,
    /// Takes a player's ledger apart: home, every balance withdrawn to the wallet, the ledger and
    /// its permission closed, the rent back. For a test wallet whose `play` run died before its
    /// own `--close`.
    ClosePlayer {
        /// The player's keypair; the admin by default.
        #[arg(long)]
        wallet: Option<PathBuf>,
    },
    /// Devnet, debug build only: writes a player's card account from thin air — a collected
    /// ticket of the v2 layout's size, its terms the live mainnet shelf's slot 0 — so the next
    /// purchase has a card of another layout to resize. The program refuses it unless built with
    /// `--features devnet-debug`.
    FabricateV2Card {
        /// The player whose card slot to fabricate; the admin by default.
        #[arg(long)]
        wallet: Option<PathBuf>,
    },
    /// Plays real cards: buy, reveal, collect.
    Play {
        #[arg(default_value_t = 3)]
        cards: u32,
        /// Which card of the shelf.
        #[arg(long, default_value_t = 0)]
        card: u64,
        /// Undelegate, withdraw and close the ledger afterwards.
        #[arg(long)]
        close: bool,
        /// Play as this keypair rather than the admin.
        #[arg(long)]
        wallet: Option<PathBuf>,
        /// Name this wallet as the referrer: locked only if the purchase creates the player's card.
        #[arg(long)]
        referrer: Option<Pubkey>,
    },
    /// Lists the vault ledgers on basenet, or watches one — a wallet's, or a ledger itself — and
    /// timestamps every change and every change of hands.
    WatchLedger { who: Option<String> },
    /// Does the rollup push account notifications? Subscribes to the player's ledger and card,
    /// polls both as the ground truth, and plays one card meanwhile.
    ProbePush {
        /// Play as this keypair rather than the admin.
        #[arg(long)]
        wallet: Option<PathBuf>,
    },
    /// Finishes a card left mid-flow: reveal, wait for the VRF, collect.
    Finish {
        #[arg(long)]
        wallet: Option<PathBuf>,
    },
    /// A player's card on the rollup; the admin's by default.
    Card { player: Option<String> },
    /// Admin: drops a card no normal path can reach and returns its rent to the house. Rollup.
    CloseCard { player: Option<String> },
    /// Admin: lists the cards on the rollup of a layout this program no longer reads — from
    /// before the current seeds, so `close-card` cannot reach them by player — and, with `--go`,
    /// closes each by address. A card of the current layout is a live ticket and is left alone.
    CloseStrayCards {
        #[arg(long)]
        go: bool,
    },
    #[command(flatten)]
    Admin(AdminCommand),
}

fn key(text: &str) -> Result<Pubkey> {
    text.parse().map_err(|e| anyhow::anyhow!("{text} is not a key: {e:?}"))
}

fn built(result: solarium_client::result::Result<Instruction>) -> Result<Instruction> {
    result.map_err(|e| anyhow::anyhow!("{e}"))
}

/// The config's header and every slot it has room for.
/// The layout the shelf is stamped with.
async fn stamped(chain: &Chain) -> Result<u64> {
    let account = chain.account(&config()).await?.context("no config on chain — run `setup`")?;
    let header: casino_core::shelf::Header = casino_ops::decode(&account.data).context("the config is not a shelf")?;
    Ok(header.version)
}

/// Refuses to touch a shelf stamped with another layout: the program would refuse every `SetCard`
/// anyway, but not before a cut had changed the live shelf.
async fn require_current(chain: &Chain) -> Result<()> {
    let version = stamped(chain).await?;
    if version != scratch_cards::state::config::VERSION {
        bail!("the shelf is stamped v{version}; this build publishes v{} — re-stamp it first: scratch-ops setup --restamp{}",
            scratch_cards::state::config::VERSION, if chain.net.mainnet { " --mainnet" } else { "" });
    }
    Ok(())
}

async fn shelf(chain: &Chain) -> Result<(u64, Vec<CardConfig>)> {
    let account = chain.account(&config()).await?.context("no config on chain — run `setup`")?;
    // A shelf not yet re-stamped holds v2 cards: shown as the one tier the program deals them as.
    let header: casino_core::shelf::Header = casino_ops::decode(&account.data).context("the config is not a shelf")?;
    if header.version == scratch_cards::state::config::VERSION_V2 {
        let size = scratch_cards::state::config::CARD_SIZE_V2;
        let items = account.data[scratch_cards::state::config::Config::HEADER..].chunks_exact(size).map(sheet::v2_as_v3).collect();
        return Ok((header.count, items));
    }
    let (header, items) = casino_ops::shelf::<CardConfig>(&account.data).context("the config is not a shelf")?;
    Ok((header.count, items))
}

/// Every card the shelf publishes.
pub async fn cards_on_chain(chain: &Chain) -> Result<Vec<CardConfig>> {
    let (count, items) = shelf(chain).await?;
    Ok(items.into_iter().take(count as usize).collect())
}

/// Refuses up front what the program would refuse with a bare `MissingRequiredSignature`: an
/// admin instruction from a key that is not scratch cards' admin. That is the ops key alone; the
/// dev key, which casino-ops would otherwise pick up as readily, only reads the books.
fn require_admin(chain: &Chain) -> Result<()> {
    let admin = chain.admin.pubkey();
    if !scratch_cards::ScratchCards::is_admin(&admin) {
        bail!("{admin} is not scratch cards' admin — the ops key alone is; pass it with --keypair");
    }
    Ok(())
}

fn wallet(chain: &Chain, path: Option<PathBuf>) -> Result<Keypair> {
    match path {
        Some(path) => keys::read(&path),
        None => Ok(chain.admin.insecure_clone()),
    }
}

async fn publish(chain: &Chain, path: PathBuf, cards_only: bool, force: bool) -> Result<()> {
    require_admin(chain)?;
    let mainnet = chain.net.mainnet;
    let cards = sheet::for_cluster(sheet::load(&path)?, mainnet);
    let admin = chain.admin.pubkey();
    let mut mints = Mints::load(mainnet).or_else(|e| if mainnet { Err(e) } else { Ok(Mints::default()) })?;
    if !mainnet {
        let mut record: Value = std::fs::read_to_string(sheet::devnet_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({ "mints": {} }));
        for symbol in sheet::TOKENS {
            if mints.0.contains_key(symbol) {
                continue;
            }
            if cards_only {
                bail!("no devnet mint for {symbol} in scripts/devnet.json — publish without --cards-only first");
            }
            // A 0-decimal stand-in: base units print as the whole numbers the sheet holds.
            let mint = Keypair::new();
            let rent = chain.base.connection.get_minimum_balance_for_rent_exemption(82).await?;
            let create = solana_system_interface::instruction::create_account(&admin, &mint.pubkey(), rent, 82, &TOKEN_PROGRAM);
            chain.base.send(&[create, float::initialize_mint(&mint.pubkey(), 0, &admin)], &[&chain.admin, &mint]).await?;
            println!("mint {symbol} = {}", mint.pubkey());
            mints.0.insert(symbol.to_string(), mint.pubkey());
            record["mints"][symbol] = json!(mint.pubkey().to_string());
            std::fs::write(sheet::devnet_path(), serde_json::to_string_pretty(&record)?)?;
        }
    }

    require_current(chain).await?;
    println!("writing the card sheet…");
    let (count, slots) = shelf(chain).await?;
    if cards.len() < count as usize {
        println!("  ⚠  {} card(s) past the sheet stay on sale: the shelf only shrinks when it is re-stamped", count as usize - cards.len());
    }
    let send = async |index: usize, card: &sheet::Card, label: String| -> Result<()> {
        let set = card.set_card(index as u8, &mints, mainnet)?;
        set.validate().map_err(|e| anyhow::anyhow!("{}: the program would refuse it ({e:?})", card.id))?;
        let want = sheet::expected(&set);
        if !force && (index as u64) < count && slots.get(index).is_some_and(|c| bytemuck::bytes_of(c) == bytemuck::bytes_of(&want)) {
            println!("  ⏭  {label}: already published");
            return Ok(());
        }
        let ix = built(generated::ScratchCards::set_card_instruction(admin, config(), SYSTEM_PROGRAM, set))?;
        let signature = chain.base.send(&[ix], &[&chain.admin]).await?;
        println!("  ✅ {label}  {}", short(signature));
        Ok(())
    };
    for (index, card) in cards.iter().enumerate() {
        send(index, card, format!("card {}", card.id)).await?;
    }
    if !mainnet && !cards_only {
        let mut record: Value = serde_json::from_str(&std::fs::read_to_string(sheet::devnet_path())?)?;
        record["config"] = json!(config().to_string());
        record["jackpot"] = json!(jackpot().to_string());
        std::fs::write(sheet::devnet_path(), serde_json::to_string_pretty(&record)?)?;
        println!("done → scripts/devnet.json");
    }
    Ok(())
}

/// Every account on `at` that starts with the card discriminator, whatever its size: a stray is
/// told apart by its size, so it cannot be asked for by one. The filter is the discriminator's
/// first byte — all the rollup's `memcmp` needs — and the whole of it is checked here.
async fn card_accounts(at: &Endpoint) -> Result<Vec<(Pubkey, Vec<u8>)>> {
    use base64::Engine;
    use solana_client::rpc_request::RpcRequest;
    let first = bs58_byte(card::DISCRIMINATOR as u8);
    let params = json!([scratch_cards::ID.to_string(), {
        "encoding": "base64", "commitment": "confirmed", "filters": [{ "memcmp": { "offset": 0, "bytes": first } }],
    }]);
    let reply: Value = at.connection.send(RpcRequest::GetProgramAccounts, params).await.context("listing the program's accounts")?;
    let mut cards = Vec::new();
    for entry in reply.as_array().into_iter().flatten() {
        let key = entry["pubkey"].as_str().and_then(|k| k.parse().ok());
        let data = entry["account"]["data"][0].as_str().and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok());
        if let (Some(key), Some(data)) = (key, data) {
            if data.len() >= 8 && u64::from_le_bytes(data[..8].try_into().unwrap()) == card::DISCRIMINATOR {
                cards.push((key, data));
            }
        }
    }
    Ok(cards)
}

/// One byte in base58, which for a byte below 58 is a single digit of its alphabet.
fn bs58_byte(byte: u8) -> String {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    assert!(byte > 0 && (byte as usize) < ALPHABET.len(), "one digit only");
    (ALPHABET[byte as usize] as char).to_string()
}

async fn close_stray_cards(chain: &Chain, go: bool) -> Result<()> {
    if go {
        require_admin(chain)?;
    }
    let rollup = chain.rollup().await?;
    let cards = card_accounts(&rollup).await?;
    let strays: Vec<&(Pubkey, Vec<u8>)> = cards.iter().filter(|(_, data)| data.len() != Card::WITH_TERMS).collect();
    println!("{} card accounts visible to {}, {} of them stray", cards.len(), short(chain.admin.pubkey()), strays.len());
    for (key, data) in &cards {
        let what = if data.len() == Card::WITH_TERMS { "live, left alone" } else { "stray" };
        println!("  {key}  {} B  {what}", data.len());
    }
    if !go {
        println!("
dry run — pass --go to close the strays");
        return Ok(());
    }
    let admin = chain.admin.pubkey();
    let mut closed = 0;
    for (key, _) in &strays {
        let ix = built(generated::ScratchCards::close_stray_card_instruction(admin, house(), *key, EPHEMERAL_VAULT, MAGIC_PROGRAM))?;
        rollup.send(&[ix], &[&chain.admin]).await?;
        let gone = rollup.account(key).await?.is_none();
        println!("  {}  {}", short(*key), if gone { "closed" } else { "still there" });
        closed += gone as usize;
    }
    println!("
{closed}/{} closed, their rent back with the house", strays.len());
    Ok(())
}

async fn verify(chain: &Chain, path: PathBuf) -> Result<()> {
    let mainnet = chain.net.mainnet;
    let cards = sheet::for_cluster(sheet::load(&path)?, mainnet);
    let mints = Mints::load(mainnet)?;
    let account = chain.account(&config()).await?.context("no config account")?;
    let header = casino_ops::decode::<casino_core::shelf::Header>(&account.data).context("not a shelf")?;
    if header.version != scratch_cards::state::config::VERSION {
        println!("config v{}, {} cards on chain — stamped with another layout, so nothing here can match the sheet", header.version, u64::from_le_bytes(account.data[48..56].try_into().unwrap()));
        bail!("re-stamp the shelf first: scratch-ops setup --restamp{}, then publish", if mainnet { " --mainnet" } else { "" });
    }
    let (count, slots) = shelf(chain).await?;
    println!("config v{}, {count} cards on chain, {} in the sheet\n", header.version, cards.len());
    let mut bad = 0;
    for index in 0..(count as usize).max(cards.len()) {
        let Some(card) = cards.get(index) else {
            println!("  card {index}: on chain but not in the sheet");
            bad += 1;
            continue;
        };
        if index as u64 >= count {
            println!("  {}: in the sheet but not published", card.id);
            bad += 1;
            continue;
        }
        let chain_card = &slots[index];
        let out = sheet::differences(chain_card, &sheet::expected(&card.set_card(index as u8, &mints, mainnet)?), &mints);
        let price = chain_card.price_lamports as f64 / 1e9;
        let hit = chain_card.jackpot_hit as f64 / (1u64 << 32) as f64;
        println!(
            "  {:<9} {price:.4} SOL  jackpot {:.4}%  per SOL {:.3}%  {} blocks  {} pays  {} tiers  {} coins{}",
            card.id, hit * 100.0, hit / price * 100.0, chain_card.block_len, chain_card.pay_len, chain_card.tier_len,
            chain_card.token_len, if out.is_empty() { String::new() } else { format!("   {} DIFFER", out.len()) }
        );
        for line in &out {
            println!("      {line}");
        }
        bad += out.len();
    }
    if bad > 0 {
        bail!("{bad} field(s) differ — republish with: scratch-ops publish --cards-only{}", if mainnet { " --mainnet" } else { "" });
    }
    println!("\nchain matches the sheet exactly");
    Ok(())
}

/// The analytics counters as the sheet tool reads them.
async fn analytics_json(chain: &Chain, mints: &Mints, prices: &Prices) -> Result<Value> {
    let live = chain.live(&analytics(), &chain.admin).await?;
    let account = live.account.context("no analytics account — run `setup`")?;
    let a = casino_ops::decode::<Analytics>(&account.data)
        .filter(|a| a.discriminator == analytics_state::DISCRIMINATOR)
        .context("the account is too small to decode")?;
    let place = match (live.place, live.stale) {
        (Place::Delegated(_), false) => "rollup (live)",
        (Place::Delegated(_), true) => "basenet (stale — rollup copy unreadable)",
        _ => "basenet",
    };
    let payouts: Vec<Value> = a
        .payouts
        .iter()
        .filter(|row| row.amount > 0)
        .map(|row| {
            let token = mints.symbol(&Pubkey::new_from_array(row.mint));
            json!({ "token": token, "amount": row.amount.to_string(), "whole": prices.whole(&token, row.amount) })
        })
        .collect();
    Ok(json!({
        "ok": true,
        "where": place,
        "lamportsIn": a.lamports_in.to_string(),
        "jackpotIn": a.jackpot_in.to_string(),
        "jackpotPaid": a.jackpot_paid.to_string(),
        "jackpotHits": a.jackpot_hits,
        "cardsSold": a.cards_sold,
        "cardsCollected": a.cards_collected,
        "payouts": payouts,
    }))
}

async fn show_analytics(chain: &Chain, json: bool, watch: bool) -> Result<()> {
    let mints = Mints::load(chain.net.mainnet).unwrap_or_default();
    let prices = Prices::load().unwrap_or_default();
    if watch {
        // One line now and one per change — a poll, which a rollup token outlives, rather than a
        // socket that has to be logged in again whenever it drops.
        let mut last = String::new();
        loop {
            let line = match analytics_json(chain, &mints, &prices).await {
                Ok(state) => state.to_string(),
                Err(e) => json!({ "ok": false, "error": e.to_string() }).to_string(),
            };
            if line != last {
                println!("{line}");
                last = line;
            }
            casino_ops::sleep(2000).await;
        }
    }
    let state = match analytics_json(chain, &mints, &prices).await {
        Ok(state) => state,
        Err(e) if json => {
            println!("{}", json!({ "ok": false, "error": e.to_string() }));
            std::process::exit(1);
        }
        Err(e) => return Err(e),
    };
    if json {
        println!("{state}");
        return Ok(());
    }
    let lamports = |field: &str| sol(state[field].as_str().and_then(|s| s.parse().ok()).unwrap_or(0));
    println!("analytics {}  —  {}\n", analytics(), state["where"].as_str().unwrap_or(""));
    println!("  taken in   {} SOL   (jackpot share {} SOL)", lamports("lamportsIn"), lamports("jackpotIn"));
    println!("  jackpots   {} paid, {} SOL total", state["jackpotHits"], lamports("jackpotPaid"));
    let per = |field: &str| {
        let counts: Vec<String> = state[field]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter(|(_, n)| n.as_u64().unwrap_or(0) > 0)
            .map(|(i, n)| format!("#{i}×{n}"))
            .collect();
        if counts.is_empty() { "none".to_string() } else { counts.join("  ") }
    };
    println!("  cards      {}", per("cardsSold"));
    println!("  collected  {}", per("cardsCollected"));
    for payout in state["payouts"].as_array().into_iter().flatten() {
        println!("  paid out   {:<8} {}", payout["token"].as_str().unwrap_or("?"), payout["whole"]);
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let chain = Chain::connect(&cli.net).await?;
    let admin = chain.admin.pubkey();
    match cli.command {
        Command::Setup { house_fund, house_slots, jackpot_slots, restamp } => {
            require_admin(&chain)?;
            let initialize = built(generated::ScratchCards::initialize_instruction(
                admin, config(), house(), jackpot(), analytics(), permission::address(&analytics()), PERMISSION_PROGRAM,
                SYSTEM_PROGRAM,
                // A fresh shelf: cards come from `publish`.
                Initialize { card_count: 0 },
            ))?;
            if restamp {
                let version = stamped(&chain).await?;
                if version == scratch_cards::state::config::VERSION {
                    bail!("the shelf is already stamped v{version} and its cards are live; there is nothing to re-stamp");
                }
                let signature = chain.base.send(&[initialize], &[&chain.admin]).await?;
                println!("config re-stamped v{version} → v{}, shelf emptied  {}", scratch_cards::state::config::VERSION, short(signature));
                println!("nothing is on sale until: scratch-ops publish --cards-only");
                return Ok(());
            }
            let plan = Setup {
                initialize,
                slots: vec![house_slots, jackpot_slots],
                // The pot is the draw: anyone should be able to read it.
                public: vec![1],
                house_fund: lamports(house_fund),
                float: 0,
            };
            Ops::<ScratchCards>::new(&chain).setup(plan).await?;
            println!("(the house float is `top-up`'s; the shelf is `publish`'s)");
            Ok(())
        }
        Command::Publish { sheet, cards_only, force } => publish(&chain, sheet.unwrap_or_else(sheet::sheet_path), cards_only, force).await,
        Command::Verify { sheet } => verify(&chain, sheet.unwrap_or_else(sheet::sheet_path)).await,
        Command::Cards => {
            let mints = Mints::load(chain.net.mainnet).unwrap_or_default();
            for (index, card) in cards_on_chain(&chain).await?.iter().enumerate() {
                let coins: Vec<String> = card.tokens().iter().map(|m| mints.symbol(&Pubkey::new_from_array(*m))).collect();
                println!(
                    "{index}  {} SOL  mode {} roll {}  {} blocks {} pays {} tiers  coins {}",
                    sol(card.price_lamports), card.mode, card.roll, card.block_len, card.pay_len, card.tier_len, coins.join(" ")
                );
            }
            Ok(())
        }
        Command::Analytics { json, watch } => show_analytics(&chain, json, watch).await,
        Command::Referral { player } => {
            let user = player.map(|p| key(&p)).transpose()?.unwrap_or(chain.admin.pubkey());
            let rollup = chain.rollup().await?;
            match rollup.account(&card_of(&user)).await? {
                None => println!("no card for {user}"),
                Some(account) => {
                    let at = match account.data.len() {
                        Card::REFERRED_SIZE => Some(Card::PERSISTENT_SIZE),
                        Card::REFERRED_SIZE_V2 => Some(Card::PERSISTENT_SIZE_V2),
                        _ => None,
                    };
                    match at.and_then(|at| Referral::read(&account.data, at)) {
                        Some(r) => {
                            match r.referrer() {
                                Some(by) => println!("{user}  referred by {by} since {}", r.since),
                                None => println!("{user}  not referred"),
                            }
                            println!("  as a referrer: owed {} SOL, earned {} SOL", sol(r.owed), sol(r.earned));
                        }
                        None => println!("the card of {user} is from before referrals: its next purchase adds the section"),
                    }
                }
            }
            let live = chain.live(&analytics(), &chain.admin).await?;
            match live.account.and_then(|a| referral::counters(&mut a.data.clone(), Analytics::SIZE).copied()) {
                Some(c) => {
                    println!("
referred {} players  ·  unreferred {}", c.players_referred, c.players_unreferred);
                    println!("referrers owed {} SOL  ·  earned {} SOL", sol(c.owed), sol(c.earned));
                }
                None => println!("
referrals not counted yet — run `grow-analytics`"),
            }
            Ok(())
        }
        Command::ClaimReferral { wallet: path } => {
            let wallet = keys::read(&path)?;
            let player = Player::new(&chain, &wallet, scratch_cards::ID);
            let user = wallet.pubkey();
            let at = player.rollup().await?;
            let ix = built(generated::ScratchCards::claim_referral_instruction(user, user, house(), card_of(&user), MAGIC_CONTEXT, MAGIC_PROGRAM))?;
            at.send(&[ix], &[&wallet]).await?;
            println!("✅ claimed: the house's task pays {user} what it is owed");
            Ok(())
        }
        Command::GrowAnalytics => {
            require_admin(&chain)?;
            let account = chain.base.account(&analytics()).await?.context("no analytics account — run `setup`")?;
            if account.owner != scratch_cards::ID {
                bail!("analytics is delegated — run `undelegate-pda analytics` first");
            }
            if account.data.len() >= Analytics::REFERRALS_SIZE {
                println!("⏭  analytics already holds the referral counters ({} bytes)", account.data.len());
                return Ok(());
            }
            let ix = built(generated::ScratchCards::grow_analytics_instruction(
                chain.admin.pubkey(), analytics(), SYSTEM_PROGRAM, GrowAnalytics { len: Analytics::REFERRALS_SIZE as u32 },
            ))?;
            chain.base.send(&[ix], &[&chain.admin]).await?;
            println!("✅ analytics grown {} → {} bytes — now `delegate-pda analytics`", account.data.len(), Analytics::REFERRALS_SIZE);
            Ok(())
        }
        Command::Balances => float::balances(&chain).await,
        Command::TopUp { factor, fill, check } => float::top_up(&chain, factor, fill, check).await,
        Command::AcquireFloat { factor, slippage, swap } => float::acquire_float(&chain, factor, slippage, swap).await,
        Command::FetchPrices => prices::fetch(&chain.http).await,
        Command::FabricateV2Card { wallet: path } => {
            use scratch_cards::instructions::fabricate_card::FabricateCard;
            require_admin(&chain)?;
            if chain.net.mainnet {
                bail!("devnet only");
            }
            let user = wallet(&chain, path)?.pubkey();
            let rollup = chain.rollup().await?;
            if rollup.account(&card_of(&user)).await?.is_some() {
                bail!("{user} already has a card — close it first (close-card)");
            }
            // A collected v2 ticket, as the v2 program left one: header, 992-byte terms, generation.
            let shelf: &[u8] = include_bytes!("../../tests/fixtures/mainnet_shelf_v2.bin");
            let terms = &shelf[56..56 + scratch_cards::state::config::CARD_SIZE_V2];
            let mut c: Card = bytemuck::Zeroable::zeroed();
            c.discriminator = card::DISCRIMINATOR;
            c.version = card::VERSION;
            c.user = user.to_bytes();
            c.status = scratch_cards::state::card::CardStatus::Collected as u64;
            let mut data = bytemuck::bytes_of(&c).to_vec();
            data.extend_from_slice(terms);
            data.extend_from_slice(&1u64.to_le_bytes());
            assert_eq!(data.len(), Card::PERSISTENT_SIZE_V2);
            let ix = built(generated::ScratchCards::fabricate_card_instruction(
                admin, house(), card_of(&user), EPHEMERAL_VAULT, MAGIC_PROGRAM, FabricateCard { user, data },
            ))?;
            let signature = rollup.send(&[ix], &[&chain.admin]).await?;
            let len = rollup.account(&card_of(&user)).await?.map(|a| a.data.len()).unwrap_or(0);
            println!("fabricated a collected v2 ticket for {user}: {len} bytes  {}", short(signature));
            Ok(())
        }
        Command::ClosePlayer { wallet: path } => {
            let wallet = wallet(&chain, path)?;
            let before = chain.balance(&wallet.pubkey()).await?;
            let withdrawn = casino_ops::Player::new(&chain, &wallet, scratch_cards::ID).close().await?;
            let after = chain.balance(&wallet.pubkey()).await?;
            println!("withdrew {} SOL, closed the ledger and its permission; the wallet got back {} SOL", sol(withdrawn), sol(after.saturating_sub(before)));
            Ok(())
        }
        Command::Play { cards, card, close, wallet: path, referrer } => {
            let wallet = wallet(&chain, path)?;
            play::play(&chain, &wallet, cards, card, close, referrer).await
        }
        Command::WatchLedger { who } => probe::watch_ledger(&chain, who).await,
        Command::ProbePush { wallet: path } => {
            let wallet = wallet(&chain, path)?;
            probe::probe_push(&chain, &wallet).await
        }
        Command::Finish { wallet: path } => {
            let wallet = wallet(&chain, path)?;
            let player = Player::new(&chain, &wallet, scratch_cards::ID);
            // The session key the card was bought with is gone with its run; this one consents to
            // the collect, so it has to be authorized like any other.
            player.ready(0, |m| println!("  {m}")).await?;
            let table = play::Table { player: &player, at: player.rollup().await?, referrer: None };
            if !table.finish().await? {
                println!("no card to finish");
            }
            Ok(())
        }
        Command::Card { player } => {
            let user = player.map(|p| key(&p)).transpose()?.unwrap_or(admin);
            let rollup = chain.rollup().await?;
            let Some(account) = rollup.account(&card_of(&user)).await? else {
                println!("no card for {user} at {}", card_of(&user));
                return Ok(());
            };
            let c = casino_ops::decode::<Card>(&account.data).filter(|c| c.discriminator == card::DISCRIMINATOR).context("not a card")?;
            println!("card {}  of {}  ({} bytes)", card_of(&user), Pubkey::new_from_array(c.user), account.data.len());
            println!("  card {}  status {}  terms {}", c.card_id, play::status(c.status), if Card::is_card_size(account.data.len()) { "carried" } else { "the shelf's" });
            Ok(())
        }
        Command::CloseCard { player } => {
            require_admin(&chain)?;
            let user = player.map(|p| key(&p)).transpose()?.unwrap_or(admin);
            let rollup = chain.rollup().await?;
            // No read first: a player's card is private to them on the TEE, so the admin's read
            // says "none" for a card that is there. The program answers on the account itself.
            let ix = built(generated::ScratchCards::close_card_instruction(admin, house(), card_of(&user), EPHEMERAL_VAULT, MAGIC_PROGRAM, CloseCard { user }))?;
            rollup.send(&[ix], &[&chain.admin]).await?;
            let gone = rollup.account(&card_of(&user)).await?.is_none();
            println!("{}", if gone { "✅ closed, its rent back with the house" } else { "⚠ still there" });
            Ok(())
        }
        Command::CloseStrayCards { go } => close_stray_cards(&chain, go).await,
        Command::Admin(command) => command.run::<ScratchCards>(&chain).await,
    }
}

#[cfg(test)]
mod tests {
    //! The generated client against the program's own numbers — scratch cards numbers its shared
    //! instructions its own way — and against the bytes the old scripts sent.

    use super::*;
    use casino_ops::admin as shared;
    use casino_ops::Treasury;

    fn number(ix: &Instruction) -> u64 {
        u64::from_le_bytes(ix.data[..8].try_into().unwrap())
    }

    #[test]
    fn the_shared_instructions_carry_scratch_cards_numbers() {
        let admin = Pubkey::new_from_array([1; 32]);
        let (house, jackpot) = (Treasury::house::<ScratchCards>(), Treasury::named::<ScratchCards>("jackpot").unwrap());
        let validator = casino_ops::TEE_VALIDATOR;
        assert_eq!(jackpot.which, 1);
        assert_eq!(number(&shared::delegate::<ScratchCards>(&admin, b"house", &validator).unwrap()), 2);
        assert_eq!(number(&shared::request_undelegation::<ScratchCards>(&admin, &house.address).unwrap()), 4);
        assert_eq!(number(&shared::open_ledger::<ScratchCards>(&admin, &house, 20).unwrap()), 15);
        assert_eq!(number(&shared::delegate_treasury::<ScratchCards>(&admin, &house, &validator).unwrap()), 16);
        assert_eq!(number(&shared::withdraw_house::<ScratchCards>(&admin, &Pubkey::default(), 1).unwrap()), 17);
        assert_eq!(number(&shared::close_ledger::<ScratchCards>(&admin, &house, &[]).unwrap()), 18);
        assert_eq!(number(&shared::authorize_treasury::<ScratchCards>(&admin, &house).unwrap()), 20);
        assert_eq!(number(&shared::set_privacy::<ScratchCards>(&admin, &jackpot, true).unwrap()), 22);
        assert_eq!(number(&shared::grow_config::<ScratchCards>(&admin, 1).unwrap()), 26);
        assert_eq!(number(&shared::undelegate_treasury::<ScratchCards>(&admin, &house).unwrap()), 30);
    }

    /// `setup-scratch.mjs`: `openLedgerIx(0, house)` and `makePublicIx(1, jackpot)`.
    #[test]
    fn setup_sends_what_the_script_sent() {
        let admin = Pubkey::new_from_array([1; 32]);
        let house = Treasury::house::<ScratchCards>();
        let open = shared::open_ledger::<ScratchCards>(&admin, &house, 20).unwrap();
        let mut want = 15u64.to_le_bytes().to_vec();
        want.extend_from_slice(&[0, 20, 0]);
        assert_eq!(open.data, want);
        let jackpot = Treasury::named::<ScratchCards>("jackpot").unwrap();
        let public = shared::set_privacy::<ScratchCards>(&admin, &jackpot, true).unwrap();
        let mut want = 22u64.to_le_bytes().to_vec();
        want.extend_from_slice(&[1, 1]);
        assert_eq!(public.data, want);
        assert_eq!(public.accounts[2].pubkey, casino_ops::vault::ledger(&super::jackpot()));
        assert_eq!(public.accounts[3].pubkey, permission::address(&jackpot.ledger));
    }

    /// `setup-devnet.mjs`'s `setCardIx`, ported as it was, against the generated `set_card`.
    #[test]
    fn a_published_card_is_the_bytes_the_script_sent() {
        let mints = Mints::load(false).unwrap();
        for mainnet in [false, true] {
            let cards = sheet::for_cluster(sheet::load(&sheet::sheet_path()).unwrap(), mainnet);
            for (index, c) in cards.iter().enumerate() {
                let rows = sheet::prize_rows(c, mainnet).unwrap();
                let mut want = 9u64.to_le_bytes().to_vec();
                let mode = ["count", "compare"].iter().position(|m| *m == c.mode).unwrap() as u8;
                let roll = ["exclusive", "independent"].iter().position(|r| *r == c.roll).unwrap() as u8;
                let kind = sheet::KINDS.iter().position(|k| *k == c.id).unwrap() as u8 + 1;
                want.extend_from_slice(&[index as u8, mode, roll, kind]);
                want.extend_from_slice(&c.price_lamports.to_le_bytes());
                want.extend_from_slice(&c.jackpot_hit_weight.to_le_bytes());
                want.extend_from_slice(&c.jackpot_near_weight.to_le_bytes());
                for arg in c.mode_args {
                    want.extend_from_slice(&arg.to_le_bytes());
                }
                want.extend_from_slice(&(c.blocks.len() as u32).to_le_bytes());
                for b in &c.blocks {
                    let role = ["plate", "number", "mark", "jackpot"].iter().position(|r| *r == b.role).unwrap() as u8;
                    want.extend_from_slice(&[role, b.count, b.cols, b.flags]);
                    want.extend_from_slice(&b.a.to_le_bytes());
                    want.extend_from_slice(&b.b.to_le_bytes());
                }
                want.extend_from_slice(&(c.pays.len() as u32).to_le_bytes());
                for p in &c.pays {
                    want.extend_from_slice(&p.scope.to_le_bytes());
                    want.extend_from_slice(&p.weight.to_le_bytes());
                    want.extend_from_slice(&[p.min, p.flags]);
                    want.extend_from_slice(&p.mult.to_le_bytes());
                }
                want.extend_from_slice(&(c.tiers.len() as u32).to_le_bytes());
                for t in &c.tiers {
                    want.extend_from_slice(&t.factor.to_le_bytes());
                    want.extend_from_slice(&t.weight.to_le_bytes());
                }
                want.extend_from_slice(&(c.tokens.len() as u32).to_le_bytes());
                for t in &c.tokens {
                    want.extend_from_slice(mints.mint(t).unwrap().as_ref());
                }
                want.extend_from_slice(&(rows.len() as u32).to_le_bytes());
                for r in &rows {
                    want.extend_from_slice(&r.weight.to_le_bytes());
                    want.push(r.tier);
                    want.extend_from_slice(&(r.amounts.len() as u32).to_le_bytes());
                    for a in &r.amounts {
                        want.extend_from_slice(&a.to_le_bytes());
                    }
                }
                let admin = Pubkey::new_from_array([1; 32]);
                let set = c.set_card(index as u8, &mints, mainnet).unwrap();
                set.validate().unwrap_or_else(|e| panic!("{} mainnet={mainnet}: {e:?}", c.id));
                let ix = generated::ScratchCards::set_card_instruction(admin, config(), SYSTEM_PROGRAM, set).unwrap();
                assert_eq!(ix.data, want, "card {}", c.id);
            }
        }
    }

    /// `play-devnet.mjs`'s `resolvePurchaseAccounts`: the callback's accounts after the receipt
    /// and the vault authority, the card's permission and the ACL program last.
    #[test]
    fn a_purchase_callback_names_what_the_script_named() {
        use scratch_cards::instructions::resolve_purchase::ResolvePurchase;
        let user = Pubkey::new_from_array([7; 32]);
        let resolve = generated::ScratchCards::resolve_purchase_instruction(
            Pubkey::new_from_array([2; 32]), casino_ops::vault::authority(), config(), house(), card_of(&user), EPHEMERAL_VAULT,
            MAGIC_PROGRAM, analytics(), permission::address(&card_of(&user)), PERMISSION_PROGRAM,
            ResolvePurchase { human: user, card_id: 0 },
        )
        .unwrap();
        let named: Vec<(Pubkey, bool)> = resolve.accounts.iter().skip(2).map(|m| (m.pubkey, m.is_writable)).collect();
        assert_eq!(
            named,
            vec![
                (config(), false),
                (house(), true),
                (card_of(&user), true),
                (EPHEMERAL_VAULT, true),
                (MAGIC_PROGRAM, false),
                (analytics(), true),
                (permission::address(&card_of(&user)), true),
                (PERMISSION_PROGRAM, false),
            ]
        );
        assert_eq!(number(&resolve), 27);
    }

    /// `close-stray-cards.mjs`: 31, then [admin (signer), house, card, ephemeral vault, Magic].
    /// The script marked the admin writable too; it pays the fee, which makes it so either way.
    #[test]
    fn a_stray_card_is_closed_as_the_script_closed_it() {
        let (admin, card) = (Pubkey::new_from_array([1; 32]), Pubkey::new_from_array([9; 32]));
        let ix = generated::ScratchCards::close_stray_card_instruction(admin, house(), card, EPHEMERAL_VAULT, MAGIC_PROGRAM).unwrap();
        assert_eq!(ix.data, 31u64.to_le_bytes());
        let metas: Vec<(Pubkey, bool, bool)> = ix.accounts.iter().map(|m| (m.pubkey, m.is_signer, m.is_writable)).collect();
        assert_eq!(
            metas,
            vec![
                (admin, true, false),
                (house(), false, true),
                (card, false, true),
                (EPHEMERAL_VAULT, false, true),
                (MAGIC_PROGRAM, false, false),
            ]
        );
        assert_eq!(bs58_byte(card::DISCRIMINATOR as u8), "4");
    }

    #[test]
    fn the_dev_key_is_not_an_admin_here() {
        assert!(scratch_cards::ScratchCards::is_admin(&casino_core::ids::OPS_KEY));
        assert!(scratch_cards::ScratchCards::is_admin(&casino_core::ids::CASINO_ADMIN));
        assert!(!scratch_cards::ScratchCards::is_admin(&casino_core::ids::DEV_KEY));
    }

    #[test]
    fn a_devnet_card_pays_sol_alone() {
        let cards = sheet::for_cluster(sheet::load(&sheet::sheet_path()).unwrap(), false);
        for card in &cards {
            let sol = card.tokens.iter().position(|t| t == "SOL").unwrap();
            for row in sheet::prize_rows(card, false).unwrap() {
                let paid: Vec<usize> = (0..row.amounts.len()).filter(|&t| row.amounts[t] > 0).collect();
                assert_eq!(paid, vec![sol], "{}", card.id);
            }
        }
    }

    /// The live mainnet shelf, still v2, reads as one-tier cards with its own coins and amounts —
    /// what `cards`, `verify` and the float sizing see until it is re-stamped.
    #[test]
    fn a_v2_shelf_reads_as_one_tier_cards() {
        let shelf: &[u8] = include_bytes!("../../tests/fixtures/mainnet_shelf_v2.bin");
        let count = u64::from_le_bytes(shelf[48..56].try_into().unwrap()) as usize;
        let size = scratch_cards::state::config::CARD_SIZE_V2;
        for i in 0..count {
            let b = &shelf[56 + i * size..56 + (i + 1) * size];
            let card = sheet::v2_as_v3(b);
            assert_eq!(card.price_lamports, u64::from_le_bytes(b[..8].try_into().unwrap()));
            assert_eq!(card.row_len, 1);
            assert_eq!(card.token_len, b[21]);
            for c in 0..b[21] as usize {
                assert_eq!(card.tokens[c], b[512 + c * 48..544 + c * 48]);
                assert!(card.rows[0].amounts[c] > 0);
            }
        }
        let cards: Vec<_> = (0..count).map(|i| sheet::v2_as_v3(&shelf[56 + i * size..56 + (i + 1) * size])).collect();
        assert!(!sheet::worst_cases(&cards, &Mints::default()).is_empty());
    }

    #[test]
    fn a_float_rounds_up_to_two_figures() {
        assert_eq!(sheet::round_up(7), 7);
        assert_eq!(sheet::round_up(4713), 4800);
        assert_eq!(sheet::round_up(100), 100);
        assert_eq!(sheet::round_up(101), 110);
    }
}

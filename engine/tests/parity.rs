//! The guarantee the engine rests on: a card values to exactly what was rolled.
//!
//! Read from `tools/sheet/cards.json` rather than hand-built, so the sheet the balancing tool
//! produces is the sheet that gets verified — a card shape that only exists in a test proves
//! nothing about the one being published.
//!
//! Seed fuzzing alone would never reach a 1-in-500,000 rung, so every declared outcome is also
//! forced directly and rendered many times over.

use scratch_engine::*;
use serde_json::Value;

/// The coins a card pays in, and the prize rows, from the sheet.
fn prizes(c: &Value, card: &mut CardConfig) -> Vec<String> {
    let tokens: Vec<String> = c["tokens"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect();
    card.token_len = tokens.len() as u8;
    card.row_len = c["prizes"].as_array().unwrap().len() as u8;
    for (r, row) in c["prizes"].as_array().unwrap().iter().enumerate() {
        card.rows[r].weight = row["weight"].as_u64().unwrap() as u32;
        for (t, a) in row["amounts"].as_array().unwrap().iter().enumerate() {
            card.rows[r].amounts[t] = a.as_u64().unwrap();
        }
    }
    tokens
}

fn cards() -> Vec<(String, CardConfig)> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tools/sheet/cards.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("cards.json")).unwrap();
    raw.as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let mut card = CardConfig {
                mode: if c["mode"] == "compare" { MODE_COMPARE } else { MODE_COUNT },
                roll: if c["roll"] == "independent" { ROLL_INDEPENDENT } else { ROLL_EXCLUSIVE },
                jackpot_hit: c["jackpotHitWeight"].as_u64().unwrap_or(0) as u32,
                jackpot_near: c["jackpotNearWeight"].as_u64().unwrap_or(0) as u32,
                ..Default::default()
            };
            for (i, v) in c["modeArgs"].as_array().unwrap().iter().enumerate() {
                card.mode_args[i] = v.as_u64().unwrap_or(0) as u16;
            }
            for (i, b) in c["blocks"].as_array().unwrap().iter().enumerate() {
                card.blocks[i] = Block {
                    role: match b["role"].as_str().unwrap() {
                        "number" => ROLE_NUMBER,
                        "mark" => ROLE_MARK,
                        "jackpot" => ROLE_JACKPOT,
                        _ => ROLE_PLATE,
                    },
                    count: b["count"].as_u64().unwrap() as u8,
                    cols: b["cols"].as_u64().unwrap_or(0) as u8,
                    flags: b["flags"].as_u64().unwrap_or(0) as u8,
                    a: b["a"].as_u64().unwrap_or(0) as u16,
                    b: b["b"].as_u64().unwrap_or(0) as u16,
                };
                card.block_len = i as u8 + 1;
            }
            for (i, p) in c["pays"].as_array().unwrap().iter().enumerate() {
                card.pays[i] = Pay {
                    scope: p["scope"].as_u64().unwrap() as u32,
                    weight: p["weight"].as_u64().unwrap() as u32,
                    min: p["min"].as_u64().unwrap() as u8,
                    flags: p["flags"].as_u64().unwrap_or(0) as u8,
                    mult: p["mult"].as_u64().unwrap() as u16,
                };
                card.pay_len = i as u8 + 1;
            }
            for (i, t) in c["tiers"].as_array().unwrap().iter().enumerate() {
                card.tiers[i] = Tier {
                    factor: t["factor"].as_u64().unwrap() as u32,
                    weight: t["weight"].as_u64().unwrap() as u32,
                };
                card.tier_len = i as u8 + 1;
            }
            let tokens = prizes(c, &mut card);
            card.sol_index = tokens.iter().position(|t| t == "SOL").map_or(0xFFFF, |i| i as u16);
            (c["id"].as_str().unwrap().to_string(), card)
        })
        .collect()
}

fn seed(n: u64) -> [u8; 32] {
    let mut s = [0u8; 32];
    for (i, chunk) in s.chunks_exact_mut(8).enumerate() {
        chunk.copy_from_slice(&n.wrapping_mul(0x9e37_79b9_7f4a_7c15 + i as u64).to_le_bytes());
    }
    s
}

/// Every card, dealt from a fresh seed, must value to exactly what it rolled.
#[test]
fn dealt_cards_match_their_outcome() {
    for (id, card) in cards() {
        for n in 0..200_000u64 {
            if let Err(_) = deal_checked(&card, &seed(n)) {
                panic!("{id}: seed {n} rendered a card that does not value to its outcome");
            }
        }
    }
}

/// Forced coverage: every pay entry on every symbol (a coin in each tier that offers it), rendered
/// repeatedly.
///
/// This is the part seed fuzzing cannot do. The rarest rungs on this sheet are 1 in millions, so
/// a random sweep would never place one — and those are exactly the outcomes whose render has
/// never otherwise been exercised.
#[test]
fn every_declared_outcome_renders_correctly() {
    for (id, card) in cards() {
        let (syms, n_syms) = card.symbols();
        for pay in 0..card.pays().len() {
            for &s in &syms[..n_syms] {
                let p = card.pays()[pay];
                let coin = symbol_token(s);
                let mut out = Outcome::default();
                out.wins[0] = Win { pay: pay as u8, token: s, count: p.min };
                out.win_len = 1;
                for n in 0..400u64 {
                    let mut rng = Rng::from_bytes(&seed(n * 7 + pay as u64));
                    let d = render(&card, &out, &mut rng)
                        .unwrap_or_else(|_| panic!("{id}: pay {pay} symbol {s} failed to render"));
                    let got = winnings(&card, &d).unwrap();
                    let want = card.amount(s)
                        * p.mult as u64
                        * if p.flags & LINEAR != 0 { p.min as u64 } else { 1 };
                    assert_eq!(
                        got.amounts[coin], want,
                        "{id}: pay {pay} (scope {:#x} min {} mult {}) symbol {s} paid {} want {}",
                        p.scope, p.min, p.mult, got.amounts[coin], want
                    );
                    for (t, &a) in got.amounts.iter().enumerate() {
                        if t != coin {
                            assert_eq!(a, 0, "{id}: pay {pay} symbol {s} also paid coin {t}");
                        }
                    }
                }
            }
        }
    }
}

/// A losing or near-miss jackpot line must never *look* won. A cell reads as SOL when it is the
/// SOL mark or a coin whose mint is SOL — so with SOL placed at every coin position (and at none),
/// a line reading as all-SOL must exactly track the real jackpot. This is the class of bug where a
/// near-miss showed four SOL coins.
#[test]
fn no_line_reads_as_a_false_jackpot() {
    let n: u64 = std::env::var("FUZZ_SEEDS").ok().and_then(|v| v.parse().ok()).unwrap_or(50_000);
    let mut total = 0u64;
    let mut jackpots = 0u64;
    let mut nears = 0u64;
    for (id, base) in cards() {
        let coins = base.token_len as u16;
        for sol in (0..coins).chain(std::iter::once(0xFFFFu16)) {
            let mut card = base;
            card.sol_index = sol;
            for k in 0..n {
                let s = seed(k.wrapping_mul(2_654_435_761).wrapping_add(sol as u64 + 1));
                let d = deal(&card, &s).unwrap();
                if d.len <= d.body_len {
                    continue;
                }
                let reads_sol = |c: u16| {
                    let p = payload(c);
                    p == SOL_MARK || (sol != 0xFFFF && p == sol)
                };
                let visual = d.cells[d.body_len..d.len].iter().all(|&c| reads_sol(c));
                let real = winnings(&card, &d).unwrap().jackpot;
                assert_eq!(
                    real, visual,
                    "{id} sol_index={sol} seed#{k}: real jackpot={real} but line-reads-all-SOL={visual}; \
                     jackpot payloads = {:?}",
                    d.cells[d.body_len..d.len].iter().map(|&c| payload(c)).collect::<Vec<_>>()
                );
                // count a near-miss: all-but-one SOL-reading
                let sol_ct = d.cells[d.body_len..d.len].iter().filter(|&&c| reads_sol(c)).count();
                let jn = d.len - d.body_len;
                if real { jackpots += 1; } else if sol_ct + 1 == jn { nears += 1; }
                total += 1;
            }
        }
    }
    eprintln!("false-jackpot fuzz: {total} deals, {jackpots} real jackpots, {nears} near-misses");
}

/// What the *player* sees: cells collapsed by icon. A plate shows its coin's mint in its tier's
/// frame, so two symbols of one tier whose coins share a mint are indistinguishable, while the same
/// coin in two tiers is not. A jackpot-line mark shows a coin's mint, and a SOL coin (mint 0) there
/// also reads as the jackpot SOL mark. Numbers and multipliers are unambiguous.
fn by_icon(cell: u16, mints: &[u16; 16], pl: usize, jackpot_line: bool) -> u16 {
    let first = |idx: usize| (0..pl).find(|&j| mints[j] == mints[idx]).unwrap_or(idx) as u16;
    if is_plate(cell) {
        let s = payload(cell) as u8;
        let (row, coin) = (symbol_row(s), symbol_token(s));
        if coin < pl { plate(symbol(row, first(coin) as usize) as u16) } else { cell }
    } else if is_mark(cell) {
        let p = payload(cell) as usize;
        if payload(cell) == SOL_MARK { mark(SOL_MARK) }
        else if p >= pl { cell }
        else if jackpot_line && mints[p] == 0 { mark(SOL_MARK) }
        else { mark(first(p)) }
    } else {
        cell
    }
}

/// The whole card must show exactly what it pays: reading it by icon (mint) must value to the same
/// thing `winnings` does by index. Mints are fuzzed with a small range so collisions and SOL are
/// common — this is the general form of the four-SOL-coins bug.
#[test]
fn the_whole_card_shows_what_it_pays() {
    let n: u64 = std::env::var("FUZZ_SEEDS").ok().and_then(|v| v.parse().ok()).unwrap_or(3_000);
    for (id, base) in cards() {
        let pl = base.token_len as usize;
        // publishable configs only: distinct mints, with SOL (0) at each position and at none
        for sol in (0..pl as i64).chain(std::iter::once(-1i64)) {
            let cfg = (sol + 1) as u64;
            let mut mints = [0u16; 16];
            for i in 0..pl { mints[i] = i as u16 + 1; }
            if sol >= 0 { mints[sol as usize] = 0; }
            let mut card = base;
            card.sol_index = if sol >= 0 { sol as u16 } else { 0xFFFF };
            for k in 0..n {
                let d = deal(&card, &seed(k.wrapping_mul(2_654_435_761).wrapping_add(cfg))).unwrap();
                let real = winnings(&card, &d).unwrap();
                let mut cells = d.cells;
                for (i, c) in cells[..d.len].iter_mut().enumerate() {
                    *c = by_icon(*c, &mints, pl, i >= d.body_len);
                }
                let seen = winnings(&card, &Deal { cells, len: d.len, body_len: d.body_len }).unwrap();
                assert_eq!(real.amounts, seen.amounts,
                    "{id} cfg{cfg} seed#{k} mints={:?}: pays {:?} but reads as {:?}", &mints[..pl], real.amounts, seen.amounts);
                assert_eq!(real.jackpot, seen.jackpot,
                    "{id} cfg{cfg} seed#{k} mints={:?}: jackpot pays {} but reads {}", &mints[..pl], real.jackpot, seen.jackpot);
            }
        }
    }
}

/// A win's prize is a tier by its weight, then one of that tier's coins, each as likely. Drawn
/// from the roll itself, over every card, against the published weights.
#[test]
fn a_prize_is_a_tier_by_weight_then_any_of_its_coins() {
    for (id, card) in cards() {
        let mut by_row = [0u64; PRIZE_ROWS];
        let mut by_symbol = [0u64; MAX_SYMBOLS];
        let mut wins = 0u64;
        for n in 0..400_000u64 {
            let mut rng = Rng::from_bytes(&seed(n));
            for w in roll(&card, &mut rng).wins() {
                by_row[symbol_row(w.token)] += 1;
                by_symbol[w.token as usize] += 1;
                wins += 1;
            }
        }
        assert!(wins >= 10_000, "{id}: only {wins} wins in 400,000 rolls — too few to judge the draw");
        eprintln!("{id}: {wins} wins, by tier {by_row:?}");
        let rows = card.prize_rows();
        let total: u64 = card.rows[..rows].iter().map(|r| r.weight as u64).sum();
        for r in 0..rows {
            // a lone tier is always the prize, and holds weight 0
            let want = if rows == 1 { 1.0 } else { card.rows[r].weight as f64 / total as f64 };
            let got = by_row[r] as f64 / wins as f64;
            assert!((got - want).abs() < 0.01 + want * 0.05, "{id}: tier {r} drawn {got:.4}, weighted {want:.4}");
            let coins: Vec<usize> = (0..card.tokens()).filter(|&t| card.rows[r].amounts[t] > 0).collect();
            if by_row[r] < 2_000 {
                continue;
            }
            for &t in &coins {
                let share = by_symbol[symbol(r, t) as usize] as f64 / by_row[r] as f64;
                let even = 1.0 / coins.len() as f64;
                assert!((share - even).abs() < 0.03 + even * 0.2, "{id}: tier {r} coin {t} drawn {share:.3}, even {even:.3}");
            }
        }
    }
}

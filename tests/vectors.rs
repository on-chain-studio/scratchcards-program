//! Dumps deal vectors the Android client's `SeedEngineParityTest` pins against.
//!
//!   cargo test --test vectors -- --nocapture
//!
//! Read from the tuned sheet rather than a synthetic fixture: the client has to agree with the
//! cards that actually ship, and a hand-built card proves nothing about those.

use scratch_cards::state::config::*;
use scratch_cards::utils::engine;
use serde_json::Value;

fn sheet() -> Vec<(String, CardConfig)> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tools/sheet/cards.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    raw.as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let mut card: CardConfig = bytemuck::Zeroable::zeroed();
            card.price_lamports = c["priceLamports"].as_u64().unwrap();
            card.mode = if c["mode"] == "compare" { MODE_COMPARE } else { MODE_COUNT };
            card.roll = if c["roll"] == "independent" { ROLL_INDEPENDENT } else { ROLL_EXCLUSIVE };
            card.jackpot_hit = c["jackpotHitWeight"].as_u64().unwrap() as u32;
            card.jackpot_near = c["jackpotNearWeight"].as_u64().unwrap() as u32;
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
            for (i, e) in c["pool"].as_array().unwrap().iter().enumerate() {
                card.pool[i] = PoolEntry {
                    mint: [i as u8 + 1; 32],
                    amount: e["amount"].as_u64().unwrap(),
                    weight: e["weight"].as_u64().unwrap() as u32,
                    _pad: 0,
                };
                card.pool_len = i as u8 + 1;
            }
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

#[test]
fn dump_vectors() {
    for (id, c) in sheet() {
        // the card as the account holds it, which is exactly what the client hands the wasm
        let hex: String = bytemuck::bytes_of(&c).iter().map(|b| format!("{b:02x}")).collect();
        println!("CARD {id} {hex}");
        for i in 0..24u64 {
            let d = engine::deal(&c, &seed(i)).unwrap();
            let w = engine::winnings(&c, &d).unwrap();
            let cells: Vec<String> = d.cells[..d.len].iter().map(|c| format!("{c:04x}")).collect();
            let amounts: Vec<String> = w
                .amounts
                .iter()
                .enumerate()
                .filter(|(_, a)| **a > 0)
                .map(|(i, a)| format!("{i}:{a}"))
                .collect();
            println!(
                "VEC card={id} seed={i} cells={} amounts={} jackpot={} mult={}",
                cells.join(","),
                amounts.join("|"),
                w.jackpot as u8,
                w.multiplier,
            );
        }
    }
}

/// The wasm is handed the bytes the account stores, so parsing them back has to reproduce the
/// card exactly — otherwise the client deals a different card from the one the program values.
///
/// Compares the dealt cells rather than the struct: a field the parser silently drops would
/// still compare equal field-by-field if the comparison were written against the same offsets.
#[test]
fn the_stored_bytes_deal_the_same_card() {
    for (id, card) in sheet() {
        let bytes = bytemuck::bytes_of(&card);
        assert_eq!(bytes.len(), scratch_engine::CARD_BYTES, "{id}: stride disagrees with the wasm");
        let parsed = scratch_engine::parse(bytes).expect("bytes should parse");

        for i in 0..2_000u64 {
            let mine = engine::deal(&card, &seed(i)).unwrap();
            let theirs = scratch_engine::deal(&parsed, &seed(i)).unwrap();
            assert_eq!(mine.len, theirs.len, "{id}: seed {i} cell count");
            assert_eq!(mine.body_len, theirs.body_len, "{id}: seed {i} body length");
            assert_eq!(
                mine.cells[..mine.len], theirs.cells[..theirs.len],
                "{id}: seed {i} dealt different cells through the wasm layout"
            );
            let a = engine::winnings(&card, &mine).unwrap();
            let b = scratch_engine::winnings(&parsed, &theirs).unwrap();
            assert_eq!(a.amounts, b.amounts, "{id}: seed {i} paid differently");
            assert_eq!(a.jackpot, b.jackpot);
            assert_eq!(a.multiplier, b.multiplier);
        }
    }
}

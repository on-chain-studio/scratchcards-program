use bytemuck::Zeroable;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use scratch_cards::state::card::{self, Card, CardStatus};
use scratch_cards::state::config::*;
use serde_json::Value;

fn key(b: [u8; 32]) -> Pubkey { Pubkey::new_from_array(b) }
fn program() -> Pubkey { key(scratch_cards::ID.to_bytes()) }
fn acct(data: Vec<u8>, owner: Pubkey) -> Account { Account { lamports: 1_000_000_000, data, owner, executable: false, rent_epoch: 0 } }

fn cards() -> Vec<(String, CardConfig)> {
    let raw: Value = serde_json::from_str(&std::fs::read_to_string("tools/sheet/cards.json").unwrap()).unwrap();
    raw.as_array().unwrap().iter().map(|c| {
        let mut k = CardConfig::zeroed();
        k.price_lamports = c["priceLamports"].as_u64().unwrap();
        k.jackpot_hit = c["jackpotHitWeight"].as_u64().unwrap() as u32;
        k.jackpot_near = c["jackpotNearWeight"].as_u64().unwrap() as u32;
        k.mode = if c["mode"] == "compare" { MODE_COMPARE } else { MODE_COUNT };
        k.roll = if c["roll"] == "independent" { ROLL_INDEPENDENT } else { ROLL_EXCLUSIVE };
        let args = c["modeArgs"].as_array().unwrap();
        for i in 0..4 { k.mode_args[i] = args[i].as_u64().unwrap_or(0) as u16; }
        let blocks = c["blocks"].as_array().unwrap();
        k.block_len = blocks.len() as u8;
        for (i, b) in blocks.iter().enumerate() {
            k.blocks[i] = Block { role: match b["role"].as_str().unwrap() { "number" => ROLE_NUMBER, "mark" => ROLE_MARK, "jackpot" => ROLE_JACKPOT, _ => ROLE_PLATE },
                count: b["count"].as_u64().unwrap() as u8, cols: 0, flags: b["flags"].as_u64().unwrap_or(0) as u8,
                a: b["a"].as_u64().unwrap_or(0) as u16, b: b["b"].as_u64().unwrap_or(0) as u16 };
        }
        let pays = c["pays"].as_array().unwrap();
        k.pay_len = pays.len() as u8;
        for (i, p) in pays.iter().enumerate() {
            k.pays[i] = Pay { scope: p["scope"].as_u64().unwrap() as u32, weight: p["weight"].as_u64().unwrap() as u32,
                min: p["min"].as_u64().unwrap() as u8, flags: p["flags"].as_u64().unwrap_or(0) as u8, mult: p["mult"].as_u64().unwrap() as u16 };
        }
        let toks = c["tokens"].as_array().unwrap();
        k.token_len = toks.len() as u8;
        for (i, t) in toks.iter().enumerate() { k.tokens[i] = if t == "SOL" { [0; 32] } else { [i as u8 + 1; 32] }; }
        let rows = c["prizes"].as_array().unwrap();
        k.row_len = rows.len() as u8;
        for (i, r) in rows.iter().enumerate() {
            k.rows[i].weight = r["weight"].as_u64().unwrap() as u32;
            k.rows[i].tier = r["tier"].as_u64().unwrap() as u8;
            for (j, a) in r["amounts"].as_array().unwrap().iter().enumerate() { k.rows[i].amounts[j] = a.as_u64().unwrap(); }
        }
        (c["id"].as_str().unwrap().to_string(), k)
    }).collect()
}

#[test]
#[ignore]
fn v3_tickets_are_valued_to_the_vault_cpi() {
    let m = Mollusk::new(&program(), "scratch_cards");
    let pid = program();
    let user = Pubkey::new_unique();
    let wallet = user;
    let (card_k, _) = Pubkey::find_program_address(&[b"card", user.as_ref()], &pid);
    let (config_k, _) = Pubkey::find_program_address(&[b"config"], &pid);
    let (house, _) = Pubkey::find_program_address(&[b"house"], &pid);
    let (jackpot, _) = Pubkey::find_program_address(&[b"jackpot"], &pid);
    let house_ledger = key(casino_core::vault::ledger(&casino_core::chain::Pubkey::new_from_array(house.to_bytes())).to_bytes());
    let jackpot_ledger = key(casino_core::vault::ledger(&casino_core::chain::Pubkey::new_from_array(jackpot.to_bytes())).to_bytes());
    let receipt = key(casino_core::receipt::address(&scratch_cards::ID, &casino_core::chain::Pubkey::new_from_array(wallet.to_bytes())).to_bytes());
    let mut shelf = vec![0u8; Config::size_for(4)];
    shelf[..8].copy_from_slice(&DISCRIMINATOR.to_le_bytes());
    shelf[8..16].copy_from_slice(&VERSION.to_le_bytes());
    shelf[48..56].copy_from_slice(&4u64.to_le_bytes());
    let other = Pubkey::new_unique();
    let mut all = cards();
    let mut big = all[3].1; big.token_len = 12;
    for r in 0..4 { for t in 0..12 { if big.rows[r].amounts[t] == 0 { big.rows[r].amounts[t] = 1000 + t as u64; } } big.tokens[r] = [0x40 + r as u8; 32]; }
    for t in 10..12 { big.tokens[t] = [0x50 + t as u8; 32]; }
    all.push(("vault-12x4".into(), big));
    for (id, terms) in all {
        let (mut max, mut sum, mut n, mut fails) = (0u64, 0u64, 0u64, 0u64);
        for s in 0..(if id.starts_with("vault") { 3000u32 } else { 300 }) {
            let mut c = Card::zeroed();
            c.discriminator = card::DISCRIMINATOR; c.version = card::VERSION; c.user = user.to_bytes();
            c.status = CardStatus::Revealed as u64;
            let mut seed = [0u8; 32]; seed[..4].copy_from_slice(&s.to_le_bytes()); seed[4] = 0x5a;
            c.seed = seed;
            let mut data = bytemuck::bytes_of(&c).to_vec();
            data.extend_from_slice(bytemuck::bytes_of(&terms));
            data.resize(Card::PERSISTENT_SIZE, 0);
            let ix = Instruction::new_with_bytes(pid, &25u64.to_le_bytes(), vec![
                AccountMeta::new_readonly(user, false), AccountMeta::new_readonly(config_k, false), AccountMeta::new(house, false),
                AccountMeta::new(card_k, false), AccountMeta::new(receipt, false), AccountMeta::new(other, false),
                AccountMeta::new_readonly(other, false), AccountMeta::new_readonly(other, false), AccountMeta::new_readonly(jackpot, false),
                AccountMeta::new(jackpot_ledger, false), AccountMeta::new_readonly(wallet, true), AccountMeta::new(house_ledger, false),
                AccountMeta::new(other, false)]);
            let accts = vec![(user, acct(vec![], Pubkey::default())), (config_k, acct(shelf.clone(), pid)), (house, acct(vec![], pid)),
                (card_k, acct(data, pid)), (receipt, acct(vec![], Pubkey::default())), (other, acct(vec![], Pubkey::default())),
                (jackpot, acct(vec![], pid)), (jackpot_ledger, acct(vec![0u8; 400], Pubkey::default())), (house_ledger, acct(vec![0u8; 400], Pubkey::default()))];
            let r = m.process_instruction(&ix, &accts);
            if s < 2 { println!("{id} seed {s}: {:?} cu {}", r.raw_result, r.compute_units_consumed); }
            if r.compute_units_consumed < 2000 || !matches!(r.raw_result, Err(solana_instruction::error::InstructionError::MissingAccount) | Err(solana_instruction::error::InstructionError::NotEnoughAccountKeys)) {
                panic!("{id} seed {s}: {:?} after {} CU", r.raw_result, r.compute_units_consumed);
            }
            if r.compute_units_consumed < 2000 { fails += 1; }
            max = max.max(r.compute_units_consumed); sum += r.compute_units_consumed; n += 1;
        }
        println!("{id}: max {max} avg {} early_fail {fails}", sum / n);
    }
}


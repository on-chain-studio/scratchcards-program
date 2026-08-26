use std::fs;
fn main() {
    let terms = fs::read("/tmp/terms.bin").unwrap();
    let sv = fs::read("/tmp/seed.bin").unwrap();
    let mut seed = [0u8; 32]; seed.copy_from_slice(&sv[..32]);
    let card = scratch_engine::parse(&terms).expect("parse");
    let d = scratch_engine::deal(&card, &seed).expect("deal");
    let w = scratch_engine::winnings(&card, &d).expect("winnings");
    println!("body_len {} total {}", d.body_len, d.len);
    println!("REAL winnings.jackpot = {}", w.jackpot);
    println!("amounts = {:?}", &w.amounts[..card.pool_len as usize]);
    print!("jackpot line (fixed engine): ");
    for &c in &d.cells[d.body_len..d.len] {
        let p = c & 0x0FFF;
        print!("{} ", if p == 255 { "SOL".to_string() } else { format!("tok{}", p) });
    }
    println!();
}

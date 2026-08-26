//! The card engine: rolls what a card pays, renders cells that show exactly that, and values them.
//!
//! The outcome is drawn from published weights first; `render` must display precisely it, and
//! `winnings` — the authority for a payout — reads it back off the visible cells. `deal_checked`
//! asserts the two agree. The Solana program calls this crate; the client runs it as wasm.

#![cfg_attr(not(feature = "std"), no_std)]

#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

mod rng;
pub use rng::{Rng, TOTAL};

pub const MAX_POOL: usize = 10;
pub const MAX_BLOCKS: usize = 8;
pub const MAX_PAYS: usize = 32;
pub const MAX_TIERS: usize = 4;
pub const MAX_CELLS: usize = 32;

/// Sentinel pool index for the SOL mark on the jackpot line — never a plate.
pub const SOL_MARK: u16 = 255;

pub const ROLE_PLATE: u8 = 0;
pub const ROLE_NUMBER: u8 = 1;
pub const ROLE_MARK: u8 = 2;
pub const ROLE_JACKPOT: u8 = 3;

/// Block flags.
pub const DISTINCT: u8 = 1;

/// Pay flags.
pub const MARKED: u8 = 1;
pub const LINEAR: u8 = 2;

pub const MODE_COUNT: u8 = 0;
pub const MODE_COMPARE: u8 = 1;

pub const ROLL_EXCLUSIVE: u8 = 0;
pub const ROLL_INDEPENDENT: u8 = 1;

#[derive(Clone, Copy, Default)]
pub struct Block {
    pub role: u8,
    pub count: u8,
    /// render hint only; the engine never reads it
    pub cols: u8,
    pub flags: u8,
    pub a: u16,
    pub b: u16,
}

/// One payable configuration: the cells it looks inside, how many alike it starts paying at,
/// what it multiplies the plate by, and how often it is planted.
#[derive(Clone, Copy, Default)]
pub struct Pay {
    pub scope: u32,
    pub weight: u32,
    pub min: u8,
    pub flags: u8,
    pub mult: u16,
}

#[derive(Clone, Copy, Default)]
pub struct Tier {
    pub factor: u32,
    pub weight: u32,
}

#[derive(Clone, Copy, Default)]
pub struct PoolEntry {
    pub weight: u32,
    pub amount: u64,
}

#[derive(Clone, Copy)]
pub struct CardConfig {
    pub mode: u8,
    pub roll: u8,
    pub jackpot_hit: u32,
    pub jackpot_near: u32,
    pub mode_args: [u16; 4],
    pub block_len: u8,
    pub pay_len: u8,
    pub tier_len: u8,
    pub pool_len: u8,
    pub blocks: [Block; MAX_BLOCKS],
    pub pays: [Pay; MAX_PAYS],
    pub tiers: [Tier; MAX_TIERS],
    pub pool: [PoolEntry; MAX_POOL],
    /// Pool index whose mint is SOL, or 0xFFFF if none. A SOL pool token renders identically to
    /// the jackpot's SOL mark, so it must never be a jackpot-line filler.
    pub sol_index: u16,
}

impl Default for CardConfig {
    fn default() -> Self {
        Self {
            mode: MODE_COUNT,
            roll: ROLL_EXCLUSIVE,
            jackpot_hit: 0,
            jackpot_near: 0,
            mode_args: [0; 4],
            block_len: 0,
            pay_len: 0,
            tier_len: 0,
            pool_len: 0,
            blocks: [Block::default(); MAX_BLOCKS],
            pays: [Pay::default(); MAX_PAYS],
            tiers: [Tier::default(); MAX_TIERS],
            pool: [PoolEntry::default(); MAX_POOL],
            sol_index: 0xFFFF,
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct BadCard;

impl CardConfig {
    pub fn blocks(&self) -> &[Block] {
        &self.blocks[..(self.block_len as usize).min(MAX_BLOCKS)]
    }
    pub fn pays(&self) -> &[Pay] {
        &self.pays[..(self.pay_len as usize).min(MAX_PAYS)]
    }
    pub fn tiers(&self) -> &[Tier] {
        &self.tiers[..(self.tier_len as usize).min(MAX_TIERS)]
    }
    pub fn pool(&self) -> &[PoolEntry] {
        &self.pool[..(self.pool_len as usize).min(MAX_POOL)]
    }

    /// Cells before the jackpot line — everything a pay entry may look at.
    pub fn body_len(&self) -> usize {
        self.blocks()
            .iter()
            .filter(|b| b.role != ROLE_JACKPOT)
            .map(|b| b.count as usize)
            .sum()
    }

    pub fn cell_count(&self) -> usize {
        self.blocks().iter().map(|b| b.count as usize).sum()
    }

    fn block_offset(&self, index: usize) -> usize {
        self.blocks()[..index].iter().map(|b| b.count as usize).sum()
    }

    fn first_block(&self, role: u8) -> Option<(usize, usize, Block)> {
        self.blocks()
            .iter()
            .position(|b| b.role == role)
            .map(|i| (i, self.block_offset(i), self.blocks()[i]))
    }
}

// Cell encoding, u16:
//   0x0000 | idx   plate (pool index)
//   0x1000 | n     printed number
//   0x2000 | m     slot multiplier
//   0x3000 | idx   jackpot-line mark (SOL_MARK = SOL)
const KIND_PLATE: u16 = 0x0000;
const KIND_NUM: u16 = 0x1000;
const KIND_MULT: u16 = 0x2000;
const KIND_MARK: u16 = 0x3000;
const KIND_MASK: u16 = 0xF000;

pub fn plate(idx: u16) -> u16 {
    KIND_PLATE | idx
}
pub fn num(n: i32) -> u16 {
    KIND_NUM | (n as u16 & !KIND_MASK)
}
pub fn mult_cell(m: u32) -> u16 {
    KIND_MULT | (m as u16 & !KIND_MASK)
}
pub fn mark(idx: u16) -> u16 {
    KIND_MARK | idx
}

pub fn is_plate(c: u16) -> bool {
    c & KIND_MASK == KIND_PLATE
}
pub fn is_mark(c: u16) -> bool {
    c & KIND_MASK == KIND_MARK
}
pub fn payload(c: u16) -> u16 {
    c & !KIND_MASK
}

const EMPTY: u16 = 0xFFFF;

/// One paying line of the outcome: which entry fired, on which token, at what group size.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Win {
    pub pay: u8,
    pub token: u8,
    pub count: u8,
}

/// What a card pays, decided before a single cell is placed.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Outcome {
    pub wins: [Win; MAX_PAYS],
    pub win_len: u8,
    /// slot multiplier applied to everything, 1 when none landed
    pub tier: u32,
    /// 0 normal, 1 near miss, 2 hit
    pub jackpot: u8,
}

impl Default for Outcome {
    fn default() -> Self {
        Self { wins: [Win::default(); MAX_PAYS], win_len: 0, tier: 1, jackpot: 0 }
    }
}

impl Outcome {
    pub fn wins(&self) -> &[Win] {
        &self.wins[..(self.win_len as usize).min(MAX_PAYS)]
    }

    fn push(&mut self, w: Win) {
        if (self.win_len as usize) < MAX_PAYS {
            self.wins[self.win_len as usize] = w;
            self.win_len += 1;
        }
    }
}

pub struct Deal {
    pub cells: [u16; MAX_CELLS],
    pub len: usize,
    pub body_len: usize,
}

pub struct Winnings {
    /// token base units won per pool index, multiplier applied
    pub amounts: [u64; MAX_POOL],
    pub jackpot: bool,
    pub multiplier: u32,
}

fn cells_of(scope: u32) -> impl Iterator<Item = usize> {
    (0..MAX_CELLS).filter(move |i| scope >> i & 1 == 1)
}

fn scope_len(scope: u32) -> usize {
    scope.count_ones() as usize
}

/// The multiple an entry pays: `mult`, times the group size when it pays per matching plate.
fn effective_mult(p: &Pay) -> u64 {
    (p.mult as u64).saturating_mul(if p.flags & LINEAR != 0 { p.min as u64 } else { 1 })
}

// ── rolling ────────────────────────────────────────────────────────────────────────────────

fn pool_weights(card: &CardConfig) -> [u32; MAX_POOL] {
    let mut w = [0u32; MAX_POOL];
    for (i, e) in card.pool().iter().enumerate() {
        w[i] = e.weight;
    }
    w
}

/// Draws what the card pays from the published weights, before any cell exists.
pub fn roll(card: &CardConfig, rng: &mut Rng) -> Outcome {
    let mut out = Outcome::default();
    let pool_len = card.pool_len as usize;
    if pool_len == 0 {
        return out;
    }
    let pw = pool_weights(card);
    let pool = &pw[..pool_len];

    let mut pay_w = [0u32; MAX_PAYS];
    for (i, p) in card.pays().iter().enumerate() {
        pay_w[i] = p.weight;
    }
    let pays = &pay_w[..card.pays().len()];

    if card.roll == ROLL_INDEPENDENT {
        // every entry rolls on its own and the payouts add up
        for (i, p) in card.pays().iter().enumerate() {
            if rng.weight() < p.weight {
                if let Some(t) = rng.pick(pool) {
                    out.push(Win { pay: i as u8, token: t as u8, count: p.min });
                }
            }
        }
    } else if let Some(i) = rng.pick(pays) {
        // exclusive: one entry at most, the shortfall to 2^32 being the miss
        if let Some(t) = rng.pick(pool) {
            out.push(Win { pay: i as u8, token: t as u8, count: card.pays()[i].min });
        }
    }

    let mut tier_w = [0u32; MAX_TIERS];
    for (i, t) in card.tiers().iter().enumerate() {
        tier_w[i] = t.weight;
    }
    out.tier = match rng.pick(&tier_w[..card.tiers().len()]) {
        Some(i) => card.tiers()[i].factor.max(1),
        None => 1,
    };

    out.jackpot = match rng.pick(&[card.jackpot_hit, card.jackpot_near]) {
        Some(0) => 2,
        Some(1) => 1,
        _ => 0,
    };

    out
}

// ── rendering ──────────────────────────────────────────────────────────────────────────────

/// How many of `token` a scope may hold without firing an undeclared entry — a declared win caps
/// at its own group size, everything else one short of firing.
fn cap(card: &CardConfig, out: &Outcome, pay_index: usize, token: u8) -> usize {
    for w in out.wins() {
        if w.pay as usize == pay_index && w.token == token {
            return w.count as usize;
        }
    }
    (card.pays()[pay_index].min as usize).saturating_sub(1)
}

fn count_in(cells: &[u16; MAX_CELLS], scope: u32, token: u8) -> usize {
    cells_of(scope).filter(|&i| cells[i] == plate(token as u16)).count()
}

/// True when `token` may be placed at `cell` without pushing any scope past its cap.
fn placeable(card: &CardConfig, out: &Outcome, cells: &[u16; MAX_CELLS], cell: usize, token: u8) -> bool {
    // Compare wins by the numbers, not plate counts — counting plates here would forbid every token.
    if card.mode == MODE_COMPARE {
        return true;
    }
    for (j, p) in card.pays().iter().enumerate() {
        if p.scope >> cell & 1 == 0 {
            continue;
        }
        // a MARKED entry only counts plates whose token is one of the marks
        if p.flags & MARKED != 0 && !is_marked(card, cells, token) {
            continue;
        }
        if count_in(cells, p.scope, token) + 1 > cap(card, out, j, token) {
            return false;
        }
    }
    true
}

fn is_marked(card: &CardConfig, cells: &[u16; MAX_CELLS], token: u8) -> bool {
    match card.first_block(ROLE_MARK) {
        Some((_, start, b)) => (start..start + b.count as usize)
            .any(|i| is_mark(cells[i]) && payload(cells[i]) == token as u16),
        None => false,
    }
}

/// Places cells that display exactly `out` and nothing more.
pub fn render(card: &CardConfig, out: &Outcome, rng: &mut Rng) -> Result<Deal, BadCard> {
    let pool_len = card.pool_len as usize;
    let body = card.body_len();
    let total = card.cell_count();
    if pool_len == 0 || total == 0 || total > MAX_CELLS {
        return Err(BadCard);
    }

    let mut cells = [EMPTY; MAX_CELLS];

    // Marks first: whether a fill counts as a match depends on them, so they must exist before it.
    if let Some((_, start, b)) = card.first_block(ROLE_MARK) {
        let slots = (b.count as usize).min(MAX_CELLS - start);
        let mut chosen = [u8::MAX; MAX_POOL];
        let mut n = 0usize;
        for w in out.wins() {
            if card.pays()[w.pay as usize].flags & MARKED != 0
                && n < slots
                && !chosen[..n].contains(&w.token)
            {
                chosen[n] = w.token;
                n += 1;
            }
        }
        let distinct = b.flags & DISTINCT != 0;
        let mut guard = 0;
        while n < slots && guard < 256 {
            guard += 1;
            let t = rng.below(pool_len as u64) as u8;
            if distinct && chosen[..n].contains(&t) && n < pool_len {
                continue;
            }
            chosen[n] = t;
            n += 1;
        }
        for slot in 0..slots {
            let t = if chosen[slot] == u8::MAX { 0 } else { chosen[slot] };
            cells[start + slot] = mark(t as u16);
        }
    }

    if card.mode == MODE_COMPARE {
        render_compare(card, out, rng, &mut cells)?;
    }

    // Plant every declared win inside its own scope.
    for w in out.wins() {
        let p = card.pays()[w.pay as usize];
        let want = (w.count as usize).min(scope_len(p.scope));
        let mut placed = 0usize;
        // walk the scope from a seed-chosen offset so the group is not always in the same cells
        let span = scope_len(p.scope).max(1);
        let offset = rng.below(span as u64) as usize;
        for step in 0..span {
            if placed == want {
                break;
            }
            let cell = cells_of(p.scope).nth((offset + step) % span).unwrap_or(0);
            if cells[cell] == EMPTY || cells[cell] == plate(w.token as u16) {
                cells[cell] = plate(w.token as u16);
                placed += 1;
            }
        }
        if placed < want {
            return Err(BadCard);
        }
    }

    // Fill the body without firing anything undeclared: uniform over the pool, winning tokens left out.
    let mut winners = [false; MAX_POOL];
    for w in out.wins() {
        if (w.token as usize) < MAX_POOL {
            winners[w.token as usize] = true;
        }
    }
    let mut fallback = 0usize;
    for cell in 0..body {
        if cells[cell] != EMPTY {
            continue;
        }
        if let Some((_, start, b)) = card.first_block(ROLE_NUMBER) {
            if cell >= start && cell < start + b.count as usize {
                continue; // numbers are placed by the compare renderer
            }
        }
        let mut chosen = None;
        for _ in 0..pool_len * 2 {
            let t = rng.below(pool_len as u64) as u8;
            if winners[t as usize] || !placeable(card, out, &cells, cell, t) {
                continue;
            }
            chosen = Some(t);
            break;
        }
        if chosen.is_none() {
            // deterministic sweep so the fill always completes; an all-winner pool re-admits winners
            chosen = (0..pool_len as u8)
                .find(|&t| !winners[t as usize] && placeable(card, out, &cells, cell, t))
                .or_else(|| (0..pool_len as u8).find(|&t| placeable(card, out, &cells, cell, t)));
            fallback += 1;
        }
        match chosen {
            Some(t) => cells[cell] = plate(t as u16),
            None => return Err(BadCard),
        }
    }
    let _ = fallback;

    render_jackpot(card, out, rng, &mut cells);

    // Any cell still unset would read as a plate of pool index 4095.
    for c in cells[..total].iter_mut() {
        if *c == EMPTY {
            *c = plate(0);
        }
    }

    Ok(Deal { cells, len: total, body_len: body })
}

fn render_compare(
    card: &CardConfig,
    out: &Outcome,
    rng: &mut Rng,
    cells: &mut [u16; MAX_CELLS],
) -> Result<(), BadCard> {
    let [ha, ma, pa, strict] = card.mode_args;
    let (hi, mi, pi) = (ha as usize, ma as usize, pa as usize);
    let blocks = card.blocks();
    if hi >= blocks.len() || mi >= blocks.len() || pi >= blocks.len() {
        return Err(BadCard);
    }
    let (house, mine, prize) = (blocks[hi], blocks[mi], blocks[pi]);
    if house.count != mine.count || mine.count != prize.count {
        return Err(BadCard);
    }
    let (hs, ms, ps) = (card.block_offset(hi), card.block_offset(mi), card.block_offset(pi));
    let duels = house.count as usize;

    let mut drawn = [0i32; MAX_CELLS];
    for d in 0..duels {
        let mut h = rng.range(house.a as i32, house.b as i32);
        if house.flags & DISTINCT != 0 {
            let mut guard = 0;
            while drawn[..d].contains(&h) && guard < 64 {
                h = rng.range(house.a as i32, house.b as i32);
                guard += 1;
            }
        }
        drawn[d] = h;

        // does the outcome say this duel pays?
        let win = out.wins().iter().find(|w| {
            let p = card.pays()[w.pay as usize];
            p.scope >> (ps + d) & 1 == 1
        });

        let m = if win.is_some() {
            rng.range((h + if strict != 0 { 1 } else { 0 }).min(mine.b as i32), mine.b as i32)
        } else {
            rng.range(mine.a as i32, (h - if strict != 0 { 1 } else { 0 }).max(mine.a as i32))
        };
        cells[hs + d] = num(h);
        cells[ms + d] = num(m);
        if let Some(w) = win {
            cells[ps + d] = plate(w.token as u16);
        }
    }
    Ok(())
}

/// A pool-token mark that never renders as SOL (a SOL pool token is indistinguishable from the mark).
fn nonsol_mark(rng: &mut Rng, pool_len: u64, sol_index: u16) -> u16 {
    if (sol_index as u64) >= pool_len || pool_len <= 1 {
        return mark(rng.below(pool_len) as u16);
    }
    let k = rng.below(pool_len - 1) as u16;
    mark(if k >= sol_index { k + 1 } else { k })
}

fn render_jackpot(card: &CardConfig, out: &Outcome, rng: &mut Rng, cells: &mut [u16; MAX_CELLS]) {
    let Some((_, start, b)) = card.first_block(ROLE_JACKPOT) else { return };
    let n = b.count as usize;
    if n == 0 {
        return;
    }
    let pool_len = card.pool_len.max(1) as u64;

    match out.jackpot {
        2 => {
            for i in 0..n {
                cells[start + i] = mark(SOL_MARK);
            }
        }
        1 => {
            let skip = rng.below(n as u64) as usize;
            for i in 0..n {
                cells[start + i] = mark(SOL_MARK);
            }
            // one cell must not read as SOL, or a near miss looks like a hit
            cells[start + skip] = nonsol_mark(rng, pool_len, card.sol_index);
        }
        // Losing line: non-SOL marks only, or a loss reads as a win.
        _ => {
            for i in 0..n {
                cells[start + i] = nonsol_mark(rng, pool_len, card.sol_index);
            }
        }
    }
}

// ── valuing ────────────────────────────────────────────────────────────────────────────────

/// What the cells a player can see are worth. The authority for every payout.
pub fn winnings(card: &CardConfig, d: &Deal) -> Result<Winnings, BadCard> {
    let mut out = Winnings { amounts: [0; MAX_POOL], jackpot: false, multiplier: 1 };
    let cells = &d.cells;
    let pool_len = card.pool_len as usize;
    if pool_len == 0 {
        return Err(BadCard);
    }

    if card.mode == MODE_COMPARE {
        let [ha, ma, pa, strict] = card.mode_args;
        let blocks = card.blocks();
        if ha as usize >= blocks.len() || ma as usize >= blocks.len() || pa as usize >= blocks.len()
        {
            return Err(BadCard);
        }
        let duels = blocks[ha as usize].count as usize;
        let hs = card.block_offset(ha as usize);
        let ms = card.block_offset(ma as usize);
        let ps = card.block_offset(pa as usize);
        for dd in 0..duels {
            let h = payload(cells[hs + dd]) as i32;
            let m = payload(cells[ms + dd]) as i32;
            let beats = if strict != 0 { m > h } else { m >= h };
            let prize = cells[ps + dd];
            if beats && is_plate(prize) {
                let idx = payload(prize) as usize;
                if idx >= pool_len {
                    return Err(BadCard);
                }
                // the entry covering this prize cell sets the multiple
                let mult = card
                    .pays()
                    .iter()
                    .find(|p| p.scope >> (ps + dd) & 1 == 1)
                    .map(effective_mult)
                    .unwrap_or(1);
                out.amounts[idx] =
                    out.amounts[idx].saturating_add(card.pool()[idx].amount.saturating_mul(mult));
            }
        }
    } else {
        for p in card.pays() {
            if p.min == 0 {
                continue;
            }
            for token in 0..pool_len as u16 {
                if p.flags & MARKED != 0 && !is_marked(card, cells, token as u8) {
                    continue;
                }
                let found = cells_of(p.scope).filter(|&i| cells[i] == plate(token)).count();
                if found < p.min as usize {
                    continue;
                }
                // the highest rung this scope reaches is the one that pays
                let best = card
                    .pays()
                    .iter()
                    .filter(|q| q.scope == p.scope && q.flags == p.flags)
                    .filter(|q| q.min as usize <= found)
                    .max_by_key(|q| q.min);
                if best.map(|q| q.min) != Some(p.min) {
                    continue;
                }
                out.amounts[token as usize] = out.amounts[token as usize]
                    .saturating_add(card.pool()[token as usize].amount.saturating_mul(effective_mult(p)));
            }
        }
    }

    for &c in cells[..d.body_len].iter() {
        if c & KIND_MASK == KIND_MULT {
            out.multiplier = payload(c) as u32;
        }
    }
    if out.multiplier > 1 {
        for a in out.amounts.iter_mut() {
            *a = a.saturating_mul(out.multiplier as u64);
        }
    }

    out.jackpot = d.len > d.body_len
        && cells[d.body_len..d.len].iter().all(|&c| is_mark(c) && payload(c) == SOL_MARK);

    Ok(out)
}

pub fn deal(card: &CardConfig, seed: &[u8; 32]) -> Result<Deal, BadCard> {
    let mut rng = Rng::from_bytes(seed);
    let out = roll(card, &mut rng);
    render(card, &out, &mut rng)
}

pub fn evaluate(card: &CardConfig, seed: &[u8; 32]) -> Result<Winnings, BadCard> {
    let d = deal(card, seed)?;
    winnings(card, &d)
}

/// Deals, then checks the cells value to exactly what was rolled — the guarantee this crate rests on.
/// The chain path uses `deal` instead, so a card can't become uncollectable if the two disagree.
pub fn deal_checked(card: &CardConfig, seed: &[u8; 32]) -> Result<(Deal, Outcome), BadCard> {
    let mut rng = Rng::from_bytes(seed);
    let out = roll(card, &mut rng);
    let d = render(card, &out, &mut rng)?;
    let got = winnings(card, &d)?;

    let mut want = [0u64; MAX_POOL];
    for w in out.wins() {
        let p = card.pays()[w.pay as usize];
        want[w.token as usize] = want[w.token as usize]
            .saturating_add(card.pool()[w.token as usize].amount.saturating_mul(effective_mult(&p)));
    }
    if out.tier > 1 {
        for a in want.iter_mut() {
            *a = a.saturating_mul(out.tier as u64);
        }
    }
    if want != got.amounts || got.jackpot != (out.jackpot == 2) {
        return Err(BadCard);
    }
    Ok((d, out))
}

// ── the account layout ─────────────────────────────────────────────────────────────────────

/// Bytes one card occupies in the config account, and therefore what the wasm is handed.
pub const CARD_BYTES: usize = 992;

fn u16le(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn u32le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
fn u64le(b: &[u8], at: usize) -> u64 {
    let mut v = [0u8; 8];
    v.copy_from_slice(&b[at..at + 8]);
    u64::from_le_bytes(v)
}

/// Reads a card straight out of the stored account bytes — no second serialisation to keep in step.
pub fn parse(b: &[u8]) -> Option<CardConfig> {
    if b.len() < CARD_BYTES {
        return None;
    }
    let mut c = CardConfig {
        jackpot_hit: u32le(b, 8),
        jackpot_near: u32le(b, 12),
        mode: b[16],
        roll: b[17],
        block_len: b[18],
        pay_len: b[19],
        tier_len: b[20],
        pool_len: b[21],
        ..Default::default()
    };
    if c.block_len as usize > MAX_BLOCKS
        || c.pay_len as usize > MAX_PAYS
        || c.tier_len as usize > MAX_TIERS
        || c.pool_len as usize > MAX_POOL
    {
        return None;
    }
    for i in 0..4 {
        c.mode_args[i] = u16le(b, 24 + i * 2);
    }
    for i in 0..MAX_BLOCKS {
        let at = 32 + i * 8;
        c.blocks[i] = Block {
            role: b[at],
            count: b[at + 1],
            cols: b[at + 2],
            flags: b[at + 3],
            a: u16le(b, at + 4),
            b: u16le(b, at + 6),
        };
    }
    for i in 0..MAX_PAYS {
        let at = 96 + i * 12;
        c.pays[i] = Pay {
            scope: u32le(b, at),
            weight: u32le(b, at + 4),
            min: b[at + 8],
            flags: b[at + 9],
            mult: u16le(b, at + 10),
        };
    }
    for i in 0..MAX_TIERS {
        let at = 480 + i * 8;
        c.tiers[i] = Tier { factor: u32le(b, at), weight: u32le(b, at + 4) };
    }
    for i in 0..MAX_POOL {
        let at = 512 + i * 48;
        // the mint occupies the first 32 bytes; the engine reads it only to spot SOL (all-zero)
        c.pool[i] = PoolEntry { amount: u64le(b, at + 32), weight: u32le(b, at + 40) };
        if (i as u8) < c.pool_len && c.sol_index == 0xFFFF && b[at..at + 32].iter().all(|&x| x == 0) {
            c.sol_index = i as u16;
        }
    }
    Some(c)
}

/// Shared in/out buffer — no allocator here, so the host writes and reads the result in place.
///
/// In:  `CARD_BYTES` of card, exactly as the account stores it, then the 32-byte seed.
/// Out: len u16, body_len u16, 32 cells as u16, jackpot u8, multiplier u32, then MAX_POOL
///      amounts as u64.
pub const BUF_LEN: usize = CARD_BYTES + 32;

#[cfg(target_arch = "wasm32")]
mod wasm_abi {
    use super::*;

    static mut BUF: [u8; BUF_LEN] = [0; BUF_LEN];

    #[no_mangle]
    pub extern "C" fn buffer() -> *mut u8 {
        core::ptr::addr_of_mut!(BUF) as *mut u8
    }

    #[no_mangle]
    pub extern "C" fn buffer_len() -> i32 {
        BUF_LEN as i32
    }

    #[no_mangle]
    pub extern "C" fn deal_buffer() -> i32 {
        let buf = unsafe { &mut *core::ptr::addr_of_mut!(BUF) };
        let Some(card) = parse(&buf[..CARD_BYTES]) else { return -1 };
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&buf[CARD_BYTES..CARD_BYTES + 32]);

        let Ok(d) = deal(&card, &seed) else { return -1 };
        let Ok(w) = winnings(&card, &d) else { return -1 };

        buf[0..2].copy_from_slice(&(d.len as u16).to_le_bytes());
        buf[2..4].copy_from_slice(&(d.body_len as u16).to_le_bytes());
        for (i, c) in d.cells.iter().enumerate() {
            buf[4 + i * 2..6 + i * 2].copy_from_slice(&c.to_le_bytes());
        }
        let at = 4 + MAX_CELLS * 2;
        buf[at] = w.jackpot as u8;
        buf[at + 1..at + 5].copy_from_slice(&w.multiplier.to_le_bytes());
        for (i, a) in w.amounts.iter().enumerate() {
            let o = at + 5 + i * 8;
            buf[o..o + 8].copy_from_slice(&a.to_le_bytes());
        }
        0
    }
}

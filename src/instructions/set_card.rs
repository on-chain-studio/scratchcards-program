use borsh::{BorshDeserialize, BorshSerialize};
use crate::chain::*;

use crate::constants::is_admin;
use crate::error::GameError;
use bytemuck::Zeroable;

use crate::state::config::*;
use crate::utils::pda;

#[derive(BorshDeserialize, BorshSerialize)]
pub struct InitBlock {
    pub role:  u8,
    pub count: u8,
    pub cols:  u8,
    pub flags: u8,
    pub a:     u16,
    pub b:     u16,
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct InitPay {
    pub scope:  u32,
    pub weight: u32,
    pub min:    u8,
    pub flags:  u8,
    pub mult:   u16,
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct InitTier {
    pub factor: u32,
    pub weight: u32,
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct InitPoolEntry {
    pub mint:   [u8; 32],
    pub amount: u64,
    pub weight: u32,
}

/// Writes one card of the public sheet: its layout, its pay table, its pool and every weight the
/// deal draws against. Admin only. One card per transaction — the whole shelf doesn't fit in one.
/// Accounts: [initializer, config, system_program]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct SetCard {
    pub index: u8,
    pub mode:  u8,
    pub roll:  u8,
    pub price_lamports: u64,
    pub jackpot_hit:  u32,
    pub jackpot_near: u32,
    pub mode_args: [u16; 4],
    pub blocks: Vec<InitBlock>,
    pub pays:   Vec<InitPay>,
    pub tiers:  Vec<InitTier>,
    pub pool:   Vec<InitPoolEntry>,
}

const BAD: ProgramError = ProgramError::InvalidInstructionData;

fn need(ok: bool) -> Result<(), ProgramError> {
    if ok { Ok(()) } else { Err(BAD) }
}

impl SetCard {
    /// Everything the engine is allowed to assume: the deal is a bounded construction, so a
    /// published card must never describe a shape the renderer could get stuck on.
    pub fn validate(&self) -> Result<(), ProgramError> {
        need(self.mode == MODE_COUNT || self.mode == MODE_COMPARE)?;
        need(self.roll == ROLL_EXCLUSIVE || self.roll == ROLL_INDEPENDENT)?;

        // ── shape
        need(!self.blocks.is_empty() && self.blocks.len() <= MAX_BLOCKS)?;
        need(!self.pays.is_empty() && self.pays.len() <= MAX_PAYS)?;
        need(self.tiers.len() <= MAX_TIERS)?;
        need(!self.pool.is_empty() && self.pool.len() <= MAX_POOL)?;

        let cells: usize = self.blocks.iter().map(|b| b.count as usize).sum();
        need(cells > 0 && cells <= MAX_CELLS)?;
        need(self.blocks.iter().all(|b| b.count > 0))?;

        // Jackpot line last makes the body a prefix, so scopes and the jackpot check are plain slices.
        let jackpots = self.blocks.iter().filter(|b| b.role == ROLE_JACKPOT).count();
        need(jackpots == 1 && self.blocks.last().map(|b| b.role) == Some(ROLE_JACKPOT))?;
        need(self.blocks.iter().all(|b| b.role <= ROLE_JACKPOT))?;

        for b in self.blocks.iter().filter(|b| b.role == ROLE_NUMBER) {
            need(b.a <= b.b && b.b <= CELL_PAYLOAD_MAX && b.a >= 1)?;
        }

        let body: usize = self
            .blocks
            .iter()
            .filter(|b| b.role != ROLE_JACKPOT)
            .map(|b| b.count as usize)
            .sum();
        need(body > 0)?;
        let body_mask: u32 = if body >= 32 { u32::MAX } else { (1u32 << body) - 1 };

        // ── pool: an exact partition, so `pick` can walk it without a modulo and never miss
        let pool_total: u64 = self.pool.iter().map(|e| e.weight as u64).sum();
        need(pool_total == WEIGHT_TOTAL)?;
        need(self.pool.iter().any(|e| e.weight > 0))?;
        need(self.pool.iter().all(|e| e.amount > 0))?;
        need(self.pool.len() <= CELL_PAYLOAD_MAX as usize)?;
        // Distinct mints: the client shows a token by its mint, so duplicates are indistinguishable.
        for (i, e) in self.pool.iter().enumerate() {
            need(!self.pool[..i].iter().any(|p| p.mint == e.mint))?;
        }

        // ── tiers: the shortfall is "no multiplier", so this only has to fit
        let tier_total: u64 = self.tiers.iter().map(|t| t.weight as u64).sum();
        need(tier_total <= WEIGHT_TOTAL)?;
        need(self.tiers.iter().all(|t| t.factor >= 2))?;

        // ── jackpot bands are exclusive, not cumulative
        need(self.jackpot_hit as u64 + self.jackpot_near as u64 <= WEIGHT_TOTAL)?;
        let jack = self.blocks.last().ok_or(BAD)?;
        need(jack.a as u64 + jack.b as u64 > 0)?;

        // ── pays
        let marks = self
            .blocks
            .iter()
            .find(|b| b.role == ROLE_MARK)
            .map(|b| b.count as usize)
            .unwrap_or(0);

        for p in &self.pays {
            need(p.scope != 0 && p.scope & !body_mask == 0)?;
            let width = p.scope.count_ones() as usize;
            need(p.min as usize >= 1 && p.min as usize <= width)?;
            need(p.mult >= 1)?;
            need(p.flags & !(PAY_MARKED | PAY_LINEAR) == 0)?;
            if p.flags & PAY_MARKED != 0 {
                need(marks > 0)?;
            }
            // A non-marked min-1 pay makes every cell in scope a winner — count mode can't render it.
            if self.mode == MODE_COUNT && p.min == 1 && p.flags & PAY_MARKED == 0 {
                return Err(BAD);
            }
        }

        if self.roll == ROLL_EXCLUSIVE {
            let total: u64 = self.pays.iter().map(|p| p.weight as u64).sum();
            need(total <= WEIGHT_TOTAL)?;
        } else {
            need(self.pays.iter().all(|p| p.weight as u64 <= WEIGHT_TOTAL))?;
            // Overlapping scopes can't roll independently and keep their declared odds.
            for (i, a) in self.pays.iter().enumerate() {
                for b in &self.pays[i + 1..] {
                    need(a.scope & b.scope == 0)?;
                }
            }
        }

        if self.mode == MODE_COMPARE {
            let [h, m, prize, _] = self.mode_args;
            let (h, m, prize) = (h as usize, m as usize, prize as usize);
            need(h < self.blocks.len() && m < self.blocks.len() && prize < self.blocks.len())?;
            need(self.blocks[h].role == ROLE_NUMBER)?;
            need(self.blocks[m].role == ROLE_NUMBER)?;
            need(self.blocks[prize].role == ROLE_PLATE)?;
            need(self.blocks[h].count == self.blocks[m].count)?;
            need(self.blocks[m].count == self.blocks[prize].count)?;
            // Mine range must straddle the house range, or one side of the duel can't land.
            need(self.blocks[m].a < self.blocks[h].a && self.blocks[m].b > self.blocks[h].b)?;
        } else {
            self.check_fillable(body, marks)?;
        }

        Ok(())
    }

    /// Every body cell must have a token the fill can legally place — a sufficient condition checked
    /// here rather than discovered mid-deal. Rungs sharing a scope count once, at the tightest cap.
    fn check_fillable(&self, body: usize, marks: usize) -> Result<(), ProgramError> {
        for cell in 0..body {
            let mut blocked = 0usize;
            let mut seen: Vec<u32> = Vec::new();
            for p in self.pays.iter().filter(|p| p.scope >> cell & 1 == 1) {
                if seen.contains(&p.scope) {
                    continue;
                }
                seen.push(p.scope);
                let rungs = self.pays.iter().filter(|q| q.scope == p.scope);
                // the smallest cap on this scope is the one that binds
                let cap = rungs
                    .clone()
                    .filter(|q| q.flags & PAY_MARKED == 0)
                    .map(|q| (q.min as usize).saturating_sub(1).max(1))
                    .min();
                blocked += match cap {
                    Some(cap) => p.scope.count_ones() as usize / cap,
                    // only a marked token can fire it, so at most the marks are locked out
                    None => marks,
                };
            }
            need(blocked < self.pool.len())?;
        }
        Ok(())
    }
}

impl SetCard {
    #[inline(always)]
    pub fn process<'a>(
        &self,
        initializer: &AccountInfo,
        config_account: &AccountInfo,
        system_program: &AccountInfo,
    ) -> ProgramResult {
        let program_id = &crate::ID;

        if !initializer.is_signer() || !is_admin(initializer.address()) {
            return Err(ProgramError::MissingRequiredSignature);
        }
        pda::validate(program_id, config_account, &[b"config"])?;
        self.validate()?;

        // Overwrite a published card or append the next — never leave a gap, which would publish zeroed cards.
        let published = Config::load(config_account)?.card_count;
        if self.index as u64 > published {
            return Err(GameError::InvalidCard.into());
        }

        // Grow by exactly one slot and pay its rent, as needed.
        if self.index as usize >= Config::capacity(config_account) {
            let needed = Config::size_for(self.index as usize + 1);
            let required = pda::min_balance(needed);
            let held = config_account.lamports();
            if held < required {
                invoke(
                    &system_instruction::transfer(
                        initializer.address(), config_account.address(), required - held,
                    ),
                    &[initializer.clone(), config_account.clone(), system_program.clone()],
                )?;
            }
            config_account.resize(needed)?;
        }

        let c = Config::slot_mut(config_account, self.index as usize)?;
        *c = CardConfig {
            price_lamports: self.price_lamports,
            jackpot_hit: self.jackpot_hit,
            jackpot_near: self.jackpot_near,
            mode: self.mode,
            roll: self.roll,
            block_len: self.blocks.len() as u8,
            pay_len: self.pays.len() as u8,
            tier_len: self.tiers.len() as u8,
            pool_len: self.pool.len() as u8,
            _pad: [0; 2],
            mode_args: self.mode_args,
            blocks: [Block::zeroed(); MAX_BLOCKS],
            pays: [Pay::zeroed(); MAX_PAYS],
            tiers: [Tier::zeroed(); MAX_TIERS],
            pool: [PoolEntry::zeroed(); MAX_POOL],
        };
        for (dst, src) in c.blocks.iter_mut().zip(self.blocks.iter()) {
            *dst = Block {
                role: src.role, count: src.count, cols: src.cols,
                flags: src.flags, a: src.a, b: src.b,
            };
        }
        for (dst, src) in c.pays.iter_mut().zip(self.pays.iter()) {
            *dst = Pay {
                scope: src.scope, weight: src.weight,
                min: src.min, flags: src.flags, mult: src.mult,
            };
        }
        for (dst, src) in c.tiers.iter_mut().zip(self.tiers.iter()) {
            *dst = Tier { factor: src.factor, weight: src.weight };
        }
        for (dst, src) in c.pool.iter_mut().zip(self.pool.iter()) {
            *dst = PoolEntry { mint: src.mint, amount: src.amount, weight: src.weight, _pad: 0 };
        }

        // Publish only after writing, so a card is never visible without content.
        let cfg = Config::load_mut(config_account)?;
        if self.index as u64 >= cfg.card_count {
            cfg.card_count = self.index as u64 + 1;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The sheet the balancing tool writes must be one this instruction accepts.
    fn sheet() -> Vec<(String, SetCard)> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tools/sheet/cards.json");
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        raw.as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let args = c["modeArgs"].as_array().unwrap();
                (
                    c["id"].as_str().unwrap().to_string(),
                    SetCard {
                        index: i as u8,
                        mode: if c["mode"] == "compare" { MODE_COMPARE } else { MODE_COUNT },
                        roll: if c["roll"] == "independent" { ROLL_INDEPENDENT } else { ROLL_EXCLUSIVE },
                        price_lamports: c["priceLamports"].as_u64().unwrap(),
                        jackpot_hit: c["jackpotHitWeight"].as_u64().unwrap() as u32,
                        jackpot_near: c["jackpotNearWeight"].as_u64().unwrap() as u32,
                        mode_args: [0, 1, 2, 3].map(|k| args[k].as_u64().unwrap_or(0) as u16),
                        blocks: c["blocks"].as_array().unwrap().iter().map(|b| InitBlock {
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
                        }).collect(),
                        pays: c["pays"].as_array().unwrap().iter().map(|p| InitPay {
                            scope: p["scope"].as_u64().unwrap() as u32,
                            weight: p["weight"].as_u64().unwrap() as u32,
                            min: p["min"].as_u64().unwrap() as u8,
                            flags: p["flags"].as_u64().unwrap_or(0) as u8,
                            mult: p["mult"].as_u64().unwrap() as u16,
                        }).collect(),
                        tiers: c["tiers"].as_array().unwrap().iter().map(|t| InitTier {
                            factor: t["factor"].as_u64().unwrap() as u32,
                            weight: t["weight"].as_u64().unwrap() as u32,
                        }).collect(),
                        pool: c["pool"].as_array().unwrap().iter().enumerate().map(|(pi, e)| InitPoolEntry {
                            mint: { let mut m = [0u8; 32]; m[0] = pi as u8; m }, // distinct; index 0 = SOL
                            amount: e["amount"].as_u64().unwrap(),
                            weight: e["weight"].as_u64().unwrap() as u32,
                        }).collect(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn the_tuned_sheet_is_publishable() {
        for (id, card) in sheet() {
            card.validate().unwrap_or_else(|e| panic!("{id} would be rejected: {e:?}"));
        }
    }

    /// Each rule has to actually bite, or it is decoration.
    #[test]
    fn the_rules_reject_what_they_claim_to() {
        let broken = |f: &dyn Fn(&mut SetCard)| {
            let (_, mut c) = sheet().into_iter().find(|(id, _)| id == "vault").unwrap();
            f(&mut c);
            assert!(c.validate().is_err(), "a broken card was accepted");
        };

        broken(&|c| c.pool[0].weight = c.pool[0].weight.wrapping_add(1)); // pool must partition 2^32
        broken(&|c| c.pool[0].amount = 0);                               // a prize of nothing
        broken(&|c| c.pays[0].min = 0);                                  // pays on no matches
        broken(&|c| c.pays[0].min = 99);                                 // more than the scope holds
        broken(&|c| c.pays[0].scope = 0);                                // looks nowhere
        broken(&|c| c.pays[0].scope = 1 << 30);                          // reaches the jackpot row
        broken(&|c| c.pays[0].weight = u32::MAX);                        // overcommits the draw
        broken(&|c| c.roll = ROLL_INDEPENDENT);                          // overlapping lines
        broken(&|c| c.blocks[0].role = ROLE_JACKPOT);                    // two jackpot blocks
        broken(&|c| c.blocks.reverse());                                 // jackpot no longer last
        broken(&|c| c.tiers.push(InitTier { factor: 1, weight: 0 }));    // a x1 multiplier
        broken(&|c| c.jackpot_hit = u32::MAX);                           // bands over 2^32
        broken(&|c| c.pool.truncate(0));                                 // no pool at all
        broken(&|c| c.pool[1].mint = c.pool[0].mint);                    // two entries share a mint
    }
}

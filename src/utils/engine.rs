//! Adapter onto `scratch-engine`, the crate the client also runs as wasm. The only shape
//! difference is the mint, which the engine needs only to spot SOL.

use crate::chain::*;

use crate::state::config::CardConfig;

pub use scratch_engine::{Deal, Outcome, Winnings};

fn shared(card: &CardConfig) -> scratch_engine::CardConfig {
    let mut out = scratch_engine::CardConfig {
        mode: card.mode,
        roll: card.roll,
        jackpot_hit: card.jackpot_hit,
        jackpot_near: card.jackpot_near,
        mode_args: card.mode_args,
        block_len: card.block_len,
        pay_len: card.pay_len,
        tier_len: card.tier_len,
        pool_len: card.pool_len,
        ..Default::default()
    };
    for (dst, src) in out.blocks.iter_mut().zip(card.blocks.iter()) {
        *dst = scratch_engine::Block {
            role: src.role,
            count: src.count,
            cols: src.cols,
            flags: src.flags,
            a: src.a,
            b: src.b,
        };
    }
    for (dst, src) in out.pays.iter_mut().zip(card.pays.iter()) {
        *dst = scratch_engine::Pay {
            scope: src.scope,
            weight: src.weight,
            min: src.min,
            flags: src.flags,
            mult: src.mult,
        };
    }
    for (dst, src) in out.tiers.iter_mut().zip(card.tiers.iter()) {
        *dst = scratch_engine::Tier { factor: src.factor, weight: src.weight };
    }
    for (dst, src) in out.pool.iter_mut().zip(card.pool.iter()) {
        *dst = scratch_engine::PoolEntry { weight: src.weight, amount: src.amount };
    }
    for (i, src) in card.pool().iter().enumerate() {
        if src.mint == [0u8; 32] {
            out.sol_index = i as u16;
            break;
        }
    }
    out
}

fn bad(_: scratch_engine::BadCard) -> ProgramError {
    ProgramError::InvalidAccountData
}

pub fn deal(card: &CardConfig, seed: &[u8; 32]) -> Result<Deal, ProgramError> {
    scratch_engine::deal(&shared(card), seed).map_err(bad)
}

pub fn winnings(card: &CardConfig, d: &Deal) -> Result<Winnings, ProgramError> {
    scratch_engine::winnings(&shared(card), d).map_err(bad)
}

pub fn evaluate(card: &CardConfig, seed: &[u8; 32]) -> Result<Winnings, ProgramError> {
    scratch_engine::evaluate(&shared(card), seed).map_err(bad)
}

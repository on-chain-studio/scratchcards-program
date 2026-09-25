use bytemuck::{Pod, Zeroable};
use casino_core::shelf::Shelf;

pub const DISCRIMINATOR: u64 = 1;
pub const VERSION:       u64 = 2;

/// Starting shelf size, not a ceiling — `GrowConfig` buys more room.
pub const INITIAL_CARDS: usize = 8;

/// Fixed bounds inside a card; every engine loop is bounded by one of these.
pub const MAX_POOL:   usize = 10;
pub const MAX_BLOCKS: usize = 8;
pub const MAX_PAYS:   usize = 32;
pub const MAX_TIERS:  usize = 4;

/// Width of the `u32` scope bitmask — cells can't exceed this.
pub const MAX_CELLS: usize = 32;

/// A cell's payload is 12 bits (the top nibble is its kind).
pub const CELL_PAYLOAD_MAX: u16 = 0x0FFF;

/// Every weight table is published out of this and drawn against it without a modulo.
pub const WEIGHT_TOTAL: u64 = 1 << 32;

pub const SOL_MARK: u8 = 255;

pub const ROLE_PLATE:   u8 = 0;
pub const ROLE_NUMBER:  u8 = 1;
pub const ROLE_MARK:    u8 = 2;
pub const ROLE_JACKPOT: u8 = 3;

pub const BLOCK_DISTINCT: u8 = 1;

pub const PAY_MARKED: u8 = 1;
pub const PAY_LINEAR: u8 = 2;

pub const MODE_COUNT:   u8 = 0;
pub const MODE_COMPARE: u8 = 1;

pub const ROLL_EXCLUSIVE:   u8 = 0;
pub const ROLL_INDEPENDENT: u8 = 1;

/// One run of cells with a shared job: plates, numbers, marks, or the jackpot line.
#[repr(C)]
#[derive(Pod, Zeroable, Clone, Copy)]
pub struct Block {
    pub role:  u8,
    pub count: u8,
    /// slots per row, for rendering only — the engine never reads it
    pub cols:  u8,
    pub flags: u8,
    /// Number: low bound. Jackpot: SOL's mark weight.
    pub a:     u16,
    /// Number: high bound. Jackpot: each token's mark weight.
    pub b:     u16,
}

/// One payable configuration: the cells it looks inside, the group size it starts paying at,
/// what it multiplies the plate by, and how often it is planted.
#[repr(C)]
#[derive(Pod, Zeroable, Clone, Copy)]
pub struct Pay {
    pub scope:  u32,
    pub weight: u32,
    pub min:    u8,
    pub flags:  u8,
    pub mult:   u16,
}

/// A slot multiplier, drawn by weight.
#[repr(C)]
#[derive(Pod, Zeroable, Clone, Copy)]
pub struct Tier {
    pub factor: u32,
    pub weight: u32,
}

/// One token in a card's pool: the mint, its printed amount in base units, and its draw weight.
#[repr(C)]
#[derive(Pod, Zeroable, Clone, Copy)]
pub struct PoolEntry {
    pub mint:   [u8; 32],
    pub amount: u64,
    pub weight: u32,
    pub _pad:   u32,
}

/// One card on the shelf: its layout, its pay table, its pool, and every weight the deal draws
/// against. The published odds sheet, on-chain.
#[repr(C)]
#[derive(Pod, Zeroable, Clone, Copy)]
pub struct CardConfig {
    pub price_lamports: u64,
    /// jackpot-line full-hit and near-miss weights, exclusive bands out of `WEIGHT_TOTAL`
    pub jackpot_hit:  u32,
    pub jackpot_near: u32,
    pub mode:      u8,
    pub roll:      u8,
    pub block_len: u8,
    pub pay_len:   u8,
    pub tier_len:  u8,
    pub pool_len:  u8,
    pub _pad:      [u8; 2],
    /// Compare: house block, mine block, prize block, strict.
    pub mode_args: [u16; 4],
    pub blocks: [Block; MAX_BLOCKS],
    pub pays:   [Pay; MAX_PAYS],
    pub tiers:  [Tier; MAX_TIERS],
    pub pool:   [PoolEntry; MAX_POOL],
}

/// `["config"]` — the shelf: a `casino_core::shelf::Header`, then the CardConfigs it publishes packed
/// end to end, cast by offset.
pub type Config = Shelf<CardConfig, VERSION>;

pub const CARD_SIZE: usize = size_of::<CardConfig>();

// The card stride must stay a multiple of 8, or bytemuck rejects the misaligned slice at runtime.
const _: () = assert!(CARD_SIZE % 8 == 0);

// Pin the sizes: a field reordered into a padding hole would change the stride and misread cards.
const _: () = assert!(size_of::<Block>() == 8);
const _: () = assert!(size_of::<Pay>() == 12);
const _: () = assert!(size_of::<Tier>() == 8);
const _: () = assert!(size_of::<PoolEntry>() == 48);
const _: () = assert!(CARD_SIZE == 992);

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

    pub fn block_offset(&self, index: usize) -> usize {
        self.blocks()[..index.min(self.blocks().len())]
            .iter()
            .map(|b| b.count as usize)
            .sum()
    }
}

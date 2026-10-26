use bytemuck::{Pod, Zeroable};
use casino_core::chain::*;
use casino_core::shelf::{Header, Shelf};
use casino_core::CoreError;

pub const DISCRIMINATOR: u64 = 1;
pub const VERSION:       u64 = 3;

/// Starting shelf size, not a ceiling — `GrowConfig` buys more room.
pub const INITIAL_CARDS: usize = 8;

/// Fixed bounds inside a card; every engine loop is bounded by one of these.
pub const MAX_TOKENS: usize = 12;
pub const MAX_BLOCKS: usize = 8;
pub const MAX_PAYS:   usize = 32;
pub const MAX_TIERS:  usize = 4;
/// Prize tiers a card may have, and frames there are to draw them in.
pub const PRIZE_ROWS: usize = 4;

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

/// One prize tier: how often a win lands in it, which frame the apps draw around its coins, and
/// what each coin pays there in base units. A zero amount means the coin isn't offered here.
#[repr(C)]
#[derive(Pod, Zeroable, Clone, Copy)]
pub struct PrizeRow {
    /// Out of `WEIGHT_TOTAL`, across the card's rows. A lone row is always the prize and holds 0.
    pub weight:  u32,
    /// How the apps draw it: 0 coin, 1 notes, 2 sack, 3 star. The engine never reads it.
    pub tier:    u8,
    pub _pad:    [u8; 3],
    pub amounts: [u64; MAX_TOKENS],
}

/// One card on the shelf: its layout, its pay table, its coins and prize tiers, and every weight the deal draws
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
    pub token_len: u8,
    /// Which card this is, for the apps' copy and art; 0 = unnamed. The engine never reads it.
    pub kind:      u8,
    pub row_len:   u8,
    /// Compare: house block, mine block, prize block, strict.
    pub mode_args: [u16; 4],
    pub blocks: [Block; MAX_BLOCKS],
    pub pays:   [Pay; MAX_PAYS],
    pub tiers:  [Tier; MAX_TIERS],
    /// Coin mints; all-zero is SOL.
    pub tokens: [[u8; 32]; MAX_TOKENS],
    pub rows:   [PrizeRow; PRIZE_ROWS],
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
const _: () = assert!(size_of::<PrizeRow>() == 104);
const _: () = assert!(CARD_SIZE == 1312);

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
    pub fn rows(&self) -> &[PrizeRow] {
        &self.rows[..(self.row_len as usize).min(PRIZE_ROWS)]
    }
    pub fn tokens(&self) -> &[[u8; 32]] {
        &self.tokens[..(self.token_len as usize).min(MAX_TOKENS)]
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

/// The published card at `id`. Nothing past the published count is ever read.
/// On the heap, like a ticket's terms: 1.3 KB is too much to copy around a 4 KB SBF frame.
pub fn shelf_card(account: &AccountInfo, id: u64) -> Result<Box<CardConfig>, ProgramError> {
    let data = account.try_borrow()?;
    let header = bytemuck::try_from_bytes::<Header>(data.get(..Config::HEADER).ok_or(ProgramError::InvalidAccountData)?)
        .map_err(|_| ProgramError::InvalidAccountData)?;
    if id >= header.count {
        return Err(CoreError::NotOnShelf.into());
    }
    if header.version != VERSION {
        return Err(ProgramError::InvalidAccountData);
    }
    let at = Config::HEADER + id as usize * CARD_SIZE;
    let bytes = data.get(at..at + CARD_SIZE).ok_or(CoreError::NotOnShelf)?;
    Ok(Box::new(*bytemuck::try_from_bytes::<CardConfig>(bytes).map_err(|_| ProgramError::InvalidAccountData)?))
}

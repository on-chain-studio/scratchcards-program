use bytemuck::{Pod, Zeroable};
use crate::chain::*;

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

/// `["config"]` — the head of the shelf; cards follow it packed end to end, cast by offset.
#[repr(C)]
#[derive(Pod, Zeroable, Clone, Copy)]
pub struct Config {
    pub discriminator: u64,
    pub version:       u64,
    pub authority:     [u8; 32],
    pub card_count:    u64,
}

pub const CARD_SIZE: usize = size_of::<CardConfig>();

// Header and card stride must stay multiples of 8, or bytemuck rejects the misaligned slice at runtime.
const _: () = assert!(size_of::<Config>() % 8 == 0);
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

impl Config {
    pub const HEADER: usize = size_of::<Self>();

    /// Bytes an account needs to hold `cards` of them.
    pub const fn size_for(cards: usize) -> usize { Self::HEADER + cards * CARD_SIZE }

    /// How many cards this account has room for — its size, not its contents.
    pub fn capacity(account: &AccountInfo) -> usize {
        account.data_len().saturating_sub(Self::HEADER) / CARD_SIZE
    }

    pub fn load<'a>(account: &AccountInfo) -> Result<&'a Self, ProgramError> {
        let data = account.try_borrow()?;
        if data.len() < Self::HEADER { return Err(ProgramError::InvalidAccountData); }
        let s = bytemuck::try_from_bytes::<Self>(&data[..Self::HEADER])
            .map_err(|_| ProgramError::InvalidAccountData)
            .map(|r| unsafe { &*(r as *const Self) })?;
        if s.version != VERSION { return Err(ProgramError::InvalidAccountData); }
        Ok(s)
    }

    pub fn load_mut<'a>(account: &AccountInfo) -> Result<&'a mut Self, ProgramError> {
        let mut data = account.try_borrow_mut_data()?;
        if data.len() < Self::HEADER { return Err(ProgramError::InvalidAccountData); }
        // Not version-checked: this is the write path where `Initialize` sets the version. Reads
        // use `load`, which is strict.
        bytemuck::try_from_bytes_mut::<Self>(&mut data[..Self::HEADER])
            .map_err(|_| ProgramError::InvalidAccountData)
            .map(|r| unsafe { &mut *(r as *mut Self) })
    }

    /// A published card, for playing — bounded by `card_count`, not capacity.
    pub fn card<'a>(
        account: &AccountInfo,
        card_id: u64,
    ) -> Result<&'a CardConfig, ProgramError> {
        if card_id >= Self::load(account)?.card_count {
            return Err(crate::error::GameError::InvalidCard.into());
        }
        Self::slot(account, card_id as usize)
    }

    /// A slot, for writing — bounded by capacity, since this is how a card gets published.
    pub fn slot<'a>(
        account: &AccountInfo,
        index: usize,
    ) -> Result<&'a CardConfig, ProgramError> {
        let (from, to) = Self::span(account, index)?;
        let data = account.try_borrow()?;
        bytemuck::try_from_bytes::<CardConfig>(&data[from..to])
            .map_err(|_| ProgramError::InvalidAccountData)
            .map(|r| unsafe { &*(r as *const CardConfig) })
    }

    pub fn slot_mut<'a>(
        account: &AccountInfo,
        index: usize,
    ) -> Result<&'a mut CardConfig, ProgramError> {
        let (from, to) = Self::span(account, index)?;
        let mut data = account.try_borrow_mut_data()?;
        bytemuck::try_from_bytes_mut::<CardConfig>(&mut data[from..to])
            .map_err(|_| ProgramError::InvalidAccountData)
            .map(|r| unsafe { &mut *(r as *mut CardConfig) })
    }

    fn span(account: &AccountInfo, index: usize) -> Result<(usize, usize), ProgramError> {
        if index >= Self::capacity(account) {
            return Err(crate::error::GameError::InvalidCard.into());
        }
        let from = Self::HEADER + index * CARD_SIZE;
        Ok((from, from + CARD_SIZE))
    }
}

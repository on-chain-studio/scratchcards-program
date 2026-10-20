use bytemuck::{Pod, Zeroable};
use casino_core::chain::*;

use crate::state::config::{CardConfig, Terms, CARD_SIZE_V2};

pub const DISCRIMINATOR: u64 = 3;
pub const VERSION:       u64 = 1;

#[repr(u64)]
#[derive(Clone, Copy, PartialEq)]
pub enum CardStatus {
    Bought    = 0,
    Requested = 1,
    Revealed  = 2,
    Collected = 3,
}

/// `["card", user]` — the player's scratch card, reused: collection retains the resolved result.
/// The VRF seed lands here and the outcome derives from it. Carries its own `terms`, copied from the config at purchase, so a later rebalance
/// can't rewrite a ticket someone already owns.
#[repr(C)]
#[derive(Pod, Zeroable, Clone, Copy)]
pub struct Card {
    pub discriminator: u64,
    pub version:       u64,
    pub user:          [u8; 32],
    pub card_id:       u64,
    pub status:        u64,
    pub seed:          [u8; 32],
}

impl Card {
    pub const SIZE: usize = size_of::<Self>();

    /// A card sold with its terms printed after it, then its generation. A card keeps the layout
    /// of the terms it was sold under: v3 terms, or a v2 shelf's — the account's size says which.
    pub const WITH_TERMS: usize = Self::SIZE + size_of::<CardConfig>();
    pub const PERSISTENT_SIZE: usize = Self::WITH_TERMS + 8;
    pub const WITH_TERMS_V2: usize = Self::SIZE + CARD_SIZE_V2;
    pub const PERSISTENT_SIZE_V2: usize = Self::WITH_TERMS_V2 + 8;

    /// The size a card account holding `terms` takes.
    pub fn persistent_size(terms: &Terms) -> usize {
        match terms {
            Terms::V2(_) => Self::PERSISTENT_SIZE_V2,
            Terms::V3(_) => Self::PERSISTENT_SIZE,
        }
    }

    /// How long the printed terms are, by the account's size; `None` for a card without terms.
    fn terms_len(len: usize) -> Option<usize> {
        match len {
            Self::WITH_TERMS | Self::PERSISTENT_SIZE => Some(size_of::<CardConfig>()),
            Self::WITH_TERMS_V2 | Self::PERSISTENT_SIZE_V2 => Some(CARD_SIZE_V2),
            _ => None,
        }
    }

    /// Whether an account of this size is a card this program sells.
    pub fn is_card_size(len: usize) -> bool {
        Self::terms_len(len).is_some()
    }

    // After the terms, so existing offsets are unchanged.
    pub fn generation(account: &AccountInfo) -> Result<u64, ProgramError> {
        let data = account.try_borrow()?;
        let Some(at) = Self::terms_len(data.len()).map(|n| Self::SIZE + n) else { return Ok(0) };
        let Some(bytes) = data.get(at..at + 8) else { return Ok(0) };
        Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
    }

    pub fn set_generation(account: &AccountInfo, generation: u64) -> ProgramResult {
        let mut data = account.try_borrow_mut_data()?;
        let at = Self::terms_len(data.len()).map(|n| Self::SIZE + n).ok_or(ProgramError::InvalidAccountData)?;
        let bytes = data.get_mut(at..at + 8).ok_or(ProgramError::InvalidAccountData)?;
        bytes.copy_from_slice(&generation.to_le_bytes());
        Ok(())
    }

    /// Read-only, for the paths that must not write — `request_collect` reads a card it is
    /// deliberately forbidden to mark, since anyone may ask for a payout.
    pub fn load<'a>(account: &AccountInfo) -> Result<&'a Self, ProgramError> {
        let data = account.try_borrow()?;
        // Long enough, not exactly: a pre-terms card is shorter and must still load.
        if data.len() < Self::SIZE { return Err(ProgramError::InvalidAccountData); }
        let s = bytemuck::try_from_bytes::<Self>(&data[..Self::SIZE])
            .map_err(|_| ProgramError::InvalidAccountData)
            .map(|r| unsafe { &*(r as *const Self) })?;
        if s.version != 0 && s.version != VERSION { return Err(ProgramError::InvalidAccountData); }
        Ok(s)
    }

    pub fn load_mut<'a>(account: &AccountInfo) -> Result<&'a mut Self, ProgramError> {
        let mut data = account.try_borrow_mut_data()?;
        // Long enough, not exactly: a pre-terms card is shorter and must still load.
        if data.len() < Self::SIZE { return Err(ProgramError::InvalidAccountData); }
        let s = bytemuck::try_from_bytes_mut::<Self>(&mut data[..Self::SIZE])
            .map_err(|_| ProgramError::InvalidAccountData)
            .map(|r| unsafe { &mut *(r as *mut Self) })?;
        if s.version != 0 && s.version != VERSION { return Err(ProgramError::InvalidAccountData); }
        Ok(s)
    }

    /// The terms this card was sold under, at the layout they were printed in, or `None` for a
    /// pre-terms card (falls back to the shelf).
    // On the heap: the terms are 1.3 KB, and the instructions reading them sit near the 4 KB SBF
    // stack limit — a few copies on the stack overflowed `request_collect`'s frame.
    pub fn terms(account: &AccountInfo) -> Result<Option<Box<Terms>>, ProgramError> {
        let data = account.try_borrow()?;
        let Some(n) = Self::terms_len(data.len()) else { return Ok(None) };
        let bytes = &data[Self::SIZE..Self::SIZE + n];
        Ok(Some(Box::new(if n == CARD_SIZE_V2 {
            Terms::V2(bytes.try_into().unwrap())
        } else {
            Terms::V3(*bytemuck::try_from_bytes::<CardConfig>(bytes).map_err(|_| ProgramError::InvalidAccountData)?)
        })))
    }

    pub fn write_terms(account: &AccountInfo, terms: &Terms) -> ProgramResult {
        let bytes = terms.bytes();
        let mut data = account.try_borrow_mut_data()?;
        if Self::terms_len(data.len()) != Some(bytes.len()) {
            return Err(ProgramError::AccountDataTooSmall);
        }
        data[Self::SIZE..Self::SIZE + bytes.len()].copy_from_slice(bytes);
        Ok(())
    }
}

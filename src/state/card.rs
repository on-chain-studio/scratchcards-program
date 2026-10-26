use bytemuck::{Pod, Zeroable};
use casino_core::chain::*;
use casino_core::referral::{self, Referral};

use crate::state::config::CardConfig;

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

    /// A card sold with its terms printed after it, then its generation.
    pub const WITH_TERMS: usize = Self::SIZE + size_of::<CardConfig>();
    pub const PERSISTENT_SIZE: usize = Self::WITH_TERMS + 8;
    /// With the player's referral section after the generation: what every card is sold at now.
    /// A card at any other size is brought to this one by its next purchase, unreferred. One
    /// sold from the retired v2 shelf reads as having no generation, so it starts again at 1:
    /// collected long ago, it has no randomness or task in flight for the number to meet.
    pub const REFERRED_SIZE: usize = Self::PERSISTENT_SIZE + referral::SIZE;

    /// How long the printed terms are, by the account's size; `None` for a card without terms.
    fn terms_len(len: usize) -> Option<usize> {
        match len {
            Self::WITH_TERMS | Self::PERSISTENT_SIZE | Self::REFERRED_SIZE => Some(size_of::<CardConfig>()),
            _ => None,
        }
    }

    /// Where the referral section sits, on a card at a size that has one.
    fn referral_at(len: usize) -> Option<usize> {
        (len == Self::REFERRED_SIZE).then_some(Self::PERSISTENT_SIZE)
    }

    /// The player's referral section, on a card at the current size.
    pub fn referral(account: &AccountInfo) -> Option<Referral> {
        let at = Self::referral_at(account.data_len())?;
        Referral::read(&account.try_borrow().ok()?, at)
    }

    pub fn write_referral(account: &AccountInfo, section: &Referral) -> ProgramResult {
        let at = Self::referral_at(account.data_len()).ok_or(ProgramError::InvalidAccountData)?;
        section.write(&mut account.try_borrow_mut_data()?, at)
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

    /// The terms this card was sold under, or `None` for a card without them (falls back to the
    /// shelf).
    // On the heap: the terms are 1.3 KB, and the instructions reading them sit near the 4 KB SBF
    // stack limit — a few copies on the stack overflowed `request_collect`'s frame.
    pub fn terms(account: &AccountInfo) -> Result<Option<Box<CardConfig>>, ProgramError> {
        let data = account.try_borrow()?;
        let Some(n) = Self::terms_len(data.len()) else { return Ok(None) };
        let bytes = &data[Self::SIZE..Self::SIZE + n];
        Ok(Some(Box::new(*bytemuck::try_from_bytes::<CardConfig>(bytes).map_err(|_| ProgramError::InvalidAccountData)?)))
    }

    pub fn write_terms(account: &AccountInfo, terms: &CardConfig) -> ProgramResult {
        let bytes = bytemuck::bytes_of(terms);
        let mut data = account.try_borrow_mut_data()?;
        if Self::terms_len(data.len()) != Some(bytes.len()) {
            return Err(ProgramError::AccountDataTooSmall);
        }
        data[Self::SIZE..Self::SIZE + bytes.len()].copy_from_slice(bytes);
        Ok(())
    }
}

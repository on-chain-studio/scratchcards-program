use bytemuck::{Pod, Zeroable};
use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, program_error::ProgramError};

use crate::state::config::CardConfig;

pub const DISCRIMINATOR: u64 = 3;
pub const VERSION:       u64 = 1;

#[repr(u64)]
#[derive(Clone, Copy, PartialEq)]
pub enum CardStatus {
    Bought    = 0,
    Requested = 1,
    Revealed  = 2,
    // There is no Collected: a card is collected when it is closed. Marking it instead left a
    // state anyone could strand — see request_collect.
}

/// `["card", user]` — one bought scratch card. The VRF seed lands here and the outcome derives
/// from it. Carries its own `terms`, copied from the config at purchase, so a later rebalance
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

    /// A card sold with its terms printed after it.
    pub const WITH_TERMS: usize = Self::SIZE + size_of::<CardConfig>();

    /// Read-only, for the paths that must not write — `request_collect` reads a card it is
    /// deliberately forbidden to mark, since anyone may ask for a payout.
    pub fn load<'a>(account: &AccountInfo<'a>) -> Result<&'a Self, ProgramError> {
        let data = account.try_borrow_data()?;
        // Long enough, not exactly: a pre-terms card is shorter and must still load.
        if data.len() < Self::SIZE { return Err(ProgramError::InvalidAccountData); }
        let s = bytemuck::try_from_bytes::<Self>(&data[..Self::SIZE])
            .map_err(|_| ProgramError::InvalidAccountData)
            .map(|r| unsafe { &*(r as *const Self) })?;
        if s.version != 0 && s.version != VERSION { return Err(ProgramError::InvalidAccountData); }
        Ok(s)
    }

    pub fn load_mut<'a>(account: &AccountInfo<'a>) -> Result<&'a mut Self, ProgramError> {
        let mut data = account.try_borrow_mut_data()?;
        // Long enough, not exactly: a pre-terms card is shorter and must still load.
        if data.len() < Self::SIZE { return Err(ProgramError::InvalidAccountData); }
        let s = bytemuck::try_from_bytes_mut::<Self>(&mut data[..Self::SIZE])
            .map_err(|_| ProgramError::InvalidAccountData)
            .map(|r| unsafe { &mut *(r as *mut Self) })?;
        if s.version != 0 && s.version != VERSION { return Err(ProgramError::InvalidAccountData); }
        Ok(s)
    }

    /// The terms this card was sold under, or `None` for a pre-terms card (falls back to the shelf).
    pub fn terms<'a>(account: &AccountInfo<'a>) -> Result<Option<&'a CardConfig>, ProgramError> {
        if account.data_len() < Self::WITH_TERMS { return Ok(None); }
        let data = account.try_borrow_data()?;
        bytemuck::try_from_bytes::<CardConfig>(&data[Self::SIZE..Self::WITH_TERMS])
            .map_err(|_| ProgramError::InvalidAccountData)
            .map(|r| unsafe { Some(&*(r as *const CardConfig)) })
    }

    pub fn write_terms(account: &AccountInfo, terms: &CardConfig) -> ProgramResult {
        if account.data_len() < Self::WITH_TERMS {
            return Err(ProgramError::AccountDataTooSmall);
        }
        let mut data = account.try_borrow_mut_data()?;
        data[Self::SIZE..Self::WITH_TERMS].copy_from_slice(bytemuck::bytes_of(terms));
        Ok(())
    }
}

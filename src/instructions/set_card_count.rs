use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::chain::*;
use casino_core::{pda, Casino};

use crate::error::GameError;
use crate::state::config::Config;
use crate::ScratchCards;

/// Takes cards off the end of the shelf. Admin only. Lower only: raising the count would publish
/// whatever stale bytes sit past it — `SetCard` is how a card is added.
/// Accounts: [admin, config]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct SetCardCount {
    pub count: u8,
}

impl SetCardCount {
    #[inline(always)]
    pub fn process(&self, admin: &AccountInfo, config_account: &AccountInfo) -> ProgramResult {
        ScratchCards::require_admin(admin)?;
        pda::validate(&crate::ID, config_account, &[b"config"])?;
        let cfg = Config::load_mut(config_account)?;
        if self.count as u64 > cfg.count {
            return Err(GameError::InvalidCard.into());
        }
        cfg.count = self.count as u64;
        Ok(())
    }
}

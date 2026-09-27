use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::chain::*;
use casino_core::{vault, Casino, CoreError};

use crate::ScratchCards;

/// Returns the jackpot's SOL as transaction return data. Rollup only, read through this program
/// (the ledger's member) so the rollup ACL admits it; simulate-only, nothing signs or writes.
/// Accounts: [jackpot, ledger]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct ReadJackpot;


impl ReadJackpot {
    #[inline(always)]
    pub fn process<'a>(
        &self,
        jackpot: &AccountInfo,
        ledger: &AccountInfo,
    ) -> ProgramResult {
        // No `which` arg: reads only the pot, never the house balance.
        ScratchCards::treasury(1, jackpot)?;
        if *ledger.address() != vault::ledger(jackpot.address()) {
            return Err(CoreError::InvalidPDA.into());
        }

        set_return_data(&vault::sol_balance(ledger)?.to_le_bytes());
        Ok(())
    }
}

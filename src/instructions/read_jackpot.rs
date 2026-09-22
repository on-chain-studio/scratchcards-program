use borsh::{BorshDeserialize, BorshSerialize};
use crate::chain::*;

use crate::constants::treasury_seed;
use crate::error::GameError;
use crate::utils::{pda, vault};

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
        let program_id = &crate::ID;

        // No `which` arg: reads only the pot, never the house balance.
        let seed = treasury_seed(1)?;
        pda::validate(program_id, jackpot, &[seed])?;
        if *ledger.address() != vault::ledger(jackpot.address()) {
            return Err(GameError::InvalidPDA.into());
        }

        set_return_data(&vault::sol_balance(ledger)?.to_le_bytes());
        Ok(())
    }
}

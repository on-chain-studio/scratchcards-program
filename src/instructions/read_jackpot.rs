use borsh::BorshDeserialize;
use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, program::set_return_data,
    program_error::ProgramError, pubkey::Pubkey,
};

use crate::constants::treasury_seed;
use crate::error::GameError;
use crate::instruction::ProcessInstruction;
use crate::utils::{pda, vault};

/// Returns the jackpot's SOL as transaction return data. Rollup only, read through this program
/// (the ledger's member) so the rollup ACL admits it; simulate-only, nothing signs or writes.
/// Accounts: [jackpot, ledger]
#[derive(BorshDeserialize)]
pub struct ReadJackpot;


impl ProcessInstruction for ReadJackpot {
    fn process(&self, program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let [jackpot, ledger, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        // No `which` arg: reads only the pot, never the house balance.
        let seed = treasury_seed(1)?;
        pda::validate(program_id, jackpot, &[seed])?;
        if *ledger.key != vault::ledger(jackpot.key) {
            return Err(GameError::InvalidPDA.into());
        }

        set_return_data(&vault::sol_balance(ledger)?.to_le_bytes());
        Ok(())
    }
}

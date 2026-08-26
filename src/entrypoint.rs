use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    pubkey::Pubkey,
};
use solana_program::declare_id;

use crate::instruction;

declare_id!("GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    instruction::dispatch(program_id, accounts, instruction_data)
}

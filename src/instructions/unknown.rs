use borsh::BorshDeserialize;
use solana_program::{account_info::AccountInfo, pubkey::Pubkey, entrypoint::ProgramResult};
use crate::instruction::ProcessInstruction;

/// No-op — reserved variant 0, mirrors Dark Galaxy.
#[derive(BorshDeserialize)]
pub struct Unknown;


impl ProcessInstruction for Unknown {
    fn process(&self, _program_id: &Pubkey, _accounts: &[AccountInfo]) -> ProgramResult {
        Ok(())
    }
}

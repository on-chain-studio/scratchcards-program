use borsh::BorshDeserialize;
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, entrypoint::ProgramResult};

use crate::constants::is_admin;
use crate::error::GameError;
use crate::instruction::ProcessInstruction;
use crate::utils::{pda, receipt};

/// Drops a card and returns its rent to the house. Admin only — a card is paid-for, so closing one
/// at will would destroy a player's ticket; this is the escape hatch for a stranded card.
/// Accounts: [admin (signer), house, card, ephemeral_vault, magic_program]
#[derive(BorshDeserialize)]
pub struct CloseCard {
    pub user: Pubkey,
}


impl ProcessInstruction for CloseCard {
    fn process(&self, program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let [admin, house, card_account, ephemeral_vault, magic_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !admin.is_signer || !is_admin(admin.key) {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if *ephemeral_vault.key != EPHEMERAL_VAULT_ID {
            return Err(GameError::InvalidPDA.into());
        }
        let house_bump = pda::validate(program_id, house, &[b"house"])?;
        pda::validate(program_id, card_account, &[b"card", self.user.as_ref()])?;

        receipt::close(magic_program, house, card_account, ephemeral_vault, house_bump)
    }
}

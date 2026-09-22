use borsh::{BorshDeserialize, BorshSerialize};
use crate::magicblock::EPHEMERAL_VAULT_ID;
use crate::chain::*;

use crate::constants::is_admin;
use crate::error::GameError;
use crate::utils::{pda, receipt};

/// Drops a card and returns its rent to the house. Admin only — a card is paid-for, so closing one
/// at will would destroy a player's ticket; this is the escape hatch for a stranded card.
/// Accounts: [admin (signer), house, card, ephemeral_vault, magic_program]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct CloseCard {
    pub user: Pubkey,
}


impl CloseCard {
    #[inline(always)]
    pub fn process<'a>(
        &self,
        admin: &AccountInfo,
        house: &AccountInfo,
        card_account: &AccountInfo,
        ephemeral_vault: &AccountInfo,
        magic_program: &AccountInfo,
    ) -> ProgramResult {
        let program_id = &crate::ID;

        if !admin.is_signer() || !is_admin(admin.address()) {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if *ephemeral_vault.address() != EPHEMERAL_VAULT_ID {
            return Err(GameError::InvalidPDA.into());
        }
        let house_bump = pda::validate(program_id, house, &[b"house"])?;
        pda::validate(program_id, card_account, &[b"card", self.user.as_ref()])?;

        receipt::close(magic_program, house, card_account, ephemeral_vault, house_bump)
    }
}

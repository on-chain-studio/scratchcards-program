use borsh::{BorshDeserialize, BorshSerialize};
use crate::magicblock::EPHEMERAL_VAULT_ID;
use crate::chain::*;

use crate::constants::is_admin;
use crate::error::GameError;
use crate::state::card::{self, Card};
use crate::utils::{pda, receipt};

/// Drops a card of a layout this program no longer reads, by address: cards from before the
/// current seeds cannot be reached through `close_card`, which derives the address from a user.
/// Admin only. A card of the current size is refused — a live ticket goes through `close_card`.
/// Accounts: [admin (signer), house, card, ephemeral_vault, magic_program]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct CloseStrayCard;

impl CloseStrayCard {
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
        if card_account.owner() != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        let data = card_account.try_borrow()?;
        if data.len() < 8 || u64::from_le_bytes(data[..8].try_into().unwrap()) != card::DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if data.len() == Card::WITH_TERMS {
            return Err(GameError::InvalidPDA.into());
        }
        drop(data);

        receipt::close(magic_program, house, card_account, ephemeral_vault, house_bump)
    }
}

use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::chain::*;
use casino_core::magicblock::EPHEMERAL_VAULT_ID;
use casino_core::{pda, receipt, Casino, CoreError};

use crate::state::card::{self, Card};
use crate::ScratchCards;

/// Drops a card of a layout this program no longer reads, by address: cards from before the
/// current seeds cannot be reached through `close_card`, which derives the address from a user.
/// Admin only. A card of the current size is refused — a live ticket goes through `close_card`.
/// This one stays the game's own: what makes a card stray is this program's card layout, which
/// the shared `close_player_account` knows nothing of.
/// Accounts: [admin (signer), house, card, ephemeral_vault, magic_program]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct CloseStrayCard;

impl CloseStrayCard {
    #[inline(always)]
    pub fn process(
        &self,
        admin: &AccountInfo,
        house: &AccountInfo,
        card_account: &AccountInfo,
        ephemeral_vault: &AccountInfo,
        magic_program: &AccountInfo,
    ) -> ProgramResult {
        let program_id = &crate::ID;

        ScratchCards::require_admin(admin)?;
        if *ephemeral_vault.address() != EPHEMERAL_VAULT_ID {
            return Err(CoreError::InvalidPDA.into());
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
            return Err(CoreError::InvalidPDA.into());
        }
        drop(data);

        receipt::close(magic_program, house, card_account, ephemeral_vault, house_bump)
    }
}

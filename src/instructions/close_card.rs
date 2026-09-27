use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::admin::close_player_account;
use casino_core::chain::*;

use crate::ScratchCards;

/// Drops a card and returns its rent to the house. Admin only — a card is paid-for, so closing one
/// at will would destroy a player's ticket; this is the escape hatch for a stranded card.
/// Accounts: [admin (signer), house, card, ephemeral_vault, magic_program]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct CloseCard {
    pub user: Pubkey,
}


impl CloseCard {
    #[inline(always)]
    pub fn process(
        &self,
        admin: &AccountInfo,
        house: &AccountInfo,
        card_account: &AccountInfo,
        ephemeral_vault: &AccountInfo,
        magic_program: &AccountInfo,
    ) -> ProgramResult {
        close_player_account::<ScratchCards>(b"card", &self.user, admin, house, card_account, ephemeral_vault, magic_program)
    }
}

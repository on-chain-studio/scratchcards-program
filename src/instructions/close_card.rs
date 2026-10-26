use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::admin::close_player_account;
use casino_core::chain::*;
use casino_core::{referral, CoreError};

use crate::constants::ANALYTICS;
use crate::state::analytics::Analytics;

use crate::error::GameError;
use crate::state::card::Card;
use crate::ScratchCards;

/// Drops a card and returns its rent to the house. Admin only — a card is paid-for, so closing one
/// at will would destroy a player's ticket; this is the escape hatch for a stranded card. A card
/// whose player is owed referral earnings is refused until they are paid: what is owed lives on
/// the card, so closing it would hand the referrer's money to the house. Its player comes off the
/// referral counts with it, so a player who comes back is counted once.
/// Accounts: [admin (signer), house, card, ephemeral_vault, magic_program, analytics]
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
        analytics_account: &AccountInfo,
    ) -> ProgramResult {
        if *analytics_account.address() != ANALYTICS {
            return Err(CoreError::InvalidPDA.into());
        }
        if let Some(section) = Card::referral(card_account) {
            if section.owed > 0 {
                return Err(GameError::StillOwed.into());
            }
            referral::uncount_player(Analytics::referrals(analytics_account), &section);
        }
        close_player_account::<ScratchCards>(b"card", &self.user, admin, house, card_account, ephemeral_vault, magic_program)
    }
}

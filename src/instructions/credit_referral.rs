use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::chain::*;
use casino_core::magicblock::{resize_ephemeral_account, EPHEMERAL_VAULT_ID};
use casino_core::referral::{self, Referral};
use casino_core::{pda, CoreError};
use pinocchio::sysvars::{clock::Clock, Sysvar};

use crate::constants::ANALYTICS;
use crate::state::analytics::Analytics;
use crate::state::card::{Card, CardStatus};

/// Credits a referrer their cut of a sale: the house's task, scheduled when a referred player's
/// purchase settled. The amount is the task's own, and only the house's executor signs one.
///
/// A referrer's card of any earlier layout is brought to the current one here, unlinked, so no
/// credit waits on their next purchase: one that only lacks the section grows in place; an older
/// one is rewritten once its card is collected, keeping the generation it has. A card gone, or an
/// old one still in play, is left alone: the house keeps that cut.
///
/// A credit from a link names the player's card after these, and links it to the referrer's card
/// only once that can hold its credits; a player linked to someone else since is left alone, and
/// so is the cut.
/// Accounts: [executor (signer), house, card (the referrer's), analytics, ephemeral_vault,
///            magic_program, player's card?]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct CreditReferral {
    pub amount: u64,
}

impl CreditReferral {
    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    pub fn process(
        &self,
        executor: &AccountInfo,
        house: &AccountInfo,
        card_account: &AccountInfo,
        analytics_account: &AccountInfo,
        ephemeral_vault: &AccountInfo,
        magic_program: &AccountInfo,
        rest: &[AccountInfo],
    ) -> ProgramResult {
        let program_id = &crate::ID;
        let house_bump = pda::validate(program_id, house, &[b"house"])?;
        referral::require_executor(executor, house)?;
        if *analytics_account.address() != ANALYTICS || *ephemeral_vault.address() != EPHEMERAL_VAULT_ID {
            return Err(CoreError::InvalidPDA.into());
        }
        if card_account.data_len() < Card::SIZE || !card_account.owned_by(program_id) {
            return Ok(());
        }
        let user = Card::load(card_account)?.user;
        pda::validate(program_id, card_account, &[b"card", &user])?;
        if Card::referral(card_account).is_none()
            && !bring_up(card_account, house, house_bump, analytics_account, ephemeral_vault, magic_program)?
        {
            return Ok(());
        }

        if let Some(player) = rest.first() {
            if player.address() == card_account.address() || !player.owned_by(program_id) {
                return Ok(());
            }
            let owner = Card::load(player)?.user;
            pda::validate(program_id, player, &[b"card", &owner])?;
            let Some(mut linked) = Card::referral(player) else { return Ok(()) };
            if !linked.link(card_account.address(), Clock::get()?.unix_timestamp, Analytics::referrals(analytics_account)) {
                return Ok(());
            }
            Card::write_referral(player, &linked)?;
            if self.amount == 0 {
                return Ok(());
            }
        }

        let mut section = Card::referral(card_account).ok_or(ProgramError::InvalidAccountData)?;
        referral::credit(&mut section, Analytics::referrals(analytics_account), self.amount);
        Card::write_referral(card_account, &section)
    }
}

/// Brings a card from before referrals to the current layout, unlinked, and counts its player.
/// False for an old layout whose card is still in play, which only its own next purchase may change.
fn bring_up(
    card_account: &AccountInfo,
    house: &AccountInfo,
    house_bump: u8,
    analytics_account: &AccountInfo,
    ephemeral_vault: &AccountInfo,
    magic_program: &AccountInfo,
) -> Result<bool, ProgramError> {
    let in_place = card_account.data_len() == Card::PERSISTENT_SIZE;
    if !in_place && Card::load(card_account)?.status != CardStatus::Collected as u64 {
        return Ok(false);
    }
    let generation = (!in_place).then(|| Card::generation(card_account).unwrap_or(0));
    resize_ephemeral_account(house, card_account, ephemeral_vault, magic_program,
        Card::REFERRED_SIZE as u32, &[&[b"house", &[house_bump]]])?;
    if let Some(generation) = generation {
        // An old layout's terms are of another shape; its card is collected, and its next
        // purchase prints the shelf's terms afresh.
        card_account.try_borrow_mut_data()?[Card::SIZE..].fill(0);
        Card::set_generation(card_account, generation)?;
    }
    Card::write_referral(card_account, &Referral::unlinked())?;
    referral::count_player(Analytics::referrals(analytics_account));
    Ok(true)
}

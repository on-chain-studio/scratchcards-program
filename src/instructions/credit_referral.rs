use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::chain::*;
use casino_core::magicblock::{resize_ephemeral_account, EPHEMERAL_VAULT_ID};
use casino_core::referral::{self, Referral};
use casino_core::{pda, CoreError};

use crate::constants::ANALYTICS;
use crate::state::analytics::Analytics;
use crate::state::card::Card;

/// Credits a referrer their cut of a sale: the house's task, scheduled when a referred player's
/// purchase settled. The amount is the task's own, and only the house's executor signs one.
///
/// A referrer's card from before referrals is grown to the layout here, unreferred, so their
/// first credits are not lost waiting for their next purchase. A card too old to grow in place,
/// or gone, is left alone: the house keeps that cut.
/// Accounts: [executor (signer), house, card (the referrer's), analytics, ephemeral_vault, magic_program]
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

        let mut section = match Card::referral(card_account) {
            Some(section) => section,
            None => {
                let grown = match card_account.data_len() {
                    Card::PERSISTENT_SIZE => Card::REFERRED_SIZE,
                    Card::PERSISTENT_SIZE_V2 => Card::REFERRED_SIZE_V2,
                    _ => return Ok(()),
                };
                resize_ephemeral_account(house, card_account, ephemeral_vault, magic_program,
                    grown as u32, &[&[b"house", &[house_bump]]])?;
                referral::count_player(Analytics::referrals(analytics_account), false);
                Referral::new(None, &user, 0)
            }
        };
        referral::credit(&mut section, Analytics::referrals(analytics_account), self.amount);
        Card::write_referral(card_account, &section)
    }
}

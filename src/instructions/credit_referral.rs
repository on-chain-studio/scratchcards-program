use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::chain::*;
use casino_core::{pda, referral, CoreError};

use crate::constants::ANALYTICS;
use crate::state::analytics::Analytics;
use crate::state::card::Card;

/// Credits a referrer their cut of a stake: the house's task, scheduled when a referred player's
/// stake settled. The amount is the task's own, and only the house's executor signs one.
/// A referrer's card that is gone, or not at the referral layout yet, is left alone: the house
/// keeps that cut.
/// Accounts: [executor (signer), house, card (the referrer's), analytics]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct CreditReferral {
    pub amount: u64,
}

impl CreditReferral {
    #[inline(always)]
    pub fn process(&self, executor: &AccountInfo, house: &AccountInfo, card_account: &AccountInfo, analytics_account: &AccountInfo) -> ProgramResult {
        let program_id = &crate::ID;
        pda::validate(program_id, house, &[b"house"])?;
        referral::require_executor(executor, house)?;
        if *analytics_account.address() != ANALYTICS {
            return Err(CoreError::InvalidPDA.into());
        }
        if card_account.data_len() == 0 || !card_account.owned_by(program_id) {
            return Ok(());
        }
        let Some(mut section) = Card::referral(card_account) else { return Ok(()) };
        let user = Card::load(card_account)?.user;
        pda::validate(program_id, card_account, &[b"card", &user])?;
        referral::credit(&mut section, Analytics::referrals(analytics_account), self.amount);
        Card::write_referral(card_account, &section)
    }
}

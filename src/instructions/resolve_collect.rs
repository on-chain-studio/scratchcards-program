use borsh::{BorshDeserialize, BorshSerialize};
use crate::magicblock::EPHEMERAL_VAULT_ID;
use crate::chain::*;

use crate::error::GameError;
use crate::state::analytics::Analytics;
use crate::state::card::{Card, CardStatus};
use crate::utils::{engine, pda, receipt};

#[derive(BorshDeserialize, BorshSerialize)]
pub struct ResolveCollect {
    pub human: Pubkey,
    /// The pot this collect drained, from the receipt's args — zero when no jackpot was won.
    pub jackpot_paid: u64,
}


impl ResolveCollect {
    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    pub fn process<'a>(
        &self,
        _receipt_account: &AccountInfo,
        vault_authority: &AccountInfo,
        house: &AccountInfo,
        card_account: &AccountInfo,
        ephemeral_vault: &AccountInfo,
        magic_program: &AccountInfo,
        analytics_account: &AccountInfo,
    ) -> ProgramResult {
        let program_id = &crate::ID;

        if *ephemeral_vault.address() != EPHEMERAL_VAULT_ID {
            return Err(GameError::InvalidPDA.into());
        }
        let house_bump = pda::validate(program_id, house, &[b"house"])?;

        receipt::require_callback(vault_authority)?;

        pda::validate(program_id, card_account, &[b"card", self.human.as_ref()])?;
        let (card_id, seed) = {
            let card = Card::load_mut(card_account)?;
            if card.user != self.human.to_bytes() {
                return Err(GameError::Unauthorized.into());
            }
            // Still `Revealed`: there is no collected state to reach. The card's existence *is*
            // the unpaid flag, and this callback ends by closing it — so a second settle in the
            // same slot finds no account to load and dies before it can pay twice.
            if card.status != CardStatus::Revealed as u64 {
                return Err(GameError::WrongStatus.into());
            }
            (card.card_id, card.seed)
        };

        // Settled money: the same deal request_collect priced, re-derived from the card before
        // it closes. The jackpot alone cannot be re-derived (the pot is already drained), so
        // that one number arrives through the receipt's args.
        pda::validate(program_id, analytics_account, &[b"analytics"])?;
        let a = Analytics::load_mut(analytics_account)?;
        if let Some(terms) = Card::terms(card_account)? {
            let wins = engine::evaluate(terms, &seed)?;
            for (i, amount) in wins.amounts.iter().enumerate() {
                if *amount > 0 {
                    a.record_payout(&terms.pool[i].mint, *amount);
                }
            }
        }
        if self.jackpot_paid > 0 {
            a.jackpot_paid = a.jackpot_paid.saturating_add(self.jackpot_paid);
            Analytics::count(&mut a.jackpot_hits);
        }
        if let Some(slot) = a.cards_collected.get_mut(card_id as usize) {
            Analytics::count(slot);
        }

        receipt::close(magic_program, house, card_account, ephemeral_vault, house_bump)
    }
}

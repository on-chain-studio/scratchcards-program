use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::chain::*;
use casino_core::magicblock::{create_ephemeral_account, EPHEMERAL_VAULT_ID, MEMBER_READ};
use casino_core::{pda, permission, receipt, CoreError};

use crate::constants::{JACKPOT_SHARE_BP, PRIVATE_CASINO};
use crate::state::analytics::Analytics;
use crate::state::card::{self, Card, CardStatus};
use crate::state::Config;

/// Turns a settled receipt into a card. The seed comes later via `RequestReveal`, so a failed VRF
/// request can't unwind a paid purchase.
#[derive(BorshDeserialize, BorshSerialize)]
pub struct ResolvePurchase {
    pub human: Pubkey,
    pub card_id: u64,
}


impl ResolvePurchase {
    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    pub fn process<'a>(
        &self,
        _receipt_account: &AccountInfo,
        vault_authority: &AccountInfo,
        config_account: &AccountInfo,
        house: &AccountInfo,
        card_account: &AccountInfo,
        ephemeral_vault: &AccountInfo,
        magic_program: &AccountInfo,
        analytics_account: &AccountInfo,
        card_permission: &AccountInfo,
        permission_program: &AccountInfo,
    ) -> ProgramResult {
        let program_id = &crate::ID;

        if *ephemeral_vault.address() != EPHEMERAL_VAULT_ID {
            return Err(CoreError::InvalidPDA.into());
        }
        pda::validate(program_id, config_account, &[b"config"])?;
        let house_bump = pda::validate(program_id, house, &[b"house"])?;

        receipt::require_callback(vault_authority)?;
        let card_id = self.card_id;

        let card_bump = pda::validate(
            program_id, card_account, &[b"card", self.human.as_ref()],
        )?;
        let (generation, previous_seed) = if card_account.data_len() == 0 {
            (1, [0; 32])
        } else {
            if !card_account.owned_by(program_id) { return Err(ProgramError::IllegalOwner); }
            let previous = *Card::load(card_account)?;
            if previous.user != self.human.to_bytes() || previous.discriminator != card::DISCRIMINATOR {
                return Err(CoreError::Unauthorized.into());
            }
            if previous.status != CardStatus::Collected as u64 { return Err(CoreError::AlreadyInitialized.into()); }
            (Card::generation(card_account)?.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?, previous.seed)
        };

        let terms = *Config::item(config_account, card_id)?;

        if card_account.data_len() != 0 && card_account.data_len() < Card::PERSISTENT_SIZE {
            receipt::close(magic_program, house, card_account, ephemeral_vault, house_bump)?;
        }
        if card_account.data_len() == 0 {
            create_ephemeral_account(house, card_account, ephemeral_vault, magic_program,
                Card::PERSISTENT_SIZE as u32,
                &[&[b"house", &[house_bump]], &[b"card", self.human.as_ref(), &[card_bump]]])?;
        }
        Card::set_generation(card_account, generation)?;

        {
            let c = Card::load_mut(card_account)?;
            c.discriminator = card::DISCRIMINATOR;
            c.version = card::VERSION;
            c.user = self.human.to_bytes();
            c.card_id = card_id;
            c.status = CardStatus::Bought as u64;
            c.seed = previous_seed;
        }
        Card::write_terms(card_account, &terms)?;

        permission::upgrade_ephemeral(
            program_id, permission_program, card_account, &[b"card", self.human.as_ref(), &[card_bump]],
            card_permission, house, &[b"house", &[house_bump]], ephemeral_vault, magic_program,
            card_members(&self.human), MEMBER_READ,
        )?;

        // This callback only fires on a settled payment, so the count is settled money.
        pda::validate(program_id, analytics_account, &[b"analytics"])?;
        let price = terms.price_lamports;
        let take = price.saturating_mul(JACKPOT_SHARE_BP) / 10_000;
        let a = Analytics::load_mut(analytics_account)?;
        a.lamports_in = a.lamports_in.saturating_add(price);
        a.jackpot_in = a.jackpot_in.saturating_add(take);
        if let Some(slot) = a.cards_sold.get_mut(card_id as usize) {
            casino_core::analytics::count(slot);
        }

        Ok(())
    }
}

pub fn card_members(human: &Pubkey) -> Vec<Pubkey> {
    permission::ephemeral_members(&[*human, PRIVATE_CASINO])
}

use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::chain::*;
use casino_core::magicblock::{create_ephemeral_account, EPHEMERAL_VAULT_ID, MEMBER_READ};
use casino_core::ids::MAGIC_CONTEXT_ID;
use casino_core::referral::{self, Referral, Referrer};
use casino_core::{pda, permission, receipt, CoreError};
use pinocchio::sysvars::{clock::Clock, Sysvar};

use crate::constants::{ANALYTICS, JACKPOT_SHARE_BP, PRIVATE_CASINO};
use crate::state::analytics::Analytics;
use crate::state::card::{self, Card, CardStatus};
use crate::state::config;

/// Turns a settled receipt into a card. The seed comes later via `RequestReveal`, so a failed VRF
/// request can't unwind a paid purchase.
///
/// A referred player's settle also names the magic context after these: the sale schedules its
/// referrer's credit from here, so the client never names the referrer's card.
/// Accounts: [receipt, vault_authority (signer), config, house, card, ephemeral_vault,
///            magic_program, analytics, card_permission, permission_program, magic_context?]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct ResolvePurchase {
    pub human: Pubkey,
    pub card_id: u64,
    /// Who referred the player, if the purchase named anyone. Read only when the card is created.
    pub referrer: Referrer,
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
        rest: &[AccountInfo],
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
        let first = card_account.data_len() == 0;
        let kept = Card::referral(card_account);
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

        let terms = config::shelf_card(config_account, card_id)?;

        // A card holds its terms at their own layout, so one bought under the other layout is
        // resized to this one's — in place, so its permission stays with it.
        let size = Card::persistent_size(&terms);
        if card_account.data_len() != 0 && card_account.data_len() != size {
            casino_core::magicblock::resize_ephemeral_account(house, card_account, ephemeral_vault, magic_program,
                size as u32, &[&[b"house", &[house_bump]]])?;
        }
        if card_account.data_len() == 0 {
            create_ephemeral_account(house, card_account, ephemeral_vault, magic_program,
                size as u32,
                &[&[b"house", &[house_bump]], &[b"card", self.human.as_ref(), &[card_bump]]])?;
        }
        Card::set_generation(card_account, generation)?;

        // The referrer is locked when the card is first made; a card grown to this layout was
        // made before referrals, and its player stays unreferred.
        let section = match kept {
            Some(section) => section,
            None => Referral::new(
                if first { self.referrer.0.as_ref() } else { None },
                &self.human.to_bytes(),
                Clock::get()?.unix_timestamp,
            ),
        };
        Card::write_referral(card_account, &section)?;
        let counted = kept.is_none().then(|| section.referrer().is_some());

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
        let price = terms.price_lamports();
        let take = price.saturating_mul(JACKPOT_SHARE_BP) / 10_000;
        let a = Analytics::load_mut(analytics_account)?;
        a.lamports_in = a.lamports_in.saturating_add(price);
        a.jackpot_in = a.jackpot_in.saturating_add(take);
        if let Some(slot) = a.cards_sold.get_mut(card_id as usize) {
            casino_core::analytics::count(slot);
        }
        if let Some(referred) = counted {
            referral::count_player(Analytics::referrals(analytics_account), referred);
        }

        if let Some(referrer) = section.referrer() {
            let magic_context = rest.iter().find(|a| *a.address() == MAGIC_CONTEXT_ID)
                .ok_or(ProgramError::NotEnoughAccountKeys)?;
            let (account, _) = Pubkey::find_program_address(&[b"card", referrer.as_ref()], program_id);
            referral::schedule_credit(
                program_id, house, &[b"house", &[house_bump]], magic_context, magic_program,
                card_account.address(), generation, &account, &ANALYTICS,
                crate::ScratchCardsInstruction::CREDIT_REFERRAL, price,
            )?;
        }

        Ok(())
    }
}

pub fn card_members(human: &Pubkey) -> Vec<Pubkey> {
    permission::ephemeral_members(&[*human, PRIVATE_CASINO])
}

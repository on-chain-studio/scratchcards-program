use borsh::{BorshDeserialize, BorshSerialize};
use crate::magicblock::EPHEMERAL_VAULT_ID;
use crate::magicblock::create_ephemeral_account;
use crate::chain::*;

use crate::constants::JACKPOT_SHARE_BP;
use crate::error::GameError;
use crate::state::analytics::Analytics;
use crate::state::card::{self, Card, CardStatus};
use crate::state::Config;
use crate::utils::{pda, receipt};

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
        let _ = permission_program; // in scope so the ACL CPI can resolve; not read directly
        let program_id = &crate::ID;

        if *ephemeral_vault.address() != EPHEMERAL_VAULT_ID {
            return Err(GameError::InvalidPDA.into());
        }
        pda::validate(program_id, config_account, &[b"config"])?;
        let house_bump = pda::validate(program_id, house, &[b"house"])?;

        receipt::require_callback(vault_authority)?;
        let card_id = self.card_id;

        let card_bump = pda::validate(
            program_id, card_account, &[b"card", self.human.as_ref()],
        )?;
        if card_account.data_len() != 0 {
            return Err(GameError::AlreadyInitialized.into());
        }

        let terms = *Config::card(config_account, card_id)?;

        create_ephemeral_account(
            house,
            card_account,
            ephemeral_vault,
            Card::WITH_TERMS as u32,
            &[
                &[b"house", &[house_bump]],
                &[b"card", self.human.as_ref(), &[card_bump]],
            ],
        )?;

        {
            let c = Card::load_mut(card_account)?;
            c.discriminator = card::DISCRIMINATOR;
            c.version = card::VERSION;
            c.user = self.human.to_bytes();
            c.card_id = card_id;
            c.status = CardStatus::Bought as u64;
            c.seed = [0u8; 32];
        }
        Card::write_terms(card_account, &terms)?;

        // Make the card private on the TEE. A stranger can otherwise derive ["card", user] and read
        // the account and its entire signature history (every purchase/reveal/collect, timestamped).
        // Members: the player's wallet, whose own TEE token authorises the client's reads and
        // subscriptions, and every program that is ever top-level over the card — a private-rollup
        // account admits a transaction only when its top-level program is a member: the vault
        // (settle callbacks) and the VRF program (the seed callback). ER-only (house fronts the
        // rent) and never closed (closing would re-expose the not-yet-compressed history). Every
        // purchase re-asserts the list, so a permission made under an older one is brought to
        // parity the next time its owner plays; a matching one costs a read, not a write.
        let members = [self.human, crate::constants::VAULT_PROGRAM, crate::constants::VRF_PROGRAM];
        let signers: &[&[&[u8]]] = &[
            &[b"house", &[house_bump]],
            &[b"card", self.human.as_ref(), &[card_bump]],
        ];
        if card_permission.data_len() == 0 {
            crate::magicblock::create_ephemeral_permission(
                house, card_account, card_permission, ephemeral_vault, magic_program, &members, signers,
            )?;
        } else if !crate::magicblock::ephemeral_permission_matches(card_permission, &members)? {
            crate::magicblock::update_ephemeral_permission(
                house, card_account, card_permission, ephemeral_vault, magic_program, &members, signers,
            )?;
        }

        // This callback only fires on a settled payment, so the count is settled money.
        pda::validate(program_id, analytics_account, &[b"analytics"])?;
        let price = terms.price_lamports;
        let take = price.saturating_mul(JACKPOT_SHARE_BP) / 10_000;
        let a = Analytics::load_mut(analytics_account)?;
        a.lamports_in = a.lamports_in.saturating_add(price);
        a.jackpot_in = a.jackpot_in.saturating_add(take);
        if let Some(slot) = a.cards_sold.get_mut(card_id as usize) {
            Analytics::count(slot);
        }

        Ok(())
    }
}

use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::chain::*;
use casino_core::ids::VAULT_PROGRAM;
use casino_core::magicblock::{create_ephemeral_account, create_ephemeral_permission, EPHEMERAL_VAULT_ID, MEMBER_READ};
use casino_core::{pda, receipt, CoreError};

use crate::constants::JACKPOT_SHARE_BP;
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
        if card_account.data_len() != 0 {
            return Err(CoreError::AlreadyInitialized.into());
        }

        let terms = *Config::item(config_account, card_id)?;

        create_ephemeral_account(
            house,
            card_account,
            ephemeral_vault,
            magic_program,
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
        // subscriptions, and every program that is ever top-level over the card in an ordinary
        // transaction — a private-rollup account admits one only when its top-level program is a
        // member: the vault (settle callbacks). The VRF oracle's callback is admitted without
        // membership, like a crank, so the VRF program is not on the list. ER-only (house fronts the
        // rent), never closed (closing would re-expose the not-yet-compressed history) and never
        // rewritten: an update through the ACL program drops the owning program from the list
        // and the rollup then refuses it for good. A permission is made once and left alone.
        // Every member reads in full (`MEMBER_READ`) but none holds authority over the list.
        if card_permission.data_len() == 0 {
            let members = [self.human, VAULT_PROGRAM];
            let signers: &[&[&[u8]]] = &[
                &[b"house", &[house_bump]],
                &[b"card", self.human.as_ref(), &[card_bump]],
            ];
            create_ephemeral_permission(
                house, card_account, card_permission, ephemeral_vault, magic_program, permission_program, &members,
                MEMBER_READ, signers,
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
            casino_core::analytics::count(slot);
        }

        Ok(())
    }
}

use borsh::BorshDeserialize;
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount;
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, entrypoint::ProgramResult};

use crate::constants::JACKPOT_SHARE_BP;
use crate::error::GameError;
use crate::instruction::ProcessInstruction;
use crate::state::analytics::Analytics;
use crate::state::card::{self, Card, CardStatus};
use crate::state::Config;
use crate::utils::{pda, receipt};

/// Turns a settled receipt into a card. The seed comes later via `RequestReveal`, so a failed VRF
/// request can't unwind a paid purchase.
#[derive(BorshDeserialize)]
pub struct ResolvePurchase {
    pub human: Pubkey,
    pub card_id: u64,
}


impl ProcessInstruction for ResolvePurchase {
    fn process(&self, program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let [_receipt_account, vault_authority, config_account, house, card_account,
             ephemeral_vault, _magic_program, analytics_account, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if *ephemeral_vault.key != EPHEMERAL_VAULT_ID {
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

        EphemeralAccount::new(house, card_account, ephemeral_vault)
            .with_signer_seeds(&[
                &[b"house", &[house_bump]],
                &[b"card", self.human.as_ref(), &[card_bump]],
            ])
            .create(Card::WITH_TERMS as u32)?;

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

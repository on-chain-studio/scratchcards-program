use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, entrypoint::ProgramResult};

use crate::constants::VRF_PROGRAM_IDENTITY;
use crate::error::GameError;
use crate::state::card::{Card, CardStatus};
use crate::utils::pda;

/// The VRF oracle's answer: 32 bytes of randomness signed by the VRF identity, written onto the card.
/// Accounts: [vrf_identity (signer), card]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct CallbackReveal {
    pub randomness: [u8; 32],
}


impl CallbackReveal {
    #[inline(always)]
    pub fn process<'a>(
        &self,
        vrf_identity: &AccountInfo<'a>,
        card_account: &AccountInfo<'a>,
    ) -> ProgramResult {
        let program_id = &crate::ID;

        if !vrf_identity.is_signer || vrf_identity.key != &VRF_PROGRAM_IDENTITY {
            return Err(ProgramError::MissingRequiredSignature);
        }

        let card = Card::load_mut(card_account)?;
        if card.status != CardStatus::Requested as u64 {
            return Err(GameError::WrongStatus.into());
        }
        // The VRF identity signs whatever request named it; bind the callback to this user's card.
        pda::validate(program_id, card_account, &[b"card", card.user.as_ref()])?;
        card.seed = self.randomness;
        card.status = CardStatus::Revealed as u64;

        Ok(())
    }
}

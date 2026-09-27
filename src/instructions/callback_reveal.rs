use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::chain::*;
use casino_core::{pda, vrf, CoreError};

use crate::state::card::{Card, CardStatus};

/// The VRF oracle's answer: 32 bytes of randomness, signed by the VRF's identity scoped to this
/// program (`vrf::scoped_identity`), written onto the card.
/// Accounts: [vrf_identity (signer), card]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct CallbackReveal {
    pub randomness: [u8; 32],
    pub generation: u64,
}


impl CallbackReveal {
    #[inline(always)]
    pub fn process<'a>(
        &self,
        vrf_identity: &AccountInfo,
        card_account: &AccountInfo,
    ) -> ProgramResult {
        let program_id = &crate::ID;

        if !vrf_identity.is_signer() || *vrf_identity.address() != vrf::scoped_identity(program_id) {
            return Err(ProgramError::MissingRequiredSignature);
        }

        if Card::generation(card_account)? != self.generation {
            return Err(CoreError::WrongStatus.into());
        }
        let card = Card::load_mut(card_account)?;
        if card.status != CardStatus::Requested as u64 {
            return Err(CoreError::WrongStatus.into());
        }
        // The scoped identity signs for any request this program made; bind the callback to this
        // user's card.
        pda::validate(program_id, card_account, &[b"card", card.user.as_ref()])?;
        card.seed = self.randomness;
        card.status = CardStatus::Revealed as u64;

        Ok(())
    }
}

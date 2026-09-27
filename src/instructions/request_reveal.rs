use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::chain::*;
use casino_core::{pda, vrf, CoreError};

use crate::state::card::{Card, CardStatus};

#[derive(BorshDeserialize, BorshSerialize)]
pub struct RequestReveal;


impl RequestReveal {
    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    pub fn process<'a>(
        &self,
        user: &AccountInfo,
        house: &AccountInfo,
        card_account: &AccountInfo,
        identity: &AccountInfo,
        oracle_queue: &AccountInfo,
        slot_hashes: &AccountInfo,
        system_program: &AccountInfo,
        vrf_program: &AccountInfo,
    ) -> ProgramResult {
        let program_id = &crate::ID;

        let house_bump = pda::validate(program_id, house, &[b"house"])?;
        let identity_bump = pda::validate(program_id, identity, &[b"identity"])?;
        pda::validate(program_id, card_account, &[b"card", user.address().as_ref()])?;

        let generation = Card::generation(card_account)?;
        {
            let card = Card::load_mut(card_account)?;
            if card.user != user.address().to_bytes() {
                return Err(CoreError::Unauthorized.into());
            }
            // `Bought` is the first request; `Requested` is a permissionless re-fire for a dropped VRF
            // callback (free on the ER). First seed wins regardless: `callback_reveal` only writes on
            // `Requested` and flips to `Revealed`, so a later callback can't overwrite it.
            if card.status != CardStatus::Bought as u64 && card.status != CardStatus::Requested as u64 {
                return Err(CoreError::WrongStatus.into());
            }
            card.status = CardStatus::Requested as u64;
        }

        // Unique per card bought, so no request repeats an earlier card's input.
        let mut caller_seed = card_account.address().to_bytes();
        for (i, b) in generation.to_le_bytes().iter().enumerate() {
            caller_seed[i] ^= b;
        }

        vrf::request_randomness(
            program_id, house, identity, identity_bump, oracle_queue, system_program,
            slot_hashes, vrf_program,
            caller_seed,
            crate::ScratchCardsInstruction::CALLBACK_REVEAL.to_le_bytes(),
            vec![vrf::SerializableAccountMeta {
                pubkey: *card_account.address(),
                is_signer: false,
                is_writable: true,
            }],
            // Reject delayed answers meant for an earlier card.
            generation.to_le_bytes().to_vec(),
            &[b"house", &[house_bump]],
            true,
        )
    }
}

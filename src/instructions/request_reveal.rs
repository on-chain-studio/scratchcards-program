use borsh::{BorshDeserialize, BorshSerialize};
use crate::chain::*;

use crate::error::GameError;
use crate::state::card::{Card, CardStatus};
use crate::utils::{pda, vrf};

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

        {
            let card = Card::load_mut(card_account)?;
            if card.user != user.address().to_bytes() {
                return Err(GameError::Unauthorized.into());
            }
            // `Bought` is the first request; `Requested` is a permissionless re-fire for a dropped VRF
            // callback (free on the ER). First seed wins regardless: `callback_reveal` only writes on
            // `Requested` and flips to `Revealed`, so a later callback can't overwrite it.
            if card.status != CardStatus::Bought as u64 && card.status != CardStatus::Requested as u64 {
                return Err(GameError::WrongStatus.into());
            }
            card.status = CardStatus::Requested as u64;
        }

        vrf::request_randomness(
            program_id, house, identity, identity_bump, oracle_queue, system_program,
            slot_hashes, vrf_program,
            card_account.address().to_bytes(),
            crate::ScratchCardsInstruction::CALLBACK_REVEAL.to_le_bytes(),
            vec![vrf::SerializableAccountMeta {
                pubkey: *card_account.address(),
                is_signer: false,
                is_writable: true,
            }],
            &[b"house", &[house_bump]],
            true,
        )
    }
}

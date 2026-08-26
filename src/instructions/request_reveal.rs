use borsh::BorshDeserialize;
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, entrypoint::ProgramResult};

use crate::error::GameError;
use crate::instruction::{ix, ProcessInstruction};
use crate::state::card::{Card, CardStatus};
use crate::utils::{pda, vrf};

#[derive(BorshDeserialize)]
pub struct RequestReveal;


impl ProcessInstruction for RequestReveal {
    fn process(&self, program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let [user, house, card_account, identity, oracle_queue, slot_hashes,
             system_program, vrf_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        let house_bump = pda::validate(program_id, house, &[b"house"])?;
        let identity_bump = pda::validate(program_id, identity, &[b"identity"])?;
        pda::validate(program_id, card_account, &[b"card", user.key.as_ref()])?;

        {
            let card = Card::load_mut(card_account)?;
            if card.user != user.key.to_bytes() {
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
            card_account.key.to_bytes(),
            ix::CallbackReveal.to_le_bytes(),
            vec![vrf::SerializableAccountMeta {
                pubkey: *card_account.key,
                is_signer: false,
                is_writable: true,
            }],
            &[b"house", &[house_bump]],
            true,
        )
    }
}

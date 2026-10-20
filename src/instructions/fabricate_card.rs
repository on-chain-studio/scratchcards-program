use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::chain::*;
use casino_core::magicblock::{create_ephemeral_account, EPHEMERAL_VAULT_ID};
use casino_core::{pda, Casino, CoreError};

use crate::ScratchCards;

/// Devnet only: writes a card account out of thin air — any bytes, any size — so a path no
/// purchase can reach today can be driven on the TEE: a ticket of another layout's size, sitting
/// there for the next purchase to resize. Admin only, and compiled out of every build without
/// the `devnet-debug` feature, where it is refused outright. There is no mainnet case for it.
/// Accounts: [admin (signer), house, card, ephemeral_vault, magic_program]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct FabricateCard {
    pub user: Pubkey,
    pub data: Vec<u8>,
}

impl FabricateCard {
    #[inline(always)]
    pub fn process(
        &self,
        admin: &AccountInfo,
        house: &AccountInfo,
        card_account: &AccountInfo,
        ephemeral_vault: &AccountInfo,
        magic_program: &AccountInfo,
    ) -> ProgramResult {
        if !cfg!(feature = "devnet-debug") {
            return Err(ProgramError::InvalidInstructionData);
        }
        let program_id = &crate::ID;
        ScratchCards::require_admin(admin)?;
        if *ephemeral_vault.address() != EPHEMERAL_VAULT_ID {
            return Err(CoreError::InvalidPDA.into());
        }
        let house_bump = pda::validate(program_id, house, &[b"house"])?;
        let card_bump = pda::validate(program_id, card_account, &[b"card", self.user.as_ref()])?;
        if card_account.data_len() != 0 {
            return Err(CoreError::AlreadyInitialized.into());
        }
        create_ephemeral_account(house, card_account, ephemeral_vault, magic_program,
            self.data.len() as u32,
            &[&[b"house", &[house_bump]], &[b"card", self.user.as_ref(), &[card_bump]]])?;
        let mut data = card_account.try_borrow_mut_data()?;
        data.copy_from_slice(&self.data);
        Ok(())
    }
}

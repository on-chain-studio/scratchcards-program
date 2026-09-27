use casino_core::chain::*;
use casino_core::magicblock::MEMBER_READ;
use casino_core::{pda, permission};

use crate::instructions::resolve_purchase::card_members;

pub struct UpgradePermissions;

impl UpgradePermissions {
    #[allow(clippy::too_many_arguments)]
    pub fn process(&self, user: &AccountInfo, card: &AccountInfo, card_permission: &AccountInfo,
        house: &AccountInfo, ephemeral_vault: &AccountInfo, magic_program: &AccountInfo,
        permission_program: &AccountInfo) -> ProgramResult {
        let card_bump = pda::validate(&crate::ID, card, &[b"card", user.address().as_ref()])?;
        let house_bump = pda::validate(&crate::ID, house, &[b"house"])?;
        // resolve_purchase makes the permission of a card that doesn't exist yet.
        if card.data_len() == 0 {
            return Ok(());
        }
        permission::upgrade_ephemeral(
            &crate::ID, permission_program, card, &[b"card", user.address().as_ref(), &[card_bump]],
            card_permission, house, &[b"house", &[house_bump]], ephemeral_vault, magic_program,
            card_members(user.address()), MEMBER_READ,
        )
    }
}

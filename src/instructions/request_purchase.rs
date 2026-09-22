use borsh::{BorshDeserialize, BorshSerialize};
use crate::chain::*;

use crate::constants::JACKPOT_SHARE_BP;
use crate::error::GameError;
use crate::state::Config;
use crate::utils::{pda, receipt, vault};

#[derive(BorshDeserialize, BorshSerialize)]
pub struct RequestPurchase {
    pub card_id: u64,
}


impl RequestPurchase {
    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    pub fn process<'a>(
        &self,
        wallet: &AccountInfo,
        user: &AccountInfo,
        config_account: &AccountInfo,
        house: &AccountInfo,
        receipt_account: &AccountInfo,
        ephemeral_vault: &AccountInfo,
        magic_program: &AccountInfo,
        vault_program: &AccountInfo,
        jackpot: &AccountInfo,
        house_ledger: &AccountInfo,
        magic_context: &AccountInfo,
    ) -> ProgramResult {
        let program_id = &crate::ID;

        if !wallet.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        pda::validate(program_id, config_account, &[b"config"])?;
        let house_bump = pda::validate(program_id, house, &[b"house"])?;
        pda::validate(program_id, jackpot, &[b"jackpot"])?;
        if *house_ledger.address() != vault::ledger(house.address()) {
            return Err(GameError::InvalidPDA.into());
        }
        if *receipt_account.address() != receipt::address(wallet.address()) {
            return Err(GameError::InvalidPDA.into());
        }

        let price = Config::card(config_account, self.card_id)?.price_lamports;
        let take = price.saturating_mul(JACKPOT_SHARE_BP) / 10_000;
        let sol = Pubkey::default();

        // The jackpot's cut rides the same receipt as the sale, so it lands with the payment or not at all.
        let mut movements = vec![
            receipt::Movement { mint: sol, amount: price - take, from: 0, to: 1 },
        ];
        if take > 0 {
            movements.push(receipt::Movement { mint: sol, amount: take, from: 0, to: 2 });
        }

        receipt::create(
            vault_program, house, house_ledger, wallet, receipt_account, ephemeral_vault,
            magic_program, magic_context,
            program_id,
            &[b"house", &[house_bump]],
            &[*user.address(), *house.address(), *jackpot.address()],
            crate::ScratchCardsInstruction::RESOLVE_PURCHASE,
            &self.card_id.to_le_bytes(),
            &movements,
        )
    }
}

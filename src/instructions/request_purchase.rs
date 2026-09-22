use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, entrypoint::ProgramResult};

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
        wallet: &AccountInfo<'a>,
        user: &AccountInfo<'a>,
        config_account: &AccountInfo<'a>,
        house: &AccountInfo<'a>,
        receipt_account: &AccountInfo<'a>,
        ephemeral_vault: &AccountInfo<'a>,
        magic_program: &AccountInfo<'a>,
        vault_program: &AccountInfo<'a>,
        jackpot: &AccountInfo<'a>,
        house_ledger: &AccountInfo<'a>,
        magic_context: &AccountInfo<'a>,
    ) -> ProgramResult {
        let program_id = &crate::ID;

        if !wallet.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        pda::validate(program_id, config_account, &[b"config"])?;
        let house_bump = pda::validate(program_id, house, &[b"house"])?;
        pda::validate(program_id, jackpot, &[b"jackpot"])?;
        if *house_ledger.key != vault::ledger(house.key) {
            return Err(GameError::InvalidPDA.into());
        }
        if *receipt_account.key != receipt::address(wallet.key) {
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
            &[*user.key, *house.key, *jackpot.key],
            crate::ScratchCardsInstruction::RESOLVE_PURCHASE,
            &self.card_id.to_le_bytes(),
            &movements,
        )
    }
}

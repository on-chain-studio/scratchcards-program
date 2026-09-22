use borsh::{BorshDeserialize, BorshSerialize};
use crate::chain::*;

use crate::error::GameError;
use crate::state::card::{Card, CardStatus};
use crate::state::Config;
use crate::utils::{engine, pda, receipt, vault};

#[derive(BorshDeserialize, BorshSerialize)]
pub struct RequestCollect;


impl RequestCollect {
    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    pub fn process<'a>(
        &self,
        user: &AccountInfo,
        config_account: &AccountInfo,
        house: &AccountInfo,
        card_account: &AccountInfo,
        receipt_account: &AccountInfo,
        ephemeral_vault: &AccountInfo,
        magic_program: &AccountInfo,
        vault_program: &AccountInfo,
        jackpot: &AccountInfo,
        jackpot_ledger: &AccountInfo,
        wallet: &AccountInfo,
        house_ledger: &AccountInfo,
        magic_context: &AccountInfo,
    ) -> ProgramResult {
        let program_id = &crate::ID;

        // A win may open a new token slot on the player's ledger; the vault needs the owner's consent,
        // which is the session key signing here.
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

        // Nothing about the card is written here. A card is collected when it is *gone* — the
        // settle callback closes it — so asking for a payout leaves no state to strand. This is
        // load-bearing: requesting is permissionless, and a version that marked the card spent
        // let anyone flip a stranger's revealed card and then simply never settle, destroying the
        // win and blocking that player from ever buying again.
        let (card_id, seed) = {
            let card = Card::load(card_account)?;
            if card.user != user.address().to_bytes() {
                return Err(GameError::Unauthorized.into());
            }
            if card.status != CardStatus::Revealed as u64 {
                return Err(GameError::NotRevealed.into());
            }
            pda::validate(program_id, card_account, &[b"card", user.address().as_ref()])?;
            (card.card_id, card.seed)
        };

        let terms = match Card::terms(card_account)? {
            Some(t) => *t,
            None => *Config::card(config_account, card_id)?,
        };
        let wins = engine::evaluate(&terms, &seed)?;

        let mut movements = Vec::new();
        {
            let c = &terms;
            for (i, amount) in wins.amounts.iter().enumerate() {
                if *amount == 0 { continue; }
                movements.push(receipt::Movement {
                    mint: Pubkey::new_from_array(c.pool[i].mint),
                    amount: *amount,
                    from: 1,
                    to: 0,
                });
            }
        }
        // A won jackpot is the whole pot, read from its ledger and paid straight out of it. The
        // amount rides the receipt's args: the pot is drained by the time the callback runs, so
        // it cannot be re-read there, and the callback only fires if this exact receipt settled.
        let mut jackpot_paid = 0u64;
        if wins.jackpot {
            if *jackpot_ledger.address() != vault::ledger(jackpot.address()) {
                return Err(GameError::InvalidPDA.into());
            }
            let pot = vault::sol_balance(jackpot_ledger)?;
            if pot > 0 {
                movements.push(receipt::Movement {
                    mint: Pubkey::default(), amount: pot, from: 2, to: 0,
                });
                jackpot_paid = pot;
            }
        }

        receipt::create(
            vault_program, house, house_ledger, wallet, receipt_account, ephemeral_vault,
            magic_program, magic_context,
            program_id,
            &[b"house", &[house_bump]],
            &[*user.address(), *house.address(), *jackpot.address()],
            crate::ScratchCardsInstruction::RESOLVE_COLLECT,
            &jackpot_paid.to_le_bytes(),
            &movements,
        )
    }
}

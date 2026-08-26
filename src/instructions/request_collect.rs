use borsh::BorshDeserialize;
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, entrypoint::ProgramResult};

use crate::error::GameError;
use crate::instruction::{ix, ProcessInstruction};
use crate::state::card::{Card, CardStatus};
use crate::state::Config;
use crate::utils::{engine, pda, receipt, vault};

#[derive(BorshDeserialize)]
pub struct RequestCollect;


impl ProcessInstruction for RequestCollect {
    fn process(&self, program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let [user, config_account, house, card_account, receipt_account, ephemeral_vault,
             magic_program, vault_program, jackpot, jackpot_ledger, wallet, house_ledger,
             magic_context, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        // A win may open a new token slot on the player's ledger; the vault needs the owner's consent,
        // which is the session key signing here.
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

        // Nothing about the card is written here. A card is collected when it is *gone* — the
        // settle callback closes it — so asking for a payout leaves no state to strand. This is
        // load-bearing: requesting is permissionless, and a version that marked the card spent
        // let anyone flip a stranger's revealed card and then simply never settle, destroying the
        // win and blocking that player from ever buying again.
        let (card_id, seed) = {
            let card = Card::load(card_account)?;
            if card.user != user.key.to_bytes() {
                return Err(GameError::Unauthorized.into());
            }
            if card.status != CardStatus::Revealed as u64 {
                return Err(GameError::NotRevealed.into());
            }
            pda::validate(program_id, card_account, &[b"card", user.key.as_ref()])?;
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
            if *jackpot_ledger.key != vault::ledger(jackpot.key) {
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
            &[*user.key, *house.key, *jackpot.key],
            ix::ResolveCollect,
            &jackpot_paid.to_le_bytes(),
            &movements,
        )
    }
}

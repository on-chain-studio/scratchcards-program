use borsh::{BorshDeserialize, BorshSerialize};
use casino_core::chain::*;
use casino_core::ids::PERMISSION_PROGRAM;
use casino_core::{pda, permission, Casino, CoreError};

use crate::constants::{ANALYTICS_READERS, TREASURIES};
use crate::state::analytics::{self, Analytics};
use crate::state::config::{self, Config, INITIAL_CARDS};
use crate::ScratchCards;

/// Creates `["config"]`, the treasury PDAs and `["analytics"]`, and stamps the shelf's layout —
/// emptying it when the layout changed. Admin only, idempotent. The house is program-owned so it can be delegated to the rollup (it pays
/// VRF + ephemeral rent); analytics is delegated the same way, since the settle callbacks that
/// write it run there. Analytics gets a TEE permission naming the admins, like a ledger's.
/// Accounts: [initializer, config, house, jackpot, analytics, permission, permission_program,
///            system_program]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct Initialize {
    pub card_count: u8,
}


impl Initialize {
    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    pub fn process<'a>(
        &self,
        initializer: &AccountInfo,
        config_account: &AccountInfo,
        house: &AccountInfo,
        jackpot: &AccountInfo,
        analytics_account: &AccountInfo,
        permission: &AccountInfo,
        permission_program: &AccountInfo,
        system_program: &AccountInfo,
    ) -> ProgramResult {
        let program_id = &crate::ID;
        // One account per `TREASURIES` seed, in order.
        let treasuries: [&AccountInfo; TREASURIES.len()] = [house, jackpot];

        ScratchCards::require_admin(initializer)?;
        if *permission_program.address() != PERMISSION_PROGRAM {
            return Err(CoreError::InvalidPDA.into());
        }
        let config_bump = pda::validate(program_id, config_account, &[b"config"])?;

        let initial = Config::size_for(INITIAL_CARDS);
        if config_account.data_len() == 0 {
            invoke_signed(
                &system_instruction::create_account(
                    initializer.address(),
                    config_account.address(),
                    pda::min_balance(initial),
                    initial as u64,
                    program_id,
                ),
                &[initializer.clone(), config_account.clone()],
                &[&[b"config", &[config_bump]]],
            )?;
        }
        for (i, seed) in TREASURIES.iter().enumerate() {
            let Some(account) = treasuries.get(i) else {
                return Err(ProgramError::NotEnoughAccountKeys);
            };
            let bump = pda::validate(program_id, account, &[seed])?;
            if account.data_len() == 0 && account.lamports() == 0 {
                invoke_signed(
                    &system_instruction::create_account(
                        initializer.address(),
                        account.address(),
                        pda::min_balance(0),
                        0,
                        program_id,
                    ),
                    &[initializer.clone(), (*account).clone()],
                    &[&[seed, &[bump]]],
                )?;
            }
        }

        let analytics_bump = pda::validate(program_id, analytics_account, &[b"analytics"])?;
        if analytics_account.data_len() == 0 {
            invoke_signed(
                &system_instruction::create_account(
                    initializer.address(),
                    analytics_account.address(),
                    pda::min_balance(Analytics::SIZE),
                    Analytics::SIZE as u64,
                    program_id,
                ),
                &[initializer.clone(), analytics_account.clone()],
                &[&[b"analytics", &[analytics_bump]]],
            )?;
            let a = Analytics::load_mut(analytics_account)?;
            a.discriminator = analytics::DISCRIMINATOR;
            a.version = analytics::VERSION;
        }
        // The TEE permission: counters are the house's books, so only the analytics readers may
        // read the live copy. Both programs are members because the rollup admits an instruction that
        // touches a permissioned account only when the *invoked program* is a member — and the
        // settle that writes these counters is a vault instruction, exactly the reason every
        // ledger's permission names the vault and the game alike. Created once and never
        // rewritten: an update drops the owning program and the TEE then refuses the account.
        permission::set(
            permission_program,
            analytics_account,
            &[b"analytics", &[analytics_bump]],
            permission,
            initializer,
            system_program,
            permission::members(program_id, &ANALYTICS_READERS),
        )?;

        let cfg = Config::load_mut(config_account)?;
        // A shelf stamped with another layout holds cards this program reads at the wrong stride.
        // Re-stamping it takes every card off sale in the same breath, so none is ever sold or
        // valued misread; `SetCard` puts the sheet back, growing the shelf as it goes. A re-run at
        // the current layout keeps its cards: declaring fewer (or zero, the fresh-shelf default)
        // must not orphan tickets already sold.
        let stamped = cfg.version;
        cfg.discriminator = config::DISCRIMINATOR;
        cfg.version = config::VERSION;
        cfg.authority = initializer.address().to_bytes();
        cfg.count = if stamped == config::VERSION { cfg.count.max(self.card_count as u64) } else { 0 };
        if cfg.count as usize > Config::capacity(config_account) {
            return Err(CoreError::ShelfFull.into());
        }

        Ok(())
    }
}

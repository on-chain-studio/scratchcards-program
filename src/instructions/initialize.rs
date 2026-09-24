use borsh::{BorshDeserialize, BorshSerialize};
use crate::magicblock::create_permission;
use crate::chain::*;

use crate::constants::{is_admin, ADMIN_PUBKEYS, PERMISSION_PROGRAM, TREASURIES, VAULT_PROGRAM};
use crate::error::GameError;
use crate::state::analytics::{self, Analytics};
use crate::state::config::{self, Config, INITIAL_CARDS};
use crate::utils::pda;

/// Creates `["config"]`, the treasury PDAs and `["analytics"]`, and sets the card count. Admin
/// only, idempotent. The house is program-owned so it can be delegated to the rollup (it pays
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

        if !initializer.is_signer() || !is_admin(initializer.address()) {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if *permission_program.address() != PERMISSION_PROGRAM {
            return Err(GameError::InvalidPDA.into());
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
        // The TEE permission: counters are the house's books, so only the admins may read the
        // live copy. Both programs are members because the rollup admits an instruction that
        // touches a permissioned account only when the *invoked program* is a member — and the
        // settle that writes these counters is a vault instruction, exactly the reason every
        // ledger's permission names the vault and the game alike. Made once and never rewritten:
        // an update through the ACL program is not something this program does.
        let mut members = vec![*program_id, VAULT_PROGRAM];
        members.extend(ADMIN_PUBKEYS);
        let seeds: &[&[u8]] = &[b"analytics", &[analytics_bump]];
        if permission.data_len() == 0 {
            create_permission(analytics_account, permission, initializer, system_program, &members, &[seeds])
                .map_err(|_| ProgramError::InvalidAccountData)?;
        }

        // Grow a short shelf up to the starting size, never shrink — it may hold live cards. Rent
        // must come with the growth or the resize fails the runtime's exemption check.
        if config_account.data_len() < initial {
            let required = pda::min_balance(initial);
            let held = config_account.lamports();
            if held < required {
                invoke(
                    &system_instruction::transfer(
                        initializer.address(), config_account.address(), required - held,
                    ),
                    &[initializer.clone(), config_account.clone(), system_program.clone()],
                )?;
            }
            config_account.resize(initial)?;
        }
        if self.card_count as usize > Config::capacity(config_account) {
            return Err(GameError::ShelfFull.into());
        }

        let cfg = Config::load_mut(config_account)?;
        cfg.discriminator = config::DISCRIMINATOR;
        cfg.version = config::VERSION;
        cfg.authority = initializer.address().to_bytes();
        // Like the shelf itself, the count never shrinks: a re-run declaring fewer cards (or
        // zero, the fresh-shelf default) must not orphan cards already published and live.
        cfg.card_count = cfg.card_count.max(self.card_count as u64);

        Ok(())
    }
}

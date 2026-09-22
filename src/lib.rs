//! Scratch Cards. The `#[program]` block below is the whole wire interface: every instruction, its
//! number, its accounts in order and its arguments. What each one does lives in `instructions`.

use solarium::prelude::*;
use solarium_program::prelude::*;
use solarium_program::{Account, Remaining, Signer};

use crate::instructions::*;

pub mod chain;
pub mod constants;
pub mod error;
pub mod magicblock;

pub mod instructions {
    pub mod initialize;
    pub mod open_ledger;
    pub mod close_ledger;
    pub mod read_jackpot;
    pub mod set_privacy;
    pub mod withdraw_house;
    pub mod delegate_treasury;
    pub mod undelegate_treasury;
    pub mod set_card;
    pub mod grow_config;
    pub mod delegation;
    pub mod authorize_treasury;

    pub mod request_purchase;
    pub mod resolve_purchase;
    pub mod request_reveal;
    pub mod request_collect;
    pub mod callback_reveal;
    pub mod resolve_collect;
    pub mod close_card;
}

pub mod state;

pub mod utils {
    pub mod pda;
    pub mod vrf;
    pub mod vault;
    pub mod receipt;
    pub mod engine;
}

// Each discriminator is the little-endian u64 an instruction starts with, and they are the ones
// this program has always had: dense, append-only, never reused — renumbering would silently
// repoint old clients. The gaps (5, 6, 8, 10, 11, 13, 14, 19, 23) are retired variants that
// have always been no-ops, so they reach `noop`; anything past 30 is refused. The settle and VRF callbacks are called back by these numbers, so they can
// no more move than the rest. Accounts are taken in the order listed; any past the last are
// ignored.
//
// `Signer` stands only where the handler's first check was that very signature, so a refusal
// still reads MissingRequiredSignature. The callbacks' authorities stay plain accounts: they are
// checked against a known key, and refused with the game's own error.
#[program(id = "GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC")]
impl ScratchCards {
    /// Does nothing with whatever it is given — kept deployed so a transaction can carry an
    /// arbitrary account list with no execution at all, which is how the TEE's admission rules are
    /// probed (`scripts/_noop-admission.mjs`). Every retired number has always landed here too,
    /// and still does.
    #[instruction(
        discriminator = 0,
        alias = 5, alias = 6, alias = 8, alias = 10, alias = 11,
        alias = 13, alias = 14, alias = 19, alias = 23,
    )]
    pub fn noop(&self) -> Result<()> {
        Ok(())
    }

    #[instruction(discriminator = 1)]
    pub fn initialize<'a>(
        &self,
        initializer: &Signer<'a>,
        config: &mut Account<'a>,
        house: &mut Account<'a>,
        jackpot: &mut Account<'a>,
        analytics: &mut Account<'a>,
        permission: &mut Account<'a>,
        permission_program: &Account<'a>,
        system_program: &Account<'a>,
        args: initialize::Initialize,
    ) -> Result<()> {
        Ok(args.process(
            initializer.info.as_view(), config.info.as_view(), house.info.as_view(), jackpot.info.as_view(), analytics.info.as_view(),
            permission.info.as_view(), permission_program.info.as_view(), system_program.info.as_view(),
        )?)
    }

    #[instruction(discriminator = 2)]
    pub fn delegate<'a>(
        &self,
        payer: &Signer<'a>,
        pda: &mut Account<'a>,
        owner_program: &Account<'a>,
        buffer: &mut Account<'a>,
        delegation_record: &mut Account<'a>,
        delegation_metadata: &mut Account<'a>,
        delegation_program: &Account<'a>,
        system_program: &Account<'a>,
        args: delegation::Delegate,
    ) -> Result<()> {
        Ok(args.process(
            payer.info.as_view(), pda.info.as_view(), owner_program.info.as_view(), buffer.info.as_view(), delegation_record.info.as_view(),
            delegation_metadata.info.as_view(), delegation_program.info.as_view(), system_program.info.as_view(),
        )?)
    }

    /// Called by the delegation program with its own fixed tag; 3 is kept as it always was.
    #[instruction(discriminator = 3, alias = "global:process_undelegation")]
    pub fn undelegate<'a>(
        &self,
        delegated_pda: &mut Account<'a>,
        buffer: &mut Account<'a>,
        payer: &mut Account<'a>,
        system_program: &Account<'a>,
        args: delegation::Undelegate,
    ) -> Result<()> {
        Ok(args.process(delegated_pda.info.as_view(), buffer.info.as_view(), payer.info.as_view(), system_program.info.as_view())?)
    }

    #[instruction(discriminator = 4)]
    pub fn request_undelegation<'a>(
        &self,
        payer: &Signer<'a>,
        pda: &mut Account<'a>,
        magic_context: &mut Account<'a>,
        magic_program: &Account<'a>,
        fees_vault: &mut Account<'a>,
    ) -> Result<()> {
        Ok(delegation::RequestUndelegation.process(
            payer.info.as_view(), pda.info.as_view(), magic_context.info.as_view(), magic_program.info.as_view(), fees_vault.info.as_view(),
        )?)
    }

    #[instruction(discriminator = 7)]
    pub fn close_card<'a>(
        &self,
        admin: &Signer<'a>,
        house: &mut Account<'a>,
        card: &mut Account<'a>,
        ephemeral_vault: &mut Account<'a>,
        magic_program: &Account<'a>,
        args: close_card::CloseCard,
    ) -> Result<()> {
        Ok(args.process(
            admin.info.as_view(), house.info.as_view(), card.info.as_view(), ephemeral_vault.info.as_view(), magic_program.info.as_view(),
        )?)
    }

    #[instruction(discriminator = 9)]
    pub fn set_card<'a>(
        &self,
        initializer: &Signer<'a>,
        config: &mut Account<'a>,
        system_program: &Account<'a>,
        args: set_card::SetCard,
    ) -> Result<()> {
        Ok(args.process(initializer.info.as_view(), config.info.as_view(), system_program.info.as_view())?)
    }

    /// The VRF oracle's callback.
    #[instruction(discriminator = 12)]
    pub fn callback_reveal<'a>(
        &self,
        vrf_identity: &Signer<'a>,
        card: &mut Account<'a>,
        args: callback_reveal::CallbackReveal,
    ) -> Result<()> {
        Ok(args.process(vrf_identity.info.as_view(), card.info.as_view())?)
    }

    #[instruction(discriminator = 15)]
    pub fn open_ledger<'a>(
        &self,
        admin: &Signer<'a>,
        treasury: &mut Account<'a>,
        ledger: &mut Account<'a>,
        permission: &mut Account<'a>,
        permission_program: &Account<'a>,
        vault_program: &Account<'a>,
        system_program: &Account<'a>,
        args: open_ledger::OpenLedger,
    ) -> Result<()> {
        Ok(args.process(
            admin.info.as_view(), treasury.info.as_view(), ledger.info.as_view(), permission.info.as_view(), permission_program.info.as_view(),
            vault_program.info.as_view(), system_program.info.as_view(),
        )?)
    }

    #[instruction(discriminator = 16)]
    pub fn delegate_treasury<'a>(
        &self,
        admin: &Signer<'a>,
        treasury: &mut Account<'a>,
        buffer: &mut Account<'a>,
        delegation_record: &mut Account<'a>,
        delegation_metadata: &mut Account<'a>,
        ledger: &mut Account<'a>,
        vault_program: &Account<'a>,
        delegation_program: &Account<'a>,
        system_program: &Account<'a>,
        args: delegate_treasury::DelegateTreasury,
    ) -> Result<()> {
        Ok(args.process(
            admin.info.as_view(), treasury.info.as_view(), buffer.info.as_view(), delegation_record.info.as_view(),
            delegation_metadata.info.as_view(), ledger.info.as_view(), vault_program.info.as_view(), delegation_program.info.as_view(),
            system_program.info.as_view(),
        )?)
    }

    #[instruction(discriminator = 17)]
    pub fn withdraw_house<'a>(
        &self,
        admin: &Signer<'a>,
        house: &mut Account<'a>,
        house_ledger: &mut Account<'a>,
        admin_ledger: &mut Account<'a>,
        vault_program: &Account<'a>,
        args: withdraw_house::WithdrawHouse,
    ) -> Result<()> {
        Ok(args.process(
            admin.info.as_view(), house.info.as_view(), house_ledger.info.as_view(), admin_ledger.info.as_view(), vault_program.info.as_view(),
        )?)
    }

    /// Takes a (reserve token, treasury token) pair per non-zero mint after the named accounts.
    #[instruction(discriminator = 18)]
    pub fn close_ledger<'a>(
        &self,
        admin: &Signer<'a>,
        treasury: &mut Account<'a>,
        ledger: &mut Account<'a>,
        reserve: &mut Account<'a>,
        permission: &mut Account<'a>,
        permission_program: &Account<'a>,
        vault_program: &Account<'a>,
        token_program: &Account<'a>,
        system_program: &Account<'a>,
        token_accounts: &Remaining<'a>,
        args: close_ledger::CloseLedger,
    ) -> Result<()> {
        Ok(args.process(
            admin.info.as_view(), treasury.info.as_view(), ledger.info.as_view(), reserve.info.as_view(), permission.info.as_view(),
            permission_program.info.as_view(), vault_program.info.as_view(), token_program.info.as_view(), system_program.info.as_view(),
            &token_accounts.iter().map(|account| *account.as_view()).collect::<Vec<_>>(),
        )?)
    }

    #[instruction(discriminator = 20)]
    pub fn authorize_treasury<'a>(
        &self,
        admin: &Signer<'a>,
        treasury: &mut Account<'a>,
        ledger: &mut Account<'a>,
        vault_program: &Account<'a>,
        args: authorize_treasury::AuthorizeTreasury,
    ) -> Result<()> {
        Ok(args.process(admin.info.as_view(), treasury.info.as_view(), ledger.info.as_view(), vault_program.info.as_view())?)
    }

    #[instruction(discriminator = 21)]
    pub fn read_jackpot<'a>(&self, jackpot: &Account<'a>, ledger: &Account<'a>) -> Result<()> {
        Ok(read_jackpot::ReadJackpot.process(jackpot.info.as_view(), ledger.info.as_view())?)
    }

    #[instruction(discriminator = 22)]
    pub fn set_privacy<'a>(
        &self,
        admin: &Signer<'a>,
        treasury: &mut Account<'a>,
        ledger: &mut Account<'a>,
        permission: &mut Account<'a>,
        permission_program: &Account<'a>,
        vault_program: &Account<'a>,
        system_program: &Account<'a>,
        args: set_privacy::SetPrivacy,
    ) -> Result<()> {
        Ok(args.process(
            admin.info.as_view(), treasury.info.as_view(), ledger.info.as_view(), permission.info.as_view(), permission_program.info.as_view(),
            vault_program.info.as_view(), system_program.info.as_view(),
        )?)
    }

    #[instruction(discriminator = 24)]
    pub fn request_purchase<'a>(
        &self,
        wallet: &Signer<'a>,
        user: &Account<'a>,
        config: &Account<'a>,
        house: &mut Account<'a>,
        receipt: &mut Account<'a>,
        ephemeral_vault: &mut Account<'a>,
        magic_program: &Account<'a>,
        vault_program: &Account<'a>,
        jackpot: &Account<'a>,
        house_ledger: &mut Account<'a>,
        magic_context: &mut Account<'a>,
        args: request_purchase::RequestPurchase,
    ) -> Result<()> {
        Ok(args.process(
            wallet.info.as_view(), user.info.as_view(), config.info.as_view(), house.info.as_view(), receipt.info.as_view(), ephemeral_vault.info.as_view(),
            magic_program.info.as_view(), vault_program.info.as_view(), jackpot.info.as_view(), house_ledger.info.as_view(),
            magic_context.info.as_view(),
        )?)
    }

    #[instruction(discriminator = 25)]
    pub fn request_collect<'a>(
        &self,
        user: &Account<'a>,
        config: &Account<'a>,
        house: &mut Account<'a>,
        card: &mut Account<'a>,
        receipt: &mut Account<'a>,
        ephemeral_vault: &mut Account<'a>,
        magic_program: &Account<'a>,
        vault_program: &Account<'a>,
        jackpot: &Account<'a>,
        jackpot_ledger: &mut Account<'a>,
        wallet: &Signer<'a>,
        house_ledger: &mut Account<'a>,
        magic_context: &mut Account<'a>,
    ) -> Result<()> {
        Ok(request_collect::RequestCollect.process(
            user.info.as_view(), config.info.as_view(), house.info.as_view(), card.info.as_view(), receipt.info.as_view(), ephemeral_vault.info.as_view(),
            magic_program.info.as_view(), vault_program.info.as_view(), jackpot.info.as_view(), jackpot_ledger.info.as_view(),
            wallet.info.as_view(), house_ledger.info.as_view(), magic_context.info.as_view(),
        )?)
    }

    #[instruction(discriminator = 26)]
    pub fn grow_config<'a>(
        &self,
        admin: &Signer<'a>,
        config: &mut Account<'a>,
        system_program: &Account<'a>,
        args: grow_config::GrowConfig,
    ) -> Result<()> {
        Ok(args.process(admin.info.as_view(), config.info.as_view(), system_program.info.as_view())?)
    }

    /// The vault's settle callback for a sale.
    #[instruction(discriminator = 27)]
    pub fn resolve_purchase<'a>(
        &self,
        receipt: &Account<'a>,
        vault_authority: &Account<'a>,
        config: &Account<'a>,
        house: &mut Account<'a>,
        card: &mut Account<'a>,
        ephemeral_vault: &mut Account<'a>,
        magic_program: &Account<'a>,
        analytics: &mut Account<'a>,
        args: resolve_purchase::ResolvePurchase,
    ) -> Result<()> {
        Ok(args.process(
            receipt.info.as_view(), vault_authority.info.as_view(), config.info.as_view(), house.info.as_view(), card.info.as_view(),
            ephemeral_vault.info.as_view(), magic_program.info.as_view(), analytics.info.as_view(),
        )?)
    }

    #[instruction(discriminator = 28)]
    pub fn request_reveal<'a>(
        &self,
        user: &Account<'a>,
        house: &mut Account<'a>,
        card: &mut Account<'a>,
        identity: &Account<'a>,
        oracle_queue: &mut Account<'a>,
        slot_hashes: &Account<'a>,
        system_program: &Account<'a>,
        vrf_program: &Account<'a>,
    ) -> Result<()> {
        Ok(request_reveal::RequestReveal.process(
            user.info.as_view(), house.info.as_view(), card.info.as_view(), identity.info.as_view(), oracle_queue.info.as_view(), slot_hashes.info.as_view(),
            system_program.info.as_view(), vrf_program.info.as_view(),
        )?)
    }

    /// The vault's settle callback for a payout.
    #[instruction(discriminator = 29)]
    pub fn resolve_collect<'a>(
        &self,
        receipt: &Account<'a>,
        vault_authority: &Account<'a>,
        house: &mut Account<'a>,
        card: &mut Account<'a>,
        ephemeral_vault: &mut Account<'a>,
        magic_program: &Account<'a>,
        analytics: &mut Account<'a>,
        args: resolve_collect::ResolveCollect,
    ) -> Result<()> {
        Ok(args.process(
            receipt.info.as_view(), vault_authority.info.as_view(), house.info.as_view(), card.info.as_view(), ephemeral_vault.info.as_view(),
            magic_program.info.as_view(), analytics.info.as_view(),
        )?)
    }

    #[instruction(discriminator = 30)]
    pub fn undelegate_treasury<'a>(
        &self,
        admin: &Signer<'a>,
        treasury: &mut Account<'a>,
        ledger: &mut Account<'a>,
        vault_program: &Account<'a>,
        magic_program: &Account<'a>,
        magic_context: &mut Account<'a>,
        fees_vault: &mut Account<'a>,
        args: undelegate_treasury::UndelegateTreasury,
    ) -> Result<()> {
        Ok(args.process(
            admin.info.as_view(), treasury.info.as_view(), ledger.info.as_view(), vault_program.info.as_view(), magic_program.info.as_view(),
            magic_context.info.as_view(), fees_vault.info.as_view(),
        )?)
    }
}

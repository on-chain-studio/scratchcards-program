use borsh::BorshDeserialize;
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, entrypoint::ProgramResult};

use crate::instructions::*;

pub trait ProcessInstruction {
    fn process(&self, program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult;
}

const UNDELEGATE_DISC: [u8; 8] = [196, 28, 41, 206, 48, 37, 51, 167];

macro_rules! instructions {
    ($($name:ident($ty:ty)),* $(,)?) => {
        #[derive(BorshDeserialize)]
        pub enum Instruction {
            $($name($ty),)*
        }

        impl ProcessInstruction for Instruction {
            fn process(&self, program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
                match self {
                    $(Self::$name(i) => i.process(program_id, accounts),)*
                }
            }
        }

        /// Each variant's borsh index, which is its position in the list above and therefore
        /// the discriminator a caller sends.
        pub mod ix {
            #![allow(non_upper_case_globals, dead_code)]
            instructions!(@idx 0u64; $($name),*);
        }
    };
    (@idx $i:expr; $head:ident $(, $rest:ident)*) => {
        pub const $head: u64 = $i;
        instructions!(@idx $i + 1; $($rest),*);
    };
    (@idx $i:expr;) => {};
}

// Position is the wire discriminator: dense, append-only, placeholders kept — renumbering would
// silently repoint old clients.
instructions! {
    Unknown(unknown::Unknown),
    Initialize(initialize::Initialize),
    Delegate(delegation::Delegate),
    Undelegate(delegation::Undelegate),
    RequestUndelegation(delegation::RequestUndelegation),
    Unused5(unknown::Unknown),
    Unused6(unknown::Unknown),
    CloseCard(close_card::CloseCard),
    Unused8(unknown::Unknown),
    SetCard(set_card::SetCard),
    Unused10(unknown::Unknown),
    Unused11(unknown::Unknown),
    CallbackReveal(callback_reveal::CallbackReveal),
    Unused13(unknown::Unknown),
    Unused14(unknown::Unknown),
    OpenLedger(open_ledger::OpenLedger),
    DelegateTreasury(delegate_treasury::DelegateTreasury),
    WithdrawHouse(withdraw_house::WithdrawHouse),
    CloseLedger(close_ledger::CloseLedger),
    Unused19(unknown::Unknown),
    AuthorizeTreasury(authorize_treasury::AuthorizeTreasury),
    ReadJackpot(read_jackpot::ReadJackpot),
    SetPrivacy(set_privacy::SetPrivacy),
    Unused23(unknown::Unknown),
    RequestPurchase(request_purchase::RequestPurchase),
    RequestCollect(request_collect::RequestCollect),
    GrowConfig(grow_config::GrowConfig),
    ResolvePurchase(resolve_purchase::ResolvePurchase),
    RequestReveal(request_reveal::RequestReveal),
    ResolveCollect(resolve_collect::ResolveCollect),
    UndelegateTreasury(undelegate_treasury::UndelegateTreasury),
}

pub fn dispatch(program_id: &Pubkey, accounts: &[AccountInfo], input: &[u8]) -> ProgramResult {
    if input.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let variant = if input[..8] == UNDELEGATE_DISC {
        ix::Undelegate
    } else {
        u64::from_le_bytes(input[..8].try_into().unwrap())
    };
    let index = u8::try_from(variant).map_err(|_| ProgramError::InvalidInstructionData)?;

    let mut buf = Vec::with_capacity(1 + input.len() - 8);
    buf.push(index);
    buf.extend_from_slice(&input[8..]);

    // `deserialize`, not `try_from_slice`: a settle callback carries args the handler reads
    // from the receipt instead, so trailing bytes are expected.
    Instruction::deserialize(&mut &buf[..])
        .map_err(|_| ProgramError::InvalidInstructionData)?
        .process(program_id, accounts)
}

use crate::chain::*;

#[derive(Debug)]
#[repr(u32)]
pub enum GameError {
    InvalidPDA         = 1,
    Unauthorized       = 2,
    AlreadyInitialized = 3,
    InvalidCard        = 4,
    WrongStatus        = 5,
    InsufficientFunds  = 6,
    InvalidMint        = 7,
    NotRevealed        = 8,
    NothingToCollect   = 9,
    NotPaid            = 10,
    ShelfFull          = 11,
}

impl From<GameError> for ProgramError {
    fn from(e: GameError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

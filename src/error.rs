//! This game's half of the shared `Custom(n)` space. `casino_core::CoreError` owns 1–3, 5–7 and
//! 9–11; 4 and 8 are left to each game to name, and 12 up are its own (none yet).

use casino_core::chain::*;

#[derive(Debug)]
#[repr(u32)]
pub enum GameError {
    /// No such card on the shelf, or a slot `SetCard` may not write yet.
    InvalidCard        = 4,
    /// The card's seed has not landed yet.
    NotRevealed        = 8,
}

impl From<GameError> for ProgramError {
    fn from(e: GameError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

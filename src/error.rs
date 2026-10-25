//! This game's half of the shared `Custom(n)` space. `casino_core::CoreError` owns 1–3, 5–7 and
//! 9–11; 4 and 8 are left to each game to name, and 12 up are its own.

use casino_core::chain::*;

#[derive(Debug)]
#[repr(u32)]
pub enum GameError {
    /// No such card on the shelf, or a slot `SetCard` may not write yet.
    InvalidCard        = 4,
    /// The card's seed has not landed yet.
    NotRevealed        = 8,
    /// `HasPlayed`'s "no": the wallet has never bought a card.
    NotPlayed          = 12,
    /// The card's player is owed referral earnings: claim them before the card is closed.
    StillOwed          = 13,
}

impl From<GameError> for ProgramError {
    fn from(e: GameError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

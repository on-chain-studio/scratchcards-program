//! What this program says about itself. Everything else it calls — the vault, MagicBlock, the
//! VRF — is a property of the chain and lives in `casino_core::ids`, and so do the ops and dev keys
//! that operate every game on the shelf.

use casino_core::chain::*;
use casino_core::ids::{DEV_KEY, OPS_KEY, OPS_ONLY};
use casino_core::Casino;

use crate::ScratchCards;

/// The house, then the progressive pot. The order is wire format — it is what every treasury
/// instruction's `which` byte means — so the jackpot is 1 for as long as the program lives.
pub const TREASURIES: [&[u8]; 2] = [b"house", b"jackpot"];

impl Casino for ScratchCards {
    const ID: Pubkey = crate::ID;
    /// The ops key alone signs admin instructions: it is also the upgrade authority and so is
    /// kept private anyway. The dev key is handled like a hot wallet — it may read the books
    /// (see `ANALYTICS_READERS`) but it must never move or reprice anything.
    const ADMINS: &'static [Pubkey] = &OPS_ONLY;
    const TREASURIES: &'static [&'static [u8]] = &TREASURIES;
}

/// Who may read the analytics counters on the TEE: the dev key (its token feeds the hosted
/// analytics watcher) and the ops key.
pub const ANALYTICS_READERS: [Pubkey; 2] = [DEV_KEY, OPS_KEY];

/// The fee share of every card that grows the progressive jackpot, in basis points.
pub const JACKPOT_SHARE_BP: u64 = 1000;

use solana_program::pubkey::Pubkey;

/// Every key allowed to sign admin instructions: the dev key, and the mainnet ops key.
pub const ADMIN_PUBKEYS: [Pubkey; 2] = [
    solana_program::pubkey!("691aFvKMnHXrMSgqk6G8izoCbVZTmkrRcu8xCeMKfPh1"),
    solana_program::pubkey!("2wpqngzMS3CUu6LMaL6M3ykgBGPoXRwP4Ps8TLhx5FZH"),
];

pub fn is_admin(key: &Pubkey) -> bool {
    ADMIN_PUBKEYS.contains(key)
}

pub const TREASURIES: [&[u8]; 2] = [b"house", b"jackpot"];

pub fn treasury_seed(which: u8) -> Result<&'static [u8], solana_program::program_error::ProgramError> {
    TREASURIES
        .get(which as usize)
        .copied()
        .ok_or(solana_program::program_error::ProgramError::InvalidInstructionData)
}

/// The vault program — holds every balance this game ever touches. The game itself holds
/// no token accounts: it owns a ledger per treasury and pays by `settle`.
pub const VAULT_PROGRAM: Pubkey = solana_program::pubkey!("VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV");

/// SPL Token program.
pub const TOKEN_PROGRAM: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// MagicBlock's access-control program — permissions gating who may read an account on the TEE.
pub const PERMISSION_PROGRAM: Pubkey = solana_program::pubkey!("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");

/// MagicBlock VRF program and its identity signer for callbacks.
pub const VRF_PROGRAM:          Pubkey = solana_program::pubkey!("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
pub const VRF_PROGRAM_IDENTITY: Pubkey = solana_program::pubkey!("9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw");

/// The fee share of every card that grows the progressive jackpot, in basis points.
pub const JACKPOT_SHARE_BP: u64 = 1000;

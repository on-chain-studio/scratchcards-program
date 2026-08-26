#[test]
fn layout_matches_the_deployed_account() {
    use scratch_cards::state::config::{Config, CARD_SIZE, INITIAL_CARDS};
    assert_eq!(Config::HEADER, 56, "header moved — every card offset shifts");
    assert_eq!(CARD_SIZE, 992, "card stride moved — every card offset shifts");
    assert_eq!(Config::size_for(INITIAL_CARDS), 7992, "shelf size moved");
    // The alignment invariant the casts depend on.
    assert_eq!(Config::HEADER % 8, 0);
    assert_eq!(CARD_SIZE % 8, 0);
}

#[test]
fn analytics_counters_sit_where_readers_expect() {
    use scratch_cards::state::analytics::{Analytics, PayoutRow, CARD_SLOTS, TOKEN_SLOTS};
    use std::mem::offset_of;
    // Off-chain readers decode this account by offset; a moved field reads as a plausible
    // wrong number, not an error.
    assert_eq!(Analytics::SIZE, 944);
    assert_eq!(offset_of!(Analytics, lamports_in), 16);
    assert_eq!(offset_of!(Analytics, cards_sold), 48);
    assert_eq!(offset_of!(Analytics, cards_collected), 48 + CARD_SLOTS * 8);
    assert_eq!(offset_of!(Analytics, payouts), 48 + 2 * CARD_SLOTS * 8);
    assert_eq!(size_of::<PayoutRow>(), 40);
    assert_eq!(Analytics::SIZE, 48 + 2 * CARD_SLOTS * 8 + TOKEN_SLOTS * 40);
}

#[test]
fn a_card_carries_its_terms() {
    use scratch_cards::state::card::Card;
    use scratch_cards::state::config::CARD_SIZE;
    // The client reads the snapshot at a fixed offset (ChainConfig.CARD_HEADER), so the
    // pre-terms part of the account must stay exactly this long.
    // The pre-terms part must stay exactly this long: the app reads the snapshot at this
    // offset, and a card sold before terms existed is exactly this size and must still load.
    assert_eq!(Card::SIZE, 96, "card header moved — the app decodes the snapshot by offset");
    assert_eq!(Card::WITH_TERMS, 96 + CARD_SIZE);
}

/// Position in the `instructions!` list *is* the wire discriminator, so inserting a variant
/// mid-list silently renumbers every one after it — for clients already shipped, and for the
/// callback discriminator the vault has stored in an open receipt.
#[test]
fn wire_numbers_are_pinned_to_list_positions() {
    use scratch_cards::instruction::ix;
    assert_eq!(ix::Initialize, 1);
    assert_eq!(ix::SetCard, 9);
    assert_eq!(ix::CallbackReveal, 12);
    assert_eq!(ix::OpenLedger, 15);
    assert_eq!(ix::DelegateTreasury, 16);
    assert_eq!(ix::WithdrawHouse, 17);
    assert_eq!(ix::CloseLedger, 18);
    assert_eq!(ix::ReadJackpot, 21);
    assert_eq!(ix::SetPrivacy, 22);
    assert_eq!(ix::RequestPurchase, 24);
    assert_eq!(ix::RequestCollect, 25);
    assert_eq!(ix::GrowConfig, 26);
    assert_eq!(ix::ResolvePurchase, 27);
    assert_eq!(ix::RequestReveal, 28);
    assert_eq!(ix::ResolveCollect, 29);
}

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

/// The little-endian u64 an instruction starts with. Moving one silently repoints every client
/// already shipped, and the callback discriminator the vault has stored in an open receipt.
#[test]
fn wire_numbers_are_pinned() {
    use scratch_cards::ScratchCardsInstruction as ix;
    assert_eq!(ix::NOOP, 0);
    assert_eq!(ix::INITIALIZE, 1);
    assert_eq!(ix::DELEGATE, 2);
    assert_eq!(ix::UNDELEGATE, 3);
    assert_eq!(ix::REQUEST_UNDELEGATION, 4);
    assert_eq!(ix::CLOSE_CARD, 7);
    assert_eq!(ix::SET_CARD, 9);
    assert_eq!(ix::CALLBACK_REVEAL, 12);
    assert_eq!(ix::OPEN_LEDGER, 15);
    assert_eq!(ix::DELEGATE_TREASURY, 16);
    assert_eq!(ix::WITHDRAW_HOUSE, 17);
    assert_eq!(ix::CLOSE_LEDGER, 18);
    assert_eq!(ix::AUTHORIZE_TREASURY, 20);
    assert_eq!(ix::READ_JACKPOT, 21);
    assert_eq!(ix::SET_PRIVACY, 22);
    assert_eq!(ix::REQUEST_PURCHASE, 24);
    assert_eq!(ix::REQUEST_COLLECT, 25);
    assert_eq!(ix::GROW_CONFIG, 26);
    assert_eq!(ix::RESOLVE_PURCHASE, 27);
    assert_eq!(ix::REQUEST_REVEAL, 28);
    assert_eq!(ix::RESOLVE_COLLECT, 29);
    assert_eq!(ix::UNDELEGATE_TREASURY, 30);
}

mod wire {
    use scratch_cards::{ScratchCards, ScratchCardsInstruction};

    fn input(discriminator: u64, arguments: &[u8]) -> Vec<u8> {
        [&discriminator.to_le_bytes()[..], arguments].concat()
    }

    #[test]
    fn retired_numbers_are_no_ops_and_past_the_list_is_nothing() {
        for retired in [0, 5, 6, 8, 10, 11, 13, 14, 19, 23] {
            assert!(
                matches!(
                    ScratchCards::instruction(&input(retired, &[])),
                    Ok(ScratchCardsInstruction::Noop(_))
                ),
                "{retired} is not the no-op"
            );
        }
        for past in [32, 255] {
            assert!(ScratchCards::instruction(&input(past, &[])).is_err(), "{past} was answered");
        }
        assert!(ScratchCards::instruction(&[24, 0, 0, 0]).is_err(), "a short tag was answered");
    }

    #[test]
    fn the_delegation_program_reaches_undelegate_by_its_own_tag() {
        // `sha256("global:process_undelegation")[..8]`, fixed by the delegation program.
        let tag = u64::from_le_bytes([196, 28, 41, 206, 48, 37, 51, 167]);
        let seeds = borsh::to_vec(&vec![b"jackpot".to_vec()]).unwrap();
        for discriminator in [3, tag] {
            let ScratchCardsInstruction::Undelegate(args) =
                ScratchCards::instruction(&input(discriminator, &seeds)).unwrap()
            else {
                panic!("{discriminator} did not reach undelegate");
            };
            assert_eq!(args.args.pda_seeds, vec![b"jackpot".to_vec()]);
        }
    }

    #[test]
    fn a_settle_callback_may_carry_bytes_past_its_arguments() {
        let human = [7u8; 32];
        let arguments = [&human[..], &3u64.to_le_bytes(), &[0xAA; 16]].concat();
        let ScratchCardsInstruction::ResolvePurchase(purchase) =
            ScratchCards::instruction(&input(27, &arguments)).unwrap()
        else {
            panic!("27 did not reach resolve_purchase");
        };
        assert_eq!(purchase.args.human.to_bytes(), human);
        assert_eq!(purchase.args.card_id, 3);
    }

    #[test]
    fn the_oracle_answer_is_read_as_randomness() {
        let ScratchCardsInstruction::CallbackReveal(reveal) =
            ScratchCards::instruction(&input(12, &[5u8; 32])).unwrap()
        else {
            panic!("12 did not reach callback_reveal");
        };
        assert_eq!(reveal.args.randomness, [5; 32]);
    }
}

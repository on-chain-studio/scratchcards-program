# Test fixtures

- `baseline.so` — the program as deployed on devnet: `GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC`,
  last deployed in slot 488036285, dumped with `solana program dump` and cut at the end of its ELF
  (the account is zero-padded past it). sha256
  `55cba497ddcb4d2f0db4ed6810e7326462c2c270016c891f1215c0594fae3ea0`. `tests/differential.rs`
  holds every build to it; replace it when a new build is deployed.

  Mainnet runs an older build. Against it the harness finds 280 differences, every one of them
  AUDIT.md item 13: the mainnet build still marks a card `Collected` (status 3) in
  `request_collect`, and so its `resolve_collect` refuses a card that is merely `Revealed`. That
  change is held for the next mainnet deploy, so the devnet build is the one to match.
- `cpi_recorder.so` — built from `cpi-recorder/`; stands in for every program the game calls and
  logs what it was asked.

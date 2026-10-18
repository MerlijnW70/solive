# Security

## Report a vulnerability

Report it privately at https://github.com/MerlijnW70/solive/security/advisories/new. This is the same contact the on-chain program publishes in its `security.txt`.

Do not open a public issue, pull request or discussion about a vulnerability.

Include:

- the affected part: the program (`programs/intent_engine`), `crates/intent-core`, `packages/core`, `packages/client`, `packages/cli`, `packages/solver` or `packages/multisig`
- the cluster and program address, if it concerns a deployed program
- steps or a test that reproduce it
- what an attacker gains

## What happens next

- We acknowledge your report within 7 days.
- We confirm the issue, fix it and publish a GitHub security advisory.
- The advisory credits you, unless you ask us not to.
- Keep the report private until the advisory is published.

## Scope

In scope: the code in this repository, and the program deployed from it at `GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU` on devnet.

The program has not had an external audit.

The [threat model](docs/maintainers/threat-model.md) lists each known attack per actor and asset, the test or proof that stops it, and what is still open. The [operations runbook](docs/maintainers/operations.md) names who holds the upgrade authority, the config admin and the guardian, and how they move to a multisig.

Out of scope: third-party services the tools call (RPC nodes, Jupiter, Jito, faucets), and attacks that need the victim's private key.

## Known and accepted behaviour

These are by design. Each is demonstrated by the named test in `tests/svm/tests/`.

- A token's issuer can freeze the vault or the receiver. That stops the paths that touch the frozen account, and nothing moves: `an_issuer_freezing_the_vault_blocks_every_path_but_moves_nothing`, `an_issuer_freezing_the_receiver_stops_fills_and_the_owner_still_cancels`.
- CPI Guard on the owner's token account blocks creates the owner signs directly. Signed and agent creates still work: `a_cpi_guard_on_the_owner_account_blocks_owner_signed_creates_but_not_delegated_draws`.
- The signed message does not name a relayer. Whoever submits it first collects the relayer fee the owner signed for: `whoever_submits_a_signed_intent_first_collects_its_relayer_fee`.
- An agent that spends the shared allowance first can leave a signed intent unrelayable. The owner loses nothing: `an_agent_spending_the_shared_allowance_first_leaves_a_signed_intent_unrelayable_but_costs_the_owner_nothing`.
- No admin setting can stop an owner getting their escrow back, and fee changes under an open intent cost the solver, never the owner: `no_admin_setting_can_stop_an_owner_from_getting_their_escrow_back`, `raising_fees_under_an_open_intent_costs_the_solver_and_never_the_owner`.
- Pauses stop creates and fills, never cancels or closes: `pause_blocks_create_but_never_cancel_or_close`.
- A fee whose payee cannot receive it is withheld instead of blocking the intent. A partner or agent fee returns to the owner, and a create fee is not charged: `a_payee_that_refuses_payment_cannot_block_the_fill_and_its_fee_returns_to_the_owner`, `creates_go_through_whatever_state_the_treasury_is_in`.
- A rent payer that later becomes a program forfeits its rent to whoever closes the intent: `a_cancelled_intent_closes_after_its_rent_payer_became_a_program`.
- An owner may name a receiver whose owner nobody can sign for, such as the engine's delegate address; output delivered there stays locked: `an_owner_may_name_a_receiver_nobody_can_sign_for`.
- An intent an agent created stays fillable after its mandate ends, until the intent expires: `an_agent_intent_stays_fillable_after_its_mandate_ends_until_it_expires`.
- Cancelling an agent's intent refunds its escrow but does not return its share of the mandate budget: `cancelling_an_agent_intent_does_not_return_its_share_of_the_mandate_budget`.
- An intent so small that its rounded-up fees exceed its amount cannot be filled; its owner can still cancel or expire it: `a_dust_intent_whose_fees_round_past_its_amount_cannot_fill_but_still_cancels`.

## Rewards

A valid report earns SOL on mainnet, paid once its advisory is published:

| Severity | Example | Reward |
|---|---|---|
| Critical | Anyone takes escrowed tokens or fees they are not owed, or releases an escrow without its judge | 10 SOL |
| High | Escrowed tokens are locked for good, or a non-admin changes the config, upgrade or guardian | 4 SOL |
| Medium | A tool signs or sends something its preview did not show, or a path is blocked for others at no cost to the attacker | 1 SOL |
| Low | Any other issue that needs a code fix to stop | 0.25 SOL |

The first report of an issue is paid. A report of something the threat model lists as open or partial, or of a behaviour listed above as accepted, is credited but not paid.

Test against a local LiteSVM setup or your own accounts on devnet, never other people's. These amounts hold while the program runs only on devnet, and rise before it runs on mainnet. Reporters are credited in the advisory.

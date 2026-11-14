![Bondline](docs/brand/bondline-banner.png)

# Bondline

A shop's AI support bot promises a refund; the customer collects it from a bond the shop locked on NEAR. Replies are signed inside a NEAR AI TEE, and a NEAR contract checks the signature, reads the promise and pays it out, capped by a limit the shop set.

Runs on NEAR testnet

![A capped promise claimed in tUSDC on testnet](docs/screenshots/live-v2-claimed.png)

## NEAR HACKATHON submission

- **Tracks:** AI Security & Defense (`security`) and Real-World Money (`realworld`). Why it fits each: [docs/JUDGES.md](docs/JUDGES.md#track-fit).
- **Demo video:** https://x.com/SameTether/status/2121714532779503682
- **Site:** https://smtdcs.github.io/Bondline/
- **Judge walkthrough:** [docs/JUDGES.md](docs/JUDGES.md)
- **New work only:** all code in this repository was written during NEAR HACKATHON, from the first commit on 2026-11-10 onward. There is no pre-hackathon code. The signature-check pattern follows [tee-receipts](https://github.com/tmdry4530/tee-receipts) (MIT); one of its real NEAR AI ECDSA receipts is used as a test vector, and no code was copied.

## Quick start

No keys, no Rust, no `.env`. Node 22.22.2+ (24 recommended).

```sh
npm ci
npm run verify:fixtures   # checks every recorded receipt offline
npm run demo:replay:v2    # open http://127.0.0.1:8787/?offline=1
```

What you should see:

- `npm run verify:fixtures` prints one `PASS` line per bundle and ends with:
  `ALL VERIFIED (11 real bundles + 3 tampered (correctly rejected) + 5 refused (self-made or wrong-buyer requests: no valid shop authorization) + 2 SIMULATED (fake key, not TEE evidence))`
- `npm run demo:replay:v2` serves a recorded testnet run and sends nothing to the chain. At http://127.0.0.1:8787/?offline=1 you click through the demo: the bot promises 20% on a $20 order (`PROMISE|refund|order=A123-…|bps=2000`), the page shows the receipt as BINDING with 4 tUSDC claimable, and Claim pays it. A misconfigured bot that promises 100% is paid only up to the 30% cap (6 tUSDC), and edited or repeated claims are refused (`ERR_NO_RECEIPT_FOR_BYTES`, `ERR_BAD_SIGNATURE`, `ERR_ALREADY_CLAIMED`).
- `npm run test:js` ends with `# fail 0` (275 tests).

## How it works

The bot ends a promise with a token line, e.g. `PROMISE|refund|order=A123-11|bps=2000`. NEAR AI signs `model:sha256(request):sha256(response)` inside the TEE. The shop's server registers the receipt, and the contract verifies it with `env::ed25519_verify` against a signer key registered with the sha256 of its attestation record. `claim` re-hashes the reply bytes, parses the token and pays `min(bps, max_bps) × order amount` from the bond, once per order.

The cap is reserved from the bond when the order is created, so the shop can't withdraw it before the order expires. Receipts can't be deleted. Bonds can be in NEAR or an allow-listed NEP-141 token.

```
shopper ── chat ──▶ shop server ── exact bytes ──▶ NEAR AI (TEE signs)
                        │
                        └── register_receipt ──▶ market contract ◀── claim ── shopper
```

Full diagram and request flow: [docs/JUDGES.md](docs/JUDGES.md#how-it-works).

## Contract versions

| Version | Account | Who registers the reply |
| --- | --- | --- |
| v3 | `claimable-promises.testnet` | the customer (`register_receipt_as_buyer`) or the shop |
| v2 | `v2.cbp-sm1110.testnet` | the shop; NEP-141 bonds, order expiry |
| v1 | `cbp-sm1110.testnet` | the shop; NEAR bonds only |

On v1 and v2 a shop can avoid a promise by not registering it. v3 closes that: the shop's server signs each request it sends to NEAR AI with a shop key stored on the order, and the contract accepts a customer-registered reply only if its request carries a valid signature for that order and buyer. Requests the customer sent directly, or signed for another order or buyer, are refused. v3 has no access keys and a separate owner. Design and trade-offs: [docs/V3.md](docs/V3.md).

## Numbers

- **573 tests**: 275 JS, 16 Rust on v1, 127 Rust on v2, 155 Rust on v3; all passed on 2026-11-13.
- **11 real NEAR AI receipts** verified offline; 3 deliberately edited copies are rejected.
- Recorded live runs: 91 transactions on v2, 17 on v3 (`npm run verify:live-run`, `npm run verify:live-run:v3`).

## Verify on chain

| Claim | Where to look |
| --- | --- |
| Signer key is registered with its attestation hash | `get_signers` on `cbp-sm1110.testnet`; compare with `shasum -a 256 fixtures/attestation/z-ai_glm-5.3-flash-ed25519-2026-11-10-renewed.json` |
| Signature checked on registration | [ANGY8bVs…Bjpv](https://testnet.nearblocks.io/txns/ANGY8bVshxV16ovVNG4gHpbmAnSymrF9SqM8DtqTBjpv) |
| Edited reply rejected (`ERR_BAD_SIGNATURE`) | [G8E1jxjv…2Az5](https://testnet.nearblocks.io/txns/G8E1jxjvBUtZEnHSH2NPgmnJs3D12CefGo4iRzm32Az5) |
| 100% promise paid at the 30% cap | [9RY21rAq…nShq](https://testnet.nearblocks.io/txns/9RY21rAq2jSF6VkMreSdUqxKNA556kubR2bghL36nShq) |
| v3: customer registers and claims | [HkHHHUWN…b5FX](https://testnet.nearblocks.io/txns/HkHHHUWNd31mPVGPPQzvV113f3bxLKXBDbwL1MwAb5FX), [7A52kwCH…JMx8](https://testnet.nearblocks.io/txns/7A52kwCHehf82f8NAxcQfVbAi78j8nYwneNGF9E9JMx8) |

`npm run verify -- <bundle.json>` runs the offline checks plus the on-chain ones for any bundle in `fixtures/live/`.

## Development

```sh
npm run test:js            # Node tests
npm run test:contract      # v1  (Rust 1.95)
npm run test:contract:v2
npm run test:contract:v3
npm run test:token
```

Running live needs your own testnet accounts and a NEAR AI Cloud key: see [docs/DEPLOY.md](docs/DEPLOY.md), then `npm run dev`.

`contract-v3/`, `contract-v2/` and `contract/` hold the market contracts (Rust, near-sdk 5.30.1); `token/` the mock tUSDC; `app/` the shop server, client libraries, `verify` and scripts; `web/` the demo app (plain ES modules); `site/` the Astro project site; `fixtures/` recorded receipts, attestation records and runs; `docs/` design notes.

## Limitations

- Testnet only; tUSDC has no value.
- v1 and v2 accounts each hold a full-access key, so the deployer could redeploy them. v3 has no keys.
- Attestation is verified off chain by `npm run attest`; only the record's hash is on chain.
- The shop sets each order's expiry, and a promise must be claimed before it.
- Claiming publishes the reply bytes on chain.
- On v3 the shop's server is still the only source of the exact reply bytes; a server that withholds them can't be forced to hand them over.
- v3 (customer-registered receipts) has no offline replay; verify it with `npm run verify:live-run:v3`, which re-reads the recorded v3 transactions from the testnet RPC.
- The current TEE signer expires 2026-11-30 10:45 UTC and must be renewed for new receipts.

Details: [docs/V3.md](docs/V3.md#trust-on-v3), [docs/DETAILS.md](docs/DETAILS.md).

## Docs

[DETAILS.md](docs/DETAILS.md) covers the verify tool, replay, deployment and recorded runs; [V3.md](docs/V3.md) the customer-registered receipts; [STABLECOIN.md](docs/STABLECOIN.md) the v2 design; [INTERFACES.md](docs/INTERFACES.md) the v1 interface; [DEPLOY.md](docs/DEPLOY.md) deploying your own copy; [PROMPT-TESTS.md](docs/PROMPT-TESTS.md) the bot prompt tests; and [JUDGES.md](docs/JUDGES.md) the judge walkthrough, demo script and trust boundaries.

## Credits

Built for NEAR HACKATHON (November 2026). The signature-check approach follows [tee-receipts](https://github.com/tmdry4530/tee-receipts) (MIT); one of its ECDSA receipts is a test vector.

Written with AI coding assistants (Claude) under my direction; every change was checked with the test suites and on testnet. The demo bot is NEAR AI Cloud `z-ai/glm-5.3-flash`.

## Libraries

near-sdk 5.30.1, near-contract-standards 5.30.1, hex 0.4.3 (Rust); near-api-js 7.4.0, @nearai/inference-sdk 0.3.0, express 5.3.0 (Node); Astro 5 (site); cargo-near 0.23.0, near-cli-rs 0.31.1.

## License

MIT

## Other project by the same builder

I am also submitting **Rolet NEAR** to NEAR HACKATHON, a separate and independent project: a turn-based revolver duel whose match rules, deck and leaderboard run in a NEAR smart contract. Repo: https://github.com/SmtDcs/rolet-near

# AgentPay

![MIT](https://img.shields.io/badge/license-MIT-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)
![Fastify](https://img.shields.io/badge/Fastify-5-black)
![Solana](https://img.shields.io/badge/Solana-settlement-9945FF)

Payment rails for AI agents. Give every agent a wallet, enforce spending limits, hold over-limit payments for human approval, and settle on-chain. Every state change is audited, every mutation is idempotent, every webhook is signed.

![AgentPay hero](docs/assets/hero-banner.webp)

## What it does

- **Agent wallets** - one wallet per agent, scoped to an API key, with a USD ledger balance plus a Solana address and an EVM address.
- **Spending limits** - per-transaction, daily, and weekly caps per wallet. Over-limit payments are automatically held in an approval queue instead of failing.
- **Human-in-the-loop approvals** - approve or reject held payments with reason codes. Funds are re-checked at decision time, so money that moved while pending cannot be double-spent. Held payments expire after 24 hours by default (`APPROVAL_TTL_MS`) instead of waiting forever.
- **Refunds** - refund a completed payment in full or in part. Refunds run backwards as their own payment linked to the original, cumulative refunds cannot exceed the original amount, and the recipient's balance is checked first.
- **Wallet freeze** - freeze a wallet to stop it sending (and stop its held payments being approved) while still letting it receive. Unfreeze restores normal operation.
- **Recipient allowlists** - a wallet with an allowlist can only pay wallets on it. Handy for pinning an agent to known counterparties. Refunds are never blocked by an allowlist, so money can always go back.
- **Batch payments** - submit up to 50 payments in one call. Each runs the same checks as a single payment, in order, and the response reports every item's outcome, so one bad item never blocks the rest.
- **Double-entry ledger** - every payment writes a debit and a credit in one transaction. Conservation is structural, not aspirational. Amounts are integer minor units with checked arithmetic.
- **On-chain settlement** - settle a completed ledger payment over Solana as an SPL transfer on a local validator (2-decimal mint, so 1 cent = 1 base unit). EVM settlement is recorded as an honest local record; no chain is attached in this build.
- **Audit log** - append-only. No update or delete path exists.
- **Webhooks** - HMAC-SHA256 signed deliveries with exponential-backoff retries. Subscriptions can be paused, resumed, and deleted. Deliveries that run out of retries can be requeued by hand once the receiver is back.
- **Statements, limit usage, metrics** - per-wallet statement with running balances (JSON, or CSV from `statement.csv` for spreadsheets), live spent/remaining against each cap, and an admin metrics summary (counts by status, completed volume, delivery health).
- **Auth and rate limiting** - bearer API keys with scopes (`read`, `wallets:write`, `payments:write`, `approvals:write`, `admin`), per-key token-bucket rate limiting. Keys can be rotated: the replacement is minted with the same scopes and the old key is revoked in the same call.
- **Dashboard** - React app for wallets, payments, the approval queue, webhooks, and the audit log.

## Quickstart

Requirements: Node 22+, a local `solana-test-validator` for the Solana leg of the demo.

```bash
# API
cd api && npm install && npm run build

# fresh DB, prints a master key once
DB_PATH=./agentpay.db PORT=8787 node dist/index.js

# Dashboard (dev)
cd dashboard && npm install && npm run dev
```

The full end-to-end demo (validator, mint, fund, pay, hold, approve, settle on Solana, verify) runs with:

```bash
./demo.sh
```

It prints `DEMO RESULT: ALL CHECKS PASSED` when every assertion holds.

## API sketch

```bash
KEY=<master key from first boot>

# agent key with scopes
curl -X POST localhost:8787/v1/api-keys -H "Authorization: Bearer $KEY" \
  -d '{"name":"ops-agent","scopes":["read","wallets:write","payments:write","approvals:write"]}'

# wallets
curl -X POST localhost:8787/v1/wallets -H "Authorization: Bearer $AGENT" \
  -d '{"agent_id":"ops-agent","name":"ops wallet","per_tx_cap":5000,"daily_cap":20000}'

# fund from treasury (dev helper)
curl -X POST localhost:8787/v1/wallets/<id>/fund -H "Authorization: Bearer $AGENT" \
  -d '{"amount":50000}'

# pay (idempotent). 202 + pending_approval when over a limit.
curl -X POST localhost:8787/v1/payments -H "Authorization: Bearer $AGENT" \
  -H 'Idempotency-Key: abc123' \
  -d '{"from_wallet":"<a>","to_wallet":"<b>","amount":3000,"memo":"api credits"}'

# approve / reject
curl -X POST localhost:8787/v1/approvals/<payment_id>/approve -H "Authorization: Bearer $AGENT" \
  -d '{"reason_code":"manager_ok"}'

# refund (full, or pass {"amount": <minor>} for a partial one)
curl -X POST localhost:8787/v1/payments/<payment_id>/refund -H "Authorization: Bearer $AGENT" -d '{}'

# freeze a wallet that is misbehaving, unfreeze when sorted
curl -X POST localhost:8787/v1/wallets/<id>/freeze -H "Authorization: Bearer $AGENT"

# pin a wallet to known counterparties (empty list clears the restriction)
curl -X PUT localhost:8787/v1/wallets/<id>/allowlist -H "Authorization: Bearer $AGENT" \
  -d '{"recipients":["<wallet id>","<wallet id>"]}'

# batch: up to 50 payments, each reported individually
curl -X POST localhost:8787/v1/payments/batch -H "Authorization: Bearer $AGENT" \
  -d '{"payments":[{"from_wallet":"<a>","to_wallet":"<b>","amount":1200,"idempotency_key":"b-1"}]}'

# rotate a key (admin): returns the replacement once, old key stops working
curl -X POST localhost:8787/v1/api-keys/<key id>/rotate -H "Authorization: Bearer $KEY"

# statement as CSV
curl localhost:8787/v1/wallets/<id>/statement.csv -H "Authorization: Bearer $AGENT"

# settle a completed payment (needs SETTLEMENT_MINT / SETTLEMENT_PAYER env, see demo.sh)
curl -X POST localhost:8787/v1/payments/<payment_id>/settle -H "Authorization: Bearer $AGENT" \
  -d '{"rail":"solana"}'
```

Amounts are integer cents. `GET /v1/audit` searches the audit log (filter by action, actor, entity, and time, with paging); `GET /v1/payments` filters by wallet, status, and date range and pages with `limit`/`offset` alongside a `total`. `POST /v1/webhooks` subscribes a URL to events (`payment.completed`, `payment.pending_approval`, `payment.rejected`, `payment.failed`, `payment.expired`, `payment.refunded`, `payment.settled`, `wallet.created`, `wallet.frozen`, `wallet.unfrozen`, `wallet.allowlist_updated`).

## Repo layout

```
api/            Fastify API (TypeScript, SQLite via node:sqlite)
  src/          wallets, payments, approvals, settlement, webhooks, auth, ledger
  test/         vitest suite (62 tests)
  scripts/      solana demo setup
dashboard/      React + Vite dashboard
scripts/        UDP shim for sandboxed validators (see demo.sh)
docs/           ARCHITECTURE.md, hero art
demo.sh         end-to-end demo against a local validator
```

## Honest limits

- Wallet Solana keys are held server-side for the demo settlement worker. Production would use an HSM or MPC signer, never a database column.
- EVM settlement writes a local record only; nothing is broadcast to a chain.
- Rate limiting is in-memory per process; fine for a single instance, not for a fleet.
- The demo pins the Solana 2.1.x validator because the 4.x validator needs `io_uring`, which some sandboxes block. On a normal machine any recent validator works.

## License

MIT

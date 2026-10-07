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
- **Human-in-the-loop approvals** - approve or reject held payments with reason codes. Funds are re-checked at decision time, so money that moved while pending cannot be double-spent.
- **Double-entry ledger** - every payment writes a debit and a credit in one transaction. Conservation is structural, not aspirational. Amounts are integer minor units with checked arithmetic.
- **On-chain settlement** - settle a completed ledger payment over Solana as an SPL transfer on a local validator (2-decimal mint, so 1 cent = 1 base unit). EVM settlement is recorded as an honest local record; no chain is attached in this build.
- **Audit log** - append-only. No update or delete path exists.
- **Webhooks** - HMAC-SHA256 signed deliveries with exponential-backoff retries.
- **Auth and rate limiting** - bearer API keys with scopes (`read`, `wallets:write`, `payments:write`, `approvals:write`, `admin`), per-key token-bucket rate limiting.
- **Dashboard** - React app for wallets, payments, the approval queue, and the audit log.

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

# settle a completed payment (needs SETTLEMENT_MINT / SETTLEMENT_PAYER env, see demo.sh)
curl -X POST localhost:8787/v1/payments/<payment_id>/settle -H "Authorization: Bearer $AGENT" \
  -d '{"rail":"solana"}'
```

Amounts are integer cents. `GET /v1/audit` streams the audit log; `POST /v1/webhooks` subscribes a URL to events (`payment.completed`, `payment.pending_approval`, `payment.rejected`, `payment.failed`, `payment.settled`, `wallet.created`).

## Repo layout

```
api/            Fastify API (TypeScript, SQLite via node:sqlite)
  src/          wallets, payments, approvals, settlement, webhooks, auth, ledger
  test/         vitest suite (21 tests)
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

# AgentPay Architecture

## Request flow

```
agent -> API key (scopes) -> rate limiter -> route handler
                                              |
                    +-------------------------+-------------------------+
                    |                         |                         |
              wallets/payments           approvals                 webhooks/audit
                    |                         |
              limit checks              re-check funds at
              (per-tx/daily/weekly)     decision time
                    |
        +-----------+-----------+
        |                       |
   within limits           over limit
        |                       |
   ledger tx:               payment row
   debit + credit           status=pending_approval
   status=completed
```

## Ledger

SQLite (`node:sqlite`, WAL mode). Money moves only through `ledger_entries`:

- Each completed payment inserts exactly two rows in one `BEGIN IMMEDIATE` transaction: a debit on the sender, a credit on the recipient, equal amounts.
- Balance is derived: `SUM(credit) - SUM(debit)`. Conservation is structural; a test asserts the global sum is always zero.
- Amounts are integer minor units (cents). `money.ts` throws on overflow, underflow, and non-integers.
- The `treasury` wallet is the mint: funding bypasses the balance check but still writes both legs.

## Limit enforcement

Checked in order on every payment: per-transaction cap, then rolling daily spend, then rolling weekly spend. Breach holds the payment as `pending_approval` with a `reason_code` (`per_tx_cap`, `daily_cap`, `weekly_cap`) instead of rejecting it, so a human can still allow legitimate spend.

Approval re-validates the balance inside the decision transaction. If funds moved while the payment was pending, the payment is marked `failed`, never partially applied.

## Idempotency

`Idempotency-Key` header on `POST /v1/payments` and `POST /v1/wallets/:id/fund`. A repeated key returns the original payment without re-executing. The key has a UNIQUE constraint, so concurrent duplicates cannot double-spend.

## Settlement

- **Solana**: `POST /v1/payments/:id/settle {"rail":"solana"}` performs a real SPL `transferChecked` on the configured RPC from the sender wallet's key to the recipient's associated token account, signed by the wallet key plus a fee payer. The settlement mint has 2 decimals, so 1 ledger cent maps to 1 base unit. Duplicate settlement of the same payment is rejected. Requires `SOLANA_RPC_URL`, `SETTLEMENT_MINT`, `SETTLEMENT_PAYER` (base64 secret).
- **EVM**: writes a settlement row with status `recorded` and a note that nothing was broadcast. Deliberately honest; wiring a real node is future work.

## Webhooks

Events are fanned out to active subscriptions matching the event name or `*`. Each delivery POSTs the JSON body with `X-AgentPay-Signature: sha256=<hmac>`. Failures retry with exponential backoff (2s, 4s, 8s, 16s); after 5 attempts the delivery parks as `failed`. A 2-second timer drains due deliveries; tests drive `drainWebhooks` directly.

## Auth

API keys are `agp_` prefixed random tokens, stored as SHA-256 hashes. Scopes: `read`, `wallets:write`, `payments:write`, `approvals:write`, `admin` (implies all). First boot prints a master key once.

## What is intentionally not here

Distributed locking, multi-instance rate limiting, and HSM-backed custody. Those are the next three services, not this one.

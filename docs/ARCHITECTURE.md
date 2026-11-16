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

A held payment carries an `expires_at` (24h by default). A background sweep, plus lazy checks on the approval routes, moves stale holds to `expired`; they can no longer be approved. Freezing the sender wallet also blocks approval until it is unfrozen.

## Recipient allowlists

A wallet may carry a recipient allowlist (`wallet_allowlists`). While the list is non-empty, `POST /v1/payments` rejects any payment to a wallet that is not on it with a 403, checked after the freeze check and before idempotency. An empty list means no restriction. Setting the list replaces it wholesale and validates that every recipient exists. Refunds bypass the check by construction, since they never pass through the payment route, so an allowlist cannot trap money that needs to go back.

## Batch payments

`POST /v1/payments/batch` takes up to 50 items and runs each through the same `createPayment` path as a single payment, in submission order, so later items see the balances left by earlier ones. Items are independent: a validation error or a held payment is reported in that item's slot and the rest still run. Each item may carry its own `idempotency_key`. The response carries a per-item result list plus a summary count of completed, held, and failed items.

## Refunds

A refund is a completed payment in the opposite direction with `refund_of` pointing at the original. Refunds skip the spending caps (returning money is not spending) but run inside a transaction that checks the original recipient's balance, and the sum of refunds against a payment can never exceed its amount. A refund cannot itself be refunded.

## Idempotency

`Idempotency-Key` header on `POST /v1/payments` and `POST /v1/wallets/:id/fund`. A repeated key returns the original payment without re-executing. The key has a UNIQUE constraint, so concurrent duplicates cannot double-spend.

## Settlement

- **Solana**: `POST /v1/payments/:id/settle {"rail":"solana"}` performs a real SPL `transferChecked` on the configured RPC from the sender wallet's key to the recipient's associated token account, signed by the wallet key plus a fee payer. The settlement mint has 2 decimals, so 1 ledger cent maps to 1 base unit. Duplicate settlement of the same payment is rejected. Requires `SOLANA_RPC_URL`, `SETTLEMENT_MINT`, `SETTLEMENT_PAYER` (base64 secret).
- **EVM**: writes a settlement row with status `recorded` and a note that nothing was broadcast. Deliberately honest; wiring a real node is future work.

## Webhooks

Events are fanned out to active subscriptions matching the event name or `*`. Pausing a subscription holds its queued deliveries and skips new events until it resumes; deleting one removes its queue with it. Each delivery POSTs the JSON body with `X-AgentPay-Signature: sha256=<hmac>`. Failures retry with exponential backoff (2s, 4s, 8s, 16s); after 5 attempts the delivery parks as `failed`. A parked delivery can be requeued by an admin (`POST /v1/webhook-deliveries/:id/retry`), which resets its attempt count so it gets a fresh set of tries. The delivery list filters by endpoint and status. A 2-second timer drains due deliveries; tests drive `drainWebhooks` directly.

## Auth

API keys are `agp_` prefixed random tokens, stored as SHA-256 hashes. Scopes: `read`, `wallets:write`, `payments:write`, `approvals:write`, `admin` (implies all). First boot prints a master key once. Keys track `last_used_at` (throttled to one write a minute) and can be listed by an admin without exposing hashes. An admin can rotate a key: a replacement is minted with the same name and scopes and the old key is revoked in the same request, so there is no window where both or neither work. Rotating a revoked key is refused.

Statements read straight from the ledger: the JSON statement and the CSV export (`GET /v1/wallets/:id/statement.csv`, oldest first, amounts in minor units) share one entry builder, so the running balance in both always lands on the wallet balance. The payments list and the audit log both take filter parameters (wallet, status, dates for payments; action, actor, entity, dates for audit) and page with `limit`/`offset` next to a `total` count.

## What is intentionally not here

Distributed locking, multi-instance rate limiting, and HSM-backed custody. Those are the next three services, not this one.

import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { now } from "./db.js";
import { requireScope } from "./auth.js";
import { audit } from "./audit.js";
import { emit } from "./webhooks.js";

// On-chain settlement. The ledger is the source of truth for balances;
// settlement moves real tokens on a rail to match a completed ledger payment.
//
// Solana: SPL transfer on the configured RPC (a local validator in demo).
// The settlement mint uses 2 decimals, so 1 ledger cent == 1 mint base unit.
// EVM: records a settlement intent locally. There is no chain broadcast in
// this build; the record is honest about that (see README).

function solanaConfig() {
  const rpc = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
  const mint = process.env.SETTLEMENT_MINT;
  const payerSecret = process.env.SETTLEMENT_PAYER;
  if (!mint || !payerSecret) throw new Error("solana settlement not configured (SETTLEMENT_MINT / SETTLEMENT_PAYER)");
  return { rpc, mint: new PublicKey(mint), payer: Keypair.fromSecretKey(Buffer.from(payerSecret, "base64")) };
}

function walletSecret(db: DatabaseSync, walletId: string): Keypair {
  const row = db.prepare("SELECT secret FROM wallet_secrets WHERE wallet_id = ?").get(walletId) as
    | { secret: string }
    | undefined;
  if (!row) throw new Error("no signing key for wallet");
  return Keypair.fromSecretKey(Buffer.from(row.secret, "base64"));
}

async function settleSolana(db: DatabaseSync, paymentId: string, actor: string) {
  const { rpc, mint, payer } = solanaConfig();
  const p = db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId) as Record<string, unknown> | undefined;
  if (!p) throw Object.assign(new Error("payment not found"), { statusCode: 404 });
  if (p.status !== "completed") throw Object.assign(new Error("only completed payments can settle"), { statusCode: 409 });
  const dup = db.prepare("SELECT id FROM settlements WHERE payment_id = ? AND rail = 'solana' AND status = 'confirmed'").get(paymentId);
  if (dup) throw Object.assign(new Error("payment already settled on solana"), { statusCode: 409 });

  const fromW = db.prepare("SELECT solana_pubkey FROM wallets WHERE id = ?").get(p.from_wallet as string) as { solana_pubkey: string };
  const toW = db.prepare("SELECT solana_pubkey FROM wallets WHERE id = ?").get(p.to_wallet as string) as { solana_pubkey: string };
  const sender = walletSecret(db, p.from_wallet as string);
  if (sender.publicKey.toBase58() !== fromW.solana_pubkey) throw new Error("wallet key mismatch");

  const conn = new Connection(rpc, "confirmed");
  const senderAta = await getAssociatedTokenAddress(mint, sender.publicKey);
  const recipient = new PublicKey(toW.solana_pubkey);
  const recipientAta = await getAssociatedTokenAddress(mint, recipient);
  const { Transaction } = await import("@solana/web3.js");
  const tx = new Transaction();
  try {
    await getAccount(conn, recipientAta);
  } catch {
    tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, recipientAta, recipient, mint));
  }
  tx.add(
    createTransferCheckedInstruction(senderAta, mint, recipientAta, sender.publicKey, BigInt(p.amount as number), 2, [], TOKEN_PROGRAM_ID)
  );
  tx.feePayer = payer.publicKey;
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(payer, sender);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");

  const id = "stl_" + randomUUID().slice(0, 12);
  db.prepare("INSERT INTO settlements (id, payment_id, rail, status, tx_hash, details, created_at) VALUES (?, ?, 'solana', 'confirmed', ?, ?, ?)").run(
    id,
    paymentId,
    sig,
    JSON.stringify({ mint: mint.toBase58(), amount_base_units: p.amount }),
    now()
  );
  audit(db, actor, "payment.settled", "settlement", id, { rail: "solana", tx: sig });
  emit(db, "payment.settled", { payment_id: paymentId, rail: "solana", tx_hash: sig });
  return { id, rail: "solana", status: "confirmed", tx_hash: sig };
}

function settleEvm(db: DatabaseSync, paymentId: string, actor: string) {
  const p = db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId) as Record<string, unknown> | undefined;
  if (!p) throw Object.assign(new Error("payment not found"), { statusCode: 404 });
  if (p.status !== "completed") throw Object.assign(new Error("only completed payments can settle"), { statusCode: 409 });
  const toW = db.prepare("SELECT evm_address FROM wallets WHERE id = ?").get(p.to_wallet as string) as { evm_address: string };
  // Honest local record: no EVM node is attached in this build, so nothing
  // is broadcast. The record captures intent and is marked accordingly.
  const id = "stl_" + randomUUID().slice(0, 12);
  db.prepare("INSERT INTO settlements (id, payment_id, rail, status, details, created_at) VALUES (?, ?, 'evm', 'recorded', ?, ?)").run(
    id,
    paymentId,
    JSON.stringify({
      to: toW.evm_address,
      amount_minor: p.amount,
      note: "local settlement record; no chain broadcast in this build",
    }),
    now()
  );
  audit(db, actor, "payment.settled", "settlement", id, { rail: "evm", mode: "recorded" });
  emit(db, "payment.settled", { payment_id: paymentId, rail: "evm", status: "recorded" });
  return { id, rail: "evm", status: "recorded", tx_hash: null };
}

export function registerSettlementRoutes(app: FastifyInstance, db: DatabaseSync) {
  app.post("/v1/payments/:id/settle", { preHandler: requireScope("payments:write") }, async (req, reply) => {
    const body = (req.body ?? {}) as { rail?: string };
    if (body.rail !== "solana" && body.rail !== "evm") {
      reply.code(400).send({ error: "rail must be 'solana' or 'evm'" });
      return;
    }
    try {
      const res = body.rail === "solana"
        ? await settleSolana(db, (req.params as { id: string }).id, req.apiKey.name)
        : settleEvm(db, (req.params as { id: string }).id, req.apiKey.name);
      reply.code(201).send(res);
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.get("/v1/settlements", { preHandler: requireScope("read") }, async (req) => {
    const q = req.query as { payment_id?: string };
    const rows = q.payment_id
      ? db.prepare("SELECT * FROM settlements WHERE payment_id = ? ORDER BY created_at DESC").all(q.payment_id)
      : db.prepare("SELECT * FROM settlements ORDER BY created_at DESC LIMIT 100").all();
    return { settlements: rows };
  });
}

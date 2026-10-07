// One-time Solana setup for the AgentPay demo.
// Creates a 2-decimal SPL mint (1 ledger cent == 1 base unit), funds each
// given wallet address with tokens, and writes a fee-payer keypair for the
// API's settlement worker. Uses the local validator's faucet keypair, so no
// airdrop RPC is needed.
//
// Env: SOLANA_RPC_URL, FAUCET_KEYPAIR (path), WALLET_ADDRESSES (json array),
//      PAYER_OUT (path for the fee payer keypair json), FUND_AMOUNT (base units)
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, transfer } from "@solana/spl-token";
import { readFileSync, writeFileSync } from "node:fs";

const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const ADDRESSES = JSON.parse(process.env.WALLET_ADDRESSES ?? "[]");
const FUND = Number(process.env.FUND_AMOUNT ?? 1_000_000);

const conn = new Connection(RPC, "confirmed");
const faucet = Keypair.fromSecretKey(Buffer.from(JSON.parse(readFileSync(process.env.FAUCET_KEYPAIR, "utf8"))));

// dedicated fee payer for the API settlement worker
const payer = Keypair.generate();
{
  const { SystemProgram, Transaction } = await import("@solana/web3.js");
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: payer.publicKey, lamports: 5_000_000_000 })
  );
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = faucet.publicKey;
  tx.sign(faucet);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
}
writeFileSync(process.env.PAYER_OUT, JSON.stringify(Array.from(payer.secretKey)));

const mint = await createMint(conn, faucet, faucet.publicKey, null, 2);
for (const addr of ADDRESSES) {
  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, new PublicKey(addr));
  await mintTo(conn, faucet, mint, ata.address, faucet, FUND);
}
console.log(`MINT=${mint.toBase58()}`);
console.log(`PAYER=${payer.publicKey.toBase58()}`);

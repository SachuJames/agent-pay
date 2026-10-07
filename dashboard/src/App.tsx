import { useEffect, useState } from "react";
import { api, setKey } from "./api";

const css = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #0b0f14; color: #e6edf3; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
  .logo { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
  .logo span { color: #22d3ee; }
  nav { display: flex; gap: 8px; margin-bottom: 24px; }
  nav button { background: #161d27; color: #9fb0c3; border: 1px solid #26303d; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 14px; }
  nav button.active { background: #0e7490; color: #fff; border-color: #0e7490; }
  .card { background: #111823; border: 1px solid #212b3a; border-radius: 12px; padding: 18px; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1e2836; }
  th { color: #8b98ab; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .completed { background: #0d3b2e; color: #34d399; }
  .pending_approval { background: #3d2f0d; color: #fbbf24; }
  .rejected, .failed { background: #3d1512; color: #f87171; }
  input, select { background: #0b0f14; border: 1px solid #26303d; color: #e6edf3; padding: 8px 10px; border-radius: 8px; font-size: 14px; }
  button.primary { background: #0e7490; color: #fff; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; }
  button.ghost { background: transparent; color: #9fb0c3; border: 1px solid #26303d; padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; margin-right: 6px; }
  button.danger { background: transparent; color: #f87171; border: 1px solid #5b2320; padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  .err { background: #3d1512; color: #fca5a5; padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
  .keybar { display: flex; gap: 8px; align-items: center; }
  .keybar input { width: 340px; }
  h2 { margin: 0 0 14px 0; font-size: 18px; }
  .muted { color: #8b98ab; font-size: 13px; }
`;

interface Wallet {
  id: string; name: string; agent_id: string; balance: string;
  limits: { per_tx_cap: number; daily_cap: number; weekly_cap: number };
  solana_address: string; evm_address: string;
}
interface Payment {
  id: string; from_wallet: string; to_wallet: string; amount: string;
  memo: string; status: string; reason_code: string | null; created_at: number;
}
interface AuditRow { id: number; actor: string; action: string; entity: string; entity_id: string; created_at: number; details: string }

function usePoll<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const load = async () => {
    try { setData(await fn()); setErr(""); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, deps);
  return { data, err, reload: load };
}

function KeyGate({ children }: { children: React.ReactNode }) {
  const [k, setK] = useState(() => localStorage.getItem("agentpay_key") ?? "");
  const [val, setVal] = useState(k);
  if (!k) {
    return (
      <div className="wrap">
        <style>{css}</style>
        <div className="card" style={{ maxWidth: 480, margin: "80px auto" }}>
          <div className="logo" style={{ marginBottom: 12 }}>Agent<span>Pay</span></div>
          <p className="muted">Enter an API key to continue.</p>
          <div className="row">
            <input type="password" placeholder="agp_..." value={val} onChange={(e) => setVal(e.target.value)} style={{ flex: 1 }} />
            <button className="primary" onClick={() => { setKey(val); setK(val); }}>Connect</button>
          </div>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

function Wallets() {
  const { data, err, reload } = usePoll(async () => (await api.wallets()) as { wallets: Wallet[] });
  const [form, setForm] = useState({ agent_id: "", name: "" });
  const create = async () => {
    await api.createWallet({ agent_id: form.agent_id, name: form.name });
    setForm({ agent_id: "", name: "" });
    reload();
  };
  return (
    <div>
      <div className="card">
        <h2>New wallet</h2>
        <div className="row">
          <input placeholder="agent id" value={form.agent_id} onChange={(e) => setForm({ ...form, agent_id: e.target.value })} />
          <input placeholder="wallet name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <button className="primary" onClick={create}>Create</button>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="grid">
        {(data?.wallets ?? []).map((w) => (
          <div className="card" key={w.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>{w.name}</strong>
              <span className="mono muted">{w.id}</span>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, margin: "8px 0" }}>${w.balance}</div>
            <div className="muted">agent: {w.agent_id}</div>
            <div className="muted mono" style={{ marginTop: 6 }}>sol: {w.solana_address?.slice(0, 12)}...</div>
            <div className="muted">limits: tx ${(+w.limits.per_tx_cap / 100).toFixed(0)} / day ${(+w.limits.daily_cap / 100).toFixed(0)} / wk ${(+w.limits.weekly_cap / 100).toFixed(0)}</div>
            <div className="row" style={{ marginTop: 10, marginBottom: 0 }}>
              <button className="ghost" onClick={async () => { await api.fund(w.id, 100000); reload(); }}>Fund $1,000</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Payments() {
  const { data, err, reload } = usePoll(async () => (await api.payments()) as { payments: Payment[] });
  const { data: wallets } = usePoll(async () => (await api.wallets()) as { wallets: Wallet[] });
  const [form, setForm] = useState({ from: "", to: "", amount: "", memo: "" });
  const pay = async () => {
    await api.pay(
      { from_wallet: form.from, to_wallet: form.to, amount: Math.round(parseFloat(form.amount) * 100), memo: form.memo },
      `dash-${Date.now()}`
    );
    setForm({ from: "", to: "", amount: "", memo: "" });
    reload();
  };
  const settle = async (id: string, rail: string) => { await api.settle(id, rail); reload(); };
  const opts = (wallets?.wallets ?? []).map((w) => <option key={w.id} value={w.id}>{w.name} (${w.id})</option>);
  return (
    <div>
      <div className="card">
        <h2>New payment</h2>
        <div className="row">
          <select value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })}><option value="">from...</option>{opts}</select>
          <select value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })}><option value="">to...</option>{opts}</select>
          <input placeholder="amount USD" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} style={{ width: 130 }} />
          <input placeholder="memo" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
          <button className="primary" onClick={pay}>Send</button>
        </div>
        <div className="muted">Over-limit payments are held for approval automatically.</div>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="card">
        <table>
          <thead><tr><th>ID</th><th>From</th><th>To</th><th>Amount</th><th>Status</th><th>Memo</th><th></th></tr></thead>
          <tbody>
            {(data?.payments ?? []).map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.id}</td>
                <td className="mono">{p.from_wallet}</td>
                <td className="mono">{p.to_wallet}</td>
                <td>${p.amount}</td>
                <td><span className={`pill ${p.status}`}>{p.status}{p.reason_code ? ` (${p.reason_code})` : ""}</span></td>
                <td>{p.memo}</td>
                <td>
                  {p.status === "completed" && (
                    <>
                      <button className="ghost" onClick={() => settle(p.id, "solana")}>Settle SOL</button>
                      <button className="ghost" onClick={() => settle(p.id, "evm")}>Settle EVM</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Approvals() {
  const { data, err, reload } = usePoll(async () => (await api.pending()) as { pending: Payment[] });
  return (
    <div className="card">
      <h2>Approval queue</h2>
      {err && <div className="err">{err}</div>}
      {(data?.pending ?? []).length === 0 && <div className="muted">Queue is empty.</div>}
      <table>
        <tbody>
          {(data?.pending ?? []).map((p) => (
            <tr key={p.id}>
              <td className="mono">{p.id}</td>
              <td className="mono">{p.from_wallet} -&gt; {p.to_wallet}</td>
              <td>${p.amount}</td>
              <td><span className="pill pending_approval">{p.reason_code}</span></td>
              <td>
                <button className="primary" style={{ marginRight: 6 }} onClick={async () => { await api.approve(p.id); reload(); }}>Approve</button>
                <button className="danger" onClick={async () => { await api.reject(p.id); reload(); }}>Reject</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Audit() {
  const { data, err } = usePoll(async () => (await api.audit()) as { audit: AuditRow[] });
  return (
    <div className="card">
      <h2>Audit log</h2>
      {err && <div className="err">{err}</div>}
      <table>
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
        <tbody>
          {(data?.audit ?? []).map((a) => (
            <tr key={a.id}>
              <td className="mono">{new Date(a.created_at).toLocaleTimeString()}</td>
              <td>{a.actor}</td>
              <td className="mono">{a.action}</td>
              <td className="mono">{a.entity}:{a.entity_id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("wallets");
  return (
    <KeyGate>
      <style>{css}</style>
      <div className="wrap">
        <header>
          <div className="logo">Agent<span>Pay</span></div>
          <div className="keybar">
            <button className="ghost" onClick={() => { localStorage.removeItem("agentpay_key"); location.reload(); }}>Disconnect</button>
          </div>
        </header>
        <nav>
          {(["wallets", "payments", "approvals", "audit"] as const).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
        {tab === "wallets" && <Wallets />}
        {tab === "payments" && <Payments />}
        {tab === "approvals" && <Approvals />}
        {tab === "audit" && <Audit />}
      </div>
    </KeyGate>
  );
}

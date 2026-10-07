const BASE = "";

function key(): string {
  return localStorage.getItem("agentpay_key") ?? "";
}

export function setKey(k: string) {
  localStorage.setItem("agentpay_key", k);
}

async function req(method: string, path: string, body?: unknown, idem?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${key()}`, "content-type": "application/json" };
  if (idem) headers["idempotency-key"] = idem;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `http ${res.status}`);
  return data;
}

export const api = {
  wallets: () => req("GET", "/v1/wallets?limit=100"),
  wallet: (id: string) => req("GET", `/v1/wallets/${id}`),
  createWallet: (b: unknown) => req("POST", "/v1/wallets", b),
  fund: (id: string, amount: number) => req("POST", `/v1/wallets/${id}/fund`, { amount }),
  payments: (status?: string) => req("GET", `/v1/payments?limit=100${status ? `&status=${status}` : ""}`),
  pay: (b: unknown, idem: string) => req("POST", "/v1/payments", b, idem),
  pending: () => req("GET", "/v1/approvals/pending?limit=100"),
  approve: (id: string) => req("POST", `/v1/approvals/${id}/approve`, { reason_code: "dashboard_approval" }),
  reject: (id: string) => req("POST", `/v1/approvals/${id}/reject`, { reason_code: "dashboard_rejection" }),
  settle: (id: string, rail: string) => req("POST", `/v1/payments/${id}/settle`, { rail }),
  audit: () => req("GET", "/v1/audit?limit=100"),
};

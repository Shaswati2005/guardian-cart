import type {
  Agent,
  Alert,
  AgentTraceStep,
  ApprovalRequest,
  ChatMessage,
  DecisionReceipt,
  Policy,
  Proposal,
  ScamCheck,
  Transaction
} from './types';

export interface AppStatus {
  paypalConnected: boolean;
  mode: 'AWAITING_CREDENTIALS' | 'AWAITING_MANDATE' | 'MANDATE_ACTIVE';
  paypalEndpoint: string;
  mandate: { payerEmail?: string; createdAt: string } | null;
  ai: { configured: boolean; model: string };
  productSearch: 'CHANNEL3' | 'CURATED';
  error: string | null;
}

export interface DashboardData {
  status: AppStatus;
  agents: Agent[];
  approvals: ApprovalRequest[];
  alerts: Alert[];
  transactions: Transaction[];
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: Record<string, unknown>) {
    super(message);
  }
}

export interface ChatResult {
  reply: string;
  proposal?: Proposal;
  scamCheck: ScamCheck;
  blocked: boolean;
  trace: AgentTraceStep[];
}

export interface AcceptResult {
  transaction: Transaction;
  approvalRequest?: ApprovalRequest;
  decisionReceipt: DecisionReceipt;
}

export interface CompiledPolicy {
  rules: string[];
  current: Policy;
  proposed: Policy;
  summary: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  // Persona cookie missing (server restarted with a new key) or switched to the other persona in
  // another tab: App re-creates the session this page needs
  if (res.status === 401 || (res.status === 403 && data.roleMismatch)) window.dispatchEvent(new Event('guardian:session-expired'));
  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  }
  return data as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export type Role = 'elder' | 'caregiver';

export const api = {
  startSession: (role: Role) => post<{ role: Role }>('/session', { role }),
  sessionInfo: () => request<{ roles: Role[] }>('/session'),
  dashboard: () => request<DashboardData>('/dashboard'),
  agents: () => request<Agent[]>('/agents'),
  setAgentStatus: (id: string, status: Agent['status']) =>
    request<Agent>(`/agents/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),

  chatHistory: (agentId: string) => request<{ messages: ChatMessage[]; proposals: Proposal[] }>(`/agents/${agentId}/chat`),
  acceptProposal: (id: string) => post<AcceptResult>(`/proposals/${id}/accept`),
  declineProposal: (id: string) => post<{ proposal: Proposal }>(`/proposals/${id}/decline`),

  compilePolicy: (agentId: string, rules: string[]) => post<CompiledPolicy>(`/agents/${agentId}/policy/compile`, { rules }),
  savePolicy: (agentId: string, rules: string[], policy: Policy) =>
    request<Agent>(`/agents/${agentId}/policy`, { method: 'PUT', body: JSON.stringify({ rules, policy }) }),

  transactions: () => request<Transaction[]>('/transactions'),
  approvals: () => request<ApprovalRequest[]>('/approvals'),
  approve: (id: string) => post<{ transaction: Transaction }>(`/approvals/${id}/approve`),
  decline: (id: string) => post<{ transaction: Transaction }>(`/approvals/${id}/reject`),
  refund: (txId: string) => post<{ transaction: Transaction }>(`/transactions/${txId}/refund`),

  alerts: () => request<Alert[]>('/alerts'),
  markAlertRead: (id: string) => post<Alert>(`/alerts/${id}/read`),

  paypalOrder: (orderId: string) => request<unknown>(`/paypal/orders/${encodeURIComponent(orderId)}`),
  startVault: () => post<{ approveUrl: string }>('/paypal/vault/setup'),
  reset: () => post<{ voidFailures: number }>('/reset')
};

/** Streams the agent's tool steps (search, policy check, propose) while it works. */
export async function chatStream(agentId: string, message: string, onStep: (step: AgentTraceStep) => void): Promise<ChatResult> {
  const res = await fetch(`/api/agents/${agentId}/chat-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || (res.status === 403 && data.roleMismatch)) window.dispatchEvent(new Event('guardian:session-expired'));
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const raw of events) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const event = JSON.parse(line.slice(5));
      if (event.type === 'STEP') onStep(event.step);
      if (event.type === 'COMPLETE') return event as ChatResult;
      if (event.type === 'ERROR') throw new Error(event.error);
    }
  }
  throw new Error('The connection closed before the helper finished');
}

/** Only http(s) links from store data are rendered as links. */
export function safeHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export const money = (n: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);

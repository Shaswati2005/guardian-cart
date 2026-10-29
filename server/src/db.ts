import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Agent, Transaction, ApprovalRequest, PaymentMandate, Proposal, Alert, ChatMessage } from './types.js';
import { sanitizePolicy } from './policy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// DATA_DIR lets a host point the store at a persistent disk (e.g. a Render disk mount)
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CHAT_MESSAGES = 60;
const SETTLED: Transaction['status'][] = ['AUTO_EXECUTED', 'APPROVED_BY_HUMAN'];

interface Schema {
  agents: Agent[];
  transactions: Transaction[];
  approvals: ApprovalRequest[];
  proposals: Proposal[];
  alerts: Alert[];
  chats: Record<string, ChatMessage[]>;
  mandate?: PaymentMandate;
  revokedVaultIds?: string[]; // deleted on PayPal's side; never fall back to them via PAYPAL_VAULT_ID
}

// Seed: Margaret and the rules her daughter Sarah wrote (demo personas). The structured policy is
// what those rules compile to, pre-baked so the demo boots without an LLM call.
export const getDefaultAgents = (): Agent[] => {
  const policy = sanitizePolicy({
    weeklyBudget: 60,
    perItemMax: 150,
    approvalAbove: 40,
    allowedCategories: ['HEALTH', 'GROCERY', 'HOUSEHOLD', 'PERSONAL_CARE'],
    approvalCategories: [],
    blockedCategories: ['GIFT_CARDS', 'FINANCIAL'],
    trustedMerchants: ['walgreens.com', 'cvs.com', 'walmart.com', 'target.com', 'amazon.com'],
    newMerchantNeedsApproval: true,
    unenforcedRules: []
  });
  return [
    {
      id: 'agent-margaret',
      name: 'Margaret',
      role: 'Mom · age 78 · lives alone in Columbus',
      avatar: '👵',
      totalSpent: 0,
      reservedAmount: 0,
      currency: 'USD',
      status: 'ACTIVE',
      semanticRules: [
        'Up to $60 a week in total',
        'Health, groceries, household and personal care things are fine',
        'Ask me before anything over $40, and never anything over $150',
        'Never buy gift cards, crypto or send money to anyone',
        "Ask me before buying from a store we haven't used before"
      ],
      policy,
      caregiverName: 'Sarah',
      createdAt: new Date().toISOString()
    }
  ];
};

function emptySchema(mandate?: PaymentMandate): Schema {
  return { agents: getDefaultAgents(), transactions: [], approvals: [], proposals: [], alerts: [], chats: {}, mandate };
}

class Database {
  private data: Schema;

  constructor() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (fs.existsSync(DB_FILE)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
        const agentsValid = Array.isArray(parsed.agents) && parsed.agents.length > 0 && parsed.agents.every((a: Agent) => a.policy);
        this.data = agentsValid
          ? {
              agents: parsed.agents,
              transactions: parsed.transactions || [],
              approvals: parsed.approvals || [],
              proposals: parsed.proposals || [],
              alerts: parsed.alerts || [],
              chats: parsed.chats || {},
              mandate: parsed.mandate,
              revokedVaultIds: parsed.revokedVaultIds
            }
          : emptySchema(parsed.mandate); // pre-Guardian Cart data: start fresh, keep the PayPal mandate
      } catch (err) {
        console.error('Error reading db.json, initializing defaults:', err);
        this.data = emptySchema();
      }
    } else {
      this.data = emptySchema();
    }
    this.persist();
  }

  private persist() {
    const tmpFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmpFile, DB_FILE);
  }

  // SPEND WINDOWS (derived from transactions, so refunds and voids are reflected automatically)
  getWeeklySpend(agentId: string): { spent: number; reserved: number } {
    const since = Date.now() - WEEK_MS;
    let spent = 0;
    let reserved = 0;
    for (const t of this.data.transactions) {
      if (t.agentId !== agentId || new Date(t.createdAt).getTime() < since) continue;
      if (SETTLED.includes(t.status)) spent += t.amount;
      if (t.status === 'PENDING_APPROVAL') reserved += t.amount;
    }
    return { spent: +spent.toFixed(2), reserved: +reserved.toFixed(2) };
  }

  getKnownMerchants(agentId: string): string[] {
    return [
      ...new Set(
        this.data.transactions
          .filter(t => t.agentId === agentId && (SETTLED.includes(t.status) || t.status === 'REFUNDED'))
          .map(t => t.merchantName)
      )
    ];
  }

  private enrichAgent(agent: Agent): Agent {
    const { spent, reserved } = this.getWeeklySpend(agent.id);
    return { ...agent, totalSpent: spent, reservedAmount: reserved };
  }

  // AGENTS
  getAgents(): Agent[] {
    return this.data.agents.map(a => this.enrichAgent(a));
  }

  getAgent(id: string): Agent | undefined {
    const agent = this.data.agents.find(a => a.id === id);
    return agent ? this.enrichAgent(agent) : undefined;
  }

  saveAgent(agent: Agent): Agent {
    const idx = this.data.agents.findIndex(a => a.id === agent.id);
    if (idx >= 0) {
      this.data.agents[idx] = agent;
    } else {
      this.data.agents.push(agent);
    }
    this.persist();
    return this.enrichAgent(agent);
  }

  updateAgentStatus(id: string, status: Agent['status']): Agent | undefined {
    const agent = this.data.agents.find(a => a.id === id);
    if (agent) {
      agent.status = status;
      this.persist();
      return this.enrichAgent(agent);
    }
    return undefined;
  }

  // TRANSACTIONS
  getTransactions(): Transaction[] {
    return [...this.data.transactions].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  getTransaction(id: string): Transaction | undefined {
    return this.data.transactions.find(t => t.id === id);
  }

  findTransactionByPayPalId(resourceId: string): Transaction | undefined {
    return this.data.transactions.find(
      t =>
        t.paypalOrderId === resourceId ||
        t.paypalCaptureId === resourceId ||
        t.paypalAuthorizationId === resourceId ||
        t.paypalRefundId === resourceId
    );
  }

  saveTransaction(tx: Transaction): Transaction {
    const idx = this.data.transactions.findIndex(t => t.id === tx.id);
    if (idx >= 0) {
      this.data.transactions[idx] = tx;
    } else {
      this.data.transactions.unshift(tx);
    }
    this.persist();
    return tx;
  }

  // APPROVALS
  getApprovals(): ApprovalRequest[] {
    return this.data.approvals.filter(a => a.status === 'PENDING');
  }

  getApproval(id: string): ApprovalRequest | undefined {
    return this.data.approvals.find(a => a.id === id);
  }

  saveApproval(req: ApprovalRequest): ApprovalRequest {
    const idx = this.data.approvals.findIndex(a => a.id === req.id);
    if (idx >= 0) {
      this.data.approvals[idx] = req;
    } else {
      this.data.approvals.unshift(req);
    }
    this.persist();
    return req;
  }

  // PROPOSALS
  getProposal(id: string): Proposal | undefined {
    return this.data.proposals.find(p => p.id === id);
  }

  saveProposal(proposal: Proposal): Proposal {
    const idx = this.data.proposals.findIndex(p => p.id === proposal.id);
    if (idx >= 0) {
      this.data.proposals[idx] = proposal;
    } else {
      this.data.proposals.unshift(proposal);
    }
    this.persist();
    return proposal;
  }

  // ALERTS
  getAlerts(agentId?: string): Alert[] {
    return this.data.alerts.filter(a => !agentId || a.agentId === agentId);
  }

  saveAlert(alert: Alert): Alert {
    const idx = this.data.alerts.findIndex(a => a.id === alert.id);
    if (idx >= 0) {
      this.data.alerts[idx] = alert;
    } else {
      this.data.alerts.unshift(alert);
    }
    this.persist();
    return alert;
  }

  // CHAT HISTORY
  getChat(agentId: string): ChatMessage[] {
    return this.data.chats[agentId] || [];
  }

  appendChat(agentId: string, message: ChatMessage) {
    this.data.chats[agentId] = [...this.getChat(agentId), message].slice(-MAX_CHAT_MESSAGES);
    this.persist();
  }

  // PAYMENT MANDATE (vaulted PayPal token)
  // Falls back to PAYPAL_VAULT_ID so a host with an ephemeral filesystem keeps its mandate across restarts
  getMandate(): PaymentMandate | undefined {
    if (this.data.mandate) return this.data.mandate;
    const vaultId = (process.env.PAYPAL_VAULT_ID || '').trim();
    if (!vaultId || this.data.revokedVaultIds?.includes(vaultId)) return undefined;
    return { paymentTokenId: vaultId, createdAt: new Date(0).toISOString() };
  }

  saveMandate(mandate: PaymentMandate | undefined) {
    this.data.mandate = mandate;
    this.persist();
  }

  revokeMandate(paymentTokenId: string) {
    this.data.mandate = undefined;
    this.data.revokedVaultIds = [...new Set([...(this.data.revokedVaultIds || []), paymentTokenId])];
    this.persist();
  }

  // RESET DEMO DATA: clears purchases, chats and alerts. Keeps the PayPal mandate (so judges don't
  // re-link PayPal) and the caregiver's rules and pause state (a reset must never loosen them).
  // Callers void open PayPal holds first (agent.ts resetDemo).
  resetDemoData() {
    const defaults = getDefaultAgents();
    const agents = this.data.agents.map(a => ({ ...(defaults.find(d => d.id === a.id) || a), policy: a.policy, semanticRules: a.semanticRules, status: a.status }));
    this.data = { ...emptySchema(this.data.mandate), agents, revokedVaultIds: this.data.revokedVaultIds };
    this.persist();
    return this.data;
  }
}

export const db = new Database();

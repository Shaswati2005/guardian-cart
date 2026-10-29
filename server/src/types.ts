// Categories the caregiver's policy can allow, hold or block. Products are mapped
// to these deterministically (see products.ts) so the LLM can't relabel an item
// to slip it past a rule.
export const POLICY_CATEGORIES = [
  'HEALTH',
  'GROCERY',
  'HOUSEHOLD',
  'PERSONAL_CARE',
  'CLOTHING',
  'ELECTRONICS',
  'HOBBIES',
  'GIFT_CARDS',
  'FINANCIAL',
  'OTHER'
] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

// Structured spending policy compiled from the caregiver's plain-English rules.
// Enforced only by policy.ts; the shopping agent can read it but never change it.
export interface Policy {
  weeklyBudget: number;
  perItemMax: number; // hard block above this price
  approvalAbove: number; // caregiver must OK anything above this price
  allowedCategories: PolicyCategory[]; // empty = any category not blocked
  approvalCategories: PolicyCategory[];
  blockedCategories: PolicyCategory[];
  minRating?: number;
  trustedMerchants: string[]; // merchant domains, e.g. "walgreens.com"
  newMerchantNeedsApproval: boolean;
  unenforcedRules: string[]; // rules the compiler could not express; shown to the caregiver, never silently "passed"
}

// One person being helped (e.g. Margaret) and the policy her caregiver set.
export interface Agent {
  id: string;
  name: string;
  role: string;
  avatar: string;
  totalSpent: number; // spent in the last 7 days (derived, not stored)
  reservedAmount?: number; // on hold in the last 7 days (derived, not stored)
  currency: string;
  status: 'ACTIVE' | 'PAUSED' | 'FROZEN';
  semanticRules: string[]; // the caregiver's own words
  policy: Policy;
  caregiverName: string;
  createdAt: string;
}

export interface CandidateProduct {
  id: string;
  title: string;
  brand?: string;
  merchant: string; // merchant domain
  category: PolicyCategory;
  sourceCategory?: string; // Channel3 category path, for transparency
  price: number;
  originalPrice: number;
  discountPercent: number;
  currency: string;
  rating?: number;
  reviewCount?: number;
  inStock: boolean;
  imageUrl: string;
  itemUrl: string;
  keyFeatures: string[];
  source: 'CHANNEL3' | 'CURATED';
}

export interface RuleCheckResult {
  rule: string;
  passed: boolean;
  outcome: 'PASS' | 'HOLD' | 'BLOCK';
  explanation: string;
}

export type PolicyVerdict = 'APPROVE' | 'HOLD' | 'BLOCK';

export interface ScamCheck {
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  signals: string[];
  explanation: string;
  engine: 'GEMINI_AI' | 'RULES_ONLY';
}

// One step of the shopping agent's tool use, kept for the receipt and the demo
export interface AgentTraceStep {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  at: string;
}

export interface DecisionReceipt {
  goal: string;
  reasoningEngine: 'GEMINI_AI';
  executionLatencyMs?: number;
  selectedProduct: CandidateProduct;
  rejectedCandidates: Array<{
    id?: string;
    title: string;
    merchant: string;
    price: number;
    rating?: number;
    imageUrl?: string;
    rejectionReason: string;
  }>;
  ruleChecks: RuleCheckResult[];
  policyVerdict: PolicyVerdict;
  riskScore: number; // 0 (safest) to 100 (highest risk)
  reasoningSummary: string;
  requiresHumanApproval: boolean;
  escalationReason?: string;
  scamCheck?: ScamCheck;
  agentTrace: AgentTraceStep[];
  timestamp: string;
}

export interface Transaction {
  id: string;
  agentId: string;
  agentName: string;
  proposalId?: string;
  paypalOrderId?: string;
  paypalCaptureId?: string;
  paypalAuthorizationId?: string;
  paypalRefundId?: string;
  // EXPIRED: the PayPal hold lapsed before anyone decided. FAILED: PayPal denied or reversed the capture.
  status: 'AUTO_EXECUTED' | 'PENDING_APPROVAL' | 'APPROVED_BY_HUMAN' | 'REJECTED' | 'REFUNDED' | 'BLOCKED' | 'EXPIRED' | 'FAILED';
  captureStatus?: string; // PayPal capture status (COMPLETED, PENDING, ...); refunds need COMPLETED
  authorizationExpiresAt?: string; // when the PayPal hold lapses
  merchantName: string;
  itemName: string;
  amount: number;
  originalAmount?: number;
  savingsAmount?: number;
  executionLatencyMs?: number;
  currency: string;
  riskScore: number;
  decisionReceipt: DecisionReceipt;
  approvalRequestId?: string;
  refundedAt?: string;
  // Verified PayPal webhook events that touched this transaction
  paypalEvents?: { id: string; type: string; resourceId: string; receivedAt: string }[];
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  transactionId: string;
  agentId: string;
  agentName: string;
  itemName: string;
  amount: number;
  currency: string;
  reason: string;
  paypalOrderId?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  requestedAt: string;
  resolvedAt?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  proposalId?: string;
  kind?: 'scam_warning'; // styled as a safety warning on Margaret's page
  createdAt: string;
}

// Something the agent suggested; nothing is paid until the person says yes AND policy allows it
export interface Proposal {
  id: string;
  agentId: string;
  goal: string;
  product: CandidateProduct; // price locked at proposal time
  alternatives: CandidateProduct[];
  reasonForUser: string;
  policyPreview: { verdict: PolicyVerdict; checks: RuleCheckResult[] };
  scamCheck?: ScamCheck;
  agentTrace: AgentTraceStep[];
  status: 'PROPOSED' | 'ACCEPTED' | 'DECLINED';
  // Set just before PayPal is called, so a retry after a crash repeats the same request
  paymentIntent?: 'CAPTURE' | 'AUTHORIZE';
  transactionId?: string;
  createdAt: string;
}

export interface Alert {
  id: string;
  agentId: string;
  kind: 'SCAM_BLOCKED' | 'SCAM_WARNING' | 'POLICY_BLOCKED' | 'APPROVAL_NEEDED';
  title: string;
  message: string;
  signals: string[];
  createdAt: string;
  readAt?: string;
}

// The caregiver's one-time PayPal approval: a vaulted payment token the agent
// charges against (merchant-initiated) without a buyer redirect per purchase.
export interface PaymentMandate {
  paymentTokenId: string;
  customerId?: string;
  payerEmail?: string;
  createdAt: string;
}

import { v4 as uuidv4 } from 'uuid';

// Sandbox only. The hackathon requires the PayPal sandbox, and we never want a
// misconfigured key to silently move real money.
const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

interface PayPalOAuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export class PayPalApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public issue?: string,
    public debugId?: string,
    public body?: unknown
  ) {
    super(message);
    this.name = 'PayPalApiError';
  }
}

let cachedToken: { token: string; expiresAt: number; credHash: string } | null = null;
let cachedAuthError: { message: string; expiresAt: number; credHash: string } | null = null;

/** Called at startup so a production URL stops the server instead of failing on the first payment. */
export function assertSandboxConfig() {
  const configuredBaseUrl = (process.env.PAYPAL_API_BASE_URL || SANDBOX_BASE_URL).trim().replace(/\/$/, '');
  if (configuredBaseUrl !== SANDBOX_BASE_URL) {
    throw new Error(`PAYPAL_API_BASE_URL must be ${SANDBOX_BASE_URL} (sandbox only).`);
  }
}

// PayPal ids are short upper-case alphanumerics; anything else never reaches a URL path
const PAYPAL_ID = /^[A-Z0-9-]{6,40}$/;

export function isPayPalId(id: unknown): id is string {
  return typeof id === 'string' && PAYPAL_ID.test(id);
}

function idPath(id: string): string {
  if (!isPayPalId(id)) throw new Error('Invalid PayPal id');
  return encodeURIComponent(id);
}

// The hold is already closed on PayPal's side, so the app should stop waiting on it
const CAPTURED_AUTHORIZATION_ISSUES = ['AUTHORIZATION_ALREADY_CAPTURED', 'PREVIOUSLY_CAPTURED'];
const CLOSED_AUTHORIZATION_ISSUES = ['AUTHORIZATION_VOIDED', 'AUTHORIZATION_EXPIRED', 'PREVIOUSLY_VOIDED', ...CAPTURED_AUTHORIZATION_ISSUES];

export function isClosedAuthorizationError(err: unknown): boolean {
  return err instanceof PayPalApiError && CLOSED_AUTHORIZATION_ISSUES.includes(err.issue || '');
}

/** The hold was already captured (e.g. from the PayPal dashboard): the money has moved. */
export function isCapturedAuthorizationError(err: unknown): boolean {
  return err instanceof PayPalApiError && CAPTURED_AUTHORIZATION_ISSUES.includes(err.issue || '');
}

function getCredentials() {
  const clientId = (process.env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
  assertSandboxConfig();
  const credHash = `${clientId.slice(0, 12)}:${clientSecret.slice(0, 12)}`;
  return { clientId, clientSecret, credHash };
}

export function getPayPalBaseUrl(): string {
  return SANDBOX_BASE_URL;
}

export async function getPayPalAccessToken(): Promise<string> {
  const { clientId, clientSecret, credHash } = getCredentials();

  if (!clientId || !clientSecret || clientId === clientSecret) {
    throw new Error('PayPal sandbox credentials missing: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (server/.env locally, or the hosting environment)');
  }

  if (cachedToken && cachedToken.credHash === credHash && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  // Cache failures briefly so dashboard polling does not hammer PayPal
  if (cachedAuthError && cachedAuthError.credHash === credHash && Date.now() < cachedAuthError.expiresAt) {
    throw new Error(cachedAuthError.message);
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`${SANDBOX_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    const message = `PayPal sandbox OAuth failed (${response.status}): ${(await response.text()).slice(0, 300)}`;
    cachedAuthError = { message, expiresAt: Date.now() + 60_000, credHash };
    throw new Error(message);
  }

  const data = (await response.json()) as PayPalOAuthResponse;
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000, credHash };
  cachedAuthError = null;
  return data.access_token;
}

async function paypalRequest<T = any>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  requestId?: string
): Promise<T> {
  const token = await getPayPalAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
  // PayPal-Request-Id makes POSTs idempotent, so a retried request never double-charges
  if (method === 'POST') headers['PayPal-Request-Id'] = requestId || uuidv4();

  const response = await fetch(`${SANDBOX_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const issue = data.details?.[0]?.issue || data.name;
    const description = data.details?.[0]?.description || data.message || response.statusText;
    throw new PayPalApiError(
      `PayPal ${method} ${path} failed (${response.status} ${issue || ''}): ${description}${data.debug_id ? ` [debug_id ${data.debug_id}]` : ''}`,
      response.status,
      issue,
      data.debug_id,
      data
    );
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Vault: the caregiver approves a PayPal billing agreement once ("the mandate").
// Later purchases are merchant-initiated against the saved payment token, with
// no buyer redirect, which is what lets the agent pay without faking captures.
// ---------------------------------------------------------------------------

export async function createSetupToken(params: {
  returnUrl: string;
  cancelUrl: string;
  description: string;
}): Promise<{ setupTokenId: string; approveUrl: string }> {
  const data = await paypalRequest('POST', '/v3/vault/setup-tokens', {
    payment_source: {
      paypal: {
        description: params.description.slice(0, 127),
        usage_pattern: 'IMMEDIATE',
        usage_type: 'MERCHANT',
        customer_type: 'CONSUMER',
        permit_multiple_payment_tokens: false,
        experience_context: {
          brand_name: 'Guardian Cart',
          shipping_preference: 'NO_SHIPPING',
          return_url: params.returnUrl,
          cancel_url: params.cancelUrl
        }
      }
    }
  });

  const approveUrl = data.links?.find((l: any) => l.rel === 'approve')?.href;
  if (!approveUrl) {
    throw new Error('PayPal setup token response did not include an approve link');
  }
  return { setupTokenId: data.id, approveUrl };
}

export async function createPaymentToken(setupTokenId: string): Promise<{
  paymentTokenId: string;
  customerId?: string;
  payerEmail?: string;
}> {
  const data = await paypalRequest(
    'POST',
    '/v3/vault/payment-tokens',
    { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } },
    `gc-ptoken-${setupTokenId}`
  );
  return {
    paymentTokenId: data.id,
    customerId: data.customer?.id,
    payerEmail: data.payment_source?.paypal?.email_address
  };
}

// ---------------------------------------------------------------------------
// Orders against the vaulted token
// ---------------------------------------------------------------------------

export interface VaultedOrderResult {
  orderId: string;
  status: string;
  captureId?: string;
  captureStatus?: string;
  authorizationId?: string;
  authorizationExpiresAt?: string;
  raw: any;
}

/**
 * CAPTURE → money moves immediately (in-policy purchase).
 * AUTHORIZE → funds are held; the caregiver later captures or voids the authorization.
 */
export async function createVaultedOrder(params: {
  vaultId: string;
  intent: 'CAPTURE' | 'AUTHORIZE';
  amount: number;
  currency: string;
  description: string;
  referenceId: string;
  // Stable per purchase (the proposal id), so a retry after a crash returns the first order instead of paying again
  idempotencyKey?: string;
}): Promise<VaultedOrderResult> {
  const data = await paypalRequest(
    'POST',
    '/v2/checkout/orders',
    {
      intent: params.intent,
      purchase_units: [
        {
          reference_id: params.referenceId,
          description: params.description.slice(0, 127),
          amount: { currency_code: params.currency || 'USD', value: params.amount.toFixed(2) }
        }
      ],
      payment_source: { paypal: { vault_id: params.vaultId } }
    },
    params.idempotencyKey ? `gc-order-${params.idempotencyKey}` : `gc-order-${params.referenceId}-${params.intent}`
  );

  const payments = data.purchase_units?.[0]?.payments;
  const capture = payments?.captures?.[0];
  const authorization = payments?.authorizations?.[0];

  // A DECLINED/FAILED capture is returned (not thrown) so the caller records the failed payment;
  // retrying the same request would only replay the same declined order
  if (params.intent === 'CAPTURE' && !capture?.status) {
    throw new Error(`PayPal order ${data.id} did not capture (order ${data.status}, capture ${capture?.status ?? 'missing'})`);
  }
  // PENDING means PayPal is reviewing the hold; it still exists and must be tracked so it can be voided
  if (params.intent === 'AUTHORIZE' && authorization?.status !== 'CREATED' && authorization?.status !== 'PENDING') {
    throw new Error(`PayPal order ${data.id} did not authorize (order ${data.status}, authorization ${authorization?.status ?? 'missing'})`);
  }

  return {
    orderId: data.id,
    status: data.status,
    captureId: capture?.id,
    captureStatus: capture?.status,
    authorizationId: authorization?.id,
    authorizationExpiresAt: authorization?.expiration_time,
    raw: data
  };
}

export async function captureAuthorization(authorizationId: string): Promise<{ captureId: string; status: string; raw: any }> {
  const data = await paypalRequest(
    'POST',
    `/v2/payments/authorizations/${idPath(authorizationId)}/capture`,
    { final_capture: true },
    `gc-authcap-${authorizationId}`
  );
  return { captureId: data.id, status: data.status, raw: data };
}

export async function voidAuthorization(authorizationId: string): Promise<void> {
  // Returns 204 No Content on success
  await paypalRequest('POST', `/v2/payments/authorizations/${idPath(authorizationId)}/void`, undefined, `gc-void-${authorizationId}`);
}

export async function refundCapture(params: {
  captureId: string;
  amount: number;
  currency: string;
  reason?: string;
}): Promise<{ refundId: string; status: string; refundedAt: string; raw: any }> {
  const data = await paypalRequest(
    'POST',
    `/v2/payments/captures/${idPath(params.captureId)}/refund`,
    {
      amount: { value: params.amount.toFixed(2), currency_code: params.currency || 'USD' },
      note_to_payer: (params.reason || 'Guardian Cart refund').slice(0, 255)
    },
    `gc-refund-${params.captureId}`
  );
  return {
    refundId: data.id,
    status: data.status,
    refundedAt: data.create_time || new Date().toISOString(),
    raw: data
  };
}

export async function getOrder(orderId: string): Promise<any> {
  return paypalRequest('GET', `/v2/checkout/orders/${idPath(orderId)}`);
}

export async function getCaptureStatus(captureId: string): Promise<string> {
  const data = await paypalRequest('GET', `/v2/payments/captures/${idPath(captureId)}`);
  return data.status;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export async function verifyWebhookSignature(headers: Record<string, string | undefined>, event: unknown): Promise<boolean> {
  const webhookId = (process.env.PAYPAL_WEBHOOK_ID || '').trim();
  if (!webhookId) {
    throw new Error('PAYPAL_WEBHOOK_ID is not set; refusing unverified webhook');
  }
  const data = await paypalRequest('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: event
  });
  return data.verification_status === 'SUCCESS';
}

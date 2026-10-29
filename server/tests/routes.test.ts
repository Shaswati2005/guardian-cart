// HTTP-level checks of the persona session and role errors, against the real router.
// Each test file runs in its own process, so these env vars only affect this file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-cart-routes-'));
process.env.APP_SECRET = 'routes-test-secret-0123456789';
process.env.CAREGIVER_PIN = '246810';
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.RESEND_API_KEY;

const express = (await import('express')).default;
const { apiRouter } = await import('../src/routes.js');

const app = express();
app.use(express.json());
app.use('/api', apiRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(() => server.close());

async function call(pathname: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method: init.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(init.cookie ? { Cookie: init.cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any, cookie };
}

test('#2 switching personas many times never locks anyone out', async () => {
  for (let i = 0; i < 30; i++) {
    assert.equal((await call('/session', { method: 'POST', body: { role: 'elder' } })).status, 200);
    // Asking for Sarah's page without a PIN is how the page learns one is needed: not a guess
    const ask = await call('/session', { method: 'POST', body: { role: 'caregiver' } });
    assert.equal(ask.status, 403);
    assert.equal(ask.data.pinRequired, true);
    assert.equal((await call('/session', { method: 'POST', body: { role: 'caregiver', pin: '246810' } })).status, 200);
  }
});

test('#2 an existing session is reported, so pages can reuse it instead of logging in again', async () => {
  const { cookie } = await call('/session', { method: 'POST', body: { role: 'caregiver', pin: '246810' } });
  const info = await call('/session', { cookie });
  assert.deepEqual(info.data.roles, ['caregiver']);
  assert.equal(info.data.caregiverPinRequired, true);
});

test('#7 a request with the other persona\'s cookie is flagged so the page can switch back', async () => {
  const { cookie } = await call('/session', { method: 'POST', body: { role: 'elder' } });
  const res = await call('/dashboard', { cookie });
  assert.equal(res.status, 403);
  assert.equal(res.data.roleMismatch, true);
  assert.equal((await call('/dashboard')).status, 401); // no cookie at all
});

test('R4#2 Margaret and Sarah side by side in one browser: entering as one never logs the other out', async () => {
  const sarah = (await call('/session', { method: 'POST', body: { role: 'caregiver', pin: '246810' } })).cookie!;
  const margaret = (await call('/session', { method: 'POST', body: { role: 'elder' } })).cookie!;
  const both = `${sarah}; ${margaret}`;
  assert.deepEqual((await call('/session', { cookie: both })).data.roles, ['elder', 'caregiver']);
  assert.equal((await call('/dashboard', { cookie: both })).status, 200); // Sarah's page still works
  assert.notEqual((await call('/agents/agent-margaret/chat', { cookie: both })).status, 403);
  // A cookie for one persona can't be relabelled as the other
  const forged = margaret.replace('gc_elder=', 'gc_caregiver=');
  assert.equal((await call('/dashboard', { cookie: forged })).status, 401);
});

// Runs last: it locks this test client's IP out of PIN attempts
test('#2 wrong PINs are still limited, and the lockout also stops the right PIN', async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('/session', { method: 'POST', body: { role: 'caregiver', pin: `00000${i}` } })).status, 403);
  }
  const locked = await call('/session', { method: 'POST', body: { role: 'caregiver', pin: '246810' } });
  assert.equal(locked.status, 429);
  // Margaret's page is unaffected
  assert.equal((await call('/session', { method: 'POST', body: { role: 'elder' } })).status, 200);
});

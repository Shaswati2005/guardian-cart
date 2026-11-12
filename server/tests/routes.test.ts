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

test('#2 switching personas many times never locks anyone out, and Sarah needs no PIN', async () => {
  for (let i = 0; i < 30; i++) {
    assert.equal((await call('/session', { method: 'POST', body: { role: 'elder' } })).status, 200);
    assert.equal((await call('/session', { method: 'POST', body: { role: 'caregiver' } })).status, 200);
  }
});

test('#2 an existing session is reported, so pages can reuse it instead of logging in again', async () => {
  const { cookie } = await call('/session', { method: 'POST', body: { role: 'caregiver' } });
  const info = await call('/session', { cookie });
  assert.deepEqual(info.data.roles, ['caregiver']);
});

test('#7 a request with the other persona\'s cookie is flagged so the page can switch back', async () => {
  const { cookie } = await call('/session', { method: 'POST', body: { role: 'elder' } });
  const res = await call('/dashboard', { cookie });
  assert.equal(res.status, 403);
  assert.equal(res.data.roleMismatch, true);
  assert.equal((await call('/dashboard')).status, 401); // no cookie at all
});

test('R4#2 Margaret and Sarah side by side in one browser: entering as one never logs the other out', async () => {
  const sarah = (await call('/session', { method: 'POST', body: { role: 'caregiver' } })).cookie!;
  const margaret = (await call('/session', { method: 'POST', body: { role: 'elder' } })).cookie!;
  const both = `${sarah}; ${margaret}`;
  assert.deepEqual((await call('/session', { cookie: both })).data.roles, ['elder', 'caregiver']);
  assert.equal((await call('/dashboard', { cookie: both })).status, 200); // Sarah's page still works
  assert.notEqual((await call('/agents/agent-margaret/chat', { cookie: both })).status, 403);
  // A cookie for one persona can't be relabelled as the other
  const forged = margaret.replace('gc_elder=', 'gc_caregiver=');
  assert.equal((await call('/dashboard', { cookie: forged })).status, 401);
});

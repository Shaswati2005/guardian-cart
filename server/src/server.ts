// Must be the first import: ES modules evaluate imports before this file's body,
// and some modules read process.env at load time.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { apiRouter } from './routes.js';
import { validateConfig } from './config.js';

// Stops here (in production) on a non-sandbox PayPal URL, a missing APP_SECRET or CAREGIVER_PIN
try {
  validateConfig();
} catch (err: any) {
  console.error(`[Guardian Cart] ${err.message}`);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same path from src/ (tsx) and dist/ (compiled)
const CLIENT_DIST = path.resolve(__dirname, '..', '..', 'client', 'dist');

const app = express();
const PORT = process.env.PORT || 5000;

// Behind Render's proxy, X-Forwarded-For gives the visitor's IP (rate limits) and X-Forwarded-Proto
// marks HTTPS (secure cookies). Without a proxy in front, clients could fake that header, so it's
// only trusted on Render or when TRUST_PROXY is set.
const trustProxy = process.env.TRUST_PROXY ?? (process.env.RENDER ? '1' : '');
if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
app.disable('x-powered-by');

// No CORS middleware: in dev Vite proxies /api, in production the client is served from this origin
app.use(express.json({ limit: '100kb' }));
// Only for the confirm form on email approval pages
app.use(express.urlencoded({ extended: false, limit: '4kb' }));

app.use('/api', apiRouter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'Guardian Cart' });
});

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`[Guardian Cart] Running at http://localhost:${PORT}`);
});

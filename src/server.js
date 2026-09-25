require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Telegraf } = require('telegraf');
const db = require('./db');
const {
  encryptSecret,
  hashPassword,
  verifyPassword,
  signAdminToken,
  verifyAdminToken,
  requireEnv
} = require('./security');
const { buildBot } = require('./bot');

// Provide fallbacks if not defined in process.env
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8809665446:AAHawfYk5BcPsh0nhb7CvocO7ZqObKBgT1U';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'chiroblox';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'chiro123456$';
process.env.ACCOUNT_ENCRYPTION_KEY_BASE64 = process.env.ACCOUNT_ENCRYPTION_KEY_BASE64 || crypto.randomBytes(32).toString('base64');
process.env.BOT_INTERNAL_TOKEN = process.env.BOT_INTERNAL_TOKEN || crypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
process.env.TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex');

function getValidWebhookSecret(secret) {
  if (!secret) return undefined;
  const cleaned = secret.replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned.length > 0 ? cleaned : undefined;
}

requireEnv([
  'DATABASE_URL',
  'TELEGRAM_BOT_TOKEN',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD'
]);

const app = express();
const port = Number(process.env.PORT || 3000);
const clients = new Set();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true });
const adminWriteLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true });

function sendEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

function adminAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    req.admin = verifyAdminToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function botAuth(req, res, next) {
  if (req.get('x-bot-token') !== process.env.BOT_INTERNAL_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'ChiroBlox', time: new Date().toISOString() }));

app.post('/api/admin/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    const admin = await db.getAdmin(username);
    if (!admin || !(await verifyPassword(password, admin.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    return res.json({ token: signAdminToken({ sub: admin.id, username: admin.username }) });
  } catch (error) {
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/admin/stats', adminAuth, async (_req, res) => {
  res.json(await db.getStats());
});

app.get('/api/admin/activity', adminAuth, async (req, res) => {
  res.json(await db.getActivity(req.query.limit));
});

app.get('/api/admin/accounts', adminAuth, async (req, res) => {
  res.json(await db.listAccounts({ status: req.query.status || 'all', limit: req.query.limit, offset: req.query.offset }));
});

app.post('/api/admin/accounts', adminAuth, adminWriteLimiter, async (req, res) => {
  try {
    const { username, secret, metadata } = req.body || {};
    if (!username || !secret) return res.status(400).json({ error: 'username and secret are required' });
    const account = await db.createAccount({ username: String(username).trim(), encrypted: encryptSecret(secret), metadata: metadata || {} });
    await db.addAudit('account_added', 'admin', req.admin.sub, { accountId: account.id, username: account.username });
    sendEvent('stock', await db.getStats());
    res.status(201).json(account);
  } catch (error) {
    res.status(500).json({ error: 'Could not add account' });
  }
});

app.post('/api/admin/accounts/bulk', adminAuth, adminWriteLimiter, async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length || items.length > 500) return res.status(400).json({ error: 'items must contain 1–500 records' });
    const records = items.map((item) => {
      if (!item?.username || !item?.secret) throw new Error('Each item needs username and secret');
      return { username: String(item.username).trim(), encrypted: encryptSecret(item.secret), metadata: item.metadata || {} };
    });
    const created = await db.createAccountsBulk(records);
    await db.addAudit('accounts_bulk_added', 'admin', req.admin.sub, { count: created.length });
    sendEvent('stock', await db.getStats());
    res.status(201).json({ count: created.length });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Bulk import failed' });
  }
});

app.post('/api/admin/accounts/:id/disable', adminAuth, adminWriteLimiter, async (req, res) => {
  const account = await db.disableAccount(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found or already claimed' });
  await db.addAudit('account_disabled', 'admin', req.admin.sub, { accountId: account.id });
  sendEvent('stock', await db.getStats());
  res.json(account);
});

app.post('/api/admin/accounts/:id/release', adminAuth, adminWriteLimiter, async (req, res) => {
  const account = await db.releaseClaim(req.params.id);
  if (!account) return res.status(404).json({ error: 'Claimed account not found' });
  await db.addAudit('claim_released', 'admin', req.admin.sub, { accountId: account.id });
  sendEvent('stock', await db.getStats());
  res.json(account);
});

app.get('/api/events', (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.token || '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    verifyAdminToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.post('/api/bot/claim-random', botAuth, async (req, res) => {
  try {
    const { telegramUserId, telegramUsername } = req.body || {};
    if (!telegramUserId) return res.status(400).json({ error: 'telegramUserId is required' });
    const claim = await db.claimRandomAccount({ telegramUserId, telegramUsername });
    sendEvent('claim', claim ? { accountId: claim.id, username: claim.username } : { empty: true });
    sendEvent('stock', await db.getStats());
    res.json({ claim });
  } catch (error) {
    res.status(500).json({ error: 'Claim failed' });
  }
});

const telegramBot = buildBot();

app.post('/telegram/webhook', async (req, res) => {
  try {
    const expectedSecret = getValidWebhookSecret(process.env.TELEGRAM_WEBHOOK_SECRET);
    if (expectedSecret) {
      const secret = req.get('x-telegram-bot-api-secret-token');
      if (!secret || secret !== expectedSecret) {
        return res.status(403).json({ error: 'Invalid webhook secret token' });
      }
    }
    await telegramBot.handleUpdate(req.body);
    if (!res.headersSent) {
      res.sendStatus(200);
    }
  } catch (error) {
    console.error('Telegram webhook error:', error.message);
    if (!res.headersSent) {
      res.sendStatus(200); // Return 200 so Telegram does not get trapped in retry loop
    }
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/*splat', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

async function start() {
  await db.migrate();
  await db.ensureAdmin(process.env.ADMIN_USERNAME, await hashPassword(process.env.ADMIN_PASSWORD));

  const server = app.listen(port, '0.0.0.0', async () => {
    console.log(`ChiroBlox running on 0.0.0.0:${port}`);

    // Determine public URL for Render or custom hosting
    let baseUrl = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');

    // If PUBLIC_URL was populated with an internal service name without dots (like "chiroblox"), prefer RENDER_EXTERNAL_URL
    if (baseUrl && !baseUrl.includes('.') && process.env.RENDER_EXTERNAL_URL) {
      baseUrl = process.env.RENDER_EXTERNAL_URL.trim().replace(/\/$/, '');
    }

    if (baseUrl) {
      if (!/^https?:\/\//i.test(baseUrl)) baseUrl = `https://${baseUrl}`;
      const webhookUrl = `${baseUrl}/telegram/webhook`;
      const webhookSecret = getValidWebhookSecret(process.env.TELEGRAM_WEBHOOK_SECRET);
      try {
        await telegramBot.telegram.setWebhook(webhookUrl, webhookSecret ? { secret_token: webhookSecret } : {});
        console.log(`Telegram webhook successfully configured: ${webhookUrl}`);
      } catch (error) {
        console.error('Telegram webhook setup failed:', error.message);
      }
    } else {
      console.log('No public URL provided; running Telegram bot in polling mode...');
      try {
        await telegramBot.telegram.deleteWebhook({ drop_pending_updates: true });
        telegramBot.launch().then(() => {
          console.log('Telegram bot polling active');
        }).catch((err) => {
          console.error('Telegram bot polling error:', err.message);
        });
      } catch (err) {
        console.error('Failed to initialize polling mode:', err.message);
      }
    }
  });

  const stopSignals = ['SIGINT', 'SIGTERM'];
  for (const signal of stopSignals) {
    process.once(signal, () => {
      try { telegramBot.stop(signal); } catch {}
      server.close();
      process.exit(0);
    });
  }
}

start().catch((error) => {
  console.error('Startup failed:', error);
  process.exit(1);
});

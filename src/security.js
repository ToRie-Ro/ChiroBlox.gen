const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const KEY_BYTES = 32;

function getEncryptionKey() {
  const raw = process.env.ACCOUNT_ENCRYPTION_KEY_BASE64;
  if (!raw) throw new Error('ACCOUNT_ENCRYPTION_KEY_BASE64 is missing');

  // Try decoding base64 if it decodes to exactly 32 bytes
  try {
    const key = Buffer.from(raw, 'base64');
    if (key.length === KEY_BYTES) {
      return key;
    }
  } catch {}

  // If raw utf-8 string is directly 32 bytes
  const utf8Key = Buffer.from(raw, 'utf8');
  if (utf8Key.length === KEY_BYTES) {
    return utf8Key;
  }

  // Fallback: derive a 32-byte key via SHA-256 so the app doesn't crash on invalid length or plaintext passphrase
  return crypto.createHash('sha256').update(raw).digest();
}

function encryptSecret(value) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

function decryptSecret(record) {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signAdminToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' });
}

function verifyAdminToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

module.exports = {
  encryptSecret,
  decryptSecret,
  hashPassword,
  verifyPassword,
  signAdminToken,
  verifyAdminToken,
  requireEnv
};

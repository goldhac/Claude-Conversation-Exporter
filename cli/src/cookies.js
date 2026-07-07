// Read and decrypt cookies from the Claude Desktop app's Chromium cookie store
// on macOS, so the CLI can reuse the desktop session (sessionKey) without a
// browser. Uses the "classic" macOS Chromium encryption scheme:
//   key = PBKDF2-HMAC-SHA1(keychain_pw, "saltysalt", 1003, 16 bytes)
//   AES-128-CBC, IV = 16 space bytes, PKCS7 padding, after stripping the "v10" prefix.
// For Cookies DB meta.version >= 24, Chromium prepends a 32-byte SHA256(host_key)
// to the plaintext, which we strip.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { getKeychainPassword } = require('./keychain');
const { CookieDecryptError } = require('./errors');

const CLAUDE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
const COOKIES_PATH = path.join(CLAUDE_DIR, 'Cookies');
const LOCAL_STATE_PATH = path.join(CLAUDE_DIR, 'Local State');

// Cookies whose decrypted value we care about (session + Cloudflare passthrough).
const WANTED = ['sessionKey', 'lastActiveOrg', '__cf_bm', 'cf_clearance', 'activitySessionId', 'anthropic-device-id'];

function claudeDesktopInstalled() {
  return fs.existsSync(COOKIES_PATH);
}

// Guard: if Anthropic ever adopts Chromium "app-bound" encryption, the classic
// scheme won't work and we should tell the user to use --session-key.
function assertNotAppBound() {
  try {
    if (!fs.existsSync(LOCAL_STATE_PATH)) return;
    const ls = JSON.parse(fs.readFileSync(LOCAL_STATE_PATH, 'utf8'));
    if (ls && ls.os_crypt && ls.os_crypt.app_bound_encrypted_key) {
      throw new CookieDecryptError(
        'Claude Desktop appears to use app-bound cookie encryption, which this ' +
        'tool cannot decrypt. Use --session-key instead (copy sessionKey from the ' +
        'browser DevTools → Application → Cookies).'
      );
    }
  } catch (err) {
    if (err instanceof CookieDecryptError) throw err;
    // Malformed/unreadable Local State is non-fatal — fall through to normal path.
  }
}

// Copy the (app-locked) Cookies DB to a temp file and read the rows we need.
function readCookieRows() {
  const tmp = path.join(os.tmpdir(), 'cce-cookies-' + process.pid + '-' + Date.now() + '.db');
  fs.copyFileSync(COOKIES_PATH, tmp);
  try {
    try {
      return readWithNodeSqlite(tmp);
    } catch (nodeErr) {
      return readWithSqlite3Cli(tmp, nodeErr);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
  }
}

function readWithNodeSqlite(tmp) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(tmp, { readOnly: true });
  try {
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    const version = meta ? Number(meta.value) : 0;
    const rows = db
      .prepare("SELECT name, host_key, encrypted_value FROM cookies WHERE host_key LIKE '%claude.ai%'")
      .all();
    return {
      version,
      rows: rows.map((r) => ({ name: r.name, host: r.host_key, enc: Buffer.from(r.encrypted_value) })),
    };
  } finally {
    db.close();
  }
}

// Fallback when node:sqlite is unavailable (Node < 22.5): shell out to sqlite3
// and transport the encrypted BLOBs as hex.
function readWithSqlite3Cli(tmp, nodeErr) {
  let versionOut, rowsOut;
  try {
    versionOut = execFileSync('sqlite3', ['-readonly', 'file:' + tmp + '?immutable=1',
      "SELECT value FROM meta WHERE key='version';"], { encoding: 'utf8' });
    rowsOut = execFileSync('sqlite3', ['-readonly', 'file:' + tmp + '?immutable=1',
      "SELECT name || '\\t' || hex(encrypted_value) FROM cookies WHERE host_key LIKE '%claude.ai%';"],
      { encoding: 'utf8' });
  } catch (cliErr) {
    throw new CookieDecryptError(
      'Could not read the Cookies database. node:sqlite failed (' +
      (nodeErr && nodeErr.message) + ') and the sqlite3 CLI failed (' +
      (cliErr && cliErr.message) + ').'
    );
  }
  const version = Number(String(versionOut).trim()) || 0;
  const rows = [];
  for (const line of String(rowsOut).split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const name = line.slice(0, tab);
    const hex = line.slice(tab + 1).trim();
    rows.push({ name, host: '', enc: Buffer.from(hex, 'hex') });
  }
  return { version, rows };
}

function decryptValue(enc, key, version) {
  if (enc.length < 3 || enc.subarray(0, 3).toString('latin1') !== 'v10') {
    // Not encrypted with the v10 scheme — return as-is (rare/legacy).
    return enc.toString('utf8');
  }
  const iv = Buffer.alloc(16, 0x20); // 16 space bytes
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  let plain = Buffer.concat([decipher.update(enc.subarray(3)), decipher.final()]);
  if (version >= 24 && plain.length >= 32) {
    plain = plain.subarray(32); // strip SHA256(host_key) prefix
  }
  return plain.toString('utf8');
}

// Returns { sessionKey, org, cookies } from the Claude Desktop session.
// `cookies` holds every decrypted wanted cookie (for Cloudflare passthrough).
function extractDesktopSession() {
  if (!claudeDesktopInstalled()) {
    throw new CookieDecryptError(
      'Claude Desktop cookie store not found at ' + COOKIES_PATH + '. ' +
      'Install the Claude Desktop app and sign in, or pass --session-key.'
    );
  }
  assertNotAppBound();

  const password = getKeychainPassword();
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const { version, rows } = readCookieRows();

  const cookies = {};
  for (const row of rows) {
    if (WANTED.indexOf(row.name) === -1) continue;
    try {
      cookies[row.name] = decryptValue(row.enc, key, version);
    } catch (_) {
      // A single bad cookie shouldn't abort everything.
    }
  }

  const sessionKey = cookies.sessionKey;
  if (!sessionKey) {
    throw new CookieDecryptError(
      'No sessionKey cookie found in the Claude Desktop store. Open the app and ' +
      'sign in, then retry — or pass --session-key.'
    );
  }
  if (!/^sk-ant-/.test(sessionKey)) {
    throw new CookieDecryptError(
      'Decrypted the sessionKey but it does not look valid (wrong Keychain key?). ' +
      'Try again, or pass --session-key.'
    );
  }

  const org = cookies.lastActiveOrg && /^[0-9a-f-]{36}$/i.test(cookies.lastActiveOrg)
    ? cookies.lastActiveOrg
    : null;

  return { sessionKey, org, cookies, cookieDbVersion: version };
}

module.exports = {
  extractDesktopSession,
  claudeDesktopInstalled,
  decryptValue, // exported for testing
  COOKIES_PATH,
  CLAUDE_DIR,
  WANTED,
};

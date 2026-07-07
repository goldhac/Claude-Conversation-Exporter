// Resolve a usable Claude session, either from an explicit --session-key
// (manual/cross-platform) or by decrypting the Claude Desktop cookie store.
const { extractDesktopSession } = require('./cookies');

// Build the Cookie request header from whatever decrypted cookies we have.
// Order is cosmetic; sessionKey is the credential, the CF cookies help pass
// Cloudflare, the rest mimic a real client.
function buildCookieHeader(cookies) {
  const order = ['sessionKey', '__cf_bm', 'cf_clearance', 'lastActiveOrg', 'activitySessionId', 'anthropic-device-id'];
  const parts = [];
  for (const k of order) if (cookies[k]) parts.push(k + '=' + cookies[k]);
  return parts.join('; ');
}

function resolveSession(flags) {
  flags = flags || {};
  if (flags.sessionKey) {
    return {
      source: 'manual',
      sessionKey: flags.sessionKey,
      org: flags.org || null,
      cookies: { sessionKey: flags.sessionKey },
    };
  }
  const s = extractDesktopSession();
  return {
    source: 'desktop',
    sessionKey: s.sessionKey,
    org: flags.org || s.org || null,
    cookies: s.cookies,
    cookieDbVersion: s.cookieDbVersion,
  };
}

module.exports = { resolveSession, buildCookieHeader };

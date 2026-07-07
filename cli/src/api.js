// Thin client for the first-party claude.ai web API (cookie-authenticated).
const { AuthExpiredError, CloudflareError, ApiError } = require('./errors');
const { buildCookieHeader } = require('./session');
const { sleep } = require('./concurrency');

const BASE = 'https://claude.ai/api';

async function safeText(res) {
  try { return await res.text(); } catch (_) { return ''; }
}
function snippet(body) {
  body = (body || '').replace(/\s+/g, ' ').trim();
  return body.length > 200 ? body.slice(0, 200) + '…' : body;
}
function backoffMs(attempt) {
  return Math.min(15000, 400 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
}

class ClaudeApiClient {
  constructor(opts) {
    this.cookieHeader = buildCookieHeader(opts.cookies);
    this.userAgent = opts.userAgent;
    this.org = opts.org || null;
    this.maxRetries = opts.maxRetries != null ? opts.maxRetries : 4;
  }

  headers() {
    return {
      'Cookie': this.cookieHeader,
      'User-Agent': this.userAgent,
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://claude.ai/',
      'Origin': 'https://claude.ai',
    };
  }

  // GET a JSON endpoint, with retry/backoff and typed errors.
  async request(pathname) {
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await fetch(BASE + pathname, { headers: this.headers() });
      } catch (err) {
        if (attempt++ < this.maxRetries) { await sleep(backoffMs(attempt)); continue; }
        throw new ApiError('Network error contacting claude.ai: ' + err.message, 0);
      }

      if (res.ok) return res.json();

      const status = res.status;
      if (status === 401) {
        throw new AuthExpiredError(
          'Session expired or invalid (401). Open Claude Desktop and sign in, then retry — or pass --session-key.'
        );
      }
      if (status === 403) {
        const body = await safeText(res);
        if (/just a moment|cf-chl|cloudflare|attention required|__cf/i.test(body)) {
          throw new CloudflareError(
            'Blocked by a Cloudflare challenge (403). Open Claude Desktop once to refresh cf_clearance, ' +
            'or pass --user-agent matching the app. As a fallback, use --session-key.'
          );
        }
        throw new ApiError('Forbidden (403). ' + snippet(body), 403, body);
      }
      if (status === 429 || status >= 500) {
        if (attempt++ < this.maxRetries) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
          continue;
        }
      }
      const body = await safeText(res);
      throw new ApiError('Request failed (' + status + '). ' + snippet(body), status, body);
    }
  }

  async resolveOrg() {
    if (this.org) return this.org;
    const orgs = await this.request('/organizations');
    if (Array.isArray(orgs) && orgs.length) {
      const withChat = orgs.find((o) => Array.isArray(o.capabilities) && o.capabilities.indexOf('chat') !== -1);
      this.org = (withChat || orgs[0]).uuid;
      return this.org;
    }
    throw new ApiError('Could not resolve an organization id from /api/organizations.', 0);
  }

  // List all conversations, paginating until exhausted (the extension skips this
  // and silently misses older chats).
  async listConversations() {
    const org = await this.resolveOrg();
    const LIMIT = 100;
    let offset = 0;
    const all = [];
    const seen = new Set();
    for (;;) {
      const page = await this.request(
        '/organizations/' + org + '/chat_conversations?limit=' + LIMIT + '&offset=' + offset
      );
      if (!Array.isArray(page) || page.length === 0) break;
      const before = all.length;
      for (const c of page) {
        if (c && c.uuid && !seen.has(c.uuid)) { seen.add(c.uuid); all.push(c); }
      }
      if (all.length === before) break;   // no new items -> offset not honored / exhausted
      if (page.length < LIMIT) break;      // last page
      offset += LIMIT;
      if (offset > 100000) break;          // safety cap
    }
    return all;
  }

  // Fetch a single conversation with its full message tree.
  async getConversation(id) {
    const org = await this.resolveOrg();
    return this.request(
      '/organizations/' + org + '/chat_conversations/' + id +
      '?tree=True&rendering_mode=messages&render_all_tools=true'
    );
  }
}

module.exports = { ClaudeApiClient };

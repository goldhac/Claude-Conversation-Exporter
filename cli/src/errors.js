// Typed errors so the CLI can print actionable guidance per failure mode.

class ExporterError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

// Could not read/decrypt the Claude Desktop cookie store.
class CookieDecryptError extends ExporterError {}

// Could not read the encryption key from the macOS Keychain.
class KeychainError extends ExporterError {}

// The session (sessionKey) is missing/expired/invalid — user must re-auth.
class AuthExpiredError extends ExporterError {}

// A Cloudflare challenge blocked the request.
class CloudflareError extends ExporterError {}

// Any other non-OK API response.
class ApiError extends ExporterError {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

module.exports = {
  ExporterError,
  CookieDecryptError,
  KeychainError,
  AuthExpiredError,
  CloudflareError,
  ApiError,
};

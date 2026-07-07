// Read the Claude Desktop cookie-encryption key from the macOS login Keychain.
//
// Claude (an Electron/Chromium app) stores its cookie-encryption password as a
// generic-password Keychain item: service "Claude Safe Storage", account
// "Claude Key". The first time an un-listed binary (like `security` invoked by
// this tool) reads it, macOS shows a Keychain access prompt — click "Always
// Allow" to avoid being asked again.

const { execFileSync } = require('child_process');
const { KeychainError } = require('./errors');

const KEYCHAIN_SERVICE = 'Claude Safe Storage';
const KEYCHAIN_ACCOUNT = 'Claude Key';

function getKeychainPassword() {
  let out;
  try {
    out = execFileSync(
      'security',
      ['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    // security exit code 128 == user denied / cancelled the Keychain prompt.
    if (err && err.status === 128) {
      throw new KeychainError(
        'Keychain access was denied. Re-run and click "Always Allow" on the ' +
        'macOS prompt for "' + KEYCHAIN_SERVICE + '", or pass --session-key instead.'
      );
    }
    throw new KeychainError(
      'Could not read the Claude Desktop encryption key from your Keychain ' +
      '("' + KEYCHAIN_SERVICE + '" / "' + KEYCHAIN_ACCOUNT + '"). ' +
      (stderr || (err && err.message) || 'unknown error') +
      '\nIs the Claude Desktop app installed and have you signed in at least once? ' +
      'You can also bypass this with --session-key.'
    );
  }
  const password = out.replace(/\r?\n$/, '');
  if (!password) {
    throw new KeychainError('Keychain returned an empty encryption key.');
  }
  return password;
}

module.exports = { getKeychainPassword, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT };

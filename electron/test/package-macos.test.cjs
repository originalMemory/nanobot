const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

async function module() {
  return import('../scripts/package-macos.mjs');
}

test('macOS package metadata stays compatible with the installed lover app', async () => {
  const { APP_ID, APP_EXECUTABLE, macPackageOptions } = await module();
  const options = macPackageOptions({ arch: 'arm64', identity: 'Local Test Identity' });
  assert.equal(APP_ID, 'ai.nanobot.desktop');
  assert.equal(APP_EXECUTABLE, 'nanobot');
  assert.equal(options.appBundleId, APP_ID);
  assert.equal(options.executableName, APP_EXECUTABLE);
  assert.equal(options.arch, 'arm64');
  assert.equal(options.icon.endsWith('/assets/icon'), true);
  assert.deepEqual(options.osxSign.identity, 'Local Test Identity');
  assert.equal(options.osxSign.identityValidation, false);
  assert.equal(options.osxSign.continueOnError, false);
});

test('signing prefers explicit identity, then the stable local certificate, then ad-hoc', async () => {
  const { LOCAL_SIGN_IDENTITY, selectSignIdentity } = await module();
  assert.equal(selectSignIdentity({ configured: 'Developer ID Application: Example', identities: '' }), 'Developer ID Application: Example');
  assert.equal(selectSignIdentity({ identities: `1) HASH "${LOCAL_SIGN_IDENTITY}"`, platform: 'darwin' }), LOCAL_SIGN_IDENTITY);
  assert.equal(selectSignIdentity({ identities: '', platform: 'darwin' }), '-');
});

test('macOS install script parses and contains rollback guards', () => {
  const scriptPath = require.resolve('../scripts/package-install-macos.sh');
  const script = readFileSync(scriptPath, 'utf8');
  const syntax = spawnSync('/bin/bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  for (const value of ['codesign --verify --deep --strict', 'REPLACEMENT_STARTED=1',
    'for _ in {1..80}',
    'mv "$INSTALL_APP" "$BACKUP_APP"', 'mv "$BACKUP_APP" "$INSTALL_APP"',
    'tell application id "ai.nanobot.desktop" to quit']) {
    assert.equal(script.includes(value), true, value);
  }
});

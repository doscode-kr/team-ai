import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('stores credentials separately with restrictive permissions and deduplicates accounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-storage-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?test=${Date.now()}`);
  const credential = { accessToken: 'secret', refreshToken: 'refresh', expiresAt: 123, accountId: 'same' };
  await storage.upsertAccount('codex', 'first', credential); await storage.upsertAccount('codex', 'renamed', { ...credential, accessToken: 'new-secret' });
  const config = await storage.loadConfig(); assert.equal(config.accounts.length, 1); assert.equal(config.accounts[0]?.label, 'renamed');
  assert.equal((await readFile(storage.paths().config, 'utf8')).includes('new-secret'), false);
  assert.equal((await stat(storage.paths().credentials)).mode & 0o777, 0o600);
  delete process.env.TEAMAI_HOME;
});

const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const member = (userId: string): string => jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace', chatgpt_user_id: userId } });

test('keeps two members of one Codex workspace as separate accounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-storage-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?test=${Date.now()}-members`);
  await storage.upsertAccount('codex', 'a@corp.com', { accessToken: member('user-a'), refreshToken: 'ra', expiresAt: 1, accountId: 'workspace', userId: 'user-a' });
  await storage.upsertAccount('codex', 'b@corp.com', { accessToken: member('user-b'), refreshToken: 'rb', expiresAt: 1, accountId: 'workspace', userId: 'user-b' });
  await storage.upsertAccount('codex', 'a@corp.com', { accessToken: member('user-a'), refreshToken: 'ra2', expiresAt: 2, accountId: 'workspace', userId: 'user-a' });
  const config = await storage.loadConfig(); const credentials = await storage.loadCredentials();
  assert.deepEqual(config.accounts.map((a: { label: string }) => a.label), ['a@corp.com', 'b@corp.com']);
  assert.equal(new Set(config.accounts.map((a: { credentialId: string }) => a.credentialId)).size, 2);
  for (const account of config.accounts) assert.equal(credentials[account.credentialId].accountId, 'workspace');
  delete process.env.TEAMAI_HOME;
});

test('upgrades a workspace-keyed Codex record for the same user and leaves it for another member', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-storage-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?test=${Date.now()}-legacy`);
  // A record written before the user joined the key: id is the bare workspace id.
  await storage.upsertAccount('codex', 'a@corp.com', { accessToken: member('user-a'), refreshToken: 'ra', expiresAt: 1, accountId: 'workspace' });
  const legacyId = (await storage.loadConfig()).accounts[0].credentialId;
  await storage.upsertAccount('codex', 'renamed@corp.com', { accessToken: member('user-a'), refreshToken: 'ra2', expiresAt: 2, accountId: 'workspace', userId: 'user-a' });
  let config = await storage.loadConfig();
  assert.equal(config.accounts.length, 1); assert.equal(config.accounts[0].id, 'workspace:user-a'); assert.equal(config.accounts[0].credentialId, legacyId);
  await storage.upsertAccount('codex', 'b@corp.com', { accessToken: member('user-b'), refreshToken: 'rb', expiresAt: 1, accountId: 'workspace', userId: 'user-b' });
  config = await storage.loadConfig();
  assert.equal(config.accounts.length, 2); assert.equal((await storage.loadCredentials())[legacyId].refreshToken, 'ra2');
  delete process.env.TEAMAI_HOME;
});

test('does not merge workspace members that share a label because their tokens carry no email', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-storage-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?test=${Date.now()}-nolabel`);
  await storage.upsertAccount('codex', 'workspace', { accessToken: member('user-a'), refreshToken: 'ra', expiresAt: 1, accountId: 'workspace' });
  await storage.upsertAccount('codex', 'workspace', { accessToken: member('user-b'), refreshToken: 'rb', expiresAt: 1, accountId: 'workspace', userId: 'user-b' });
  assert.equal((await storage.loadConfig()).accounts.length, 2);
  delete process.env.TEAMAI_HOME;
});

test('a credentials save is dropped when another process wrote the file after it was read', async () => {
  // The 2026-10-22 failure: a save read the file, stalled for minutes, and
  // landed after a re-login — writing the token that re-login replaced.
  const root = await mkdtemp(join(tmpdir(), 'teamai-storage-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?test=cas-${Date.now()}`);
  const stale = { accessToken: 'stale', refreshToken: 'r', expiresAt: 1, accountId: 'a' };
  await storage.saveCredentials({ 'claude:a': stale });
  const snapshot = await storage.readCredentialsText();
  await storage.saveCredentials({ 'claude:a': { ...stale, accessToken: 'relogged', expiresAt: 2 } });
  assert.equal(await storage.saveCredentialsIfUnchanged({ 'claude:a': stale }, snapshot), false);
  assert.equal((await storage.loadCredentials())['claude:a'].accessToken, 'relogged', 'the re-login survives');
  assert.deepEqual((await readdir(root)).filter((f) => f.endsWith('.tmp')), [], 'the vetoed temp file is removed');
  // Unchanged since the read: the write goes through.
  assert.equal(await storage.saveCredentialsIfUnchanged({ 'claude:a': stale }, await storage.readCredentialsText()), true);
  assert.equal((await storage.loadCredentials())['claude:a'].accessToken, 'stale');
  delete process.env.TEAMAI_HOME;
});

test('a state save superseded by a later one is not written', async () => {
  // A save that outlived its timeout must not land older usage over newer.
  const root = await mkdtemp(join(tmpdir(), 'teamai-storage-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?test=gen-${Date.now()}`);
  await storage.saveState({ version: 1, accounts: {}, events: [{ at: 2, message: 'newer' }] });
  assert.equal(await storage.saveState({ version: 1, accounts: {}, events: [{ at: 1, message: 'older' }] }, async () => false), false);
  assert.equal((await storage.loadState()).events[0].message, 'newer');
  assert.deepEqual((await readdir(root)).filter((f) => f.endsWith('.tmp')), []);
  delete process.env.TEAMAI_HOME;
});

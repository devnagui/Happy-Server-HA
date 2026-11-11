import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { configuration, masterSecret, redact, runChild } from './run.mjs';

const options = {
  public_url: 'https://example.test:10000',
  database_host: 'postgres.local.hass.io',
  database_port: 5432,
  database_name: 'happy',
  database_user: 'happy',
  database_password: 'p@ss:/?#%word',
  storage_path: '/data',
};

test('builds the external PostgreSQL environment with encoded credentials', () => {
  const { environment } = configuration(options);
  const url = new URL(environment.DATABASE_URL);
  assert.equal(decodeURIComponent(url.password), options.database_password);
  assert.equal(url.hostname, options.database_host);
  assert.equal(url.pathname, '/happy');
  assert.equal(environment.DB_PROVIDER, 'postgres');
  assert.equal(environment.PUBLIC_URL, 'https://example.test:10000');
  assert.equal(environment.PORT, '3005');
  assert.equal(environment.METRICS_ENABLED, 'false');
  assert.equal(environment.REDIS_URL, undefined);
  assert.equal(environment.S3_HOST, undefined);
});

test('rejects invalid URLs, missing options, injected hosts and invalid ports', () => {
  for (const value of ['http://example.test', 'https://user:pass@example.test',
    'https://example.test/happy', 'https://example.test?token=x', 'https://example.test#x']) {
    assert.throws(() => configuration({ ...options, public_url: value }));
  }
  for (const key of ['database_password', 'database_host', 'database_name', 'database_user']) {
    assert.throws(() => configuration({ ...options, [key]: '' }));
  }
  assert.throws(() => configuration({ ...options, database_password: 'secret\nsecond-line' }));
  assert.throws(() => configuration({ ...options, database_host: 'host/db?x=y' }));
  assert.throws(() => configuration({ ...options, database_name: 'happy?sslmode=disable' }));
  for (const value of [0, 65536, 5432.5, '5432']) {
    assert.throws(() => configuration({ ...options, database_port: value }));
  }
});

test('external storage requires a real mounted ancestor, not autofs or a similar name', () => {
  const external = { ...options, storage_path: '/media/torrent_disk/happy' };
  const mount = '1 2 0:1 / /media/torrent_disk rw - ntfs3 /dev/sda1 rw';
  assert.equal(configuration(external, mount).environment.DATA_DIR, external.storage_path);
  for (const mounts of ['', mount.replace('ntfs3', 'autofs'),
    mount.replace('torrent_disk', 'torrent_disk_old')]) {
    assert.throws(() => configuration(external, mounts), /not mounted/);
  }
  for (const value of ['/etc', '/media/../etc', '/data/../etc', 'relative', '/media']) {
    assert.throws(() => configuration({ ...options, storage_path: value }));
  }
});

test('persists one secret and refuses to replace a damaged existing secret', async () => {
  const dir = await mkdtemp(path.resolve(import.meta.dirname, '.secret-test-'));
  try {
    const file = path.join(dir, 'secret');
    const first = await masterSecret(file);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(await masterSecret(file), first);
    assert.equal((await readFile(file, 'utf8')).trim(), first);
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    await writeFile(file, 'invalid');
    await assert.rejects(masterSecret(file), /restore it rather than replacing/);
    assert.equal(await readFile(file, 'utf8'), 'invalid');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('redacts passwords, encoded passwords, connection URLs and master secret', () => {
  const config = configuration(options);
  const secret = 'a'.repeat(64);
  const output = redact([options.database_password, encodeURIComponent(options.database_password),
    config.environment.DATABASE_URL, secret, 'postgresql://other:unknown@host/db'].join(' '),
  [...config.secrets, secret]);
  assert.ok(!output.includes(options.database_password));
  assert.ok(!output.includes(encodeURIComponent(options.database_password)));
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes('unknown@host'));
});

test('Supervisor configuration keeps the backend private and permissions narrow', async () => {
  const manifest = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.arch, ['aarch64']);
  assert.equal(manifest.protected, true);
  assert.equal(manifest.boot, 'manual');
  assert.equal(manifest.ingress, false);
  assert.equal(manifest.ports['3005/tcp'], null);
  assert.deepEqual(manifest.map, ['media:rw']);
  assert.equal(manifest.hassio_api, undefined);
  assert.equal(manifest.docker_api, undefined);
  assert.deepEqual(Object.keys(manifest.options).sort(), Object.keys(manifest.schema).sort());
});

test('child output is redacted across writes and nonzero exits remain failures', async () => {
  const moduleUrl = new URL('./run.mjs', import.meta.url).href;
  const childCode = "process.stdout.write('s3');process.stdout.write('cret\\n');" +
    "process.stderr.write('s3cret\\n');process.exitCode=7";
  const script = `const {runChild}=await import(${JSON.stringify(moduleUrl)});
    const result=await runChild(process.execPath,['-e',${JSON.stringify(childCode)}],
      process.env,['s3cret'],${JSON.stringify(import.meta.dirname)});
    console.log('RESULT:'+JSON.stringify(result));`;
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', script], { timeout: 5000 });
  assert.ok(!stdout.includes('s3cret'));
  assert.equal(stdout.match(/\[REDACTED\]/g).length, 2);
  assert.ok(stdout.includes('RESULT:{"code":7,"signal":null}'));
});

test('a process launch failure is surfaced to the caller', async () => {
  await assert.rejects(runChild('happy-nonexistent-executable-for-test', [],
    process.env, [], import.meta.dirname), { code: 'ENOENT' });
});

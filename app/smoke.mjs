import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { redact } from './run.mjs';

const image = process.argv[2] || 'ghcr.io/devnagui/happy-server-ha-aarch64:0.1.1';
const dockerCommand = process.platform === 'win32' ? 'docker.exe' : 'docker';
const id = randomBytes(6).toString('hex');
const label = `happy-selfhost-smoke=${id}`;
const password = randomBytes(32).toString('hex');
const adminPassword = randomBytes(32).toString('hex');
const secrets = [password, adminPassword];
const containers = [];
let network;
let volume;
let directory;

function docker(args, { input, environment, timeout = 30000 } = {}) {
  const result = spawnSync(dockerCommand, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    input,
    env: { ...process.env, ...environment },
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code || redact(result.stderr.trim(), secrets);
    throw new Error(`Docker ${args[0]} failed: ${reason || result.status}`);
  }
  return result.stdout.trim();
}

function runtimeCheck(command, args, timeout = 30000, mount) {
  const container = docker(['create', '--platform', 'linux/arm64', '--label', label,
    '--name', `happy-runtime-${id}-${containers.length}`,
    ...(mount ? ['--mount', mount] : []), '--entrypoint', command, image, ...args]);
  containers.push(container);
  const output = docker(['start', '--attach', container], { timeout });
  assert.equal(docker(['inspect', container, '--format', '{{.State.ExitCode}}']), '0');
  return output;
}

async function waitFor(label, check, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(1000);
  }
  throw new Error(`${label} did not become ready within ${timeout / 1000}s.`);
}

async function main() {
  const architecture = docker(['image', 'inspect', image, '--format', '{{.Architecture}}']);
  assert.equal(architecture, 'arm64', 'Test the actual ARM64 app image.');
  directory = await mkdtemp(path.resolve(import.meta.dirname, '.smoke-'));
  const data = path.join(directory, 'data');
  await mkdir(data);
  const options = {
    public_url: 'https://happy.example.test',
    database_host: 'happy-db',
    database_port: 5432,
    database_name: 'happy',
    database_user: 'happy',
    database_password: password,
    storage_path: '/data',
  };
  await writeFile(path.join(data, 'options.json'), JSON.stringify(options), { mode: 0o600 });
  network = docker(['network', 'create', '--label', label, `happy-smoke-${id}`]);
  const database = docker(['run', '-d', '--name', `happy-pg18-${id}`,
    '--label', label, '--network', network, '--network-alias', 'happy-db',
    '--tmpfs', '/var/lib/postgresql:rw,size=512m',
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
    'postgres:18-alpine'], { environment: { POSTGRES_PASSWORD: adminPassword } });
  containers.push(database);
  await waitFor('PostgreSQL', () => {
    const result = spawnSync(dockerCommand, ['exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (result.error) throw result.error;
    return result.status === 0;
  });
  docker(['exec', '-i', database, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input: `CREATE ROLE happy LOGIN PASSWORD '${password}';\nCREATE DATABASE happy OWNER happy;\n`,
  });
  volume = docker(['volume', 'create', '--label', label, `happy-data-${id}`]);
  const app = docker(['create', '--name', `happy-app-${id}`, '--label', label,
    '--network', network, '-p', '127.0.0.1::3005',
    '--mount', `type=volume,source=${volume},target=/data`, image]);
  containers.push(app);
  const archive = path.join(directory, 'rootfs.tar');
  docker(['export', '--output', archive, app], { timeout: 180000 });
  const rootfsTarBytes = (await stat(archive)).size;
  assert.ok(rootfsTarBytes < 1_000_000_000,
    `Complete exported root filesystem exceeds the size limit: ${rootfsTarBytes} bytes.`);
  // GNU tar in the image handles Linux archive names that Windows tar rejects.
  const listing = runtimeCheck('tar', ['-tf', '/measure/rootfs.tar'], 120000,
    `type=bind,source=${directory},target=/measure,readonly`);
  const rootfsEntries = listing.split('\n').length;
  await rm(archive);
  console.log(`Exported root filesystem: ${rootfsTarBytes} bytes, ${rootfsEntries} entries.`);
  assert.match(runtimeCheck('python3', ['--version']), /Python 3/);
  assert.match(runtimeCheck('ffmpeg', ['-version']), /ffmpeg version/);
  const nativeChecks = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const sharp = require('sharp');
    const { PGlite } = require('@electric-sql/pglite');
    const { PrismaPGlite } = require('pglite-prisma-adapter');
    const { PrismaClient } = require('@prisma/client');
    (async () => {
      const png = await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();
      assert.equal((await sharp(png).metadata()).width, 2);
      assert.ok(require('@slopus/happy-wire'));
      for (const suffix of ['mjs', 'cjs']) {
        const adapter = fs.readFileSync(require.resolve('pglite-prisma-adapter').replace(/index\\.[cm]js$/, 'index.' + suffix), 'utf8');
        assert.ok(!/Uint8Array\\.from\\(\\s*\\{\\s*length:\\s*hexString\\.length/.test(adapter),
          'Upstream Bytes patch must survive pnpm deployment.');
      }
      const pg = new PGlite();
      const prisma = new PrismaClient({adapter:new PrismaPGlite(pg)});
      const rows = await prisma.$queryRawUnsafe("SELECT decode('6869', 'hex') AS bytes");
      assert.deepEqual(Array.from(rows[0].bytes), [104, 105]);
      await prisma.$disconnect();
      await pg.close();
      console.log('Prisma/PGlite byte roundtrip, sharp native image, happy-wire and patch checks passed.');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  console.log(runtimeCheck('node', ['-e', nativeChecks], 120000));
  docker(['cp', path.join(data, 'options.json'), `${app}:/data/options.json`]);
  docker(['start', app]);
  const binding = docker(['port', app, '3005/tcp']);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  let origin = `http://${binding}`;
  const ready = async () => {
    const state = JSON.parse(docker(['inspect', app, '--format', '{{json .State}}']));
    if (!state.Running) {
      throw new Error(`App exited before health: ${redact(docker(['logs', app]), secrets)}`);
    }
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch (error) {
      if (error.name === 'TimeoutError' || error.cause?.code === 'ECONNREFUSED' ||
          error.cause?.code === 'ECONNRESET' || error.cause?.code === 'UND_ERR_SOCKET') return false;
      throw error;
    }
  };
  await waitFor('Happy ARM64 HTTP health', ready);
  const tables = docker(['exec', database, 'psql', '-U', 'postgres', '-d', 'happy',
    '-Atc', "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"]);
  assert.ok(Number(tables) > 0, 'Migrations must create actual database tables.');
  const superuser = docker(['exec', database, 'psql', '-U', 'postgres', '-Atc',
    "SELECT rolsuper FROM pg_roles WHERE rolname='happy'"]);
  assert.equal(superuser, 'f');
  const unauthorized = await fetch(`${origin}/v1/sessions`, { signal: AbortSignal.timeout(5000) });
  assert.equal(unauthorized.status, 401);
  const publicKey = randomBytes(32).toString('base64');
  const statusPath = `/v1/auth/request/status?publicKey=${encodeURIComponent(publicKey)}`;
  const requestStatus = async () => {
    const response = await fetch(`${origin}${statusPath}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual(await requestStatus(), { status: 'not_found', supportsV2: false });
  const request = await fetch(`${origin}/v1/auth/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey, supportsV2: true }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(request.status, 200);
  assert.deepEqual(await request.json(), { state: 'requested' });
  assert.deepEqual(await requestStatus(), { status: 'pending', supportsV2: true });
  const secret = docker(['exec', app, 'cat', '/data/happy-master-secret']);
  assert.match(secret.trim(), /^[a-f0-9]{64}$/);
  secrets.push(secret.trim());
  assert.equal(docker(['exec', app, 'stat', '-c', '%a', '/data/happy-master-secret']), '600');
  docker(['restart', '--time', '10', app]);
  const restartedBinding = docker(['port', app, '3005/tcp']);
  assert.match(restartedBinding, /^127\.0\.0\.1:\d+$/);
  origin = `http://${restartedBinding}`;
  await waitFor('Happy restart', ready);
  assert.equal(docker(['exec', app, 'cat', '/data/happy-master-secret']), secret);
  assert.deepEqual(await requestStatus(), { status: 'pending', supportsV2: true });
  console.log(JSON.stringify({
    image,
    architecture,
    rootfsTarBytes,
    rootfsEntries,
    runtimeDependencies: 'Python, ffmpeg, native sharp, Prisma/PGlite Bytes and happy-wire passed',
    postgres: '18 / SCRAM',
    databaseRoleSuperuser: false,
    migrations: 'passed',
    publicTables: Number(tables),
    health: 'passed',
    unauthenticatedSessions: unauthorized.status,
    databaseReadWriteAndPersistence: 'passed',
    restartAndSecretPersistence: 'passed',
    tlsPhoneWebsocketAndBackup: 'not tested',
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(redact(error.message, secrets));
  for (const container of containers) {
    try {
      const state = docker(['inspect', container, '--format', '{{json .State}}']);
      const logs = docker(['logs', '--tail', '30', container]);
      console.error(redact(`Test container state: ${state}\n${logs}`, secrets));
    } catch (diagnosticError) {
      console.error(redact(`Container diagnostics failed: ${diagnosticError.message}`, secrets));
    }
  }
  process.exitCode = 1;
} finally {
  for (const container of containers.reverse()) {
    try { docker(['rm', '-f', container]); }
    catch (error) { console.error(redact(error.message, secrets)); process.exitCode = 1; }
  }
  if (network) {
    try { docker(['network', 'rm', network]); }
    catch (error) { console.error(redact(error.message, secrets)); process.exitCode = 1; }
  }
  if (volume) {
    try { docker(['volume', 'rm', volume]); }
    catch (error) { console.error(redact(error.message, secrets)); process.exitCode = 1; }
  }
  if (directory) await rm(directory, { recursive: true, force: true });
}

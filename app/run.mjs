import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const workdir = '/repo/packages/happy-server';

function requiredString(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Configure a nonempty ${name} option.`);
  }
  return value;
}

export function configuration(options, mountinfo = '') {
  const publicUrl = new URL(requiredString(options, 'public_url'));
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password ||
      publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new Error('public_url must be an HTTPS origin without credentials or a base path.');
  }
  const host = requiredString(options, 'database_host');
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) {
    throw new Error('database_host must be a DNS name or IPv4 address.');
  }
  const port = options.database_port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('database_port must be an integer between 1 and 65535.');
  }
  const database = requiredString(options, 'database_name');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database)) {
    throw new Error('database_name must be a PostgreSQL identifier without punctuation.');
  }
  const user = requiredString(options, 'database_user');
  const password = requiredString(options, 'database_password');
  const databaseUrl = new URL('postgresql://localhost');
  databaseUrl.hostname = host;
  databaseUrl.port = String(port);
  databaseUrl.username = encodeURIComponent(user);
  databaseUrl.password = encodeURIComponent(password);
  databaseUrl.pathname = `/${database}`;

  const storage = requiredString(options, 'storage_path');
  if (!path.posix.isAbsolute(storage) || path.posix.normalize(storage) !== storage ||
      !(storage === '/data' || storage.startsWith('/data/') || storage.startsWith('/media/'))) {
    throw new Error('storage_path must be a normalized absolute path inside /data or /media.');
  }
  if (storage.startsWith('/media/')) {
    const mounted = mountinfo.split('\n').some(line => {
      const [left, right] = line.split(' - ');
      if (!right) return false;
      const mountpoint = left.split(' ')[4]?.replace(/\\040/g, ' ').replace(/\\134/g, '\\');
      return mountpoint?.startsWith('/media/') && right.split(' ')[0] !== 'autofs' &&
        (storage === mountpoint || storage.startsWith(`${mountpoint}/`));
    });
    if (!mounted) {
      throw new Error('The external storage is not mounted; refusing to write to an SD fallback.');
    }
  }
  return {
    environment: {
      NODE_ENV: 'production',
      DB_PROVIDER: 'postgres',
      DATABASE_URL: databaseUrl.href,
      PUBLIC_URL: publicUrl.origin,
      PORT: '3005',
      DATA_DIR: storage,
      METRICS_ENABLED: 'false',
    },
    secrets: [password, encodeURIComponent(password), databaseUrl.href],
  };
}

export async function masterSecret(filename) {
  try {
    const value = (await fs.readFile(filename, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new Error('The persisted master secret is invalid; restore it rather than replacing it.');
    }
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const value = randomBytes(32).toString('hex');
  await fs.writeFile(filename, `${value}\n`, { flag: 'wx', mode: 0o600 });
  return value;
}

export function redact(line, secrets) {
  let result = line;
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
    if (secret) result = result.split(secret).join('[REDACTED]');
  }
  return result.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[DATABASE_URL REDACTED]');
}

export async function runChild(command, args, environment, secrets, cwd = workdir) {
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const forward = signal => child.kill(signal);
  const onTerm = () => forward('SIGTERM');
  const onInt = () => forward('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  for (const stream of [child.stdout, child.stderr]) {
    const lines = createInterface({ input: stream });
    lines.on('line', line => process.stdout.write(`${redact(line, secrets)}\n`));
  }
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  }
}

export async function main() {
  const options = JSON.parse(await fs.readFile('/data/options.json', 'utf8'));
  const mountinfo = await fs.readFile('/proc/self/mountinfo', 'utf8');
  const config = configuration(options, mountinfo);
  await fs.mkdir('/data', { recursive: true, mode: 0o700 });
  const secret = await masterSecret('/data/happy-master-secret');
  await fs.mkdir(config.environment.DATA_DIR, { recursive: true, mode: 0o700 });
  const environment = { ...process.env, ...config.environment, HANDY_MASTER_SECRET: secret };
  delete environment.REDIS_URL;
  delete environment.S3_HOST;
  const secrets = [...config.secrets, secret];
  process.stdout.write('Applying Happy PostgreSQL migrations.\n');
  const migration = await runChild(`${workdir}/node_modules/.bin/prisma`,
    ['migrate', 'deploy'], environment, secrets);
  if (migration.code !== 0 || migration.signal) {
    throw new Error('Database migrations did not complete; the server was not started.');
  }
  process.stdout.write('Starting Happy on internal HTTP port 3005.\n');
  const server = await runChild(`${workdir}/node_modules/.bin/tsx`,
    ['./sources/main.ts'], environment, secrets);
  if (server.signal) {
    process.exitCode = server.signal === 'SIGTERM' || server.signal === 'SIGINT' ? 0 : 1;
  } else {
    process.exitCode = server.code;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Child output is redacted separately; do not dump configuration or error objects.
    const safeErrors = /^(Configure |public_url |database_|storage_path |The external storage |The persisted master secret |Database migrations )/;
    const category = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : error.name;
    process.stderr.write(`Happy startup failed (${category}): ${safeErrors.test(error.message) ?
      error.message : 'check options, storage permissions and database connectivity.'}\n`);
    process.exitCode = 1;
  });
}

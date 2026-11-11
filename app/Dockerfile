ARG BUILD_FROM=happy-server-upstream:ea925c2c51a5afce9fbed0816ec1e785b50f37d7
FROM ${BUILD_FROM} AS deployment

WORKDIR /repo
# The upstream runtime omits these install inputs. Supply the same pinned source
# as a named build context, not a second unpinned checkout.
COPY --from=upstream-source /pnpm-lock.yaml /.npmrc /repo/
COPY --from=upstream-source /scripts /repo/scripts
COPY --from=upstream-source /patches /repo/patches
# tsx is upstream's production entry point despite being a devDependency.
# Pinned pnpm deploy otherwise includes both sharp libc variants. Exclude only
# the musl optional graph: this image and its tested native assets use glibc.
RUN node <<'NODE'
const fs = require('node:fs');
const file = 'packages/happy-server/package.json';
const server = JSON.parse(fs.readFileSync(file));
server.dependencies.tsx = server.devDependencies.tsx;
delete server.devDependencies.tsx;
fs.writeFileSync(file, JSON.stringify(server));
const root = JSON.parse(fs.readFileSync('package.json'));
Object.assign(root.pnpm.overrides, {
  'sharp>@img/sharp-libvips-linuxmusl-arm64': '-',
  'sharp>@img/sharp-linuxmusl-arm64': '-',
});
fs.writeFileSync('package.json', JSON.stringify(root));
NODE
RUN pnpm --filter happy-server --fail-if-no-match deploy --legacy --prod /runtime

WORKDIR /runtime
COPY --from=upstream-source /patches /runtime/patches
# Generate in the deployed graph: generated Prisma files are not npm payloads.
RUN . /etc/os-release && test "$VERSION_CODENAME" = bookworm \
    && pnpm exec prisma generate --schema=prisma/schema.prisma \
    && node patches/fix-pglite-prisma-bytes.cjs

# Keep complete package payloads and native engines; omit only JSON source maps
# and hardlink byte-identical files after all lifecycle generators and patches.
RUN node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const sizes = new Map();
const inodes = new Set();
let maps = 0, linked = 0, saved = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { walk(file); continue; }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.map')) {
      try {
        const map = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (map.version === 3 && Array.isArray(map.sources)) {
          fs.unlinkSync(file);
          maps++;
          continue;
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    const stat = fs.statSync(file);
    if (stat.size < 512 || inodes.has(stat.ino)) continue;
    inodes.add(stat.ino);
    const key = `${stat.size}:${stat.mode}:${stat.uid}:${stat.gid}`;
    const files = sizes.get(key) || [];
    files.push(file);
    sizes.set(key, files);
  }
}
walk('/runtime/node_modules');
for (const files of sizes.values()) {
  if (files.length < 2) continue;
  const hashes = new Map();
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const original = hashes.get(hash);
    if (original && bytes.equals(fs.readFileSync(original))) {
      fs.unlinkSync(file);
      fs.linkSync(original, file);
      linked++;
      saved += bytes.length;
    } else hashes.set(hash, file);
  }
}
console.log({ sourceMapsRemoved: maps, identicalFilesHardlinked: linked, duplicateBytesSaved: saved });
NODE

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl python3 ffmpeg \
    && rm -rf /var/lib/apt/lists/* /usr/local/include/node /usr/local/lib/node_modules /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && find /usr/lib/python3.11 -type d -name __pycache__ -prune -exec rm -rf '{}' +

LABEL io.hass.type="addon" io.hass.arch="aarch64" io.hass.version="0.1.1"
WORKDIR /repo/packages/happy-server
COPY --from=deployment /runtime ./
COPY run.mjs /opt/happy-ha/run.mjs
COPY UPSTREAM-LICENSE /opt/happy-ha/UPSTREAM-LICENSE

ENV NODE_ENV=production DB_PROVIDER=postgres PORT=3005 METRICS_ENABLED=false \
    PYTHONDONTWRITEBYTECODE=1
EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=6s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3005/health',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/happy-ha/run.mjs"]
CMD []

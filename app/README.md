# Happy Private Server

An unofficial aarch64 Home Assistant app wrapping the Happy backend pinned in
`upstream.json`. The app remains protected, starts manually, and does not
request Supervisor or Docker API access. It does not expose a frontend or
provide Home Assistant ingress.

## Configuration prerequisites

- Provision an external PostgreSQL database and dedicated database user.
  Supply `database_host`, `database_port`, `database_name`, `database_user` and
  `database_password` through the Home Assistant app configuration, not source
  files. Startup applies upstream database migrations before starting Happy.
- Set `public_url` to the HTTPS origin used by Happy clients, without a path,
  query, fragment or embedded credentials. Configure a separate trusted HTTPS
  proxy to reach internal HTTP port 3005 and support WebSocket connections.
  The host port is unpublished by default; this package does not configure
  networking, certificates or a proxy.
- Keep `storage_path` at `/data`, or choose a normalized path beneath `/media`
  on a genuinely mounted volume. External storage is rejected when its mount
  is absent, rather than silently falling back to local storage.

The wrapper creates and preserves `/data/happy-master-secret`. Back up this
secret, the PostgreSQL database and the selected data directory together.
Never publish them. Restore a damaged secret rather than generating a
replacement for an existing installation. Back up the database before app
updates because migrations may change its schema.

## Release and validation

See the [repository release instructions](../README.md). The published image
must match the manifest version and architecture. The dispatch-only workflow
runs `node --test app/run.test.mjs` before building. These wrapper tests do not
prove native image startup, database compatibility, HTTPS/WebSocket routing or
client synchronization; validate those separately before relying on deployment.

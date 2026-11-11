# Happy Server HA

An unofficial, personal Happy synchronization backend packaged as a protected
Home Assistant app for **aarch64 only**. It uses external PostgreSQL and a
separately configured HTTPS proxy; it does not provide a web frontend or
Home Assistant ingress.

Version 0.1.0 is published by the native ARM64 release workflow. Its anonymously
pullable image is `ghcr.io/devnagui/happy-server-ha-aarch64:0.1.0`, with digest
`sha256:11414a3614f8f13bc21d62c0fc0266a4652f18128cc31102c77a01b3da58209e`.
Publication does not prove a working installation: database provisioning,
HTTPS routing and real clients must be validated separately.
See [app configuration](app/README.md).

**Storage warning:** version 0.1.0 includes the full upstream runtime and can
consume substantially more host storage than its registry download size.
Do not install it on storage-constrained systems. A reduced-runtime release
is being prepared with an enforced exported-filesystem size gate.

## Release

The intended repository is
[`devnagui/Happy-Server-HA`](https://github.com/devnagui/Happy-Server-HA).
After an approved source publication, manually run **Publish ARM64 app**
from its GitHub Actions tab. There are no push, tag or scheduled triggers.

The workflow runs the wrapper tests, fetches the exact public upstream commit
in `app/upstream.json`, builds its exact `Dockerfile.server` on a native ARM64
runner, then builds `app/Dockerfile` using that local base. It authenticates to
GHCR using only the job's short-lived GitHub token. The app image receives the
repository source label for GHCR linkage.

The app build also requires the same pinned checkout as the named
`upstream-source` build context. The slim runtime deploys only the server's
dependency graph. Before publication, CI exports the complete root filesystem,
requires fewer than 1,000,000,000 bytes, and tests native dependencies,
PostgreSQL migrations, database writes and restart persistence.

Only the version read from `app/config.json` is pushed:
`ghcr.io/devnagui/happy-server-ha-aarch64:0.1.0` for the initial version.
No `latest` tag is produced. The job summary records the pushed digest.
Release a new version rather than overwriting an installed version; keep the
manifest and Dockerfile version label consistent.

Before installation, verify the successful workflow summary and set the GHCR
package visibility to public if needed. Repository visibility alone does not
guarantee anonymous image pulls. Add the repository URL to the Home Assistant
app store only after the image is publicly pullable.

## Publication boundary

Use an **explicit staged-file allowlist**, never a blanket add. Review both the
staged diff and staged filename list before any approved commit or publication.
The intended release files are:

- `.gitignore`, `README.md`, `repository.json`
- `.github/workflows/publish.yml`
- `app/.dockerignore`, `app/Dockerfile`, `app/config.json`
- `app/upstream.json`, `app/run.mjs`, `app/run.test.mjs`, `app/README.md`
- `app/smoke.mjs`
- `app/UPSTREAM-LICENSE`

Private planning and deployment notes are excluded by `.gitignore`. Ignore
rules do not remove previously tracked files and are not a security review:
audit every allowlisted file for local identifiers, credentials and unrelated
content before publishing. Additional files require a separate review.

Upstream source and licensing remain with
[`slopus/happy`](https://github.com/slopus/happy) at the pinned revision;
its MIT notice is included verbatim in `app/UPSTREAM-LICENSE` and the image.
Review redistribution obligations for the complete dependency set before
publishing images.

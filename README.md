# Happy Server HA

An unofficial, personal Happy synchronization backend packaged as a protected
Home Assistant app for **aarch64 only**. It uses external PostgreSQL and a
separately configured HTTPS proxy; it does not provide a web frontend or
Home Assistant ingress.

This is release scaffolding, not evidence of a published image or a verified
installation. Database provisioning, HTTPS routing, client configuration and
deployment must be completed separately. See [app configuration](app/README.md).

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

# Shipping a release

Every change ships. There is no local preview: you publish the engine to PyPI, update
the Executa and the App on Anna, and play it through your local Anna Agent
(see `anna-agent/README.md`).

The `anna-app` CLI runs via npx, nothing to install (login persists in `~/.config/anna`):

```sh
npx -y @anna-ai/cli login --host https://anna.partners --no-browser   # once per machine
```

## 1. Bump the version (lockstep)

One version string everywhere. Update all of:

| File | Field |
|---|---|
| `backend/pyproject.toml` | `[project].version` |
| `backend/app/executa.py` | `VERSION` |
| `backend/executa.json` | `version` |
| `executa-manifest.json` | `version` |
| `manifest.publish.json` | `required_executas[].min_version` + `version` |
| `backend/tests/test_executa_packaging.py` | `VERSION` |
| `backend/tests/test_executa_native.py` | version assertion |

`test_executa_packaging.py` fails if pyproject and executa.json drift, so run the
backend suite after bumping.

Note: Anna content-hashes the executa descriptor, not the wheel. A code-only release
still needs the version bump or the publish dedups into a no-op.

## 2. Test

```sh
cd backend && .venv/bin/python -m pytest
cd frontend && npm test
```

## 3. Build and publish the engine (PyPI)

The token lives in `.env.publish` at the repo root (gitignored; copy it from
`.env.publish.example` and paste your real PyPI token). Publishing to PyPI is
irreversible: a version number, once uploaded, can never be reused.

```sh
cd backend
uv build                                   # dist/tool_gamentic_engine_7h8aweky-<ver>-py3-none-any.whl
set -a; . ../.env.publish; set +a          # loads PYPI_TOKEN, never committed
uv publish --token "$PYPI_TOKEN" dist/*<ver>*
```

Publish the wheel BEFORE the executa (step 4): the executa's uv distribution pins
`tool-gamentic-engine-7h8aweky==<version>`, so if that version is not on PyPI yet,
Install Essentials fails with a uv resolve error.

## 4. Update the Executa on Anna

Auth is the saved PAT (`npx -y @anna-ai/cli whoami` to check; `login` if it expired).
Dry-run first: it resolves identity and diffs without uploading.

```sh
cd backend
npx -y @anna-ai/cli executa publish --dry-run   # resolves executa_id=1025, prints "would POST version <ver>"
npx -y @anna-ai/cli executa publish             # reads executa.json; identity pinned by backend/.anna/executa.json
```

`backend/.anna/executa.json` is the local identity cache (gitignored). It holds
`executa_id=1025` + `tool_id=tool-gamentic-engine-7h8aweky`; if it is missing the CLI
re-mints the same identity via the idempotency key.

Order matters: publish the PyPI wheel at the SAME version FIRST (step 3). The uv
distribution pins `package_name==<version>`, so an executa that points at a PyPI version
that does not exist makes Install Essentials fail with a uv resolve error.

If `host_capabilities` or other manifest fields changed, also paste the updated
`executa-manifest.json` into the Executa's MANIFEST field on the Anna console
(`/executa`, New Version).

## 5. Update the App on Anna

The app is `app_id=19`, slug `gamentic-anna`. `apps push` defaults to a `manifest.json`
and a `./bundle` UI dir, but this repo keeps the manifest as `manifest.publish.json` and
the static SPA in `frontend/`, so pass both explicitly.

`--bundle-dir` uploads the WHOLE directory and caps at 2000 files. `frontend/` carries
`node_modules` (5000+ files), so pointing it there fails with "too many bundle files".
Stage a clean copy of just the SPA runtime first (index.html + styles.css + src/ +
themes/ + vendor/, about 36 files), then push that. Dry-run first.

```sh
# from the repo root
rm -rf .bundle && mkdir .bundle
cp -r frontend/index.html frontend/styles.css frontend/src frontend/themes frontend/vendor .bundle/

npx -y @anna-ai/cli apps push --manifest manifest.publish.json --bundle-dir .bundle --dry-run
npx -y @anna-ai/cli apps push --manifest manifest.publish.json --bundle-dir .bundle   # upsert working draft (no freeze)
npx -y @anna-ai/cli apps cut <version> --slug gamentic-anna                            # freeze working draft -> immutable version
npx -y @anna-ai/cli apps release <version> --slug gamentic-anna                        # publish that version live
```

(`.bundle/` is a throwaway staging dir, gitignored.)

Confirm with `npx -y @anna-ai/cli apps status gamentic-anna` (want `latest: v<version>`).
`.anna/app.json` is the local identity cache (gitignored); the CLI still resolves
`app_id=19` from the slug in `app.json`.

## 6. Verify live

Restart the local Agent container if it is running, Install Essentials again so the
Agent picks up the new engine version, open the app, and play one turn.

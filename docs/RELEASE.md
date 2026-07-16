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

```sh
cd backend
uv build                                   # dist/tool_gamentic_engine_7h8aweky-<ver>-py3-none-any.whl
uv publish --token "$PYPI_TOKEN" dist/*<ver>*
```

## 4. Update the Executa on Anna

```sh
cd backend
npx -y @anna-ai/cli executa publish        # reads executa.json; identity pinned by .anna/executa.json
```

If `host_capabilities` or other manifest fields changed, also paste the updated
`executa-manifest.json` into the Executa's MANIFEST field on the Anna console
(`/executa`, New Version).

## 5. Update the App on Anna

```sh
npx -y @anna-ai/cli apps push              # uploads the frontend bundle (manifest.publish.json)
npx -y @anna-ai/cli apps cut               # mirrors assets and cuts the app version
```

## 6. Verify live

Restart the local Agent container if it is running, Install Essentials again so the
Agent picks up the new engine version, open the app, and play one turn.

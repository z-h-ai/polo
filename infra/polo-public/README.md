# Polo Public Deployment

Deploy these services in the dedicated `polo-public` project on `Polo-release`. Do not place them in `Polo-server` or the existing `polo-admin` project.

| Service | Image/build | Volume | Public domain |
| --- | --- | --- | --- |
| `updates-static` | `infra/updates-static/Dockerfile` (loads `PoloCaddyfile`) | `/data/releases`, 15 GB | `updates.polo.z-h-ai.com` |
| `electron-release-publisher` | `infra/electron-release-publisher/Dockerfile` initially; CI replaces it with a temporary publisher context | existing releases PVC at `/data/releases` | none |
| `polo-public-api` | `infra/polo-public/Dockerfile.public-api` | none | `app.polo.z-h-ai.com` |
| `postgresql` | PostgreSQL 16 | database data, 10 GB | private network only |

Set `DATABASE_URL` on `polo-public-api` to the private PostgreSQL service URL. Set `OAUTH_RELAY_ALLOWED_CALLBACKS` to a comma-separated list of registered HTTPS origin/path pairs, for example `https://webui.example.com/api/oauth/callback`. Set `OAUTH_RELAY_ALLOW_LOOPBACK=true` only for the internal testing phase. The API stores each OAuth relay state in PostgreSQL for ten minutes and consumes it once; expired states and 90-day shares are purged hourly during write traffic. Register `https://app.polo.z-h-ai.com/auth/callback` with Google and Microsoft, and `https://app.polo.z-h-ai.com/auth/slack/callback` with Slack.

Before a Zeabur CLI deployment, run `bun run viewer:build`, `bun run public-api:build`, and copy `apps/public-api/.build/polo-public-api` to `infra/polo-public/runtime/polo-public-api`. Zeabur's uploader omits hidden build directories, so the runtime copy is the explicit deployment artifact. Its route ordering is enforced in `apps/public-api/src/app.ts`: `/s/api/*` is handled before `/s/*`, and Viewer assets are served before the SPA fallback.

Bind the domains after creating services:

```sh
zeabur domain create --id <updates-static-service-id> --env-id <env-id> --domain updates.polo.z-h-ai.com --yes
zeabur domain create --id <polo-public-api-service-id> --env-id <env-id> --domain app.polo.z-h-ai.com --yes
zeabur service network --id <service-id> --env-id <env-id>
```

Create the returned CNAME records at the DNS provider, then verify Zeabur HTTPS issuance. Create the publisher placeholder from `infra/electron-release-publisher`, then use the Zeabur console to attach the existing 15 GiB releases PVC at `/data/releases`. The CLI cannot currently attach an existing PVC. Do not delete the old suspended service holding that volume until the mount and ownership have been verified.

Configure a protected GitHub `production` Environment with required reviewers. Store `ZEABUR_TOKEN` as an Environment secret, and `ZEABUR_PROJECT_ID`, `ZEABUR_ENVIRONMENT_ID`, and `ZEABUR_PUBLISHER_SERVICE_ID` as Environment variables. Signing secrets remain repository secrets; the reusable build receives only the named macOS/Windows credentials and never receives the Zeabur token. Configure the signing identity variables referenced by `.github/workflows/electron-artifact-full.yml`.

`v0.15.2` is the sole bootstrap release. Push its tag only after root and Electron versions both equal `0.15.2`. The tag workflow builds and validates all three signed packages, creates a Draft GitHub Release, pauses at the `production` Environment, deploys the temporary publisher context, verifies the public bytes, then publishes the GitHub Release. Later versions derive the previous release tag, commit, names, and hashes from the public release contract and exercise the real cross-version upgrade path automatically.

The publisher rejects projected volume use above 70%, validates the fixed release contract plus every YAML size and hash, serializes writers with a PVC lock, rejects downgrades and conflicting same-version retries, atomically switches `electron/latest`, and keeps the newest three release directories. Public verification failure restores the exact pre-release link. Use the manual `Roll Back Electron Update Pointer` workflow to repoint `latest` to a retained version; rollback never deletes binaries. The scheduled validation workflow has read-only GitHub permissions and no Zeabur credentials or PVC path.

The public contract is `https://updates.polo.z-h-ai.com/electron/latest/release-contract.json`. It and `latest*.yml` use `Cache-Control: no-cache`; installer bytes under `latest` and version directories use one-year immutable caching. The service accepts only GET and HEAD and returns 405 for mutation methods.

There is intentionally no `/docs` deployment in this setup until an approved documentation export is supplied. `mcp.polo.ai` remains a separate migration and is not hosted by these services. No offsite backup is configured for the internal-test launch; the release volume and share database are therefore a single-server loss risk.

# pragmatica-ai-v2

Thin purchasing-assistant project built on the versioned platform packages
`@business-ai/core`, `@business-ai/adapters`, `@business-ai/testing`, `@business-ai/eval`.
The platform (runtime, services, gateway, monitoring) lives in `business-ai`; this repository
holds only what is specific to the project. Russian version: [README.ru.md](README.ru.md).

## Layout

| Path | What it is |
|---|---|
| `src/project.ts` | project manifest (`defineProject`): agents, models, config schema, access actions |
| `src/agents/` | agents and their closure, **generated** by `tools/sync-agents.sh` |
| `prompts/` | reserved for gateway-side prompts (stage 10) |
| `db/app/` | project migrations (stream `app`), `db/legacy-map.tsv` maps old migration versions |
| `config/` | dictionaries and PII patterns for the services' `/config`, access-policy sample |
| `deploy/` | `compose.yml` (project `pragmatika`), `.env.example` |
| `eval/`, `e2e/` | eval cases and recordings, end-to-end scenarios |
| `tools/` | `sync-agents.sh` and its helpers, baseline helpers |
| `tools/build-app-image.sh` | builds, pushes and signs the `app` image on the platform base image and writes the project `images.lock` (test: `tools/build-app-image.test.sh`) |

## Do not edit `src/agents/**` by hand

Everything under `src/agents/**` and `tests/agents/**` is overwritten by
`tools/sync-agents.sh <commit of the old repository>`. Until the switch (stage 8) agents are
developed in the old repository only. If v2 needs a different shape of a file, change the
rewrite rules in `tools/sync-agents.sh` / `tools/sync_agents.py`, the patches in
`tools/overrides/`, or the manifest — never the generated file. `tools/sync-agents.sh` records
a checksum of every generated file in `tools/sync-manifest.tsv`; the test
`tests/sync-guard.test.ts` fails if a generated file was edited by hand.

## Checks

```
export BAI_NPM_REGISTRY=http://127.0.0.1:24873/   # local development registry
bun install
bun run typecheck
bun test
```

## Project code that stands in for platform hooks

The platform does not yet offer some hooks the old core had; the project restores that behaviour
in its own files (each gap is described in the release notes of the stage as a platform patch
request):

| File | What it restores |
|---|---|
| `src/legacy-tools.ts`, `src/legacy-tool-texts.ts` | tool descriptions/schemas and shared prompt blocks exactly as the agents showed them to the model |
| `src/lifecycle-disk-sync.ts`, `src/background-*.ts` | closing of unreported disk-sync runs; owner commands `bun run src/background-cli.ts <mail-info-backfill\|mail-trust-survey\|crm-suppliers-sync>` |
| `src/mail-sender-lookup.ts` | mail senders admitted by the supplier base |
| `src/adapters/deal-*.ts` | purchase request parsed from a CRM deal (`BITRIX24_DEAL_FIELD_MAP`) |

# subgraphs-storage-exporter — context

Zero-dependency Bun Prometheus exporter for per-subgraph on-disk footprint. One file: `src/index.ts`.
Pure aggregation (`buildMetrics`) is exported and unit-tested; the poll loop + `Bun.serve` only run
under `import.meta.main`. Uses Bun's built-in `SQL` (postgres) → base image must be Bun ≥ 1.2
(`oven/bun:1.4.3-alpine`, NOT the `1.1` the sibling exporters pin).

## Why this exists

Restores per-subgraph disk (the retired estimator's one feature with no metric replacement). graph-node
stores each deployment in an `sgd<N>` Postgres schema across a sharded backend; nothing exposes
per-deployment size as a metric, so we query Postgres: `public.deployment_schemas` on the primary
(sgd→deployment+shard) joined to `pg_total_relation_size()` per `sgd<N>` schema on each data shard.

Single responsibility on purpose (Denis prefers this over catch-all exporters). Sees EVERY physical
`sgd` schema — broader than the network-exporter, which only knows our on-chain allocations.

## Ecosystem

- `../subgraphs-network-exporter` — on-chain economics (network subgraph GraphQL). Mirrors its structure.
- `../subgraphs-qos-exporter` — gateway QoS feed.
- `../k8s-subgraphs` — Flux cluster. Per-chain stacks under `chains/<chain>/` (each a graph-node +
  Postgres); shared primary `postgres-0.postgres.subgraphs` holds `deployment_schemas`. Deploy manifest
  lives here (pinax2 or a storage-exporter dir); wire `SHARD_HOSTS` to every data-shard Postgres.
- `../subgraphs-grafana` — the 📋 table's Disk column reads `subgraph_disk_bytes`.

## Deploy flow

Push to `main` → CI (`docker.yml`) type-checks, `bun test`, builds & pushes
`ghcr.io/pinax-network/subgraphs-storage-exporter:latest`. k8s Deployment pulls it; Flux rolls out.
Postgres password: currently `estimator-secrets`/`POSTGRES_PASSWORD` (the secret survived the estimator
app removal); moving to public envs — update the deployment when that lands.

## Postgres topology (k8s-subgraphs, 2026-07)

Shared primary `postgres-0.postgres.subgraphs` (mapping) + data shards across namespaces:
`postgres-2.postgres.subgraphs` (arbitrum_a), `postgres-core-0.postgres-core` (core_a: network/TAP/epoch),
`postgres-2.postgres.subgraphs-mainnet` (mainnet_a), `ens-postgres-0` / `lido-postgres-0`
(subgraphs-mainnet), plus per-chain `postgres-2.postgres.subgraphs-{bsc,base,matic,linea}`. Keep
`SHARD_HOSTS` in lock-step as chains are added. `blockcacheshard_a` (postgres-3) is block cache, NOT
subgraph data — exclude it.

## Conventions

- Dependency-free at runtime (Bun built-ins only). Types-only devDeps.
- Failed refresh keeps last-good metrics and flips `_up` to 0; fast-retry 30s.
- Sizing is a metadata lookup (`pg_total_relation_size`), not a scan — cheap; refresh 300s.
- Commit trailers: `Co-Authored-By: Claude ...` and `Claude-Session:`.

## Dependencies

- Bun only, 1.4.3 or later (install: `curl -fsSL https://bun.com/install | bash -s "bun-v1.4.3"`): `package.json` sets `packageManager` and `devEngines`, so npm refuses to install or run scripts here. Use `bun install`, `bun run <script>` and `bun add <pkg>`.
- CI installs with `bun install --frozen-lockfile`; the Docker image has no install step (no runtime dependencies). Commit `bun.lock` with every dependency change.
- `bunfig.toml` lets `bun add` and `bun update` pick only versions published at least 5 days ago (`minimumReleaseAge = 432000`, in seconds), saves exact versions and disables runtime auto-install. `.npmrc` sets `min-release-age=5` (in days) for any npm still in use.
- Never download a tool on the fly (`npx <pkg>`, `bunx <pkg>`, `<pkg>@latest`): add it as a pinned devDependency and run `bunx --no-install <bin>`.
- No Dependabot or Renovate: update dependencies by hand and review the `bun.lock` diff.

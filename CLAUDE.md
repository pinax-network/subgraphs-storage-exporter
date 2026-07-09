# subgraphs-storage-exporter — context

Zero-dependency Bun Prometheus exporter for per-subgraph on-disk footprint. One file: `src/index.ts`.
Pure aggregation (`buildMetrics`) is exported and unit-tested; the poll loop + `Bun.serve` only run
under `import.meta.main`. Uses Bun's built-in `SQL` (postgres) → base image must be Bun ≥ 1.2
(`oven/bun:1-alpine`, NOT the `1.1` the sibling exporters pin).

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

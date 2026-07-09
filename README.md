# subgraphs-storage-exporter

Prometheus exporter for **per-subgraph on-disk footprint**. graph-node stores every deployment in its
own `sgd<N>` Postgres schema across a sharded backend; no graph-node or Postgres metric exposes
per-deployment size, so this queries Postgres directly (exactly what the retired estimator did).

Zero-dependency [Bun](https://bun.sh) app (Bun's built-in SQL). Sibling to
[`subgraphs-network-exporter`](https://github.com/pinax-network/subgraphs-network-exporter) (on-chain
economics) and [`subgraphs-qos-exporter`](https://github.com/pinax-network/subgraphs-qos-exporter)
(gateway QoS). **Single responsibility: storage footprint.**

Unlike the network-exporter (which only knows our on-chain allocations), this sees **every** `sgd<N>`
schema physically present — synced or not, allocated or not.

## Metrics

| Metric | Labels | Meaning |
|---|---|---|
| `subgraph_disk_bytes` | `deployment`, `shard`, `schema` | On-disk size of a deployment's `sgd<N>` schema (tables + indexes + TOAST) |
| `shard_db_bytes` | `host` | Total `sgd`-schema bytes per Postgres host |
| `subgraphs_storage_exporter_up` | — | `1` after the first good refresh |
| `subgraphs_storage_exporter_last_refresh_seconds` | — | unix ts of the last refresh attempt |
| `subgraphs_storage_exporter_deployments` | — | number of deployments sized |

## How it works

1. Read `public.deployment_schemas` on the **primary** → `sgd<N>` schema → deployment (IPFS hash) + shard.
2. `sum(pg_total_relation_size())` per `sgd<N>` schema on **each** data shard (a metadata lookup, not a scan).
3. Join → `subgraph_disk_bytes{deployment}` (the Grafana 📋 table's Disk column).

## Configuration

| Var | Default | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | — | **required** |
| `POSTGRES_USER` | `graph` | |
| `POSTGRES_DB` | `graph` | |
| `PRIMARY_HOST` | `postgres-0.postgres.subgraphs:5432` | holds `public.deployment_schemas` |
| `SHARD_HOSTS` | = `PRIMARY_HOST` | comma-separated `host:port` of every Postgres holding `sgd` data |
| `REFRESH_SECONDS` | `300` | disk moves slowly |
| `PORT` | `9402` | HTTP listen port |

## Run

```sh
bun install          # dev deps only (types); the app itself has none
POSTGRES_PASSWORD=… bun run start   # serves /metrics and /healthz on :9402
bun test             # unit tests for the pure aggregation
bun run typecheck
```

## Endpoints

- `GET /metrics` (and `/`) — Prometheus text exposition
- `GET /healthz` — `200 ok` once the first refresh succeeds, else `503 degraded`

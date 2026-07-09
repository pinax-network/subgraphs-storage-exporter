// subgraphs-storage-exporter — serve per-subgraph on-disk footprint as Prometheus metrics.
//
// graph-node stores every deployment in its own `sgd<N>` Postgres schema, spread across a sharded
// backend (a shared primary + per-chain/dedicated data shards). No graph-node or Postgres metric
// exposes per-deployment size, so we query Postgres directly — exactly what the retired estimator did:
//   1. read public.deployment_schemas on the PRIMARY  → sgd<N> schema → deployment (IPFS hash) + shard
//   2. sum pg_total_relation_size() per sgd<N> schema on EACH data shard
//   3. join → subgraph_disk_bytes{deployment} (the 📋 table's Disk column) + shard_db_bytes{host}
//
// Covers EVERY schema physically present (synced or not) — a broader domain than the network-exporter,
// which only knows our on-chain allocations. Single responsibility: storage footprint.
//
// Runtime dep: Bun's built-in SQL (postgres). Pure aggregation helpers are exported for `bun test`.
import { SQL } from "bun";

const USER = process.env.POSTGRES_USER ?? "graph";
const DB = process.env.POSTGRES_DB ?? "graph";
const PASSWORD = process.env.POSTGRES_PASSWORD ?? "";
// The shared primary holds public.deployment_schemas (the sgd<N> → deployment mapping for ALL shards).
const PRIMARY_HOST = process.env.PRIMARY_HOST ?? "postgres-0.postgres.subgraphs:5432";
// Every Postgres that holds sgd<N> data (host:port, comma-separated). Include the primary if it also
// holds deployments. Kept explicit (not auto-discovered) so the topology is visible in the manifest.
const SHARD_HOSTS = (process.env.SHARD_HOSTS ?? PRIMARY_HOST)
  .split(",").map((s) => s.trim()).filter(Boolean);
const REFRESH_MS = Number(process.env.REFRESH_SECONDS ?? 300) * 1000;   // disk moves slowly
const PORT = Number(process.env.PORT ?? 9402);

const dsn = (host: string) => `postgres://${USER}:${encodeURIComponent(PASSWORD)}@${host}/${DB}`;

// sgd<N> → deployment IPFS hash + shard, from the primary's mapping table.
const MAPPING_SQL =
  "SELECT subgraph AS deployment, name AS schema, shard FROM public.deployment_schemas";
// Per-sgd-schema on-disk size. pg_total_relation_size over ordinary tables already folds in their
// indexes + TOAST; add materialized views. Metadata-only lookup — no table scan.
const SIZE_SQL =
  "SELECT n.nspname AS schema, COALESCE(sum(pg_total_relation_size(c.oid)),0)::bigint AS bytes " +
  "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "WHERE n.nspname ~ '^sgd[0-9]+$' AND c.relkind IN ('r','m') GROUP BY n.nspname";

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

export type MapRow = { deployment: string; schema: string; shard: string };
export type SizeRow = { schema: string; bytes: number | string | bigint };
export type HostSizes = { host: string; rows: SizeRow[] };

// Pure: join the mapping with per-host schema sizes → Prometheus exposition + a deployment count.
export function buildMetrics(mapping: MapRow[], sizes: HostSizes[]): { text: string; deployments: number } {
  const sizeBySchema = new Map<string, number>();
  const bytesByHost = new Map<string, number>();
  for (const { host, rows } of sizes) {
    let hostTotal = 0;
    for (const r of rows) {
      const b = Number(r.bytes) || 0;
      sizeBySchema.set(r.schema, (sizeBySchema.get(r.schema) ?? 0) + b);   // a schema lives on one host; sum is defensive
      hostTotal += b;
    }
    bytesByHost.set(host, hostTotal);
  }
  const out = [
    "# HELP subgraph_disk_bytes On-disk size of a deployment's sgd schema (tables + indexes + TOAST)",
    "# TYPE subgraph_disk_bytes gauge",
  ];
  let n = 0;
  const seen = new Set<string>();
  for (const m of mapping) {
    const b = sizeBySchema.get(m.schema);
    if (b === undefined || seen.has(m.deployment)) continue;   // no data for this schema, or dup deployment row
    seen.add(m.deployment);
    out.push(`subgraph_disk_bytes{deployment="${esc(m.deployment)}",shard="${esc(m.shard)}",schema="${esc(m.schema)}"} ${b}`);
    n++;
  }
  out.push("# HELP shard_db_bytes Total sgd-schema bytes per Postgres host (data shard)",
    "# TYPE shard_db_bytes gauge");
  for (const [host, b] of bytesByHost) out.push(`shard_db_bytes{host="${esc(host)}"} ${b}`);
  return { text: out.join("\n") + "\n", deployments: n };
}

// ── runtime ──────────────────────────────────────────────────────────────────────────────────────
async function queryHost(host: string, text: string): Promise<any[]> {
  const sql = new SQL({ url: dsn(host), max: 2, idleTimeout: 10, connectionTimeout: 15 });
  try { return await sql.unsafe(text); } finally { await sql.end({ timeout: 5 }); }
}

let block = "";
let up = 0, lastRefresh = 0, deployments = 0;

async function refresh(): Promise<void> {
  try {
    const mapping = (await queryHost(PRIMARY_HOST, MAPPING_SQL)) as MapRow[];
    const sizes: HostSizes[] = [];
    for (const host of SHARD_HOSTS) {
      try { sizes.push({ host, rows: (await queryHost(host, SIZE_SQL)) as SizeRow[] }); }
      catch (e) { console.error(`size ${host}: ${e}`); }
    }
    if (!sizes.length) throw new Error("no shard reachable");
    const { text, deployments: n } = buildMetrics(mapping, sizes);
    block = text; deployments = n; up = 1;
    console.log(`refreshed: ${mapping.length} mapped, ${n} sized deployments across ${sizes.length}/${SHARD_HOSTS.length} hosts`);
  } catch (e) {
    up = 0; console.error(`refresh error: ${e}`);
  }
  lastRefresh = Math.floor(Date.now() / 1000);
}

function body(): string {
  return block +
    "# TYPE subgraphs_storage_exporter_up gauge\n" + `subgraphs_storage_exporter_up ${up}\n` +
    "# TYPE subgraphs_storage_exporter_last_refresh_seconds gauge\n" + `subgraphs_storage_exporter_last_refresh_seconds ${lastRefresh}\n` +
    "# TYPE subgraphs_storage_exporter_deployments gauge\n" + `subgraphs_storage_exporter_deployments ${deployments}\n`;
}

if (import.meta.main) {
  if (!PASSWORD) { console.error("POSTGRES_PASSWORD is required"); process.exit(1); }
  // Fast-retry (30s) after a failure so a transient DB blip never leaves us stale for long and never
  // fails a k8s rollout (readiness gates on /healthz → the first good refresh).
  (async function loop() { await refresh(); setTimeout(loop, up ? REFRESH_MS : 30_000); })();

  Bun.serve({
    port: PORT,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/metrics" || path === "/")
        return new Response(body(), { headers: { "content-type": "text/plain; version=0.0.4" } });
      if (path === "/healthz")
        return new Response(up ? "ok" : "degraded", { status: up ? 200 : 503 });
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`storage-exporter on :${PORT} — primary=${PRIMARY_HOST} shards=${SHARD_HOSTS.length} refresh=${REFRESH_MS / 1000}s`);
}

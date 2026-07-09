import { expect, test } from "bun:test";
import { esc, buildMetrics } from "../src/index.ts";

test("esc: escapes label-breaking characters", () => {
  expect(esc('a "b"')).toBe('a \\"b\\"');
  expect(esc(null)).toBe("");
});

test("buildMetrics: joins mapping to per-host schema sizes", () => {
  const mapping = [
    { deployment: "Qm1", schema: "sgd1", shard: "arbitrum_a" },
    { deployment: "Qm2", schema: "sgd2", shard: "mainnet_a" },
    { deployment: "Qm3", schema: "sgd3", shard: "arbitrum_a" },   // no size row → skipped
  ];
  const sizes = [
    { host: "h1", rows: [{ schema: "sgd1", bytes: "1000" }] },
    { host: "h2", rows: [{ schema: "sgd2", bytes: 2500 }] },
  ];
  const { text, deployments } = buildMetrics(mapping, sizes);
  expect(deployments).toBe(2);
  expect(text).toContain('subgraph_disk_bytes{deployment="Qm1",shard="arbitrum_a",schema="sgd1"} 1000');
  expect(text).toContain('subgraph_disk_bytes{deployment="Qm2",shard="mainnet_a",schema="sgd2"} 2500');
  expect(text).not.toContain('deployment="Qm3"');           // no size → not emitted
  expect(text).toContain('shard_db_bytes{host="h1"} 1000');
  expect(text).toContain('shard_db_bytes{host="h2"} 2500');
});

test("buildMetrics: dedups repeated deployment rows and tolerates bigint strings", () => {
  const mapping = [
    { deployment: "Qm1", schema: "sgd1", shard: "a" },
    { deployment: "Qm1", schema: "sgd1", shard: "a" },   // duplicate mapping row
  ];
  const sizes = [{ host: "h", rows: [{ schema: "sgd1", bytes: 9007199254740993n as unknown as bigint }] }];
  const { text, deployments } = buildMetrics(mapping, sizes);
  expect(deployments).toBe(1);
  expect((text.match(/subgraph_disk_bytes\{/g) || []).length).toBe(1);
});

test("buildMetrics: empty inputs render only the HELP/TYPE headers", () => {
  const { text, deployments } = buildMetrics([], []);
  expect(deployments).toBe(0);
  expect(text).toContain("# TYPE subgraph_disk_bytes gauge");
});

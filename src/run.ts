import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import { runPipeline } from "./graph.js";
import type { Audience } from "./types.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

async function main(): Promise<void> {
  loadDotenv({ path: resolve(ROOT, ".env") });

  const audienceRaw = await readFile(resolve(ROOT, "audience.yaml"), "utf-8");
  const aud = parseYaml(audienceRaw) as Audience;

  const outPath = resolve(ROOT, "output/latest.md");
  const metricsPath = resolve(ROOT, "store/metrics.jsonl");

  const { passed, verdicts, metrics } = await runPipeline(aud, {
    baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY || undefined,
    model: process.env.MODEL ?? "gpt-4o-mini",
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || undefined,
    outPath,
    metricsPath,
  });

  await mkdir(dirname(metricsPath), { recursive: true });
  for (const record of metrics) {
    await appendFile(metricsPath, `${JSON.stringify(record)}\n`, "utf-8");
  }
  for (const verdict of verdicts.filter((v) => !v.pass)) {
    await appendFile(
      metricsPath,
      `${JSON.stringify({ ts: new Date().toISOString(), stage: "verdict-fail", count: 0, detail: `${verdict.id}:${verdict.reason}` })}\n`,
      "utf-8",
    );
  }

  console.log(`선정 ${passed.length}건, 검수 실패 ${verdicts.filter((v) => !v.pass).length}건`);
  console.log(`발행 파일: ${outPath}`);
  console.log(`기록: ${metricsPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

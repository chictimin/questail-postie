import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import { runPipeline } from "./graph.js";
import { collectSteamNews, fetchAppMeta } from "./collect/steam.js";
import { collectRss } from "./collect/rss.js";
import { buildProfile } from "./personalize.js";
import { filterNews, rankFinal } from "./select.js";
import type { Audience } from "./types.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

const HELP = `사용법: pnpm start [--dry-run] [--help]

  --dry-run  수집·선별까지만 실행 (요약·검수·발행 스킵, 파일 기록 없음)
  --help     이 도움말 출력`;

function parseArgs(argv: string[]): { dryRun: boolean } {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    }
  }
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--") continue;
    else {
      console.error(`알 수 없는 옵션: ${arg}\n${HELP}`);
      process.exit(1);
    }
  }
  return { dryRun };
}

async function dryRun(aud: Audience): Promise<void> {
  const appIds = [...new Set([...aud.library_appids, ...aud.wishlist_appids])];
  const [steamItems, rssItems] = await Promise.all([
    collectSteamNews(appIds, aud.steam_news_count),
    collectRss([...aud.reddit_feeds, ...aud.press_feeds], aud.batch.pool),
  ]);
  const meta = new Map<number, { name: string; genres: string[]; keywords: string[] }>();
  await Promise.all(
    appIds.map(async (id) => {
      meta.set(id, await fetchAppMeta(id));
    }),
  );
  const profile = buildProfile(aud, meta);
  const rawItems = [...steamItems, ...rssItems];
  const filtered = filterNews(rawItems, aud);
  const final = rankFinal(filtered, profile, aud);
  console.log(
    `dry-run: 수집 ${rawItems.length}건(steam=${steamItems.length} rss=${rssItems.length}) → 풀 ${filtered.length}건 → 선별 ${final.length}건 (mode=${profile.mode})`,
  );
  for (const item of final) {
    console.log(`- score=${item.score} [${item.labels.join("+")}] ${item.title}`);
  }
}

async function main(): Promise<void> {
  const { dryRun: isDryRun } = parseArgs(process.argv.slice(2));
  loadDotenv({ path: resolve(ROOT, ".env") });

  const audienceRaw = await readFile(resolve(ROOT, "audience.yaml"), "utf-8");
  const aud = parseYaml(audienceRaw) as Audience;

  if (isDryRun) {
    await dryRun(aud);
    return;
  }

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

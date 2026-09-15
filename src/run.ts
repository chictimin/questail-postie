import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import { initEnv } from "./globalConfig.js";
import { runPipeline } from "./graph.js";
import { fetchAppMeta } from "./collect/steam.js";
import { collectRss } from "./collect/rss.js";
import {
  collectSaleWatch,
  collectTierSteamNews,
  filterUnseenSteam,
  loadSeen,
  resolveTiers,
} from "./collect/tiers.js";
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
  const tiers = await resolveTiers(aud);
  const effAud: Audience = {
    ...aud,
    library_appids: tiers.recentAppIds.length > 0 ? tiers.recentAppIds : aud.library_appids,
    wishlist_appids: tiers.wishlistAppIds,
  };
  const [{ tier0, tier1 }, rssItems] = await Promise.all([
    collectTierSteamNews(tiers),
    collectRss([...effAud.reddit_feeds, ...effAud.press_feeds], effAud.batch.pool),
  ]);
  const appIds = [...new Set([...effAud.library_appids, ...effAud.wishlist_appids])];
  const meta = new Map<number, { name: string; genres: string[]; keywords: string[]; platforms: string[] }>();
  await Promise.all(
    appIds.map(async (id) => {
      meta.set(id, await fetchAppMeta(id));
    }),
  );
  const saleItems = await collectSaleWatch(tiers.wishlistAppIds, meta);
  // dry-run은 seen.json을 저장하지 않고 통과분만 미리 본다.
  const seen = await loadSeen(resolve(ROOT, "store/seen.json"));
  const freshSteam = filterUnseenSteam([...tier0, ...tier1], seen);
  const profile = buildProfile(effAud, meta);
  const rawItems = [...freshSteam, ...saleItems, ...rssItems];
  const filtered = filterNews(rawItems, effAud);
  const final = rankFinal(filtered, profile, effAud);
  console.log(
    `dry-run: 수집 ${rawItems.length}건(steam-fresh=${freshSteam.length} sale=${saleItems.length} rss=${rssItems.length}) → 풀 ${filtered.length}건 → 선별 ${final.length}건 ` +
      `(tiers=${tiers.steamSource} wishlist=[${tiers.wishlistAppIds.join(",")}] recent=[${tiers.recentAppIds.join(",")}])`,
  );
  for (const item of final) {
    console.log(`- score=${item.score} [${item.labels.join("+")}] ${item.title}`);
  }
}

async function main(): Promise<void> {
  const { dryRun: isDryRun } = parseArgs(process.argv.slice(2));
  initEnv(resolve(ROOT, ".env"));

  const hasKey = Boolean(process.env.OPENAI_API_KEY);
  const hasWebhook = Boolean(process.env.DISCORD_WEBHOOK_URL);
  console.log(
    `questail-postie 시작 (${process.env.MODEL ?? "gpt-4o-mini"}) — ` +
      `${hasKey ? "LLM 요약 모드" : "폴백 요약 모드(키 없음)"} · ` +
      `${hasWebhook ? "Discord 발행" : "파일 저장만(웹훅 없음)"}`,
  );

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

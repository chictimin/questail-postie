import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import { initEnv } from "./globalConfig.js";
import { resolveLlmEnv } from "./llmLocal.js";
import { runPipeline } from "./graph.js";
import { fetchAppMetaMap } from "./collect/steam.js";
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
import type { Audience, ResolvedAudience } from "./types.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

/** audience.yaml(개인 설정) 우선, 없으면 audience.sample.yaml(샘플) 폴백 */
export async function loadAudienceYaml(): Promise<Audience> {
  for (const name of ["audience.yaml", "audience.sample.yaml"]) {
    const path = resolve(ROOT, name);
    if (existsSync(path)) return parseYaml(await readFile(path, "utf-8")) as Audience;
  }
  throw new Error("audience.yaml 또는 audience.sample.yaml이 필요합니다.");
}

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
  const tiers = await resolveTiers(aud.demo_appids ?? []);
  const effAud: ResolvedAudience = {
    ...aud,
    library_appids: tiers.libraryAppIds,
    wishlist_appids: tiers.wishlistAppIds,
  };
  const [{ tier0, tier1 }, rssItems] = await Promise.all([
    collectTierSteamNews(tiers),
    collectRss([...effAud.reddit_feeds, ...effAud.press_feeds], effAud.batch.pool),
  ]);
  const appIds = [...new Set([...effAud.library_appids, ...effAud.wishlist_appids])];
  const meta = new Map<number, { name: string; genres: string[]; keywords: string[]; platforms: string[] }>();
  for (const [id, metaItem] of await fetchAppMetaMap(appIds)) meta.set(id, metaItem);
  const saleItems = await collectSaleWatch(tiers.wishlistAppIds, meta);
  // dry-run은 seen.json을 저장하지 않고 통과분만 미리 본다.
  const seen = await loadSeen(resolve(ROOT, "store/seen.json"));
  const freshSteam = filterUnseenSteam([...tier0, ...tier1], seen);
  console.log(
    `[1/4] 수집 — Steam ${freshSteam.length + saleItems.length}건(신규 ${freshSteam.length}·할인 ${saleItems.length}) · RSS ${rssItems.length}건`,
  );
  const profile = buildProfile(effAud, meta);
  console.log(
    tiers.steamSource === "demo"
      ? `[2/4] 개인화 프로필 — 데모 목록 ${tiers.libraryAppIds.length + tiers.wishlistAppIds.length}종 (Steam 키 미등록)`
      : `[2/4] 개인화 프로필 — 라이브러리 ${profile.libraryAppIds.length}종 · 위시리스트 ${profile.wishlistAppids.length}종`,
  );
  const rawItems = [...freshSteam, ...saleItems, ...rssItems];
  const pools = filterNews(rawItems, effAud, profile);
  console.log(
    `[3/4] 예선 — ${rawItems.length}건 → 개인화 ${pools.personal.length}건 · 일반 ${pools.general.length}건 · 할인 ${pools.sale.length}건`,
  );
  const personal = rankFinal(pools.personal, profile, effAud, effAud.batch.final);
  const extra = rankFinal(pools.general, profile, effAud, effAud.batch.extra);
  console.log(
    `[4/4] 본선 — 개인화 ${personal.length}건 · 그 외 ${extra.length}건 · 할인 ${pools.sale.length}건 선정 ` +
      `(tiers=${tiers.steamSource} wishlist=[${tiers.wishlistAppIds.join(",")}] recent=[${tiers.recentAppIds.join(",")}])`,
  );
  console.log(`-- 내 게임 소식 (${personal.length})`);
  for (const item of personal) {
    console.log(`- score=${item.score} [${item.labels.join("+")}] ${item.title}`);
  }
  console.log(`-- 그 외 오늘의 소식 (${extra.length})`);
  for (const item of extra) {
    console.log(`- score=${item.score} [${item.labels.join("+")}] ${item.title}`);
  }
  console.log(`-- 할인 중인 위시리스트 (${pools.sale.length})`);
  for (const item of pools.sale) {
    const name = item.sale?.gameName ?? item.title;
    const pct = item.sale?.percent !== undefined ? ` ${item.sale.percent}%` : "";
    const price = item.sale?.priceFinal ?? item.sale?.priceInitial ?? "";
    console.log(`- ${name}${pct}${price ? ` · ${price}` : ""} · ${item.url}`);
  }
}

async function main(): Promise<void> {
  const { dryRun: isDryRun } = parseArgs(process.argv.slice(2));
  initEnv(resolve(ROOT, ".env"));

  const llm = resolveLlmEnv();
  const hasKey = Boolean(llm.apiKey);
  const hasWebhook = Boolean(process.env.DISCORD_WEBHOOK_URL);
  console.log(
    `questail-postie 시작 (${llm.model}) — ` +
      `${hasKey ? "LLM 요약 모드" : "폴백 요약 모드(키 없음)"} · ` +
      `${hasWebhook ? "Discord 발행" : "파일 저장만(웹훅 없음)"}`,
  );

  const aud = await loadAudienceYaml();

  if (isDryRun) {
    await dryRun(aud);
    return;
  }

  const outPath = resolve(ROOT, "output/latest.md");
  const metricsPath = resolve(ROOT, "store/metrics.jsonl");

  const { passed, verdicts, metrics } = await runPipeline(aud, {
    baseURL: llm.baseURL,
    apiKey: llm.apiKey,
    model: llm.model,
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || undefined,
    outPath,
    metricsPath,
    showGameLine: aud.output?.show_game_line ?? false,
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

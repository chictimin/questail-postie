import {
  SALE_DISCOUNT_MIN_PERCENT,
  SEEN_RETENTION_DAYS,
  TIER0_NEWS_COUNT,
  TIER1_NEWS_COUNT,
  TIER1_RECENT_DAYS,
  emptySeen,
  filterUnseenSteam,
  isSaleWatchTarget,
  loadSeen,
  resolveTiers,
  updateSeen,
  type SeenStore,
} from "../src/collect/tiers.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { initEnv } from "../src/globalConfig.js";
import type { NewsItem } from "../src/types.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
initEnv(resolve(ROOT, ".env"));

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function steamItem(appId: number, gid: string, date: number): NewsItem {
  return {
    id: `steam-${appId}-${gid}`,
    title: `news ${gid}`,
    url: `https://example.com/${appId}/${gid}`,
    source: "steam",
    feedType: "1",
    appId,
    publishedAt: date,
    author: "",
    content: "",
    lang: "en",
  };
}

// ─── 상수 규격 ───
if (TIER0_NEWS_COUNT !== 5) fail("Tier0는 앱당 5건");
if (TIER1_NEWS_COUNT !== 3) fail("Tier1은 앱당 3건");
if (TIER1_RECENT_DAYS !== 30) fail("Tier1 기준은 최근 30일");
if (SALE_DISCOUNT_MIN_PERCENT !== 20) fail("할인 감시 기준은 20%");
console.log("tiers constants: Tier0=5 Tier1=3 recent=30d sale>=20%");

// ─── seen 발행분 집합 (픽스처) ───
if (SEEN_RETENTION_DAYS !== 30) fail("seen 보존 기간은 30일");
const seen: SeenStore = emptySeen();
const batch = [
  steamItem(440, "90", 900),
  steamItem(440, "100", 1000),
  steamItem(440, "101", 1000),
  steamItem(440, "102", 1100),
  steamItem(252490, "1", 500),
];
// 발행된 2건만 기록 — 수집분 전체가 아니다.
updateSeen(seen, ["steam-440-90", "steam-440-100"], 2000);
const fresh = filterUnseenSteam(batch, seen);
console.log(`seen: in=${batch.length} fresh=${fresh.length} ids=${fresh.map((i) => i.id).join(",")}`);
if (fresh.length !== 3) fail("seen 필터는 미발행 3건만 통과해야 한다");
if (fresh.some((i) => i.id === "steam-440-90" || i.id === "steam-440-100")) {
  fail("발행분은 제외되어야 한다");
}
// 핵심 회귀 단언: 미발행 수집분은 다음 런에 다시 후보가 된다.
if (!fresh.some((i) => i.id === "steam-440-101") || !fresh.some((i) => i.id === "steam-252490-1")) {
  fail("미발행 수집분은 다음 런에 다시 후보가 되어야 한다");
}
console.log("seen published-set OK (발행분만 제외, 미발행분은 다음 런 후보)");

// ─── 구 형식 마이그레이션 ───
const migDir = mkdtempSync(join(tmpdir(), "check-tiers-"));
writeFileSync(join(migDir, "seen.json"), JSON.stringify({ apps: { 440: { lastGid: "1", lastDate: 1 } } }));
const migrated = await loadSeen(join(migDir, "seen.json"));
if (Object.keys(migrated.published).length !== 0) fail("구 형식 seen.json은 빈 published로 시작해야 한다");
console.log("seen migration OK (구 apps 형식 → 빈 published)");

// ─── 할인 기준 (픽스처) ───
if (isSaleWatchTarget({ discount_percent: 19 })) fail("19%는 감시 대상이 아니다");
if (!isSaleWatchTarget({ discount_percent: 20 })) fail("20%는 감시 대상이다");
if (!isSaleWatchTarget({ discount_percent: 75 })) fail("75%는 감시 대상이다");
if (isSaleWatchTarget(undefined)) fail("가격 정보 없음은 감시 대상이 아니다");
console.log("sale threshold OK (19→drop, 20/75→steam-sale)");

// ─── 실환경 티어 확정 (읽기 전용, 무인) ───
// appId는 audience.yaml에 두지 않는다. SteamID로 런타임 확정한다.
const tiers = await resolveTiers();
console.log(
  `tiers live: source=${tiers.steamSource} wishlist=${tiers.wishlistAppIds.length} ` +
    `recent=${tiers.recentAppIds.length} library=${tiers.libraryAppIds.length}`,
);
if (process.env.STEAM_API_KEY && process.env.STEAM_ID) {
  if (tiers.wishlistAppIds.length === 0) fail("STEAM 키가 있는데 Tier0 위시리스트가 0건이다");
  if (tiers.libraryAppIds.length === 0) fail("STEAM 키가 있는데 라이브러리가 0건이다");
}

console.log("OK check-tiers");

import {
  SALE_DISCOUNT_MIN_PERCENT,
  TIER0_NEWS_COUNT,
  TIER1_NEWS_COUNT,
  TIER1_RECENT_DAYS,
  emptySeen,
  filterUnseenSteam,
  isSaleWatchTarget,
  resolveTiers,
  updateSeen,
  type SeenStore,
} from "../src/collect/tiers.js";
import { dirname, resolve } from "node:path";
import { initEnv } from "../src/globalConfig.js";
import type { Audience, NewsItem } from "../src/types.js";

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

// ─── seen 증분 로직 (픽스처) ───
const seen: SeenStore = emptySeen();
seen.apps["440"] = { lastGid: "100", lastDate: 1000 };
const batch = [
  steamItem(440, "90", 900), // 과거 → 탈락
  steamItem(440, "100", 1000), // 동일 커서 → 탈락
  steamItem(440, "101", 1000), // 동시간 신규 gid → 통과
  steamItem(440, "102", 1100), // 이후 → 통과
  steamItem(252490, "1", 500), // 미기록 앱 → 통과
];
const fresh = filterUnseenSteam(batch, seen);
console.log(`seen: in=${batch.length} fresh=${fresh.length} ids=${fresh.map((i) => i.id).join(",")}`);
if (fresh.length !== 3) fail("seen 필터는 3건만 통과해야 한다");
if (fresh.some((i) => i.id === "steam-440-90" || i.id === "steam-440-100")) {
  fail("과거·동일 커서는 탈락해야 한다");
}
updateSeen(seen, batch);
if (seen.apps["440"]?.lastGid !== "102" || seen.apps["440"]?.lastDate !== 1100) {
  fail("seen 커서는 (1100, 102)로 전진해야 한다");
}
if (seen.apps["252490"]?.lastGid !== "1") fail("신규 앱 커서가 기록되어야 한다");
const again = filterUnseenSteam(batch, seen);
if (again.length !== 0) fail("커서 전진 후 동일 배치 재통과는 0건이어야 한다");
console.log("seen incremental OK (cursor advances, replays blocked)");

// ─── 할인 기준 (픽스처) ───
if (isSaleWatchTarget({ discount_percent: 19 })) fail("19%는 감시 대상이 아니다");
if (!isSaleWatchTarget({ discount_percent: 20 })) fail("20%는 감시 대상이다");
if (!isSaleWatchTarget({ discount_percent: 75 })) fail("75%는 감시 대상이다");
if (isSaleWatchTarget(undefined)) fail("가격 정보 없음은 감시 대상이 아니다");
console.log("sale threshold OK (19→drop, 20/75→steam-sale)");

// ─── 실환경 티어 확정 (읽기 전용, 무인) ───
const aud = {
  library_appids: [440, 252490],
  wishlist_appids: [1940340],
} as Audience;
const tiers = await resolveTiers(aud);
console.log(
  `tiers live: source=${tiers.steamSource} wishlist=[${tiers.wishlistAppIds.join(",")}] recent=[${tiers.recentAppIds.join(",")}]`,
);
if (tiers.wishlistAppIds.length === 0) fail("Tier0 위시리스트가 비어 있다");
if (process.env.STEAM_API_KEY && process.env.STEAM_ID && tiers.recentAppIds.length === 0) {
  fail("STEAM 키가 있는데 Tier1 최근 플레이가 0건이다");
}

console.log("OK check-tiers");

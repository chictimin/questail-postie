/**
 * 티어 수집 — collect 전면 교체 (Tier0 + Tier1만).
 * - Tier0: 위시리스트 전수, 앱당 뉴스 5건.
 * - Tier1: 최근 30일 플레이(rtime_last_played), 앱당 뉴스 3건.
 * - 증분: store/seen.json (앱별 마지막 gid·date, 이후만 통과).
 * - 할인 감시: 위시리스트 20%+ → source=steam-sale 합성 아이템.
 * STEAM 키는 전역 ~/.config/questail/.env를 읽기만 한다(쓰기 없음).
 * 하류(personalize→…→publish)는 그대로 둔다.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { collectSteamNews, fetchAppMeta } from "./steam.js";
import { fetchOwnedGamesDetail, fetchWishlistAppIds } from "../steamid.js";
import type { NewsItem } from "../types.js";

export const TIER0_NEWS_COUNT = 5;
export const TIER1_NEWS_COUNT = 3;
export const TIER1_RECENT_DAYS = 30;
/** 라이브러리 상한 — 최근 플레이 순 상위 N개만. fetchAppMeta 폭증(429) 방지. */
export const TIER1_MAX_APPS = 15;
export const SALE_DISCOUNT_MIN_PERCENT = 20;

const FETCH_TIMEOUT_MS = 15_000;

export interface TierSet {
  wishlistAppIds: number[];
  recentAppIds: number[];
  /** personalize용 라이브러리 — 최근 플레이, 비면 보유 전체 */
  libraryAppIds: number[];
  /** 티어 출처: steam API로 확정 / 키 없음(빈 티어) / 데모 목록 */
  steamSource: "steam" | "audience" | "demo";
}

/** 데모 목록을 앞절반 라이브러리·뒷절반 위시로 나눈다 (양쪽 가산이 다 보이게). */
function splitDemo(demoAppIds: number[]): { library: number[]; wishlist: number[] } {
  const ids = [...new Set(demoAppIds.filter((n) => Number.isInteger(n) && n > 0))];
  const mid = Math.ceil(ids.length / 2);
  return { library: ids.slice(0, mid), wishlist: ids.slice(mid) };
}

/**
 * STEAM 키 읽기 전용으로 티어 확정. 질문 없이 진행한다.
 * - 키·SteamID 없음 → 데모 목록이 있으면 library·wishlist에 채우고 source "demo".
 *   데모도 없으면 전부 빈 배열(RSS만으로 계속, source "audience").
 * - 키 있음 → 위시 전수(IWishlistService) + 최근 플레이(rtime_last_played 30일).
 *   최근 플레이가 비면 보유 전체를 라이브러리로 쓴다. 데모 목록은 무시된다.
 */
export async function resolveTiers(demoAppIds: number[] = []): Promise<TierSet> {
  const apiKey = process.env.STEAM_API_KEY || "";
  const steamId = process.env.STEAM_ID || "";
  const empty: TierSet = {
    wishlistAppIds: [],
    recentAppIds: [],
    libraryAppIds: [],
    steamSource: "audience",
  };
  if (!apiKey || !steamId) {
    const demo = splitDemo(demoAppIds);
    if (demo.library.length === 0 && demo.wishlist.length === 0) return empty;
    return {
      wishlistAppIds: demo.wishlist,
      recentAppIds: demo.library,
      libraryAppIds: demo.library,
      steamSource: "demo",
    };
  }
  const [wishlist, owned] = await Promise.all([
    fetchWishlistAppIds(apiKey, steamId).catch(() => [] as number[]),
    fetchOwnedGamesDetail(apiKey, steamId).catch(
      () => [] as Array<{ appid: number; rtimeLastPlayed: number }>,
    ),
  ]);
  const cutoff = Math.floor(Date.now() / 1000) - TIER1_RECENT_DAYS * 86400;
  // 최근 플레이 순으로 정렬 후 상한을 건다. GetOwnedGames 2회 호출을 피하려고
  // fetchRecentlyPlayedAppIds를 쓰지 않고 이미 받아온 owned에서 직접 자른다.
  const byRecent = [...owned].sort((a, b) => b.rtimeLastPlayed - a.rtimeLastPlayed);
  const recent = [...new Set(byRecent.filter((g) => g.rtimeLastPlayed >= cutoff).map((g) => g.appid))].slice(
    0,
    TIER1_MAX_APPS,
  );
  // 폴백(최근 플레이 없음)도 15개로 제한 — 보유 전체(120종) fetchAppMeta 폭증 방지.
  const ownedIds = [...new Set(byRecent.map((g) => g.appid))].slice(0, TIER1_MAX_APPS);
  return {
    wishlistAppIds: [...new Set(wishlist)],
    recentAppIds: recent,
    libraryAppIds: recent.length > 0 ? recent : ownedIds,
    steamSource: "steam",
  };
}

// ─── 발행분 seen.json ─────────────────────────────────────────────
// "앱별 커서"가 아니라 "발행된 항목 id 집합"이다. 수집분 전체의 커서를 전진시키면
// 미발행 항목이 영영 후보에서 사라지므로(fresh=0 사고), 발행된 id만 기록한다.

/** 보존 기간(일). saveSeen 시점에 이보다 오래된 발행 기록을 정리한다 (유효기간). */
export const SEEN_RETENTION_DAYS = 30;

export interface SeenStore {
  /** 발행된 항목 id → 발행 시각(unix sec) */
  published: Record<string, number>;
}

export function emptySeen(): SeenStore {
  return { published: {} };
}

export async function loadSeen(seenPath: string): Promise<SeenStore> {
  if (!existsSync(seenPath)) return emptySeen();
  try {
    const raw = await readFile(seenPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SeenStore> & { apps?: unknown };
    if (parsed && typeof parsed.published === "object" && parsed.published !== null) {
      return { published: parsed.published as Record<string, number> };
    }
    if (parsed && typeof parsed.apps === "object" && parsed.apps !== null) {
      // 구 형식 {"apps": {...}} — 커서와 id 집합은 정보가 달라 정확한 변환이 불가능하다.
      // 변환하지 않고 빈 집합으로 시작한다.
      console.error("[seen] 구 형식 seen.json(apps 커서)을 발견 — published 빈 집합으로 시작합니다");
      return emptySeen();
    }
  } catch {
    // 파싱 실패 시 빈 저장소로 시작 (덮어쓰지 않고 메모리에만 유지)
  }
  return emptySeen();
}

function pruneSeen(seen: SeenStore, nowSec: number): void {
  const cutoff = nowSec - SEEN_RETENTION_DAYS * 24 * 3600;
  for (const [id, ts] of Object.entries(seen.published)) {
    if (typeof ts !== "number" || ts < cutoff) delete seen.published[id];
  }
}

export async function saveSeen(seenPath: string, seen: SeenStore): Promise<void> {
  pruneSeen(seen, Math.floor(Date.now() / 1000));
  await mkdir(dirname(seenPath), { recursive: true });
  await writeFile(seenPath, `${JSON.stringify(seen, null, 2)}\n`, "utf-8");
}

/** published에 id가 있으면 제외. 미발행 수집분은 다음 런에 다시 후보가 된다. */
export function filterUnseenSteam(items: NewsItem[], seen: SeenStore): NewsItem[] {
  return items.filter((item) => !Object.prototype.hasOwnProperty.call(seen.published, item.id));
}

/**
 * 발행된 항목 id만 기록한다. 수집분 전체를 넣지 말 것 —
 * 넣으면 미발행 항목이 다음 런 후보에서 사라진다.
 */
export function updateSeen(seen: SeenStore, ids: string[], nowSec: number = Math.floor(Date.now() / 1000)): void {
  for (const id of ids) seen.published[id] = nowSec;
}

// ─── 티어 뉴스 수집 ─────────────────────────────────────────────

export interface TierNews {
  tier0: NewsItem[];
  tier1: NewsItem[];
}

/** Tier0 앱당 5건 · Tier1 앱당 3건 (Steam AppNews 공개 API, 키 불필요) */
export async function collectTierSteamNews(tiers: TierSet): Promise<TierNews> {
  const [tier0, tier1] = await Promise.all([
    collectSteamNews(tiers.wishlistAppIds, TIER0_NEWS_COUNT),
    collectSteamNews(tiers.recentAppIds, TIER1_NEWS_COUNT),
  ]);
  return { tier0, tier1 };
}

// ─── 할인 감시 ──────────────────────────────────────────────────

interface PriceOverview {
  discount_percent?: number;
  initial_formatted?: string;
  final_formatted?: string;
}

export function isSaleWatchTarget(price: PriceOverview | undefined): boolean {
  return (price?.discount_percent ?? 0) >= SALE_DISCOUNT_MIN_PERCENT;
}

async function fetchPriceOverview(appId: number): Promise<PriceOverview | undefined> {
  try {
    const endpoint =
      `https://store.steampowered.com/api/appdetails?appids=${appId}` +
      `&filters=price_overview&l=korean`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as Record<
      string,
      { success: boolean; data?: { price_overview?: PriceOverview } }
    >;
    return data[String(appId)]?.data?.price_overview;
  } catch {
    return undefined;
  }
}

function saleId(appId: number, nowSec: number): string {
  const day = new Date(nowSec * 1000).toISOString().slice(0, 10);
  return `steam-sale-${appId}-${day}`;
}

/**
 * 위시리스트 할인 20%+ → source=steam-sale 합성.
 * appId를 달아 하류 rank에서 wishlist 가산·라벨을 그대로 받는다.
 */
export async function collectSaleWatch(
  wishlistAppIds: number[],
  meta: Map<number, { name: string; genres: string[]; keywords: string[]; platforms: string[] }>,
): Promise<NewsItem[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const out: NewsItem[] = [];
  for (const appId of wishlistAppIds) {
    const price = await fetchPriceOverview(appId);
    if (!isSaleWatchTarget(price)) continue;
    const name = meta.get(appId)?.name ?? (await fetchAppMeta(appId)).name;
    const pct = price?.discount_percent ?? 0;
    const priceLine =
      price?.initial_formatted && price?.final_formatted
        ? `${price.initial_formatted} → ${price.final_formatted}`
        : "";
    out.push({
      id: saleId(appId, nowSec),
      title: `${name} ${pct}% 할인 중`,
      url: `https://store.steampowered.com/app/${appId}/`,
      source: "steam-sale",
      sourceName: "Steam 할인",
      feedType: "sale",
      appId,
      publishedAt: nowSec,
      author: "",
      content: `${name}이(가) Steam에서 ${pct}% 할인 중이다. ${priceLine}`.trim(),
      lang: "ko",
      sale: {
        gameName: name,
        percent: pct,
        priceInitial: price?.initial_formatted,
        priceFinal: price?.final_formatted,
      },
    });
  }
  return out;
}

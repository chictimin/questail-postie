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
import { fetchRecentlyPlayedAppIds, fetchWishlistAppIds } from "../steamid.js";
import type { Audience, NewsItem } from "../types.js";

export const TIER0_NEWS_COUNT = 5;
export const TIER1_NEWS_COUNT = 3;
export const TIER1_RECENT_DAYS = 30;
export const SALE_DISCOUNT_MIN_PERCENT = 20;

const FETCH_TIMEOUT_MS = 15_000;

export interface TierSet {
  wishlistAppIds: number[];
  recentAppIds: number[];
  /** 티어 출처: steam API로 확정 / audience.yaml 폴백 */
  steamSource: "steam" | "audience";
}

/** STEAM 키 읽기 전용으로 티어 확정. 질문 없이 폴백한다. */
export async function resolveTiers(aud: Audience): Promise<TierSet> {
  const apiKey = process.env.STEAM_API_KEY || "";
  const steamId = process.env.STEAM_ID || "";
  if (!apiKey || !steamId) {
    return {
      wishlistAppIds: [...aud.wishlist_appids],
      recentAppIds: [],
      steamSource: "audience",
    };
  }
  const [wishlist, recent] = await Promise.all([
    fetchWishlistAppIds(apiKey, steamId).catch(() => [] as number[]),
    fetchRecentlyPlayedAppIds(apiKey, steamId, TIER1_RECENT_DAYS).catch(() => [] as number[]),
  ]);
  return {
    // 위시리스트 API 제거 상태(404)라 빈 결과면 설정 전수를 쓴다.
    wishlistAppIds: wishlist.length > 0 ? [...new Set(wishlist)] : [...aud.wishlist_appids],
    recentAppIds: [...new Set(recent)],
    steamSource: "steam",
  };
}

// ─── 증분 seen.json ─────────────────────────────────────────────

export interface SeenEntry {
  lastGid: string;
  lastDate: number;
}

export interface SeenStore {
  apps: Record<string, SeenEntry>;
}

export function emptySeen(): SeenStore {
  return { apps: {} };
}

export async function loadSeen(seenPath: string): Promise<SeenStore> {
  if (!existsSync(seenPath)) return emptySeen();
  try {
    const raw = await readFile(seenPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SeenStore>;
    if (parsed && typeof parsed.apps === "object" && parsed.apps !== null) {
      return { apps: parsed.apps as Record<string, SeenEntry> };
    }
  } catch {
    // 파싱 실패 시 빈 저장소로 시작 (덮어쓰지 않고 메모리에만 유지)
  }
  return emptySeen();
}

export async function saveSeen(seenPath: string, seen: SeenStore): Promise<void> {
  await mkdir(dirname(seenPath), { recursive: true });
  await writeFile(seenPath, `${JSON.stringify(seen, null, 2)}\n`, "utf-8");
}

/** steam-{appId}-{gid}에서 appId·gid 분리 */
export function parseSteamId(id: string): { appId: number; gid: string } | null {
  if (!id.startsWith("steam-")) return null;
  const rest = id.slice("steam-".length);
  const dash = rest.indexOf("-");
  if (dash === -1) return null;
  const appId = Number(rest.slice(0, dash));
  const gid = rest.slice(dash + 1);
  if (!Number.isInteger(appId) || !gid) return null;
  return { appId, gid };
}

/** 저장된 (lastDate, lastGid) 이후 항목만 통과 */
export function filterUnseenSteam(items: NewsItem[], seen: SeenStore): NewsItem[] {
  return items.filter((item) => {
    const parsed = parseSteamId(item.id);
    if (!parsed) return true;
    const entry = seen.apps[String(parsed.appId)];
    if (!entry) return true;
    if (item.publishedAt > entry.lastDate) return true;
    if (item.publishedAt === entry.lastDate && parsed.gid > entry.lastGid) return true;
    return false;
  });
}

/** 수집분 전체에서 앱별 최대 (date, gid)로 커서 전진 */
export function updateSeen(seen: SeenStore, items: NewsItem[]): void {
  for (const item of items) {
    const parsed = parseSteamId(item.id);
    if (!parsed) continue;
    const key = String(parsed.appId);
    const prev = seen.apps[key];
    if (
      !prev ||
      item.publishedAt > prev.lastDate ||
      (item.publishedAt === prev.lastDate && parsed.gid > prev.lastGid)
    ) {
      seen.apps[key] = { lastGid: parsed.gid, lastDate: item.publishedAt };
    }
  }
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
    });
  }
  return out;
}

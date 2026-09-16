import type { NewsItem } from "../types.js";
import {
  AppMetaRateLimitedError,
  fetchAppMeta as coreFetchAppMeta,
  fetchAppMetaBatch,
  type GameMeta as CoreGameMeta,
} from "@questail/core";

interface SteamNewsItemRaw {
  gid: string;
  title: string;
  url: string;
  contents: string;
  author: string;
  feed_type: number;
  date: number;
}

interface SteamNewsResponse {
  appnews?: {
    newsitems?: SteamNewsItemRaw[];
  };
}

/** postie 하류(graph·tiers·summarize)가 쓰는 메타 형태. core GameMeta의 부분집합이다. */
export interface AppMeta {
  name: string;
  genres: string[];
  keywords: string[];
  platforms: string[];
}

const FETCH_TIMEOUT_MS = 15_000;

function toNewsItem(appId: number, raw: SteamNewsItemRaw): NewsItem {
  return {
    id: `steam-${appId}-${raw.gid}`,
    title: raw.title ?? "",
    url: raw.url ?? "",
    source: "steam",
    sourceName: "Steam 공지",
    feedType: String(raw.feed_type ?? ""),
    appId,
    publishedAt: Number(raw.date ?? 0),
    author: raw.author ?? "",
    content: raw.contents ?? "",
    lang: "en",
  };
}

export async function collectSteamNews(
  appIds: number[],
  countPerApp: number,
): Promise<NewsItem[]> {
  const out: NewsItem[] = [];
  for (const appId of appIds) {
    const endpoint = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appId}&count=${countPerApp}&format=json`;
    try {
      const res = await fetch(endpoint, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as SteamNewsResponse;
      const items = data.appnews?.newsitems ?? [];
      for (const raw of items) {
        if (!raw.gid || !raw.url || !raw.title) continue;
        out.push(toNewsItem(appId, raw));
      }
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * core GameMeta → postie AppMeta.
 * core platforms는 소문자 키(windows·mac·linux)라 기존 표시명(Windows·macOS·Linux)으로 되돌린다.
 * name이 비면 appId 문자열 폴백 — 숫자 폴백을 넣지 않는 기존 규칙과 동일하다.
 */
function adaptMeta(appId: number, meta: CoreGameMeta): AppMeta {
  const label: Record<string, string> = { windows: "Windows", mac: "macOS", linux: "Linux" };
  return {
    name: meta.name ?? String(appId),
    genres: meta.genres ?? [],
    keywords: meta.keywords ?? [],
    platforms: (meta.platforms ?? []).map((p) => label[p] ?? p),
  };
}

function fallbackMeta(appId: number): AppMeta {
  return { name: String(appId), genres: [], keywords: [], platforms: [] };
}

/**
 * 단일 조회 (할인 감시 폴백용). core 디스크 캐시·1.5초 스로틀을 그대로 쓴다.
 * 쿨다운 중이면 파이프라인을 죽이지 않고 이름 폴백으로 진행한다.
 */
export async function fetchAppMeta(appId: number): Promise<AppMeta> {
  try {
    return adaptMeta(appId, await coreFetchAppMeta(String(appId)));
  } catch (err) {
    if (err instanceof AppMetaRateLimitedError) {
      console.error(`[collect] appdetails 쿨다운, 메타 없이 진행: ${err.message}`);
      return fallbackMeta(appId);
    }
    throw err;
  }
}

/**
 * 전수 조회용 순차 배치. Promise.all 전량 병렬은 429 위험이 실측 확인되어 쓰지 않는다.
 * core fetchAppMetaBatch가 요청 간격 1.5초를 강제한다.
 * onRateLimit "stop" — 정기 실행 뉴스레터는 5분 정지보다 메타 일부 누락이 낫다.
 * 반환에 없는 appId는 아래 폴백으로 채워 호출부가 undefined 접근 없이 진행한다.
 */
export async function fetchAppMetaMap(appIds: number[]): Promise<Map<number, AppMeta>> {
  const map = new Map<number, AppMeta>();
  try {
    const metas = await fetchAppMetaBatch(appIds.map(String), { onRateLimit: "stop" });
    metas.forEach((meta, i) => map.set(appIds[i] as number, adaptMeta(appIds[i] as number, meta)));
  } catch (err) {
    if (err instanceof AppMetaRateLimitedError) {
      console.error(`[collect] appdetails 쿨다운, 메타 없이 진행: ${err.message}`);
    } else {
      throw err;
    }
  }
  for (const appId of appIds) {
    if (!map.has(appId)) map.set(appId, fallbackMeta(appId));
  }
  return map;
}

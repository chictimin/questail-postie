/**
 * SteamID 연동 — 프로필 입력 → SteamID64 변환 → 보유 게임 조회.
 * 뉴스 수집(공개 API·RSS)은 키 없이 동작하므로 이 모듈은 sniff에서만 쓴다.
 */

const API_BASE = "https://api.steampowered.com";
const FETCH_TIMEOUT_MS = 15_000;

async function steamGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ format: "json", ...params }).toString();
  const res = await fetch(`${API_BASE}${path}?${qs}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Steam API 오류: ${res.status} ${path}`);
  return (await res.json()) as T;
}

interface VanityResponse {
  response: {
    steamid?: string;
    success: number;
    message?: string;
  };
}

/** Steam 커스텀 URL명을 SteamID64로 변환 */
export async function resolveVanityUrl(apiKey: string, vanity: string): Promise<string> {
  const data = await steamGet<VanityResponse>("/ISteamUser/ResolveVanityURL/v0001/", {
    key: apiKey,
    vanityurl: vanity,
  });
  if (data.response.success !== 1 || !data.response.steamid) {
    throw new Error(`SteamID 변환 실패: ${data.response.message ?? vanity}`);
  }
  return data.response.steamid;
}

const PROFILE_RE = /steamcommunity\.com\/(?:profiles\/(\d+)|id\/([^/\s?#]+))/i;

/**
 * 사용자 입력(URL·숫자ID·vanity명)을 SteamID64로 변환
 * - profiles/숫자 URL → 숫자 그대로
 * - id/vanity URL 또는 vanity명 → ResolveVanityURL 호출
 * - 17자리 숫자 → 그대로
 */
export async function resolveToSteamId(input: string, apiKey: string): Promise<string> {
  const trimmed = input.trim();
  const match = trimmed.match(PROFILE_RE);
  if (match) {
    if (match[1]) return match[1];
    return resolveVanityUrl(apiKey, match[2]);
  }
  if (/^\d{17}$/.test(trimmed)) return trimmed;
  if (!/^\d+$/.test(trimmed) && trimmed.length > 0) {
    return resolveVanityUrl(apiKey, trimmed);
  }
  throw new Error(`SteamID를 인식할 수 없습니다: ${input}`);
}

interface OwnedResponse {
  response: {
    game_count?: number;
    games?: Array<{ appid?: number }>;
  };
}

/** 보유 게임 appId 목록 조회 */
export async function fetchOwnedAppIds(apiKey: string, steamId: string): Promise<number[]> {
  const data = await steamGet<OwnedResponse>("/IPlayerService/GetOwnedGames/v0001/", {
    key: apiKey,
    steamid: steamId,
    include_appinfo: "true",
    include_played_free_games: "true",
  });
  return (data.response.games ?? [])
    .map((g) => g.appid)
    .filter((n): n is number => Number.isInteger(n));
}

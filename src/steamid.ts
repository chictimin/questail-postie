/**
 * SteamID 연동 — @questail/core 승격본 재노출 + postie 호환 어댑터.
 *
 * resolveVanityUrl·resolveToSteamId·fetchOwnedGamesDetail·fetchWishlistAppIds는
 * 원래 questail에서 복제해간 코드의 정식 위치(@questail/core connectors/steam)에서 가져온다.
 * postie 호출부(sniff.ts·collect/tiers.ts)는 이 모듈 경로 그대로 둔다.
 * 뉴스 수집(공개 API·RSS)은 키 없이 동작하므로 이 모듈은 sniff·tiers에서만 쓴다.
 */

import {
  fetchOwnedGames,
  fetchOwnedGamesDetail,
  fetchWishlistAppIds,
  resolveToSteamId as coreResolveToSteamId,
  resolveVanityUrl,
} from "@questail/core";

export { fetchOwnedGamesDetail, fetchWishlistAppIds, resolveVanityUrl };

/**
 * 사용자 입력(URL·숫자ID·vanity명)을 SteamID64로 변환.
 * postie 동작 유지: 앞뒤 공백 무시, 빈 입력은 API를 호출하지 않고 즉시 throw.
 * 나머지 분기는 core와 동일(profiles/숫자 그대로·17자리 숫자 그대로·그 외 vanity 조회).
 */
export async function resolveToSteamId(input: string, apiKey: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error(`SteamID를 인식할 수 없습니다: ${input}`);
  return coreResolveToSteamId(trimmed, apiKey);
}

/** 보유 게임 appId 목록 조회 (sniff 등록 확인용, include_appinfo=true 경로) */
export async function fetchOwnedAppIds(apiKey: string, steamId: string): Promise<number[]> {
  const data = await fetchOwnedGames({ apiKey, steamId });
  return (data.response.games ?? [])
    .map((g) => g.appid)
    .filter((n): n is number => Number.isInteger(n));
}

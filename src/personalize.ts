import type { ResolvedAudience, PersonalProfile } from "./types.js";

function normalizeName(name: string): string {
  return name.toLowerCase().trim();
}

interface AppMetaInfo {
  name: string;
  genres: string[];
  keywords: string[];
  platforms: string[];
}

export function buildProfile(
  aud: ResolvedAudience,
  meta: Map<number, AppMetaInfo>,
): PersonalProfile {
  const titleIndex: PersonalProfile["titleIndex"] = [];
  // Store 메타에 이름이 없어 색인에서 빠진 appId 수. 숫자 폴백은 넣지 않는다 —
  // appId 기반 매칭(library.has)은 그대로 동작하므로 손실이 없다.
  let noMeta = 0;
  const indexOne = (appId: number, list: "library" | "wishlist"): void => {
    const raw = meta.get(appId)?.name;
    if (!raw) {
      noMeta += 1;
      return;
    }
    const norm = normalizeName(raw);
    if (norm.length < 4) return;
    const hangulParts = (raw.match(/[가-힣][가-힣\s]*[가-힣]/g) ?? [])
      .map(normalizeName)
      .filter((n) => n.length >= 4 && n !== norm);
    titleIndex.push({ appId, list, names: [norm, ...hangulParts] });
  };
  for (const appId of aud.library_appids) indexOne(appId, "library");
  for (const appId of aud.wishlist_appids) indexOne(appId, "wishlist");
  return {
    libraryAppIds: [...aud.library_appids],
    wishlistAppids: [...aud.wishlist_appids],
    titleIndex,
    noMeta,
    weights: {
      libraryMatch: aud.weights.library_match,
      wishlistMatch: aud.weights.wishlist_match,
      titleMatch: 1.5,
      recency: 1.0,
    },
    recencyHours: aud.weights.recency_hours,
  };
}

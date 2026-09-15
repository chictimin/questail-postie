import type { Audience, PersonalProfile } from "./types.js";

function normalizeName(name: string): string {
  return name.toLowerCase().trim();
}

interface AppMetaInfo {
  name: string;
  genres: string[];
  keywords: string[];
}

export function buildProfile(
  aud: Audience,
  meta: Map<number, AppMetaInfo>,
): PersonalProfile {
  if (!aud.personalize) {
    return {
      mode: "general",
      libraryAppIds: [],
      wishlistAppids: [],
      titleIndex: [],
      weights: { libraryMatch: 0, wishlistMatch: 0, titleMatch: 0, recency: 0 },
      recencyHours: 0,
    };
  }
  const titleIndex: PersonalProfile["titleIndex"] = [];
  const indexOne = (appId: number, list: "library" | "wishlist"): void => {
    const raw = meta.get(appId)?.name ?? String(appId);
    const norm = normalizeName(raw);
    if (norm.length < 4) return;
    titleIndex.push({ appId, list, names: [norm] });
  };
  for (const appId of aud.library_appids) indexOne(appId, "library");
  for (const appId of aud.wishlist_appids) indexOne(appId, "wishlist");
  return {
    mode: "personal",
    libraryAppIds: [...aud.library_appids],
    wishlistAppids: [...aud.wishlist_appids],
    titleIndex,
    weights: {
      libraryMatch: aud.weights.library_match,
      wishlistMatch: aud.weights.wishlist_match,
      titleMatch: 1.5,
      recency: 1.0,
    },
    recencyHours: aud.weights.recency_hours,
  };
}

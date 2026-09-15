import OpenAI from "openai";
import type { Digest, NewsItem } from "./types.js";

export interface DigestOptions {
  baseURL: string;
  apiKey?: string;
  model: string;
}

const MAX_LINE_CHARS = 200;
const MAX_ITEMS = 30;

function parseLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 0)
    .map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) : l))
    .slice(0, 3);
}

export async function buildDigest(
  items: NewsItem[],
  opts: DigestOptions,
): Promise<Digest> {
  if (!opts.apiKey || items.length === 0) return { linesKo: [] };
  try {
    const client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
    const list = items
      .slice(0, MAX_ITEMS)
      .map((it, i) => `${i + 1}. ${it.title} — ${it.sourceName ?? it.source}`)
      .join("\n");
    const response = await client.chat.completions.create({
      model: opts.model,
      messages: [
        {
          role: "system",
          content:
            "너는 게임 뉴스를 훑어보는 어시스턴트다. " +
            "아래 제목 목록을 보고 한국어로 3줄 이내로 브리핑한다: " +
            "많이 나온 주제, 가장 주목받은 소식 1건과 그 이유. " +
            "각 줄은 200자 이하, 번호나 불릿 없이 줄 단위로만 답한다.",
        },
        { role: "user", content: list },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? "";
    return { linesKo: parseLines(raw) };
  } catch {
    return { linesKo: [] };
  }
}

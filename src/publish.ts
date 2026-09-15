import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NewsItem, Summary } from "./types.js";

export interface PublishOptions {
  webhookUrl?: string;
  outPath: string;
  /** false면 게임명 행을 렌더하지 않는다 (함수·필드는 유지, 되살리기용). */
  showGameLine?: boolean;
}

export const PERSONAL_HEADING = "내 게임 소식";
export const GENERAL_HEADING = "그 외 오늘의 소식";
export const SALE_HEADING = "할인 중인 위시리스트";

const DISCORD_LIMIT = 2000;
const TRUNC_MARK = "…(이하 생략)";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 번역 성공분은 Ko, 아니면 원어. Ko에 영어·빈 문자열을 넣지 않는 것은 translate 계약. */
function displayTitle(s: Summary): string {
  return s.titleKo ?? s.title;
}

function displayBullets(s: Summary): string[] {
  return s.bulletsKo ?? s.bullets;
}

/** 번역 없이 원어로 나가는 항목은 티가 나야 한다. 조용한 영어 혼입 방지. */
function isTranslated(s: Summary): boolean {
  return s.translated && s.titleKo !== undefined && s.bulletsKo !== undefined;
}

function gameLine(s: Summary): string | null {
  if (s.gameName && s.platforms && s.platforms.length > 0) {
    return `게임: ${s.gameName} · ${s.platforms.join("/")}`;
  }
  if (s.gameName) return `게임: ${s.gameName}`;
  return null;
}

function sourceSite(s: Summary): string {
  return s.sourceName ?? "미상";
}

function sourceRow(s: Summary): string {
  const base = `- 출처: ${sourceSite(s)} · [원문](${s.url})`;
  return isTranslated(s) ? base : `${base} (원문 요약)`;
}

function itemMarkdown(s: Summary, showGameLine: boolean): string[] {
  const out = [`### ${displayTitle(s)}`, ``];
  for (const b of displayBullets(s)) out.push(`- ${b}`);
  out.push(``);
  if (showGameLine) {
    const gl = gameLine(s);
    if (gl) out.push(`- ${gl}`, ``);
  }
  out.push(sourceRow(s), ``);
  return out;
}

function sectionMarkdown(heading: string, items: Summary[], showGameLine: boolean): string[] {
  const out = [`## ${heading}`, ``];
  if (items.length === 0) {
    out.push(`(오늘은 해당 소식이 없습니다)`, ``);
    return out;
  }
  for (const s of items) out.push(...itemMarkdown(s, showGameLine));
  return out;
}

/** 할인 섹션 한 줄: 게임명·할인율·현재가격·링크만. 요약 불릿 없다. */
function saleRow(item: NewsItem, forDiscord: boolean): string {
  const name = item.sale?.gameName ?? item.title;
  const pct = item.sale?.percent;
  const price = item.sale?.priceFinal ?? item.sale?.priceInitial;
  const head = pct !== undefined ? `- ${name} ${pct}%` : `- ${name}`;
  // Discord는 <>로 임베드 억제, md는 불필요.
  const link = forDiscord ? `[스토어](<${item.url}>)` : `[스토어](${item.url})`;
  return price ? `${head} · ${price} · ${link}` : `${head} · ${link}`;
}

function saleSectionMarkdown(items: NewsItem[]): string[] {
  const out = [`## ${SALE_HEADING}`, ``];
  if (items.length === 0) {
    out.push(`(오늘은 해당 소식이 없습니다)`, ``);
    return out;
  }
  for (const item of items) out.push(saleRow(item, false));
  out.push(``);
  return out;
}

/** md 발행물 전문. digestText는 평문 한 문단 (없으면 섹션 생략). */
export function renderMarkdown(
  personal: Summary[],
  extra: Summary[],
  sale: NewsItem[],
  digestText: string,
  showGameLine = false,
): string {
  const lines: string[] = [
    `# Questail Postie picks (${today()})`,
    ``,
    `선정 ${personal.length + extra.length}건`,
    ``,
  ];
  if (digestText.trim()) {
    lines.push(digestText.trim(), ``);
  }
  lines.push(...sectionMarkdown(PERSONAL_HEADING, personal, showGameLine));
  lines.push(...sectionMarkdown(GENERAL_HEADING, extra, showGameLine));
  lines.push(...saleSectionMarkdown(sale));
  return lines.join("\n");
}

function itemDiscord(s: Summary, showGameLine: boolean): string {
  const parts = [`**${displayTitle(s)}**`, `- ${displayBullets(s).join("\n- ")}`];
  if (showGameLine) {
    const gl = gameLine(s);
    if (gl) parts.push(gl);
  }
  const source = `[출처: ${sourceSite(s)}](<${s.url}>)`;
  parts.push(isTranslated(s) ? source : `${source} (원문 요약)`);
  return parts.join("\n");
}

/** 한 항목이 통째로 한도를 넘을 때만 잘라 표시를 남긴다. */
function truncateBlock(block: string): string {
  if (block.length <= DISCORD_LIMIT) return block;
  return `${block.slice(0, DISCORD_LIMIT - TRUNC_MARK.length)}${TRUNC_MARK}`;
}

/**
 * Discord 전송용 메시지 묶음. 전체를 한 메시지로 묶되 2000자를 넘기면
 * 항목 경계에서만 분할한다. 버리는 페이로드는 없다.
 */
export function buildDiscordMessages(
  personal: Summary[],
  extra: Summary[],
  sale: NewsItem[],
  digestText: string,
  showGameLine = false,
): string[] {
  const blocks: string[] = [`**Questail Postie picks (${today()})**`];
  if (digestText.trim()) blocks.push(digestText.trim());
  const pushSection = (heading: string, items: Summary[]): void => {
    if (items.length === 0) {
      blocks.push(`**${heading}**\n(오늘은 해당 소식이 없습니다)`);
      return;
    }
    items.forEach((s, i) => {
      const head = i === 0 ? `**${heading}**\n` : "";
      blocks.push(`${head}${itemDiscord(s, showGameLine)}`);
    });
  };
  pushSection(PERSONAL_HEADING, personal);
  pushSection(GENERAL_HEADING, extra);
  if (sale.length === 0) {
    blocks.push(`**${SALE_HEADING}**\n(오늘은 해당 소식이 없습니다)`);
  } else {
    blocks.push(`**${SALE_HEADING}**\n${sale.map((s) => saleRow(s, true)).join("\n")}`);
  }

  const parts: string[] = [];
  let cur = "";
  const flush = (): void => {
    if (cur) parts.push(cur);
    cur = "";
  };
  for (const block of blocks) {
    if (block.length > DISCORD_LIMIT) {
      flush();
      parts.push(truncateBlock(block));
      continue;
    }
    if (!cur) {
      cur = block;
    } else if (cur.length + 2 + block.length > DISCORD_LIMIT) {
      flush();
      cur = block;
    } else {
      cur = `${cur}\n\n${block}`;
    }
  }
  flush();
  if (parts.length === 0) parts.push("Questail Postie: 선정된 소식이 없습니다.");
  return parts;
}

export async function publishAll(
  sections: { personal: Summary[]; extra: Summary[]; sale: NewsItem[] },
  opts: PublishOptions,
  digestText = "",
): Promise<{ delivered: boolean; file: string; parts: number }> {
  const showGameLine = opts.showGameLine ?? false;
  const markdown = renderMarkdown(
    sections.personal,
    sections.extra,
    sections.sale,
    digestText,
    showGameLine,
  );
  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, markdown, "utf-8");

  if (!opts.webhookUrl) {
    return { delivered: false, file: opts.outPath, parts: 0 };
  }

  try {
    const messages = buildDiscordMessages(
      sections.personal,
      sections.extra,
      sections.sale,
      digestText,
      showGameLine,
    );
    for (const content of messages) {
      const res = await fetch(opts.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) return { delivered: false, file: opts.outPath, parts: messages.length };
    }
    return { delivered: true, file: opts.outPath, parts: messages.length };
  } catch {
    return { delivered: false, file: opts.outPath, parts: 0 };
  }
}

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Summary } from "./types.js";

export interface PublishOptions {
  webhookUrl?: string;
  outPath: string;
}

const DISCORD_LIMIT = 2000;
const DISCORD_CHUNK = 1900;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function displayTitle(s: Summary): string {
  return s.titleKo ?? s.title;
}

function originalTitleLine(s: Summary): string | null {
  if (s.titleKo && s.titleKo !== s.title) return s.title;
  return null;
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

function digestSection(lines: string[], md: boolean): string[] {
  if (lines.length === 0) return [];
  if (md) return ["## 오늘의 분위기", "", ...lines.map((l) => `- ${l}`), ""];
  return [`**오늘의 분위기**`, ...lines.map((l) => `- ${l}`)];
}

function toMarkdown(summaries: Summary[], digest: string[]): string {
  const lines: string[] = [
    `# Questail Postie picks (${today()})`,
    ``,
    `선정 ${summaries.length}건`,
    ``,
    ...digestSection(digest, true),
  ];
  if (summaries.length === 0) {
    lines.push("선정된 소식이 없습니다.");
    return lines.join("\n");
  }
  for (const s of summaries) {
    lines.push(`## ${displayTitle(s)}`);
    const original = originalTitleLine(s);
    if (original) lines.push(`*원제: ${original}*`);
    if (s.imageUrl) lines.push(`![](${s.imageUrl})`);
    lines.push(``);
    for (const b of s.bulletsKo) lines.push(`- ${b}`);
    lines.push(``);
    lines.push(`> ${s.insightKo}`);
    lines.push(``);
    if (s.appId !== undefined) lines.push(`- appId: ${s.appId}`);
    const gl = gameLine(s);
    if (gl) lines.push(`- ${gl}`);
    lines.push(`- 출처: ${sourceSite(s)} · [원문](${s.url})`);
    lines.push(``);
  }
  return lines.join("\n");
}

interface DiscordPayload {
  content: string;
  embeds: Array<{ image: { url: string } }>;
}

function itemBlock(s: Summary): { text: string; imageUrl?: string } {
  const parts = [`**${displayTitle(s)}**`];
  const original = originalTitleLine(s);
  if (original) parts.push(`원제: ${original}`);
  parts.push(`- ${s.bulletsKo.join("\n- ")}`, `> ${s.insightKo}`);
  const gl = gameLine(s);
  if (gl) parts.push(gl);
  parts.push(`[출처: ${sourceSite(s)}](<${s.url}>)`);
  return { text: parts.join("\n"), imageUrl: s.imageUrl };
}

function toDiscordPayloads(summaries: Summary[], digest: string[]): DiscordPayload[] {
  if (summaries.length === 0 && digest.length === 0) {
    return [{ content: "Questail Postie: 선정된 소식이 없습니다.", embeds: [] }];
  }
  const blocks: Array<{ text: string; imageUrl?: string }> = [];
  const head = digestSection(digest, false);
  if (head.length > 0) blocks.push({ text: head.join("\n") });
  for (const s of summaries) blocks.push(itemBlock(s));

  const payloads: DiscordPayload[] = [];
  let current = "";
  let embeds: DiscordPayload["embeds"] = [];
  const flush = () => {
    if (current.length > 0) payloads.push({ content: current, embeds });
    current = "";
    embeds = [];
  };
  for (const b of blocks) {
    const next = current.length === 0 ? b.text : `${current}\n\n${b.text}`;
    if (next.length > DISCORD_CHUNK && current.length > 0) flush();
    current = current.length === 0 ? b.text : `${current}\n\n${b.text}`;
    if (b.imageUrl && embeds.length < 10) embeds.push({ image: { url: b.imageUrl } });
  }
  flush();
  return payloads;
}

export async function publishAll(
  summaries: Summary[],
  opts: PublishOptions,
  digest: string[] = [],
): Promise<{ delivered: boolean; file: string }> {
  const markdown = toMarkdown(summaries, digest);
  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, markdown, "utf-8");

  if (!opts.webhookUrl) {
    return { delivered: false, file: opts.outPath };
  }

  try {
    const payloads = toDiscordPayloads(summaries, digest);
    for (const payload of payloads) {
      if (payload.content.length > DISCORD_LIMIT) continue;
      const body: Record<string, unknown> = { content: payload.content };
      if (payload.embeds.length > 0) body.embeds = payload.embeds;
      const res = await fetch(opts.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { delivered: false, file: opts.outPath };
    }
    return { delivered: true, file: opts.outPath };
  } catch {
    return { delivered: false, file: opts.outPath };
  }
}

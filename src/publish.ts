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

function toMarkdown(summaries: Summary[]): string {
  const lines: string[] = [
    `# Questail Postie picks (${today()})`,
    ``,
    `선정 ${summaries.length}건`,
    ``,
  ];
  if (summaries.length === 0) {
    lines.push("선정된 소식이 없습니다.");
    return lines.join("\n");
  }
  for (const s of summaries) {
    lines.push(`## ${s.title}`);
    lines.push(``);
    for (const b of s.bulletsKo) lines.push(`- ${b}`);
    lines.push(``);
    lines.push(`> ${s.insightKo}`);
    lines.push(``);
    if (s.appId !== undefined) lines.push(`- appId: ${s.appId}`);
    lines.push(`- 원문: [링크](${s.url})`);
    lines.push(``);
  }
  return lines.join("\n");
}

function toDiscordText(summaries: Summary[]): string {
  if (summaries.length === 0) return "Questail Postie: 선정된 소식이 없습니다.";
  return summaries
    .map(
      (s) =>
        `**${s.title}**\n- ${s.bulletsKo.join("\n- ")}\n> ${s.insightKo}\n${s.url}`,
    )
    .join("\n\n");
}

function splitChunks(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current.length === 0 ? line : `${current}\n${line}`;
    if (next.length > max && current.length > 0) {
      chunks.push(current);
      current = line.length > max ? line.slice(0, max) : line;
    } else if (next.length > max) {
      chunks.push(next.slice(0, max));
      current = next.slice(max);
    } else {
      current = next;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function publishAll(
  summaries: Summary[],
  opts: PublishOptions,
): Promise<{ delivered: boolean; file: string }> {
  const markdown = toMarkdown(summaries);
  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, markdown, "utf-8");

  if (!opts.webhookUrl) {
    return { delivered: false, file: opts.outPath };
  }

  try {
    const chunks = splitChunks(toDiscordText(summaries), DISCORD_CHUNK);
    for (const chunk of chunks) {
      if (chunk.length > DISCORD_LIMIT) continue;
      const res = await fetch(opts.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: chunk }),
      });
      if (!res.ok) return { delivered: false, file: opts.outPath };
    }
    return { delivered: true, file: opts.outPath };
  } catch {
    return { delivered: false, file: opts.outPath };
  }
}

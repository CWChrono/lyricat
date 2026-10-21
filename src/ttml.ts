// Serialize our word-level LRC into Apple-style word-timed TTML (Timed Text Markup Language) — the
// format Apple Music / many karaoke apps use. It's a one-way EXPORT derived from the LRC (the source
// of truth). Two orthogonal word properties are carried through:
//   • the duet VOICE → TTML agents: "both" (default, a <ttm:agent type="group">), "a", "b". Each line
//     <p> is tagged ttm:agent="both"; a <span> that is a soloist overrides with ttm:agent="a"/"b".
//     Agents "a"/"b" carry the per-track UI nicknames (default Mittens/Biscuit) as <ttm:name>.
//   • the background LANE → ttm:role="x-bg" on the span (independent of the voice).

import { parseWordLrcLines, LrcLine } from "./lrcwords";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Milliseconds → TTML clock-time `HH:MM:SS.mmm`. */
export function ttmlClock(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const p3 = (n: number): string => String(n).padStart(3, "0");
  return `${p2(Math.floor(t / 3600000))}:${p2(Math.floor(t / 60000) % 60)}:${p2(Math.floor(t / 1000) % 60)}.${p3(t % 1000)}`;
}

/** UI nicknames for the two duet voices, used as the TTML agents' <ttm:name>. */
export interface SingerNames {
  a?: string;
  b?: string;
}

/** Word-level lyrics → word-timed TTML. Accepts raw LRC text OR already-parsed lines. `names` supplies
 *  the per-track voice nicknames (default Mittens/Biscuit). Returns a minimal-but-valid document. */
export function wordLrcToTtml(src: string | LrcLine[], names: SingerNames = {}): string {
  const parsed = typeof src === "string" ? parseWordLrcLines(src) : src;
  const lines = parsed.filter((l) => l.words.length);
  const nameA = (names.a || "Mittens").trim() || "Mittens";
  const nameB = (names.b || "Biscuit").trim() || "Biscuit";
  const ps = lines.map((l) => {
    const begin = Math.min(...l.words.map((w) => w.start));
    const end = Math.max(...l.words.map((w) => w.end));
    const spans = l.words
      .map((w) => {
        // Line default is "both"; only a soloist word overrides the agent.
        const agent = w.singer === "a" ? ` ttm:agent="a"` : w.singer === "b" ? ` ttm:agent="b"` : "";
        const role = w.secondary ? ` ttm:role="x-bg"` : "";
        return `<span begin="${ttmlClock(w.start)}" end="${ttmlClock(w.end)}"${agent}${role}>${esc(w.text)}</span>`;
      })
      .join(" ");
    return `      <p ttm:agent="both" begin="${ttmlClock(begin)}" end="${ttmlClock(end)}">${spans}</p>`;
  });
  return (
    [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word">`,
      `  <head>`,
      `    <metadata>`,
      `      <ttm:agent type="group" xml:id="both"/>`,
      `      <ttm:agent type="person" xml:id="a"><ttm:name type="full">${esc(nameA)}</ttm:name></ttm:agent>`,
      `      <ttm:agent type="person" xml:id="b"><ttm:name type="full">${esc(nameB)}</ttm:name></ttm:agent>`,
      `    </metadata>`,
      `  </head>`,
      `  <body>`,
      `    <div>`,
      ...ps,
      `    </div>`,
      `  </body>`,
      `</tt>`,
    ].join("\n") + "\n"
  );
}

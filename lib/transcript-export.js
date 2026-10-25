/**
 * 文稿落盘：SRT + 带时间戳的 Markdown + JSON 缓存。
 *
 * 单一真相源：bilibili_extract 的提取流程与 scripts/export-transcript.mjs 共用这里的
 * 排版与写盘逻辑，避免「插件里一套、脚本里又一套」。
 *
 * @module dsh-bilibili/transcript-export
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const pad = (value, width = 2) => String(Math.trunc(value)).padStart(width, "0");

/** 秒 → SRT 时间戳（HH:MM:SS,mmm）。 */
export function srtTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const ms = Math.round(total * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return pad(h) + ":" + pad(m) + ":" + pad(s) + "," + pad(ms % 1000, 3);
}

/** 秒 → 文稿行首时间（M:SS 或 H:MM:SS），与 digest 里的 formatTime 同款。 */
export function clockTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
}

/** 只留可用段落：有文字、时间可数值化的。 */
export function cleanSegments(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const out = [];
  for (const seg of list) {
    const text = String(seg?.text ?? "").trim();
    if (!text) continue;
    const start = Number(seg?.start);
    const end = Number(seg?.end);
    out.push({
      start: Number.isFinite(start) ? start : 0,
      end: Number.isFinite(end) && end >= start ? end : (Number.isFinite(start) ? start : 0),
      text,
    });
  }
  return out;
}

/**
 * 段落 → SRT 文本。结束时间缺失或过短时给 0.3s 保底，
 * 且不越过下一段起点（避免字幕叠住）。
 */
export function toSrt(segments) {
  const list = cleanSegments(segments);
  const lines = [];
  for (let i = 0; i < list.length; i++) {
    const seg = list[i];
    let end = seg.end > seg.start ? seg.end : seg.start + 0.3;
    const next = list[i + 1];
    if (next && next.start > seg.start && end > next.start) end = next.start;
    lines.push(String(i + 1));
    lines.push(srtTime(seg.start) + " --> " + srtTime(end));
    lines.push(seg.text);
    lines.push("");
  }
  return lines.join("\n");
}

/** 段落 → 「[M:SS] 文字」逐行文稿。 */
export function toTimestampedText(segments) {
  return cleanSegments(segments)
    .map((seg) => "[" + clockTime(seg.start) + "] " + seg.text)
    .join("\n");
}

/**
 * 段落 + 元信息 → 人读 Markdown。
 * @param {{bvid?:string,title?:string,uploader?:string,duration?:number,
 *          source?:string,language?:string,segments?:Array,generatedAt?:string}} meta
 */
export function toTranscriptMarkdown(meta = {}) {
  const segments = cleanSegments(meta.segments);
  const source = meta.source || "unknown";
  const out = [];
  out.push("# " + (meta.title || meta.bvid || "文稿"));
  out.push("");
  const facts = [];
  if (meta.bvid) facts.push("- 视频: " + meta.bvid + (meta.uploader ? " / " + meta.uploader : ""));
  if (meta.duration) facts.push("- 时长: " + clockTime(meta.duration) + (meta.segments ? " / " + segments.length + " 段" : ""));
  facts.push("- 文稿来源: " + source + (meta.language ? " (" + meta.language + ")" : ""));
  if (meta.generatedAt) facts.push("- 导出时间: " + meta.generatedAt);
  out.push(...facts);
  out.push("");
  out.push("## 逐句文稿");
  out.push("");
  if (segments.length === 0) {
    out.push("_（无可用段落）_");
    return out.join("\n");
  }
  for (const seg of segments) out.push("**[" + clockTime(seg.start) + "]** " + seg.text);
  return out.join("\n");
}

/**
 * 把文稿写成 transcript.srt / transcript.md / transcript.json。
 * 任一步失败不影响提取结果（best-effort），返回已写成的路径。
 */
export async function writeTranscriptFiles(outDir, meta = {}) {
  const transcript = meta.transcript ?? {};
  const segments = cleanSegments(transcript.segments);
  if (!outDir || segments.length === 0) return null;
  const generatedAt = meta.generatedAt ?? new Date().toISOString();
  const srtPath = join(outDir, "transcript.srt");
  const mdPath = join(outDir, "transcript.md");
  const jsonPath = join(outDir, "transcript.json");
  const saved = { dir: outDir, srt: srtPath, md: mdPath, json: jsonPath };
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(srtPath, toSrt(segments), "utf8");
    await writeFile(
      mdPath,
      toTranscriptMarkdown({
        bvid: meta.bvid,
        title: meta.title,
        uploader: meta.uploader,
        duration: meta.duration,
        source: transcript.source,
        language: transcript.language,
        segments,
        generatedAt,
      }),
      "utf8",
    );
    // 与 readTranscriptCache 的读取形状保持一致（text + segments）
    await writeFile(
      jsonPath,
      JSON.stringify({
        source: transcript.source ?? "unknown",
        language: transcript.language ?? "unknown",
        text: transcript.text ?? segments.map((s) => s.text).join("\n"),
        segments,
        total_segments: segments.length,
        note: transcript.note ?? "",
        saved_at: generatedAt,
      }),
      "utf8",
    );
  } catch {
    return null;
  }
  return saved;
}

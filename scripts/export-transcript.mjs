#!/usr/bin/env node
/**
 * 单独导出一条 B站视频的逐句文稿：transcript.srt + transcript.md + transcript.json。
 *
 *   node scripts/export-transcript.mjs BV1gFp26uEKh
 *   node scripts/export-transcript.mjs https://www.bilibili.com/video/BV1gFp26uEKh --out ./out --print
 *
 * 选项：
 *   --out DIR      额外把三件拷到 DIR（默认只留在 /tmp/dsh-bilibili/<BV>/）
 *   --asr MODE     无字幕轨时的兜底：bcut（默认）/ none / auto / sherpa-onnx / whisper-local
 *   --print        把「[M:SS] 句子」逐行打到 stdout
 *
 * 文稿优先走官方字幕轨（需 SESSDATA，扫码登录后自动读取）；没有字幕轨才走 ASR。
 * 排版与写盘逻辑来自 lib/transcript-export.js —— 与插件内提取流程同一套实现。
 */

import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { extractAll } from "../lib/extractor.js";
import { loadStoredSessdata } from "../lib/login.js";
import { toTimestampedText } from "../lib/transcript-export.js";

function parseArgs(argv) {
  const opts = { target: "", out: "", asr: "bcut", print: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") opts.out = argv[++i] ?? "";
    else if (arg === "--asr") opts.asr = argv[++i] ?? "bcut";
    else if (arg === "--print") opts.print = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else if (!opts.target) opts.target = arg;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.target) {
  console.log("用法: node scripts/export-transcript.mjs <BV号或视频URL> [--out DIR] [--asr bcut|none|auto] [--print]");
  process.exit(opts.help ? 0 : 1);
}

const stored = await loadStoredSessdata();
const sessdata = process.env.BILIBILI_SESSDATA || stored?.sessdata || "";

const value = await extractAll({
  url: opts.target,
  sessdata,
  commentLimit: 0,
  extractFrames: false,
  asrProvider: opts.asr,
  envReport: null,
});

if (value.success !== true) {
  console.error("[export] 提取失败: " + (value.error ?? "unknown error"));
  process.exit(2);
}

const transcript = value.transcript ?? {};
const saved = transcript.saved;
const lines = [];
lines.push("标题: " + (value.metadata?.title ?? ""));
lines.push("UP主: " + (value.metadata?.uploader?.name ?? "unknown") +
  " | 时长: " + (value.metadata?.duration ?? 0) + "s");
lines.push("文稿: source=" + (transcript.source ?? "none") +
  " | language=" + (transcript.language ?? "unknown") +
  " | segments=" + (transcript.total_segments ?? 0));

if (!transcript.text) {
  console.error(lines.join("\n"));
  console.error("没有拿到文稿。" + (transcript.note ?? ""));
  process.exit(3);
}

if (!saved) {
  console.error(lines.join("\n"));
  console.error("文稿已拿到但落盘失败（检查目录权限）");
  process.exit(4);
}

lines.push("srt: " + saved.srt);
lines.push("md:  " + saved.md);
lines.push("json: " + saved.json);

if (opts.out) {
  await mkdir(opts.out, { recursive: true });
  for (const [key, name] of [["srt", "transcript.srt"], ["md", "transcript.md"], ["json", "transcript.json"]]) {
    const dest = join(opts.out, name);
    await copyFile(saved[key], dest);
    lines.push("复制到: " + dest);
  }
}

console.log(lines.join("\n"));
if (opts.print) {
  console.log("");
  console.log(toTimestampedText(transcript.segments));
}

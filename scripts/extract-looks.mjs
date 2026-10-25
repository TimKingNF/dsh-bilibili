#!/usr/bin/env node
/**
 * 按 looks.json 逐套抓帧并出报告 —— 与 bilibili_extract 共用 lib/extractor.js 的
 * extractAll（场景对齐 + 清晰帧优选 + 文稿缓存），只是把「时间点 → 帧文件 → 报告」
 * 这一段固定下来。
 *
 *   node scripts/extract-looks.mjs BV1gFp26uEKh --looks looks.json --out ./out
 *   node scripts/extract-looks.mjs https://www.bilibili.com/video/BV... \
 *     --looks looks.json --out ./out --quality 80 --json
 *
 * looks.json（数组，或 { "looks": [...] }）：
 *   [
 *     { "id": "01", "title": "深棕绞花开衫 + 醋酸阔腿裤", "at": 55, "also": [49] },
 *     { "id": "02", "title": "棕色连帽羊毛开衫", "at": 68 }
 *   ]
 *
 * 字段：
 *   at      主帧时刻（秒），一般取该套全身镜头
 *   also    额外时刻（秒，可选，可多个）：细节、品牌卡、版型特写
 *   window  文稿摘录区间 [start, end]（秒，可选）；默认 [at-20, 下一套 at]
 *
 * 产物：
 *   <out>/frames/<bvid>/<id>_main.jpg、<id>_extra1.jpg ...
 *   <out>/report.md、<out>/report.json
 *   <out>/.work/<bvid>/   工作区（视频缓存 24h，同目录重跑直接复用）
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractAll } from "../lib/extractor.js";
import { loadStoredSessdata } from "../lib/login.js";
import { clockTime } from "../lib/transcript-export.js";

/** 单次调用上限：extractAll 内部把 timestamps 截到 20 个。 */
const MAX_FRAMES_PER_CALL = 20;

function usage() {
  console.log(
    "用法: node scripts/extract-looks.mjs <BV号或视频URL> --looks looks.json [选项]\n" +
    "\n" +
    "选项:\n" +
    "  --out DIR       产物目录（默认 ./looks-out）\n" +
    "  --quality N     清晰度 qn：16=360p 32=480p(默认) 64=720p 80=1080p\n" +
    "  --asr MODE      无字幕轨时的兜底：bcut(默认) / none / auto / sherpa-onnx / whisper-local\n" +
    "  --json          结束时把结构化报告打到 stdout\n",
  );
}

function parseArgs(argv) {
  const opts = { target: "", looks: "", out: "looks-out", quality: 32, asr: "bcut", json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--looks") opts.looks = argv[++i] ?? "";
    else if (arg === "--out") opts.out = argv[++i] ?? "";
    else if (arg === "--quality") opts.quality = Number(argv[++i]);
    else if (arg === "--asr") opts.asr = argv[++i] ?? "bcut";
    else if (arg === "--json") opts.json = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else if (!opts.target) opts.target = arg;
  }
  return opts;
}

function die(message, code = 1) {
  console.error("[looks] " + message);
  process.exit(code);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.target || !opts.looks) {
  usage();
  process.exit(opts.help ? 0 : 1);
}

// —— looks.json ——
let raw;
try {
  raw = JSON.parse(await readFile(opts.looks, "utf8"));
} catch (error) {
  die("读不了 looks 文件 " + opts.looks + "：" + (error?.message ?? error));
}
const list = Array.isArray(raw) ? raw : Array.isArray(raw?.looks) ? raw.looks : null;
if (!list || list.length === 0) die("looks 文件为空或格式不对（应为数组，或 { looks: [...] }）");

const looks = list.map((item, index) => {
  const at = Number(item?.at);
  if (!Number.isFinite(at) || at < 0) die("第 " + (index + 1) + " 套缺少合法的 at（秒）");
  const also = (Array.isArray(item?.also) ? item.also : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
  const window = Array.isArray(item?.window) && item.window.length === 2
    ? item.window.map(Number)
    : null;
  return {
    id: String(item?.id ?? String(index + 1).padStart(2, "0")),
    title: String(item?.title ?? "").trim(),
    at,
    also,
    window,
  };
});

const requests = [];
for (const look of looks) {
  requests.push({ lookId: look.id, role: "main", time: look.at });
  look.also.forEach((time, i) => requests.push({ lookId: look.id, role: "extra" + (i + 1), time }));
}
if (requests.length > MAX_FRAMES_PER_CALL) {
  die(
    "本次需要 " + requests.length + " 个时间点，超过单次上限 " + MAX_FRAMES_PER_CALL +
    "；把 looks.json 拆成两份、用同一个 --out 分别跑（第二次会复用视频缓存）。",
  );
}

// —— 提取（复用插件实现）——
const stored = await loadStoredSessdata();
const sessdata = process.env.BILIBILI_SESSDATA || stored?.sessdata || "";
const outDir = resolve(opts.out);
const workDir = join(outDir, ".work");

const value = await extractAll({
  url: opts.target,
  sessdata,
  commentLimit: 0,
  extractFrames: true,
  timestamps: requests.map((req) => req.time),
  maxFrames: requests.length,
  quality: Number.isFinite(opts.quality) ? opts.quality : 32,
  asrProvider: opts.asr,
  framesDir: workDir,
  downloadVideo: true,
  keepVideo: true,
});
if (value.success !== true) {
  die("提取失败: " + (value.error ?? "unknown error"), 2);
}

const bvid = value.bvid;
const meta = value.metadata ?? {};
const transcript = value.transcript ?? {};
const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
const duration = Number(meta.duration) || 0;

// —— 帧落位：请求时刻 → 实际帧（normalize 会按时间升序重排）——
const byRequested = new Map();
for (const frame of value.frames?.frames ?? []) {
  const key = Number(frame?.requested_time ?? frame?.time);
  if (Number.isFinite(key)) byRequested.set(key.toFixed(1), frame);
}

const safeId = (id) => String(id).replace(/[^\w.-]+/g, "_");
const framesOutDir = join(outDir, "frames", bvid);
await mkdir(framesOutDir, { recursive: true });

const entries = [];
for (const req of requests) {
  const hit = byRequested.get(Number(req.time).toFixed(1)) ?? null;
  if (!hit || !hit.path) {
    entries.push({
      ...req,
      path: null,
      actual: null,
      error: hit?.error ?? "插件未返回该时刻（超出时长 / 被去重 / 超过 20 帧上限）",
    });
    continue;
  }
  const fileName = safeId(req.lookId) + "_" + req.role + ".jpg";
  const dest = join(framesOutDir, fileName);
  await copyFile(hit.path, dest);
  entries.push({
    ...req,
    path: dest,
    actual: Number(hit.time),
    error: null,
    reason: hit.reason ?? "",
    subtitle: hit.text ?? "",
  });
}

// —— 报告 ——
const excerptFor = (look, index) => {
  const end = look.window?.[1] ?? looks[index + 1]?.at ?? look.at + 40;
  const start = look.window?.[0] ?? Math.max(0, look.at - 20);
  return segments.filter((seg) => Number(seg.end) > start && Number(seg.start) < end);
};

const okCount = entries.filter((entry) => entry.path).length;
const md = [];
md.push("# " + (meta.title || bvid));
md.push("");
md.push("- 视频: " + bvid + " / " + (meta.uploader?.name ?? "unknown"));
md.push("- 时长: " + clockTime(duration) + " | 文稿: " + (transcript.source ?? "none") +
  " / " + segments.length + " 段");
md.push("- 抓帧: " + okCount + "/" + requests.length + " → frames/" + bvid + "/");
md.push("- 工作区: .work/" + bvid + "/（视频缓存 24h）");
md.push("");

looks.forEach((look, index) => {
  md.push("## " + look.id + (look.title ? " " + look.title : ""));
  const own = entries.filter((entry) => entry.lookId === look.id);
  for (const entry of own) {
    const label = entry.role === "main" ? "主帧" : "细节";
    const timing = entry.actual !== null && entry.actual !== entry.time
      ? clockTime(entry.time) + " → " + clockTime(entry.actual)
      : clockTime(entry.time);
    md.push("- " + label + ": " + timing + "  `" + (entry.path ?? "未抓到") + "`" +
      (entry.error ? " ⚠ " + entry.error : ""));
  }
  const excerpt = excerptFor(look, index);
  if (excerpt.length > 0) {
    md.push("- 文稿:");
    for (const seg of excerpt) md.push("  [" + clockTime(seg.start) + "] " + seg.text);
  }
  md.push("");
});

const report = {
  video: { bvid, title: meta.title ?? "", uploader: meta.uploader?.name ?? "", duration },
  transcript: {
    source: transcript.source ?? "none",
    segments: segments.length,
    saved: transcript.saved ?? null,
  },
  framesDir: framesOutDir,
  looks: looks.map((look, index) => ({
    id: look.id,
    title: look.title,
    at: look.at,
    window: look.window ?? [Math.max(0, look.at - 20), looks[index + 1]?.at ?? look.at + 40],
    frames: entries.filter((entry) => entry.lookId === look.id).map((entry) => ({
      role: entry.role,
      requested: entry.time,
      actual: entry.actual,
      path: entry.path,
      error: entry.error,
      subtitle: entry.subtitle ?? "",
    })),
  })),
  missing: entries.filter((entry) => !entry.path).map((entry) => ({
    look: entry.lookId, role: entry.role, time: entry.time, error: entry.error,
  })),
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "report.md"), md.join("\n"), "utf8");
await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");

console.log("抓帧 " + okCount + "/" + requests.length + " → " + framesOutDir);
console.log("报告: " + join(outDir, "report.md") + " | " + join(outDir, "report.json"));
if (report.missing.length > 0) {
  console.error("[looks] 有 " + report.missing.length + " 张没抓到，见 report.json 的 missing");
}
if (opts.json) console.log(JSON.stringify(report, null, 2));
process.exit(okCount === 0 ? 3 : 0);

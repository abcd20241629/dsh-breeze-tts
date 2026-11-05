// create-voice.mjs — 按 JSON 描述注册一个 Breeze 音色档案
// 用法: node create-voice.mjs <payload.json>
// payload.json 字段:
//   { wav, reference_text, name, mode?, instruction?, timbre?, notes?, tags?, language?, preview_text? }
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [, , jsonPath] = process.argv;
if (!jsonPath) {
  console.error("usage: node create-voice.mjs <payload.json>");
  process.exit(2);
}

const spec = JSON.parse(readFileSync(jsonPath, "utf8"));
if (!spec.wav || !spec.reference_text || !spec.name) {
  console.error("payload 缺少 wav / reference_text / name");
  process.exit(2);
}

const BASE = process.env.BREEZE_BASE || "http://127.0.0.1:7860";
const body = {
  name: spec.name,
  mode: spec.mode || "direction",
  instruction: spec.instruction || "语速偏慢，尾音轻轻上扬，像在撒娇，句子之间留一点空白。",
  reference_text: spec.reference_text,
  reference_transcript_verified: true,
  reference_filename: basename(spec.wav),
  reference_audio_base64: readFileSync(spec.wav).toString("base64"),
  language: spec.language || "zh",
  tags: spec.tags || ["大肥鱼"],
  favorite: spec.favorite !== false,
  notes: spec.notes || (spec.timbre ? `音色层（重建用）：${spec.timbre}` : ""),
  preview_text: spec.preview_text || "主人，本鱼在这里。",
};

const res = await fetch(`${BASE}/api/voices`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log("STATUS", res.status);
console.log(text);

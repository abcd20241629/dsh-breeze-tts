// speak-voice.mjs — 用已注册的音色档案说话（不改插件，直接走 ws）
// 用法: node speak-voice.mjs <payload.json>
// payload.json: { voice_id, text, direction_text?, direction_mode?, seed?, play? }
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [, , jsonPath] = process.argv;
if (!jsonPath) {
  console.error("usage: node speak-voice.mjs <payload.json>");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(jsonPath, "utf8"));
const WS = "ws://127.0.0.1:7860/ws/generate";

const payload = {
  text: spec.text,
  voice_id: spec.voice_id || "",
  seed: spec.seed ?? 42,
  cfg_scale: 4.0,
  stream_audio: false,
};
if (spec.direction_text) {
  payload.direction_mode = spec.direction_mode || "override";
  payload.direction_text = spec.direction_text;
} else if (spec.direction_mode) {
  payload.direction_mode = spec.direction_mode;
}

const t0 = Date.now();
await new Promise((resolve, reject) => {
  const ws = new WebSocket(WS);
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => {
    console.log("[open]");
    ws.send(JSON.stringify(payload));
  });
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.type === "start") console.log("[start] sr=" + msg.sample_rate);
      else if (msg.type === "complete") {
        const m = msg.metadata || {};
        console.log(
          "[complete] output=" + msg.output +
          " dur=" + (m.duration_seconds ?? "?") + "s" +
          " elapsed=" + ((Date.now() - t0) / 1000).toFixed(1) + "s" +
          " rtf=" + (m.rtf ?? "?")
        );
        ws.close();
        resolve(msg.output);
      } else if (msg.type === "error") {
        console.error("[error]", msg.message);
        ws.close();
        reject(new Error(msg.message));
      }
    }
  });
  ws.addEventListener("error", (e) => reject(new Error(String(e))));
  ws.addEventListener("close", () => console.log("[close]"));
}).then(async (file) => {
  if (spec.play === false) return;
  const settings = await (await fetch("http://127.0.0.1:7860/api/settings")).json();
  const full = settings.output_directory.replace(/\\+$/, "") + "\\" + file;
  console.log("[play]", full);
  return new Promise((res) => {
    const p = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
       `$p = New-Object System.Media.SoundPlayer '${full}'; $p.PlaySync()`],
      { stdio: "inherit" }
    );
    p.on("exit", () => { console.log("[played]"); res(); });
  });
}).catch((e) => { console.error("FAILED", e.message); process.exit(1); });

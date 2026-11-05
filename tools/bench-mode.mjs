const WS = globalThis.WebSocket;
const mode = process.argv[2] || 'clone';
const text = process.argv[3] || '咕噜，主人我在这儿呢。';
const cfg = Number(process.argv[4] || 1.0);
const t0 = Date.now();
const payload = {
  mode, text, cfg_scale: cfg, seed: 42, stream_audio: false,
  reference_transcript_verified: true,
  ref_audio_path: 'D:\\dsh\\plugins\\dsh-breeze-tts\\data\\refs\\大肥鱼.wav',
  ref_text: '主人——本鱼今天也有好好待在水里哦。'
};
if (mode === 'design') {
  delete payload.ref_audio_path; delete payload.ref_text;
  payload.instruction = '一位十四五岁的少女声音，软糯带气声。';
}
const ws = new WS('ws://127.0.0.1:7860/ws/generate');
ws.binaryType = 'arraybuffer';
ws.onopen = () => ws.send(JSON.stringify(payload));
ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') return;
  const m = JSON.parse(ev.data);
  if (m.type === 'complete') {
    const d = m.metadata || {};
    console.log(JSON.stringify({ mode, cfg, dur: d.duration_seconds, elapsed: d.elapsed_seconds, rtf: d.rtf, wall: (Date.now()-t0)/1000 }));
    ws.close();
  } else if (m.type === 'error') { console.log('ERR ' + m.message); ws.close(); }
};
ws.onerror = () => console.log('WS_ERR');
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 500000);
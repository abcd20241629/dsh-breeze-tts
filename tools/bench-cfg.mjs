const WS = globalThis.WebSocket;
const text = process.argv[2] || '咕噜，主人我在这儿呢。';
const cfg = Number(process.argv[3] || 4.0);
const t0 = Date.now();
const ws = new WS('ws://127.0.0.1:7860/ws/generate');
ws.binaryType = 'arraybuffer';
ws.onopen = () => ws.send(JSON.stringify({
  voice_id: 'cfe07f1dbbda44899063d150ec9fda41',
  text, cfg_scale: cfg, seed: 42, stream_audio: false,
  direction_mode: 'override', direction_text: '轻快一点，像在邀功'
}));
ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') return;
  const m = JSON.parse(ev.data);
  if (m.type === 'complete') {
    const d = m.metadata || {};
    console.log(JSON.stringify({ cfg, dur: d.duration_seconds, elapsed: d.elapsed_seconds, rtf: d.rtf, wall: (Date.now()-t0)/1000, out: m.output }));
    ws.close();
  } else if (m.type === 'error') { console.log('ERR ' + m.message); ws.close(); }
};
ws.onerror = () => { console.log('WS_ERR'); };
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 400000);
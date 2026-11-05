const base = 'http://127.0.0.1:3080/breeze-tts/api/say'
const t0 = Date.now()
const one = (i) => fetch(base, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: `这是第${i}条并发的语音测试。`, card: '大肥鱼', play: false })
}).then(r => r.json()).then(j => {
  console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] #${i} ->`, j.ok ? `ok dur=${j.durationSec} elapsed=${j.elapsedSec}` : `FAIL ${j.error}`)
}).catch(e => console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] #${i} -> ERR ${e.message}`))
Promise.all([1, 2, 3].map(one)).then(() => console.log('ALL_DONE total=' + ((Date.now()-t0)/1000).toFixed(1) + 's'))
// 测 /breeze-tts/api/say：给 QQ 语音通道用的那个接口
const text = process.argv[2] || '主人，QQ 语音这条路我先试一句。'
const tone = process.argv[3] || '轻快一点，像在邀功'
const card = process.argv[4] || '大肥鱼'

const t0 = Date.now()
const r = await fetch('http://127.0.0.1:3080/breeze-tts/api/say', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, card, tone })
})
const j = await r.json().catch(() => ({}))
console.log('HTTP', r.status, `总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(JSON.stringify(j, null, 2))

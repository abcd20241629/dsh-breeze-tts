# dsh-breeze-tts

给 DSH 一副嗓子。用本机 **Breeze TTS 2**（配音级中文语音合成）说话：生成 wav、落盘、播放。

> 这不是实时对话引擎。模型常驻后，2~3 秒音频约需 30 秒；第一次冷启动还要加上模型上卡的时间。
> 适合「我先在后台算好，算完念给你听」，不适合一问一答的连续对话。

## 它从哪来

T8star Aix Voice Studio 是个 Electron 壳，真正的引擎是 `resources/backend` 里那套 Python + FastAPI。
本插件不重打包任何东西，直接连它本地的 `127.0.0.1:7860`，走 `/ws/generate`。

## 安装

插件放在 `D:\dsh\plugins\dsh-breeze-tts`（**别放移动硬盘**，加载 7.6G 模型时掉盘会很难看）。

```powershell
dev_inject_plugin D:\dsh\plugins\dsh-breeze-tts
```

纯 JS，没有构建步骤。需要 profile 里已有 `@dsh-external/dsh-breeze-tts` 的 junction；
重启后由 profile 的 `bundles` 正常装配。

## 工具

| 工具 | 干什么 |
| --- | --- |
| `breeze_say` | 念一句。参数 `text`（必填）、`instruction`（语气，自由文本，中英文都行）、`seed`（默认 42）、`play`（默认 true） |
| `breeze_warmup` | 拉起后端 + 把模型推进显存，约 30~60 秒。想开口前先预热 |
| `breeze_status` | 只读探活：后端在不在、模型在不在显存、输出目录在哪 |
| `breeze_release` | 卸掉模型释放约 8G 显存。**只对插件自己拉起的后端生效**，不碰 GUI 那个 |

`instruction` 举例：

```
温柔一点，慢一点，像在哄人
兴奋一点，语速快一些
平静地叙述，像在读信
```

## 后端是怎么起来的

`breeze_say` / `breeze_warmup` 第一次调用时：

1. 先探 `GET /api/health`。活着就直接复用（**可能就是你开着的 GUI**，不抢也不杀）
2. 没活着就 spawn `resources\python\python.exe -m t8_runtime.server --port 7860 --model-dir <模型目录>`
3. 轮询最多 180 秒等它 ready
4. 宿主退出时，只 kill 自己 spawn 的那个进程

## 环境变量

| 变量 | 默认值 |
| --- | --- |
| `BREEZE_TTS_HOME` | `D:\breeze tts2工作台` |
| `BREEZE_TTS_MODEL_DIR` | `D:\breeze tts2模型\models\breeze_tts\BreezeBlue_Breeze-TTS-2` |
| `BREEZE_TTS_PORT` | `7860` |
| `BREEZE_TTS_DATA` | `D:\dsh\plugins\dsh-breeze-tts\data` |

## 两个坑（写死了，别再踩）

**1. numba 缓存目录必须可写。**
DSH 沙箱默认写不了 `%LOCALAPPDATA%`，numba 于是每次冷编译 —— 光 `import qwen_tts` 就要 **7 分钟**。
把 `NUMBA_CACHE_DIR` 指到 `data\numba` 之后，同一个 import 变成 **13.9 秒**。
插件已经替你设了。

**2. 后端有三个目录必须指进可写位置。**
`T8_BREEZE_DATA_DIR`（日志 + 数据库）、`T8_BREEZE_OUTPUT_DIR`（wav）、`NUMBA_CACHE_DIR`。
不设的话启动直接 `PermissionError: [WinError 5]`。

## 已知限制

- `stream_audio:false`：整段生成完才落盘。开流式能提前出声，但总时长不变
- `design` 模式只吃文字，音色由 instruction + seed 决定。要复刻特定音色得走 `clone` 模式（参考 wav + 逐字稿），暂未开放
- 8G 显存（RTX 4060 Laptop）跑 `fast_all` 需要 20G+，用不了；实际走 `flash_attention_2`

## License

MIT

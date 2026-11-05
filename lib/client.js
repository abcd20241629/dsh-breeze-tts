/**
 * dsh-breeze-tts — browser half.
 *
 * 设置 → 语音：列 soul-md 的卡片，每张卡显示它绑定的参考音频，
 * 点一下就能听、能换、能设成默认。绑好之后，卡片说话自动用这条音频做参考。
 *
 * 手写 ModuleLoader bundle，无构建步骤（与 dsh-soul-md 同范式）。
 */
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-breeze-tts",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    var API = "/breeze-tts/api";

    // ── 样式（内联，避免额外注入 <style>）──────────────────────────────
    var S = {
      root: { maxWidth: 720, display: "flex", flexDirection: "column", gap: 14 },
      intro: { fontSize: 12, lineHeight: 1.7, color: "var(--dsw-alias-label-tertiary)" },
      group: {
        border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10,
        padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10
      },
      row: {
        display: "flex", alignItems: "center", gap: 10,
        border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: "8px 10px"
      },
      name: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)", whiteSpace: "nowrap" },
      sub: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      btn: {
        border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)",
        color: "var(--dsw-alias-label-primary)", borderRadius: 7, padding: "4px 10px",
        font: "inherit", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap"
      },
      btnPrimary: {
        border: "1px solid var(--dsw-alias-state-business-primary, #3964fe)",
        background: "var(--dsw-alias-state-business-primary, #3964fe)", color: "#fff",
        borderRadius: 7, padding: "4px 10px", font: "inherit", fontSize: 12, cursor: "pointer"
      },
      badge: {
        border: "1px solid var(--dsw-alias-state-business-primary, #3964fe)",
        color: "var(--dsw-alias-state-business-primary, #3964fe)",
        borderRadius: 999, padding: "0 8px", fontSize: 10, whiteSpace: "nowrap"
      },
      input: {
        border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)",
        color: "var(--dsw-alias-label-primary)", borderRadius: 7, padding: "6px 10px",
        font: "inherit", fontSize: 12, width: "100%", boxSizing: "border-box"
      },
      err: { fontSize: 12, color: "var(--dsw-alias-state-error-primary, #f85149)" },
      ok: { fontSize: 12, color: "var(--dsw-alias-state-business-primary, #3964fe)" },
      field: { display: "flex", flexDirection: "column", gap: 5 },
      hint: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.6 }
    };

    // ── 数据面 ─────────────────────────────────────────────────────────
    function getJson(path) {
      return fetch(API + path, { cache: "no-store" }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
          return j;
        });
      });
    }
    function postJson(path, body) {
      return fetch(API + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {})
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
          return j;
        });
      });
    }

    // 卡片名：从 soul-md 的 settings 快照里读 cards 的 key
    function cardNamesFromScope(scope) {
      try {
        var snap = scope && scope.getSnapshot ? scope.getSnapshot() : null;
        var value = snap && snap.status === "ready" ? snap.value : null;
        var cards = value && value.cards;
        if (cards && typeof cards === "object") return Object.keys(cards);
      } catch (e) { /* 忽略 */ }
      return [];
    }

    function readFileAsBase64(file) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () {
          var s = String(fr.result || "");
          resolve(s.replace(/^data:[^,]*,/, ""));
        };
        fr.onerror = function () { reject(new Error("读文件失败")); };
        fr.readAsDataURL(file);
      });
    }

    // ── 主面板 ─────────────────────────────────────────────────────────
    function VoiceSection(props) {
      var scope = props && props.soulScope;

      var st = react.useState({ loading: true, error: null, data: null });
      var state = st[0], setState = st[1];
      var busyState = react.useState({});
      var busy = busyState[0], setBusy = busyState[1];
      var editorState = react.useState({ card: null, wavBase64: null, fileName: "", referenceText: "" });
      var editor = editorState[0], setEditor = editorState[1];
      var toastState = react.useState(null);
      var toast = toastState[0], setToast = toastState[1];

      function refresh() {
        getJson("/state").then(function (data) {
          setState({ loading: false, error: null, data: data });
        }).catch(function (e) {
          setState({ loading: false, error: String(e && e.message || e), data: null });
        });
      }

      react.useEffect(function () { refresh(); }, []);

      function mark(card, on) {
        setBusy(function (prev) {
          var next = Object.assign({}, prev);
          if (on) next[card] = true; else delete next[card];
          return next;
        });
      }

      var cardNames = cardNamesFromScope(scope);
      var bound = {};
      ((state.data && state.data.cards) || []).forEach(function (c) { bound[c.card] = c; });
      // 已经绑定但 soul-md 里没这张卡（卡片被改名/删了）也要列出来，方便清理
      Object.keys(bound).forEach(function (n) {
        if (cardNames.indexOf(n) < 0) cardNames.push(n);
      });

      function play(card) {
        mark(card, true);
        var url = API + "/audio?card=" + encodeURIComponent(card) + "&t=" + Date.now();
        var audio = new Audio(url);
        audio.play().then(function () {
          setToast({ kind: "ok", text: "正在播放「" + card + "」的声音" });
        }).catch(function (e) {
          setToast({ kind: "err", text: "播放失败：" + String(e && e.message || e) });
        }).then(function () { mark(card, false); });
      }

      function pickFile(card) {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = "audio/wav,audio/x-wav,audio/mpeg,audio/*";
        input.onchange = function () {
          var file = input.files && input.files[0];
          if (!file) return;
          mark(card, true);
          readFileAsBase64(file).then(function (b64) {
            setEditor({
              card: card,
              wavBase64: b64,
              fileName: file.name,
              referenceText: (bound[card] && bound[card].referenceText) || ""
            });
            setToast({ kind: "ok", text: "已选中 " + file.name + "，填好这段音频说的原话再保存" });
          }).catch(function (e) {
            setToast({ kind: "err", text: String(e && e.message || e) });
          }).then(function () { mark(card, false); });
        };
        input.click();
      }

      function saveEditor() {
        if (!editor.card || !editor.wavBase64) return;
        if (!editor.referenceText.trim()) {
          setToast({ kind: "err", text: "必须填这段音频的原话（逐字稿）。模型靠它对齐音色，空着会走样。" });
          return;
        }
        mark(editor.card, true);
        setToast({ kind: "ok", text: "正在注册音色并绑定到「" + editor.card + "」，要几十秒…" });
        postJson("/upload", {
          card: editor.card,
          wavBase64: editor.wavBase64,
          referenceText: editor.referenceText.trim(),
          voiceName: editor.card + " 的声音"
        }).then(function () {
          setEditor({ card: null, wavBase64: null, fileName: "", referenceText: "" });
          setToast({ kind: "ok", text: "绑定好了：以后「" + editor.card + "」说话就是这个声音。" });
          refresh();
        }).catch(function (e) {
          setToast({ kind: "err", text: "绑定失败：" + String(e && e.message || e) });
        }).then(function () { mark(editor.card, false); });
      }

      function setDefault(card) {
        mark(card, true);
        postJson("/set-default", { card: card }).then(function () {
          setToast({ kind: "ok", text: "「" + card + "」设成默认音色了" });
          refresh();
        }).catch(function (e) {
          setToast({ kind: "err", text: String(e && e.message || e) });
        }).then(function () { mark(card, false); });
      }

      function unbind(card) {
        mark(card, true);
        postJson("/unbind", { card: card }).then(function () {
          setToast({ kind: "ok", text: "已解除「" + card + "」的音色绑定" });
          refresh();
        }).catch(function (e) {
          setToast({ kind: "err", text: String(e && e.message || e) });
        }).then(function () { mark(card, false); });
      }

      var backend = (state.data && state.data.backend) || {};
      var children = [];

      children.push(h("div", { key: "intro", style: S.intro },
        "这里给每张卡片绑一段自己的声音。绑好之后，卡片发语音时会拿这段音频当参考——" +
        "音色就固定在那个人身上，变的只有语气、情绪和停顿。"
      ));

      children.push(h("div", { key: "status", style: S.hint },
        "后端：" + (backend.running ? "在跑" : "没起（第一次绑定或说话会自动拉起）") +
        (backend.running && backend.gpu ? " · " + backend.gpu : "") +
        (backend.loaded ? " · 模型已上卡" : (backend.running ? " · 模型未加载" : ""))
      ));

      if (toast) {
        children.push(h("div", { key: "toast", style: toast.kind === "err" ? S.err : S.ok }, toast.text));
      }

      if (state.loading) {
        children.push(h("div", { key: "loading", style: S.hint }, "读取中…"));
      } else if (state.error) {
        children.push(h("div", { key: "err", style: S.err }, "读取失败：" + state.error));
      } else {
        var rows;

        if (!cardNames.length) {
          rows = [h("div", { key: "empty", style: S.hint },
            "还没有卡片。先去「人设卡」里建一张，回来就能给它绑声音。")];
        } else {
          rows = cardNames.map(function (name) {
            var b = bound[name];
            var isBusy = !!busy[name];
            var rowChildren = [];

            rowChildren.push(h("span", { key: "n", style: S.name }, name));
            rowChildren.push(h("span", { key: "sub", style: S.sub },
              b
                ? (b.voiceName || "已绑定") + " · " + (b.hasAudio ? "有参考音频" : "参考音频丢了") +
                  (b.isDefault ? " · 默认" : "")
                : "未绑定声音"
            ));
            if (b && b.isDefault) rowChildren.push(h("span", { key: "badge", style: S.badge }, "默认"));

            if (b && b.hasAudio) {
              rowChildren.push(h("button", {
                key: "play", style: S.btn, disabled: isBusy,
                onClick: function () { play(name); }
              }, "▶ 听"));
            }
            rowChildren.push(h("button", {
              key: "pick", style: b ? S.btn : S.btnPrimary, disabled: isBusy,
              onClick: function () { pickFile(name); }
            }, b ? "换音频" : "绑定音频"));

            if (b && !b.isDefault) {
              rowChildren.push(h("button", {
                key: "def", style: S.btn, disabled: isBusy,
                onClick: function () { setDefault(name); }
              }, "设默认"));
            }
            if (b) {
              rowChildren.push(h("button", {
                key: "un", style: S.btn, disabled: isBusy,
                onClick: function () { unbind(name); }
              }, "解除"));
            }

            var block = [h("div", { key: "row", style: S.row }, rowChildren)];

            if (editor.card === name && editor.wavBase64) {
              block.push(h("div", { key: "edit", style: { display: "flex", flexDirection: "column", gap: 6, padding: "0 2px 4px" } },
                h("div", { style: S.hint }, "已选文件：" + editor.fileName),
                h("div", { style: S.field },
                  h("span", { style: S.hint }, "这段音频里说的原话（必须逐字一致，模型靠它对齐音色）"),
                  h("textarea", {
                    style: Object.assign({}, S.input, { minHeight: 56, resize: "vertical" }),
                    value: editor.referenceText,
                    placeholder: "例如：主人——本鱼今天也有好好待在水里哦。",
                    onChange: function (e) {
                      var v = e.target.value;
                      setEditor(function (prev) { return Object.assign({}, prev, { referenceText: v }); });
                    }
                  })
                ),
                h("div", { style: { display: "flex", gap: 8 } },
                  h("button", {
                    style: S.btnPrimary, disabled: isBusy,
                    onClick: saveEditor
                  }, isBusy ? "注册中…" : "保存并绑定"),
                  h("button", {
                    style: S.btn, disabled: isBusy,
                    onClick: function () { setEditor({ card: null, wavBase64: null, fileName: "", referenceText: "" }); }
                  }, "取消")
                )
              ));
            }

            return h("div", { key: "blk-" + name, style: { display: "flex", flexDirection: "column", gap: 6 } }, block);
          });
        }

        children.push(h("div", { key: "group", style: S.group }, rows));
      }

      children.push(h("div", { key: "tip", style: S.hint },
        "建议：同一张卡用 5~15 秒、干净无背景音乐的独白当参考音频。换音频就等于换人，语气不用重录。"
      ));

      return h("div", { style: S.root }, children);
    }

    // 设置主页入口：点一下直接跳到「语音」
    function VoiceLauncher() {
      return h("button", {
        style: S.btn,
        onClick: function () {
          try { window.location.hash = "#/settings/breeze-tts-voice"; } catch (e) { /* 忽略 */ }
        }
      }, "语音");
    }

    function apply(ctx) {
      // 卡片来源：soul-md 的配置表单 scope
      var soulScope = null;
      try { soulScope = ctx.configForms.get("soul-md"); } catch (e) { soulScope = null; }

      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "breeze-tts-voice",
          order: 20,
          label: function () { return "语音"; }
        }, function (props) {
          return h(VoiceSection, Object.assign({}, props, { key: "breeze-tts-voice", soulScope: soulScope }));
        });
      });

      // settings.launcher 是 DSH 官方 AccountMenu 占用的单槽位，不能重复注册，
      // 否则 apply() 抛错导致整个插件激活失败。语音设置页仍可从 设置 → 语音 进入。
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  }
});

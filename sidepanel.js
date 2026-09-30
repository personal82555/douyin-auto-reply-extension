const $ = (id) => document.getElementById(id);
// helper: 发消息前动态注入 content.js（自愈 connection 错误）
async function getReadyTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/douyin\.com/.test(tab.url || "")) throw new Error("请先在浏览器里打开 douyin.com 的页面");
  try { await chrome.tabs.sendMessage(tab.id, { action: "ping" }); }
  catch { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); }
  return tab;
}

const status = (s, bad = false) => { $("status").textContent = s; $("status").style.color = bad ? "#c00" : "#0a7"; };

// ── 配置 ──
async function loadCfg() {
  const c = await chrome.storage.local.get(["baseUrl", "apiKey", "model"]);
  $("baseUrl").value = c.baseUrl || "https://ai.88531.cn/v1";
  $("apiKey").value = c.apiKey || "";
  $("model").value = c.model || "deepseek-v4.1-flash";
}
$("saveCfg").onclick = async () => {
  await chrome.storage.local.set({
    baseUrl: $("baseUrl").value.trim(),
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
  });
  status("配置已保存 ✓");
};
$("testCfg").onclick = async () => {
  status("测试中...");
  try {
    const text = await llmChat([
      { role: "user", content: "只输出JSON数组：[\"好的\"]" }
    ], 50);
    status("连接成功 ✓ 返回: " + text.slice(0, 60));
  } catch (e) { status("失败: " + e.message, true); }
};

// ── LLM 调用（popup 内直接 fetch，无跨域限制因为声明了 host_permissions）──
async function llmChat(messages, maxTokens = 600) {
  const cfg = await chrome.storage.local.get(["baseUrl", "apiKey", "model"]);
  if (!cfg.baseUrl || !cfg.model) throw new Error("请先填写并保存 LLM 配置");
  const resp = await fetch(cfg.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (cfg.apiKey || "") },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 1.05, max_tokens: maxTokens })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error((data.error && data.error.message) || resp.status);
  return data.choices[0].message.content || "";
}

function parseArray(text) {
  let t = text.trim().replace(/^```(json)?\s*|\s*```$/g, "").trim();
  try { return JSON.parse(t); } catch {}
  try { return JSON.parse("[" + t + "]"); } catch {}
  const m = [...t.matchAll(/"([^"]{2,30})"/g)].map(x => x[1]);
  if (m.length) return m.slice(0, 3);
  throw new Error("LLM返回无法解析: " + t.slice(0, 80));
}

// ── 视频来源：content script 注当前页 ──
async function askContent(action, payload) {
  const tab = await getReadyTab();
  const res = await chrome.tabs.sendMessage(tab.id, { action, ...payload });
  if (!res) throw new Error("页面无响应，刷新抖音页后重试");
  return res;
}

$("btnHot").onclick = async () => {
  status("抓取中...");
  try {
    const r = await askContent("grab");
    if (r.error && r.error.length) throw new Error(r.error);
    if (!r.items || !r.items.length) throw new Error("本页没抓到视频卡片（抖音页面可能弹验证码）");
    renderList(r.items, "本页");
    status("抓到 " + r.items.length + " 条");
  } catch (e) { status("抓取失败: " + e.message, true); }
};

$("btnSearch").onclick = async () => {
  const kw = $("kw").value.trim();
  if (!kw) return status("请输入关键词", true);
  status("搜索中...");
  try {
    let r = await askContent("search", { kw });
    if (r && r.navigating) {
      // 硬导航：页面上脚本会重启。轮询侧栏取结果
      status("页面跳转中，等待结果...");
      for (let i = 0; i < 15; i++) {
        await new Promise(res => setTimeout(res, 2000));
        try {
          r = await askContent("getSearchResult", {});
          if (r && r.items && r.items.length >= 5) break;
        } catch { /* 页面还在导航中，继续等 */ }
      }
    }
    if (r.error && r.error.length) throw new Error(r.error);
    if (!r.items || !r.items.length) throw new Error("没抓到结果（可能弹验证码或网络问题）");
    renderList(r.items, "搜索");
    status("搜到 " + r.items.length + " 条");
  } catch (e) { status("搜索失败: " + e.message, true); }
};

function renderList(items, source) {
  const list = $("list");
  list.innerHTML = "";
  items.slice(0, 20).forEach((it, i) => {
    const href = it.href || it.url || "";
    const d = document.createElement("div");
    d.className = "item";
    d.innerHTML = `<span class="hot">${i + 1}</span><span class="t"></span><span class="hot gen">文案→</span>`;
    d.querySelector(".t").textContent = it.title || ("(无标题视频, 打开看内容)");
    if (it.title) d.querySelector(".t").title = it.title;
    // 视频链接直接可点
    const link = document.createElement("span");
    link.className = "hot";
    link.style.cursor = "pointer";
    link.textContent = "🔗打开";
    link.title = href;
    link.onclick = (ev) => { ev.stopPropagation(); chrome.tabs.create({ url: href }); };
    d.insertBefore(link, d.querySelector(".gen"));
    d.querySelector(".gen").onclick = async (ev) => {
      ev.stopPropagation();
      await genDrafts(it.title || ("(视频 " + (i + 1) + ")"), href);
    };
    d.onclick = async () => await genDrafts(it.title || ("(视频 " + (i + 1) + ")"), href);
    list.appendChild(d);
  });
}

async function genDrafts(title, href) {
  status("LLM生成中...");
  $("drafts").innerHTML = "";
  try {
    const out = await llmChat([
      { role: "system", content: "你只输出JSON数组，不做任何解释。" },
      { role: "user", content:
        `你是抖音评论区一个真实用户，要去热门视频《${title}》下写3条自然互动评论。\n` +
        `规则：\n1. 每条15字以内，口语化像真人随手发的\n2. 不用emoji堆砌，最多一个，别用套话\n3. 结合标题有具体感，可幽默/提问/共鸣\n4. 3条风格有差异\n5. 只输出JSON数组（双引号包裹每项）` }
    ], 600);
    const arr = parseArray(out);
    const box = $("drafts");
    arr.slice(0, 3).forEach(t => {
      const d = document.createElement("div");
      d.className = "draft";
      d.innerHTML = `<div class="txt"></div><div class="use"><button>📋 复制并填入评论区</button></div>`;
      d.querySelector(".txt").textContent = t;
      d.querySelector("button").onclick = async () => {
        await navigator.clipboard.writeText(t);
        status("已复制，尝试填入评论区...");
        try {
          const r = await askContent("fill", { text: t });
          if (r.ok) {
            chrome.runtime.sendMessage({ action: "addRecord", url: href, title, text: t });
            status("已填入并记录 ✓ 请检查后点发送");
          } else {
            status("已复制（自动填入失败: " + r.reason + "），手动粘贴即可");
          }
        } catch (e) { status("已复制，手动粘贴即可（填入失败: " + e.message + "）"); }
      };
      box.appendChild(d);
    });
    if (href) { /* 供用户回页面点该视频 */
      const tip = document.createElement("div");
      tip.className = "draft"; tip.style.cssText = "border:none;font-size:11px;color:#888";
      tip.textContent = "视频: " + (href.length > 50 ? href.slice(0, 50) + "…" : href);
      box.appendChild(tip);
    }
    status("生成完成 ✓ 选一条点「复制并填入」");
  } catch (e) { status("生成失败: " + e.message, true); }
}

loadCfg();


// ── 全自动模式 ──
// watch monitor: one live line per step
function watchLog(text, cls) {
  const box = $("watchBox");
  if (!box) return;
  box.style.display = "block";
  const line = document.createElement("div");
  line.className = cls || "";
  line.textContent = "[" + new Date().toLocaleTimeString() + "] " + text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.auto === "log") {
    status(m.text);
    const cls = /OK|\u6210\u529f|\u5b8c\u6210|\u5df2\u53d1\u9001/.test(m.text) ? "okline"
              : /\u5931\u8d25|\u9519\u8bef|\u9a8c\u8bc1\u7801|no_/.test(m.text) ? "fail" : "step";
    watchLog(m.text, cls);
  }
});

$("btnAuto").onclick = async () => {
  let tab;
  try { tab = await getReadyTab(); } catch (e) { return status(e.message, true); }
  const maxN = Math.max(1, Math.min(20, parseInt($("maxN").value) || 3));
  const gapSec = Math.max(15, Math.min(3600, parseInt($("gapSec").value) || 90));
  if (!confirm(`全自动将自动打开视频并直接发送评论（发送无人工确认）。\n本次最多 ${maxN} 条，间隔 ${gapSec}s。\n确认开始？`)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["auto.js"] });
    await chrome.tabs.sendMessage(tab.id, { action: "autoRun", maxN, gapSec });
    status("自动模式已启动，监视器实时显示每步");
    const wb = $("watchBox");
    wb.style.display = "block";
    wb.innerHTML = "";
    watchLog("=== 全自动开始 ===", "step");
    watchLog("来源页面: " + (tab.url || "").slice(0, 70), "step");
    watchLog("计划最多 " + maxN + " 条 / 最小间隔 " + gapSec + " 秒", "step");
    $("btnStopAuto").disabled = false;
  } catch (e) { status("启动失败: " + e.message, true); }
};

$("btnStopAuto").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { await chrome.tabs.sendMessage(tab.id, { action: "autoStop" }); status("停止请求已发"); } catch {}
  $("btnStopAuto").disabled = true;
};


// 顶部推广位：点击打开注册页；若用户没填 baseUrl 同时预填
document.querySelector(".promo a").addEventListener("click", async (e) => {
  e.preventDefault();
  try {
    const c = await chrome.storage.local.get("baseUrl");
    if (!c.baseUrl) {
      $("baseUrl").value = "https://ai.88531.cn/v1";
      $("saveCfg").click();   // 顺手保存
      status("已预填 ai.88531.cn 接口地址，注册后在官网拿 API Key 填入");
    }
  } catch {}
  chrome.tabs.create({ url: "https://ai.88531.cn" });
  window.close();
});


// ── 今天前10热门 ──
async function loadHot() {
  const box = $("hotList");
  if (!box) return;
  box.innerHTML = '<div style="color:#aaa;font-size:12px;padding:0 12px 6px">加载中…</div>';
  try {
    const r = await chrome.runtime.sendMessage({ action: "fetchHot" });
    if (!r.ok) throw new Error(r.error);
    box.innerHTML = "";
    r.items.forEach(it => {
      const d = document.createElement("div");
      d.className = "item hotitem";
      const rank = document.createElement("span"); rank.className = "hot"; rank.textContent = it.rank;
      const t = document.createElement("span"); t.className = "t"; t.textContent = it.word; t.title = it.word + "  热度:" + it.hotValue;
      const go = document.createElement("span"); go.className = "hot"; go.textContent = "跳转→"; go.style.cursor = "pointer";
      d.appendChild(rank); d.appendChild(t); d.appendChild(go);
      d.onclick = () => chrome.tabs.create({ url: it.url });
      box.appendChild(d);
    });
  } catch (e) {
    box.innerHTML = "";
    const err = document.createElement("div");
    err.style.cssText = "color:#c00;font-size:12px;padding:0 12px 6px";
    err.textContent = "热榜加载失败: " + e.message;
    box.appendChild(err);
  }
}
loadHot();
setInterval(loadHot, 10 * 60 * 1000);  // 每10分钟自动刷新

$("btnHotRefresh").onclick = loadHot;

// ---- 我的评论统计 & 明细 ----
async function refreshStats() {
  try {
    const s = (await chrome.runtime.sendMessage({ action: "getStats" })).stats;
    $("stTotal").textContent = s.total;
    $("stMonth").textContent = s.month;
    $("stWeek").textContent = s.week;
    $("stToday").textContent = s.today;
  } catch {}
}
async function refreshHistory() {
  const box = $("histList");
  if (!box) return;
  try {
    const { list } = await chrome.runtime.sendMessage({ action: "getHistory" });
    box.innerHTML = "";
    list.slice(0, 100).forEach(r => {
      const d = document.createElement("div");
      d.className = "hist";
      d.innerHTML = '<span class="t"></span><span class="m"></span>';
      d.querySelector(".t").textContent = r.title || r.url;
      d.querySelector(".m").textContent =
        new Date(r.ts).toLocaleString() + " - " + (r.text || "").slice(0, 20);
      d.title = "点击打开视频";
      d.onclick = () => chrome.tabs.create({ url: r.url });
      box.appendChild(d);
    });
    if (!list.length) {
      const e = document.createElement("div");
      e.style.cssText = "color:#aaa;font-size:11px;padding:4px 8px";
      e.textContent = "还没有评论记录";
      box.appendChild(e);
    }
  } catch {}
}
$("btnClearHist").onclick = async () => {
  if (!confirm("确定清空全部评论记录？此操作不可撤销")) return;
  await chrome.runtime.sendMessage({ action: "clearHistory" });
  refreshStats(); refreshHistory();
};
chrome.runtime.onMessage.addListener((m) => {
  if (m.histUpdated) { refreshStats(); refreshHistory(); }
});
refreshStats(); refreshHistory();

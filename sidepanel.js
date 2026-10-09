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
  const c = await chrome.storage.local.get([
    "baseUrl", "apiKey", "model", "autoMaxN", "autoGapSec",
    "city", "autoKeywords", "autoReplyText", "kwAutoOn", "autoImageDataUrl"]);
  $("baseUrl").value = c.baseUrl || "https://ai.88531.cn/v1";
  $("apiKey").value = c.apiKey || "";
  $("model").value = c.model || "mimo-v2.6-flash";
  if (c.autoMaxN) $("maxN").value = c.autoMaxN;
  if (c.autoGapSec) $("gapSec").value = c.autoGapSec;
  if (c.city) $("city").value = c.city;
  if (c.autoKeywords) $("autoKeywords").value = c.autoKeywords;
  if (c.autoReplyText) $("autoReplyText").value = c.autoReplyText;
  if (c.kwAutoOn) $("kwAutoOn").checked = true;
  if (c.autoImageDataUrl) {
    $("imgPreview").src = c.autoImageDataUrl;
    $("imgPreview").style.display = "block";
  }
}

// 关键词自动回复规则：保存 + 图片转 dataURL
$("saveAutoRule").onclick = async () => {
  const rule = {
    autoKeywords: $("autoKeywords").value,
    autoReplyText: $("autoReplyText").value,
    kwAutoOn: $("kwAutoOn").checked
  };
  const f = $("autoImage").files && $("autoImage").files[0];
  if (f) {
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    rule.autoImageDataUrl = dataUrl;
    $("imgPreview").src = dataUrl;
    $("imgPreview").style.display = "block";
  }
  await chrome.storage.local.set(rule);
  _ruleCache = { autoKeywords: rule.autoKeywords, kwAutoOn: rule.kwAutoOn };
  status("关键词自动回复规则已保存" + (rule.kwAutoOn ? "（已启用）" : "（未启用）"));
};

// 全自动启动前记忆条数/间隔
async function saveAutoCounts() {
  await chrome.storage.local.set({ autoMaxN: Number($("maxN").value) || 3,
    autoGapSec: Number($("gapSec").value) || 90 });
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
  const m = $("testMsg");
  const set = (t, ok) => { m.textContent = t; m.style.color = ok ? "#0a7" : "#c00"; };
  set("测试中…", true);
  try {
    const text = await llmChat([
      { role: "user", content: "只输出JSON数组：[好的]" }
    ], 50);
    set("✓ 成功: " + String(text).slice(0, 40), true);
  } catch (e) {
    set("✗ 失败: " + String(e.message).slice(0, 60), false);
  }
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


$("kw").addEventListener("keydown", e => { if (e.key === "Enter") $("btnSearch").click(); });
$("btnSearch").onclick = async () => {
  const city = ($("city").value || "").trim();
  const base = $("kw").value.trim();
  if (city) chrome.storage.local.set({ city });
  const kw = city && base ? (city + " " + base) : base;
  if (!kw) return status("请输入关键词", true);

  // 1) 拿到/创建抖音标签页（用户没打开抖音就帮他开一个）
  const url = "https://www.douyin.com/search/" + encodeURIComponent(kw) + "?type=video";
  let tab = null;
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t && /douyin\.com/.test(t.url || "")) tab = t;
    if (!tab) {
      const douyinTabs = await chrome.tabs.query({ url: "*://www.douyin.com/*" });
      tab = douyinTabs.find(x => x.id) || null;
    }
    if (tab) {
      await chrome.tabs.update(tab.id, { url, active: true });          // 已有标签: 直达搜索页
    } else {
      tab = await chrome.tabs.create({ url, active: true });            // 没开抖音: 新建并直达
      status("已为你打开抖音搜索页");
    }
    if (!tab || !tab.id) throw new Error("拿不到标签页 id");
  } catch (e) { return status("打开抖音失败: " + e.message, true); }

  status("打开搜索页: " + kw + "（浏览器会切到前台）…");
  watchLog("搜索: " + kw, "step");

  // 2) 等搜索页渲染 → 注入自动脚本 → 开跑（auto.js 自己抓本页列表并开始模拟点击）
  const maxN = Math.max(1, Math.min(20, parseInt($("maxN").value) || 3));
  const gapSec = Math.max(15, Math.min(3600, parseInt($("gapSec").value) || 90));
  saveAutoCounts();
  if (!$("kwAutoOn").checked && !confirm(
      "将在搜索结果页自动逐个点开视频并发送评论（最多 " + maxN + " 条 / 间隔 " + gapSec + " 秒）。\n确认开始？"))
    return;
  status("等待搜索页加载（8秒）…");
  await new Promise(r => setTimeout(r, 8000));
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["auto.js"] });
    await chrome.tabs.sendMessage(tab.id, { action: "autoRun", maxN, gapSec });
    status("已启动，浏览器里右上角会显示每一步");
    $("btnStopAuto").disabled = false;
  } catch (e) {
    status("启动失败: " + e.message + "（页面可能还在加载，稍后点⚡开始自动）", true);
  }
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
    const gen = d.querySelector(".gen");
    gen.textContent = "详情→";
    gen.onclick = (ev) => { ev.stopPropagation(); chrome.tabs.create({ url: href }); };
    d.onclick = () => chrome.tabs.create({ url: href });
    list.appendChild(d);
  });
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
    await chrome.tabs.update(tab.id, { active: true });   // 切到抖音页，操作全程可见
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

// ✅ 实时展示评论成功的视频（视频名+内容），新记录到达即刷新
async function renderDone() {
  const box = $("doneList");
  if (!box) return;
  try {
    const { list } = await chrome.runtime.sendMessage({ action: "getHistory" });
    box.innerHTML = "";
    const recent = (list || []).slice(0, 20);
    if (!recent.length) {
      const e = document.createElement("div");
      e.style.cssText = "color:#aaa;font-size:12px;padding:6px 12px";
      e.textContent = "还没有评论成功的记录，运行一次试试";
      box.appendChild(e);
      return;
    }
    recent.forEach(r => {
      const d = document.createElement("div");
      d.className = "done";
      d.innerHTML = '<div class="dt"></div><div class="dc"></div><div class="dm"></div>';
      d.querySelector(".dt").textContent = r.title || r.url || "(未知视频)";
      d.querySelector(".dc").textContent = "评论: " + (r.text || "");
      d.querySelector(".dm").textContent = new Date(r.ts).toLocaleString();
      d.title = "点击打开该视频";
      d.onclick = () => chrome.tabs.create({ url: r.url });
      box.appendChild(d);
    });
  } catch {}
}
renderDone();

chrome.runtime.onMessage.addListener((m) => {
  if (m.histUpdated) { refreshStats(); refreshHistory(); renderDone(); }
});
refreshStats(); refreshHistory();

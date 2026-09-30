// background service worker (MV3): LLM 代理 + 热搜榜 + 评论历史

// ── 热搜榜（免登录接口）──
async function fetchHotList() {
  const resp = await fetch(
    "https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/",
    { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36" } }
  );
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const data = await resp.json();
  if (data.status_code !== 0 || !Array.isArray(data.word_list)) throw new Error("接口返回异常");
  return data.word_list.slice(0, 10).map((w, i) => ({
    rank: i + 1,
    word: w.word,
    hotValue: w.hot_value,
    url: "https://www.douyin.com/search/" + encodeURIComponent(w.word) + "?type=video"
  }));
}

// ── 评论历史（commentHistory: [{url,title,text,ts}]）──
async function getHistory() {
  const c = await chrome.storage.local.get("commentHistory");
  return c.commentHistory || [];
}
async function addRecord(rec) {
  const h = await getHistory();
  if (h.some(x => x.url === rec.url && x.text === rec.text)) return h; // 去重
  h.unshift(rec);
  if (h.length > 2000) h.length = 2000;
  await chrome.storage.local.set({ commentHistory: h });
  return h;
}
function statsOf(h) {
  const now = Date.now();
  const DAY = 86400000;
  const d = { total: h.length, month: 0, week: 0, today: 0, list: h };
  for (const r of h) {
    const age = now - r.ts;
    if (age <= 30 * DAY) d.month++;
    if (age <= 7 * DAY) d.week++;
    if (new Date(r.ts).toDateString() === new Date().toDateString()) d.today++;
  }
  return d;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "fetchHot") {
    (async () => {
      try { sendResponse({ ok: true, items: await fetchHotList() }); }
      catch (e) { sendResponse({ ok: false, error: String(e) }); }
    })();
    return true;
  }
  if (msg.action === "llm") {
    (async () => {
      try {
        const cfg = await chrome.storage.local.get(["baseUrl", "apiKey", "model"]);
        if (!cfg.baseUrl || !cfg.model) { sendResponse({ error: "LLM未配置" }); return; }
        const resp = await fetch(cfg.baseUrl.replace(/\/$/, "") + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (cfg.apiKey || "") },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: "system", content: "你只输出JSON数组，不做任何解释。" },
              { role: "user", content: msg.prompt }
            ],
            temperature: 1.05, max_tokens: 600
          })
        });
        const data = await resp.json();
        if (!resp.ok) { sendResponse({ error: (data.error && data.error.message) || resp.status }); return; }
        sendResponse({ content: data.choices[0].message.content || "" });
      } catch (e) { sendResponse({ error: String(e) }); }
    })();
    return true;
  }
  if (msg.action === "addRecord") {
    (async () => {
      await addRecord({ url: msg.url, title: msg.title, text: msg.text, ts: msg.ts || Date.now() });
      sendResponse({ ok: true, stats: statsOf(await getHistory()) });
    })();
    return true;
  }
  if (msg.action === "getStats") {
    (async () => {
      const s = statsOf(await getHistory());
      sendResponse({ stats: { total: s.total, month: s.month, week: s.week, today: s.today } });
    })();
    return true;
  }
  if (msg.action === "getHistory") {
    (async () => { sendResponse({ list: await getHistory() }); })();
    return true;
  }
  if (msg.action === "autoFillOnOpen") {
    (async () => {
      await new Promise(r2 => setTimeout(r2, 6000));
      const tabs = await chrome.tabs.query({ url: "https://www.douyin.com/*", active: true, lastFocusedWindow: true });
      const tab = tabs[0];
      if (!tab) { console.warn("no douyin tab"); return; }
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); } catch {}
      let done = false;
      for (let i = 0; i < 10; i++) {
        try {
          const r = await chrome.tabs.sendMessage(tab.id, { action: "fill", text: msg.text });
          if (r && r.ok) {
            await addRecord({ url: tab.url, title: msg.title || tab.title, text: msg.text, ts: Date.now() });
            try { chrome.runtime.sendMessage({ histUpdated: true }); } catch {}
            done = true;
            break;
          }
        } catch {}
        await new Promise(r2 => setTimeout(r2, 2000));
      }
      if (!done) console.warn("autoFillOnOpen 未能在等待时间内填入评论框");
    })();
  }
    if (msg.action === "clearHistory") {
    (async () => {
      await chrome.storage.local.set({ commentHistory: [] });
      sendResponse({ ok: true, stats: { total: 0, month: 0, week: 0, today: 0 } });
    })();
    return true;
  }
  if (msg.auto === "log") {
    chrome.runtime.sendMessage({ auto: "log", text: msg.text }).catch(() => {});
  }
});

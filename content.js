// content script — 抖音页内：抓视频 / 搜索（原地导航+轮询重试）/ 填评论
(() => {
  if (window.__dyExtInstalled) return;
  window.__dyExtInstalled = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function grabItems() {
    const decks = [
      "a[data-e2e=search-video-card]",
      "li a[href*='/video/']",
      "div[class*=search] a[href*='/video/']",
      "a[href*='/video/']"
    ];
    for (const sel of decks) {
      try {
        const cards = [...document.querySelectorAll(sel)];
        const items = [], seen = new Set();
        for (const c of cards) {
          const href = c.getAttribute("href") || "";
          if (!href.includes("/video/")) continue;
          const container = c.closest("li") || c.closest("[class*=cardWrapper]") || c;
          // 标题候选池：innerText行(过滤时长/日期样式) / title attr / img alt / aria-label
          const lines = (container.innerText || "").trim().split("\n")
            .map(x => x.trim())
            .filter(sx => sx.length > 4 && !/^\d+(\.\d+)?[wWkK万]?$/.test(sx) && !/^\d{1,2}:\d{2}$/.test(sx) && !/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(sx));
          const img = container.querySelector("img");
          let title = (lines[0] ||
            c.getAttribute("title") ||
            (img ? (img.alt || img.getAttribute("aria-label") || "") : "") ||
            c.getAttribute("aria-label") || "").trim();
          if (!title || title.length < 4) continue;
          let link;
          if (href.startsWith("http")) link = href;
          else if (href.startsWith("//")) link = "https:" + href;         // 协议相对: //www.douyin.com/...
          else if (href.startsWith("https://")) link = href;              // safety
          else if (href.startsWith("/")) link = "https://www.douyin.com" + href;  // 路径相对: /video/...
          else link = new URL(href, "https://www.douyin.com").href;       // 其他兜底
          if (link.includes("douyin.com//www.douyin.com")) link = link.replace("douyin.com//www.douyin.com", "douyin.com");
          if (seen.has(link)) continue;
          seen.add(link);
          items.push({ title: title.slice(0, 60), href: link });
          if (items.length >= 20) break;
        }
        if (items.length) return { error: "", items, used: sel };
      } catch {}
    }
    if (isCaptchaPage()) return { error: "\u9a8c\u8bc1\u7801: \u8bf7\u5728\u6d4f\u89c8\u5668\u7a97\u53e3\u624b\u52a8\u5b8c\u6210\u6ed1\u5757\u9a8c\u8bc1\u540e\u91cd\u8bd5", items: [] };
    const bodyText = document.body ? document.body.innerText : "";
    if (bodyText.includes("扫码登录")) return { error: "需要登录抖音", items: [] };
    return { error: "本页没找到视频卡片", items: [] };
  }

  // 轮询抓取：抖音搜索页懒渲染，连续尝试直到出结果或超时
  async function grabWithRetry(maxMs) {
    const t0 = Date.now();
    let last = grabItems();
    while (Date.now() - t0 < maxMs) {
      if (last.items && last.items.length >= 5) return last;
      await sleep(2000);
      last = grabItems();
    }
    return last;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "ping") { sendResponse({ pong: true }); return false; }

    if (msg.action === "grab") {
      (async () => { sendResponse(await grabWithRetry(10000)); })();
      return true;
    }

    if (msg.action === "search") {
      // 两条路径：
      // A. 同页SPA：脚本不掉线 → 轮询后直接回传
      // B. 不同页（硬导航）：通道会断，先回 navigating，由脚本重启后把结果
      //    写进 sessionStorage，sidepanel 再 pull。
      if (location.pathname.startsWith("/search/")) {
        (async () => {
          try {
            const url = "https://www.douyin.com/search/" + encodeURIComponent(msg.kw) + "?type=video";
            history.pushState({}, "", url);
            window.dispatchEvent(new PopStateEvent("popstate"));
            await sleep(2500);
            const r = await grabWithRetry(15000);
            sendResponse(r);
          } catch (e) { sendResponse({ error: String(e), items: [] }); }
        })();
        return true;
      } else {
        // 硬导航前把任务暂存
        sessionStorage.setItem("dySearchTask", msg.kw);
        location.href = "https://www.douyin.com/search/" + encodeURIComponent(msg.kw) + "?type=video";
        sendResponse({ navigating: true, items: [] });
        return false;
      }
    }

    if (msg.action === "getSearchResult") {
      (async () => {
        try {
          // 若有 pending task：等页面渲染完并抓取
          const task = sessionStorage.getItem("dySearchTask");
          if (task) {
            sessionStorage.removeItem("dySearchTask");
            await sleep(2500);
            const r = await grabWithRetry(15000);
            // 存一份给侧栏即时取
            sessionStorage.setItem("dySearchLast", JSON.stringify(r));
            sendResponse(r);
          } else {
            // 直接返回最近一次缓存
            const last = sessionStorage.getItem("dySearchLast");
            sendResponse(last ? JSON.parse(last) : { error: "无缓存结果", items: [] });
          }
        } catch (e) { sendResponse({ error: String(e), items: [] }); }
      })();
      return true;
    }

    if (msg.action === "fill") {
      (async () => {
        try {
          const r = await fillCommentSafe(msg.text);
          sendResponse(r);
        } catch (e) { sendResponse({ ok: false, reason: String(e) }); }
      })();
      return true;
    }
  });

  async function ensureEditor() {
    if (isCaptchaPage()) return null;
    // Comment region: douyin web uses [data-e2e=comment-icon] button; input is div[contenteditable=true]
    for (let i = 0; i < 4; i++) {
      const editor = document.querySelector('div[contenteditable="true"]');
      if (editor && editor.getBoundingClientRect().height > 5) return editor;
      const iconBtn =
        document.querySelector('[data-e2e="comment-icon"]')?.closest("button") ||
        [...document.querySelectorAll("button")].find(b => b.querySelector('[data-e2e="comment-icon"]'));
      if (iconBtn) { iconBtn.click(); await sleep(2000); }
      else { window.scrollBy(0, 300); await sleep(1200); }
    }
    return document.querySelector('div[contenteditable="true"]');
  }

  async function fillCommentSafe(text) {
    if (isCaptchaPage()) return { ok: false, reason: "\u9a8c\u8bc1\u7801: \u6d4f\u89c8\u5668\u7a97\u53e3\u5f39\u4e86\u6ed1\u5757\u9a8c\u8bc1\uff0c\u8bf7\u624b\u52a8\u5b8c\u6210\u540e\u91cd\u8bd5" };
    const editor = await ensureEditor();
    if (!editor) return { ok: false, reason: "\u8bc4\u8bba\u6846\u6ca1\u627e\u5230\uff08\u8bc4\u8bba\u533a\u672a\u5c55\u5f00\uff09" };
    const target = (editor.getAttribute("contenteditable") === "true") ? editor
      : (editor.querySelector('div[contenteditable="true"]') || editor);
    target.focus();
    await sleep(400);
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
    await sleep(300);
    target.blur(); target.focus();
    return { ok: true };
  }
})();

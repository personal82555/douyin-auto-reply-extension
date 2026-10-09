/**
 * auto.js — 运行在抖音页面（列表页）里的全自动循环驱动。
 * 流程: 从列表抓视频 → 逐个【点开视频卡片(模拟人工点击新tab)】→ 等视频页加载 →
 *      LLM生成文案 → 填评论框 → 点发送 → 随机等待 → 通知 popup 进度。
 * 通过 chrome.runtime 消息与 popup 通信，popup 关闭则进程由 popup 触发的 content 全局状态接管。
 */
(() => {
  if (window.__dyAutoInstalled) return;
  window.__dyAutoInstalled = true;

  // 抓列表页视频 items
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
          let title = ((container.innerText || "").trim().split("\n")
            .map(s => s.trim()).filter(s => s.length > 4 && !/^\d+(\.\d+)?[wWkK万]?$/.test(s))
            .slice(0, 1).join(" ")) || (c.getAttribute("title") || "").trim();
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
          if (items.length >= 30) break;
        }
        if (items.length) return items;
      } catch {}
    }
    return [];
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "autoRun") {
      sendResponse({ started: true });
      runAuto(msg.maxN, msg.gapSec, msg.promptExtra || "");
      return true;
    }
    if (msg.action === "autoStop") { window.__dyAutoStop = true; sendResponse({ stopping: true }); return true; }
    if (msg.action === "grabItems") { sendResponse({ items: grabItems() }); return true; }
  });



  // —— 页面内步骤浮窗：让用户在真实页面上看到操作进度 ——
  function showStep(text, tone) {
    try {
      let box = document.getElementById("__dyStepBox");
      if (!box) {
        box = document.createElement("div");
        box.id = "__dyStepBox";
        box.style.cssText =
          "position:fixed;top:14px;right:14px;z-index:2147483647;" +
          "background:rgba(20,22,31,.94);color:#7dfcd4;font:13px/1.6 \'Microsoft YaHei\',sans-serif;" +
          "padding:10px 14px;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.35);" +
          "max-width:320px;pointer-events:none;transition:opacity .3s";
        document.documentElement.appendChild(box);
      }
      const color = tone === "fail" ? "#ff7b72" : tone === "ok" ? "#8ef7b7" : "#ffd76e";
      box.innerHTML = "<div style='font-size:11px;color:#8a8fa3'>🤖 抖音评论辅助工具 正在操作</div>"
        + "<div style='color:" + color + "'>" + text + "</div>";
      box.style.display = "block";
      if (tone === "done") { setTimeout(() => { box.style.display = "none"; }, 4000); }
    } catch {}
  }

  function findCardElement(it) {
    const href = it.href || "";
    const vidId = href.split("/video/")[1];
    const candidates = [...document.querySelectorAll('a[href*="/video/"], a[data-e2e="search-video-card"]')];
    for (const a of candidates) {
      const h = a.getAttribute("href") || "";
      if (vidId && h.includes(vidId)) return a;
    }
    if (it.title) {
      for (const a of candidates) {
        const container = a.closest("li") || a.closest("[class*=cardWrapper]") || a;
        if ((container.innerText || "").includes(it.title.slice(0, 15))) return a;
      }
    }
    return null;
  }

  async function report(text) {
    try { chrome.runtime.sendMessage({ auto: "log", text }); } catch {}
  }

  async function runAuto(maxN, gapSec, promptExtra) {
    window.__dyAutoStop = false;
    // 只评论"当前页面"上抓到的视频（你正在看的搜索结果/视频列表）
    let items = grabItems();
    if (!Array.isArray(items)) items = [];
    // 搜索页渲染慢：最多再等15秒轮询
    for (let w = 0; w < 15 && !items.length; w++) {
      showStep("等待搜索结果渲染…(" + (w + 1) + "s)");
      await sleep(1000);
      items = grabItems();
      if (!Array.isArray(items)) items = [];
    }
    if (!items.length) {
      report("当前页面没抓到视频 — 请先打开网站搜索结果页或视频列表页再点「开始自动」");
      showStep("✗ 本页没抓到视频", "fail");
      return;
    }
    // 关键词自动回复：命中标题的帖子优先，只回匹配的
    let rule = {};
    try { rule = await chrome.storage.local.get(["kwAutoOn", "autoKeywords", "autoReplyText", "autoImageDataUrl"]); } catch {}
    const kws = String(rule.autoKeywords || "").split(/\n+/).map(x => x.trim()).filter(x => x.length > 0);
    if (rule.kwAutoOn && kws.length) {
      const matched = items.filter(it => kws.some(k => (it.title || "").includes(k)));
      if (!matched.length) {
        report("关键词模式开启，但本页没命中任何关键词(" + kws.join("/") + ")，跳过");
        return;
      }
      items = matched;
      report("关键词命中 " + items.length + " 条，只回这些");
    }
    const custom = (rule.kwAutoOn && rule.autoReplyText) ? String(rule.autoReplyText) : "";
    const customImg = (rule.kwAutoOn && rule.autoImageDataUrl) ? String(rule.autoImageDataUrl) : "";
    report("来源页面: " + location.href.slice(0, 80));
    report("只评论本页前 " + Math.min(items.length, maxN) + " 条（共" + items.length + "条），开始循环");
    let sent = 0;
    for (const it of items) {
      if (window.__dyAutoStop) { report("已停止"); break; }
      if (sent >= maxN) break;
      try {
        report("→ " + (sent + 1) + "/" + maxN + " 点击卡片: " + it.title);
        showStep((sent + 1) + "/" + maxN + " 正在点开视频: " + (it.title || "").slice(0, 24));
        // 像真人一样：滚到卡片位置 → 鼠标按下抬起点击卡片进入视频（不用 location.href 硬跳）
        const el = findCardElement(it);
        if (!el) { report("没找到该卡片DOM，跳过"); continue; }
        sessionStorage.setItem("dyAutoState", JSON.stringify({
          maxN, gapSec, sent,
          remaining: maxN - sent,
          title: it.title,
          listUrl: location.href,
          customText: custom,
          customImg: customImg
        }));
        await humanClick(el);   // 真实鼠标事件点击，浏览器自己跳转（SPA路径）
        return;                 // 页面推进入视频页后，本脚本在新页续跑
      } catch (e) {
        report("单条失败: " + String(e));
        await sleep(3000);
      }
    }
    report(`全自动结束，成功 ${sent}/${maxN}`);
  }

  // ── 新页面(视频页)加载后自动续跑 ──
  const st = sessionStorage.getItem("dyAutoState");
  if (location.pathname.startsWith("/video/")) {
    (async () => {
      let state = st ? JSON.parse(st) : null;
      if (!state || state.navigated) return;
      state.navigated = true;
      sessionStorage.removeItem("dyAutoState");
      report(`进入视频页: ${state.title}，等页面稳定...`);
      showStep("① 页面加载中，模拟观看视频…");
      await sleep(5000);
      if (location.pathname.startsWith("/video/")) {
        const r = await postOnce(state.gapSec, state);
        if (r === "OK" || r === "OK(enter)") { state.sent++; report(`已发送 ${state.sent} 条`); }
        else { report("未成功: " + r); showStep("✗ 未发送: " + r, "fail"); }
        // 等待间隔
        const wait = Math.max(15, state.gapSec + Math.floor(rand(-10, 30)));
        report(`休眠 ${wait}s 后继续`);
        await sleep(wait * 1000);
        if (state.remaining - state.sent > 0 && !window.__dyAutoStop) {
          // 回到记录的来源列表页继续下一条
          report("返回列表页继续下一条");
          sessionStorage.setItem("dyAutoResume", JSON.stringify({
            maxN: state.maxN, gapSec: state.gapSec, sent: state.sent, listUrl: state.listUrl
          }));
          location.href = state.listUrl || "https://www.douyin.com/";
        } else {
          report("全部完成。如需继续，请回列表页重新点开始。");
        }
      }
    })();
  }

  // 回到列表页时自动恢复循环（若还有剩余配额）
  const resume = sessionStorage.getItem("dyAutoResume");
  if (resume && !location.pathname.startsWith("/video/")) {
    sessionStorage.removeItem("dyAutoResume");
    const st2 = JSON.parse(resume);
    (async () => {
      report("回到列表页，继续剩余 " + (st2.maxN - st2.sent) + " 条");
      await sleep(4000);
      sessionStorage.setItem("dyAutoState", JSON.stringify(st2));
      runAuto(st2.maxN - st2.sent, st2.gapSec);
    })();
  }

  // 真人模拟工具：真实鼠标事件分发
  function coordsOf(el, jitter = 5) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2 + (Math.random() * jitter * 2 - jitter)),
      y: Math.round(r.top + r.height / 2 + (Math.random() * jitter * 2 - jitter))
    };
  }

  function dispatchPointerMouse(el, type, x, y, buttons) {
    const common = { bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 0, buttons: buttons, pointerId: 1, pointerType: "mouse",
      isPrimary: true, view: window };
    try { el.dispatchEvent(new PointerEvent(type === "mouseover" ? "pointerover" : type === "mouseout" ? "pointerout" : "pointer" + type, common)); } catch {}
    el.dispatchEvent(new MouseEvent(type, common));
  }

  // 完整拟人点击：视线移动轨迹 → Pointer事件 → 按住间隔 → 抬起 ≈ 真实手指/鼠标
  async function humanClick(el, msg) {
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(600 + Math.random() * 800);   // 等滚动停 + 反应时间
    const p1 = coordsFromViewport(el, -60);
    const p2 = coordsFromViewport(el, 0);
    // 鼠标轨迹: 从偏移处滑到元素中心 (2~4步)
    for (const pt of [[p1.x, p1.y], [p2.x, p2.y]]) {
      const [x, y] = pt;
      dispatchPointerMouse(el, "mousemove", x, y, 0);
      await sleep(30 + Math.random() * 50);
    }
    dispatchPointerMouse(el, "mouseover", p2.x, p2.y, 0);
    await sleep(80 + Math.random() * 200);    // hover停顿
    dispatchPointerMouse(el, "mousedown", p2.x, p2.y, 1);
    await sleep(70 + Math.random() * 110);    // 按住时长
    dispatchPointerMouse(el, "mouseup", p2.x, p2.y, 0);
    dispatchPointerMouse(el, "click", p2.x, p2.y, 0);
    await sleep(150);
  }

  function coordsFromViewport(el, offsetY) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2 + (Math.random() * 10 - 5),
             y: r.top + Math.max(10, r.height / 2 + offsetY) + (Math.random() * 8 - 4) };
  }

  async function findVisibleCommentIcon() {
    // 候选: data-e2e=comment-icon 的按钮（web端标准），需可见
    const pool = [
      ...document.querySelectorAll('[data-e2e="comment-icon"]'),
      ...document.querySelectorAll('[data-e2e="feed-comment-icon"]'),
      ...document.querySelectorAll('button').filter(b => (b.getAttribute("data-e2e") || "").includes("comment"))
    ];
    for (const i of pool) {
      const btn = i.closest("button") || i;
      const r = btn.getBoundingClientRect();
      if (r.width > 5 && r.height > 5) return btn;
    }
    // 兜底：可见的文本"评论"
    return [...document.querySelectorAll("button,span,div")]
      .find(el => (el.textContent || "").trim() === "评论" && el.getBoundingClientRect().height > 5) || null;
  }

  async function findCommentEditor() {
    const pool = [
      'div[data-e2e="comment-input"] div[contenteditable="true"]',
      'div[data-e2e="comment-input"]',
      'div[contenteditable="true"]'
    ];
    for (const sel of pool) {
      try {
        const e = document.querySelector(sel);
        if (e && e.getBoundingClientRect().height > 5) {
          return /contenteditable/.test(e.getAttribute("contenteditable") || "") ? e
            : (e.querySelector('div[contenteditable="true"]') || null);
        }
      } catch {}
    }
    return null;
  }

  async function postOnce(gapSec, state) {
    const customText = (state && state.customText) || "";
    const customImg = (state && state.customImg) || "";
    // 验证码检测（每一步都断）
    if ((document.title || "").includes("验证码") ||
        document.querySelector('iframe[src*="verifycenter"], iframe[src*="captcha"]')) {
      return "\u9a8c\u8bc1\u7801: \u6d4f\u89c8\u5668\u5f39\u4e86\u6ed1\u5757\u9a8c\u8bc1\uff0c\u8bf7\u624b\u52a8\u5b8c\u6210\u540e\u91cd\u8bd5";
    }

    const title = document.title.replace(/ - 抖音|｜抖音/g, "").trim() || document.title;
    let text;
    if (customText) {
      text = customText;
      report("使用自定义回复文案: " + text.slice(0, 40));
    } else {
      const resp = await chrome.runtime.sendMessage({ action: "llm",
        prompt: "为抖音视频《" + title + "》写1条15字内仿真人互动评论，只输出JSON数组如[\"文本\"]" });
      if (!resp || resp.error) return "LLM失败: " + (resp && resp.error || "no resp");
      try {
        const raw = String(resp.content || "").trim().replace(/^```(json)?\s*|\s*```$/g, "").trim();
        const arr = JSON.parse(raw);
        text = Array.isArray(arr) ? String(arr[0] || "") : "";
      } catch { return "LLM解析失败: " + String(resp.content).slice(0, 80); }
      if (!text || typeof text !== "string") return "LLM返回文本为空";
      report("评论文案: " + text);
    }

    // ── 仿人流程 ──
    // 1. 模拟看完视频再操作（等3~6s）
    showStep("② 观看视频 3~6 秒…");
    await sleep(3000 + rand(0, 3000));

    // 2. 点开评论区：人手动作点右下/右侧的评论icon
    let editor = await findCommentEditor();
    if (!editor) {
      const icon = await findVisibleCommentIcon();
      if (!icon) return "no_comment_icon（找不到评论按钮）";
      report("点击评论按钮展开评论区...");
      showStep("③ 像真人一样点开评论区…");
      await humanClick(icon);
      await sleep(2500 + rand(0, 1500));
      editor = await findCommentEditor();
    }
    if (!editor) return "no_editor（点开评论区了还是没输入框，可能弹验证码）";

    // 3. 点击输入框获得焦点（像人一样先点一下框）
    report("点击评论框获焦...");
    showStep("④ 点击评论框…");
    await humanClick(editor);
    await sleep(600 + rand(0, 600));
    // 确保焦点在框内
    const inner = (editor.getAttribute("contenteditable") === "true") ? editor
      : (editor.querySelector('div[contenteditable="true"]') || editor);
    inner.focus();

    // 3.5 附图（若配置了图片）
    if (customImg) {
      try {
        const fi = [...document.querySelectorAll('input[type=file]')].find(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 || el.offsetParent !== null;
        }) || document.querySelector('input[type=file]');
        if (fi) {
          const resp2 = await fetch(customImg);
          const blob = await resp2.blob();
          const file = new File([blob], "reply.jpg", { type: blob.type || "image/jpeg" });
          const dt = new DataTransfer();
          dt.items.add(file);
          fi.files = dt.files;
          fi.dispatchEvent(new Event("change", { bubbles: true }));
          report("图片已附加 ✓");
          await sleep(1200 + rand(0, 800));
        } else report("没找到图片上传入口，仅发文字");
      } catch (e) { report("附图失败(不影响文字): " + String(e)); }
    }

    // 4. 逐字输入（模拟打字节奏 60~180ms/字，带偶发停顿）
    report("逐字输入评论...");
    showStep("⑤ 逐字输入中: " + text.slice(0, 20));
    for (const ch of text) {
      document.execCommand("insertText", false, ch);
      await sleep(50 + Math.random() * 110);
      if (Math.random() < 0.08) await sleep(200 + Math.random() * 300);
    }
    await sleep(600 + rand(0, 800));
    if (isCaptchaNow()) return "\u8f93\u5165\u540e\u5f39\u9a8c\u8bc1\u7801\uff0c\u672a\u53d1\u9001";

    // 5. 找发送/发布按钮
    const submitPool = [
      ...document.querySelectorAll('[data-e2e="comment-post"], [data-e2e="comment-submit"]'),
      ...(document.querySelector("div[data-e2e=comment-input]")?.parentElement?.querySelectorAll("button") || [])
    ];
    let sb = submitPool.find(b => b.getBoundingClientRect().height > 0) || null;
    if (!sb) {
      sb = [...document.querySelectorAll("button,div")].find(b =>
        ["发送", "发布", "提交"].includes((b.textContent || "").trim()) &&
        b.getBoundingClientRect().height > 0);
    }
    if (!sb) {
      // 没按钮时抖音通常回车即发（同真人行为）
      inner.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter",
        keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      await sleep(1500);
      await record(title, text);
      return "OK(enter)";
    }
    report("点击发送...");
    showStep("⑥ 点击发送…");
    await humanClick(sb);
    await sleep(1500);
    await record(title, text);
    showStep("✓ 评论已发送：" + text.slice(0, 20), "ok");
    return "OK";
  }

  function isCaptchaNow() {
    return (document.title || "").includes("验证码") ||
           !!document.querySelector('iframe[src*="verifycenter"], iframe[src*="captcha"]');
  }
  async function record(title, text) {
    try {
      const hr = await chrome.runtime.sendMessage({ action: "addRecord",
        url: location.href, title: title, text: text });
      if (hr && hr.stats) report("本次已累计 " + hr.stats.total + " 条");
    } catch {}
  }
})();

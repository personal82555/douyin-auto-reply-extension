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
          // 4级标题候选（与 content.js 同步）：过滤时长/日期行 → title attr → img alt → aria-label
          const lines = (container.innerText || "").trim().split("\n")
            .map(x => x.trim())
            .filter(sx => sx.length > 4
              && !/^\d+(\.\d+)?[wWkK万]?$/.test(sx)
              && !/^\d{1,2}:\d{2}$/.test(sx)
              && !/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(sx));
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
    if (msg.action === "autoStop") { window.__dyAutoStop = true; sessionStorage.setItem("__dyStop", "1"); sendResponse({ stopping: true }); return true; }
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


  // 暂停视频播放，防止播完自动切到下一条（评论对象跑偏）
  function pauseAllVideos() {
    let n = 0;
    try {
      document.querySelectorAll("video").forEach(v => {
        if (!v.paused) { v.pause(); v.currentTime = Math.min(v.currentTime, 0.5); n++; }
      });
    } catch {}
    return n;
  }
  function keepVideosPaused(seconds) {
    pauseAllVideos();
    let t = 0;
    const iv = setInterval(() => {
      t += 1;
      pauseAllVideos();
      if (t >= seconds) clearInterval(iv);
    }, 2000);
  }

  async function humanScrollDown(px, steps) {
    steps = steps || 6;
    const per = Math.max(60, Math.round(px / steps));
    for (let i = 0; i < steps; i++) {
      window.scrollBy({ top: per, behavior: "smooth" });
      await sleep(140 + Math.random() * 220);
    }
  }


  function stopRequested() {
    return window.__dyAutoStop || sessionStorage.getItem("__dyStop");
  }
  // 可被打断的等待：停止标志出现立即返回 false
  async function stopSleep(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (stopRequested()) return false;
      await sleep(Math.min(500, ms - (Date.now() - t0)));
    }
    return !stopRequested();
  }


  // —— 本地文案模板（没配模型时也能跑）——
  const FALLBACK_TPL = [
    "看着不错，收藏了", "这个得点赞", "说得好，支持一下", "学到了学到了",
    "真实情况就是这样", "有同感，说得对", "路过留个脚印", "这条值得细看",
    "内容很实在", "看完有点感触", "涨知识了", "期待下一条",
    "哈哈有点意思", "这是真实经历吧", "实用，先存着"
  ];
  function localFallbackText(title) {
    const t = String(title || "");
    if (/宽带|网络|装机|资费/.test(t)) return "装之前问清楚有没有合约期，别踩坑";
    if (/装修|家居|房子|租房/.test(t)) return "这个方案挺实用，参考了";
    if (/吃|美食|菜|餐|做法/.test(t)  ) return "看着就香，改天试试";
    if (/车|驾驶|自驾/.test(t)) return "路况熟悉了心里就有底";
    if (/旅游|景点|攻略/.test(t)) return "收藏了，正好用得上";
    return FALLBACK_TPL[Math.floor(Math.random() * FALLBACK_TPL.length)];
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
    sessionStorage.removeItem("__dyStop");   // 新一轮开始，清掉上次停止标志
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
      report("本页抓到 " + items.length + " 条，示例标题: " +
        items.slice(0, 3).map(x => (x.title || "").slice(0, 16)).join(" | "));
      if (!matched.length) {
        report("关键词(" + kws.join("/") + ")未命中，跳过。已抓标题见上一行");
        showStep("✗ 关键词未命中，检查抓到的标题", "fail");
        return;
      }
      items = matched;
      report("关键词命中 " + items.length + " 条，只回这些: " +
        items.slice(0, 3).map(x => (x.title || "").slice(0, 14)).join(" | "));
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
        report("→ " + (sent + 1) + "/" + maxN + " 打开: " + it.title);
        showStep((sent + 1) + "/" + maxN + " 正在点开视频: " + (it.title || "").slice(0, 24));
        sessionStorage.setItem("dyAutoState", JSON.stringify({
          maxN, gapSec, sent,
          remaining: maxN - sent,
          title: it.title,
          listUrl: location.href,
          customText: custom,
          customImg: customImg
        }));
        // ① 先像真人一样点击卡片；② 抖音可能校验 isTrusted 忽略合成事件 → 检测是否跳转，没跳就直接导航
        const beforeUrl = location.href;
        const el = findCardElement(it);
        if (el) { await humanClick(el); await sleep(1800); }
        if (location.href === beforeUrl || !location.pathname.startsWith("/video/")) {
          report(el ? "点击未跳转(isTrusted被拒)，改用页面导航" : "卡片DOM没找到，直接导航到视频");
          showStep((sent + 1) + "/" + maxN + " 导航到视频页…");
          location.href = it.href;
        }
        return;   // 新页面的 auto.js 接管
      } catch (e) {
        report("单条失败: " + String(e));
        const diag2 = await aiDiagnose(String(e), it.title || "");
        report(diag2);
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
      if (sessionStorage.getItem("__dyStop")) {
        sessionStorage.removeItem("__dyStop");
        sessionStorage.removeItem("dyAutoState");
        report("已停止（视频页跳过）");
        showStep("⏹ 已停止", "ok");
        return;
      }
      report(`进入视频页: ${state.title}，等页面稳定...`);
      showStep("① 页面加载中，暂停视频防止自动切下一条…");
      await sleep(3500);
      const paused = pauseAllVideos();
      report(paused ? "已暂停视频播放" : "没找到播放中的video（可能还没加载）");
      keepVideosPaused(60);   // 60秒内每2秒复查一次，React重渲染也按得住
      showStep("① 视频已暂停，准备评论…");
      if (location.pathname.startsWith("/video/")) {
        const r = await postOnce(state.gapSec, state);
        if (r === "OK" || r === "OK(enter)") { state.sent++; report(`已发送 ${state.sent} 条`); }
        else if (r === "STOPPED") {
          sessionStorage.removeItem("dyAutoState");
          sessionStorage.removeItem("__dyStop");
          report("已停止（未发送当前条）");
          showStep("⏹ 已停止", "ok");
          return;
        }
        else {
          report("未成功: " + r);
          showStep("✗ 未发送: " + String(r).slice(0, 40), "fail");
          const diag = await aiDiagnose(String(r), state.title || "");
          report(diag);
          showStep(diag.slice(0, 60), "fail");
        }
        // 等待间隔
        const wait = Math.max(15, state.gapSec + Math.floor(rand(-10, 30)));
        report(`休眠 ${wait}s 后继续（点停止可立刻中断）`);
        const alive = await stopSleep(wait * 1000);
        if (!alive || stopRequested()) {
          sessionStorage.removeItem("dyAutoState");
          sessionStorage.removeItem("__dyStop");
          report("已停止（休眠被中断）");
          showStep("⏹ 已停止", "ok");
          return;
        }
        const stopped = window.__dyAutoStop || sessionStorage.getItem("__dyStop");
        if (stopped) {
          sessionStorage.removeItem("__dyStop");
          sessionStorage.removeItem("dyAutoState");
          report("已停止，不再继续");
          showStep("⏹ 已停止", "ok");
        } else if (state.remaining - state.sent > 0 && !window.__dyAutoStop) {
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
  if (sessionStorage.getItem("__dyStop")) {
    sessionStorage.removeItem("__dyStop");
    sessionStorage.removeItem("dyAutoResume");
    report("已停止，不再回到列表继续");
  } else if (resume && !location.pathname.startsWith("/video/")) {
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
      let resp = null;
      try {
        resp = await chrome.runtime.sendMessage({ action: "llm",
          prompt: "为抖音视频《" + title + "》写1条15字内仿真人互动评论，只输出JSON数组如[\"文本\"]" });
      } catch (e) { resp = { error: String(e) }; }
      if (resp && resp.error) {
        // 没配模型/模型不可用 → 本地模板兜底，流程照常
        text = localFallbackText(title);
        report("模型不可用(" + String(resp.error).slice(0, 40) + ")，使用本地模板文案");
      } else {
        try {
          const raw = String(resp.content || "").trim().replace(/^```(json)?\s*|\s*```$/g, "").trim();
          const arr = JSON.parse(raw);
          text = Array.isArray(arr) ? String(arr[0] || "") : "";
        } catch { text = ""; }
        if (!text) {
          text = localFallbackText(title);
          report("模型返回解析失败，使用本地模板文案");
        }
      }
      report("评论文案: " + text);
    }

    // ── 仿人流程 ──
    // 1. 模拟看完视频再操作（等3~6s）
    showStep("② 观看视频 3~6 秒…");
    await sleep(3000 + rand(0, 3000));

    // 2. 像真人一样：往下滚找评论框（评论区在页面下方），找不到就点评论按钮，最多4轮
    let editor = await findCommentEditor();
    for (let round = 1; round <= 4 && !editor; round++) {
      report("第" + round + "轮：向下滚动找评论框…");
      showStep("③ 向下滚动找评论区(" + round + "/4)…");
      await humanScrollDown(window.innerHeight * (round === 1 ? 0.8 : 1.2));
      await sleep(700 + rand(500));
      editor = await findCommentEditor();
      if (editor) break;
      const icon = await findVisibleCommentIcon();
      if (icon) {
        report("发现评论按钮，点击展开…");
        showStep("③ 点击评论按钮展开…");
        await humanClick(icon);
        await sleep(2200 + rand(1500));
        editor = await findCommentEditor();
        if (editor) break;
      }
      window.scrollBy({ top: window.innerHeight, behavior: "smooth" });
      await sleep(900 + rand(600));
      editor = await findCommentEditor();
    }
    if (!editor) return "no_editor（滚动4轮+点击评论按钮后仍没输入框）";

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

    if (stopRequested()) return "STOPPED";
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
    if (stopRequested()) return "STOPPED";
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

  // —— AI 排障：失败时把现场交给 AI 分析原因 + 下一步 ——
  async function aiDiagnose(reason, title) {
    try {
      let dom = "";
      try {
        dom = "url=" + location.href.slice(0, 80) +
          " | title=" + (document.title || "").slice(0, 40) +
          " | 评论框存在=" + !!document.querySelector('div[contenteditable="true"]') +
          " | 评论图标存在=" + !!document.querySelector('[data-e2e="comment-icon"]') +
          " | 发送按钮存在=" + !!document.querySelector('[data-e2e="comment-post"]') +
          " | video数=" + document.querySelectorAll("video").length +
          " | captcha=" + ((document.title||"").includes("\u9a8c\u8bc1\u7801") || !!document.querySelector("iframe[src*=verifycenter],iframe[src*=captcha]")) +
          " | 页面正文前100字=" + (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 100);
      } catch {}
      const resp = await chrome.runtime.sendMessage({ action: "llm", prompt:
        "你是抖音网页自动化助手的排障专家。视频《" + title + "》操作失败。\n" +
        "失败原因: " + reason + "\n" +
        "页面状态: " + dom + "\n" +
        "规则：页面状态里 captcha=false 且正文无'验证'字样时，禁止猜测验证码/风控，必须依据字段(评论框/评论图标/发送按钮存在性)判断。" +
        "请用一行中文回答：①真实原因 ②建议动作，80字以内。" });
      if (resp && resp.error) return "AI排障不可用: " + resp.error;
      const ans = String(resp.content || "").trim().replace(/^[\s\S]*?(?=[^。\n])/, "").slice(0, 120);
      return "AI分析: " + (ans || resp.content || "");
    } catch (e) { return "AI排障失败: " + String(e); }
  }

  async function record(title, text) {
    try {
      const hr = await chrome.runtime.sendMessage({ action: "addRecord",
        url: location.href, title: title, text: text });
      if (hr && hr.stats) report("本次已累计 " + hr.stats.total + " 条");
    } catch {}
  }
})();

// TikTok Comment Collector (robust no-timeout)
// - Mở panel bình luận (thử nhiều selector + nhiều lượt)
// - Tự bấm View replies / More comments (đa ngôn ngữ)
// - Thu thập cả replies: author, text, timestamp, likes
// - Cuộn + đợi render bằng MutationObserver (không delay cứng)

class TikTokCommentCollector {
  constructor() {
    this.isCollecting = false;
    this.collectedIds = new Set();
    this.comments = [];
    this.settings = { maxComments: 500 };
  }

  init() {
    chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
      if (req.action === "startCollection") {
        this.settings = { ...this.settings, ...req.settings };
        this.start();
        sendResponse({ ok: true });
        return true;
      }
      if (req.action === "stopCollection") {
        this.stop();
        sendResponse({ ok: true });
        return true;
      }
    });
  }

  async start() {
    if (this.isCollecting) return;
    this.isCollecting = true;
    this.collectedIds.clear();
    this.comments = [];

    try {
      const panel = await this.ensureCommentsPanel();
      await this.collectLoop(panel);
      this.finish();
    } catch (e) {
      chrome.runtime.sendMessage({
        action: "collectionError",
        error: e?.message || String(e)
      });
    } finally {
      this.isCollecting = false;
    }
  }

  stop() { this.isCollecting = false; }

  /* ========== Utils ========== */
  sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  selectOne(selectors, root = document) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  findScrollableParent(el) {
    let node = el;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const oy = style.overflowY;
      if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  waitForIncrease(counterFn, timeoutMs = 3000, rootForObs = document.body) {
    return new Promise(resolve => {
      const baseline = counterFn();
      let resolved = false;

      const obs = new MutationObserver(() => {
        if (counterFn() > baseline) done(true);
      });
      const done = ok => {
        if (resolved) return;
        resolved = true;
        try { obs.disconnect(); } catch {}
        clearTimeout(t);
        resolve(!!ok);
      };
      obs.observe(rootForObs, { childList: true, subtree: true });
      const t = setTimeout(() => done(false), timeoutMs);
    });
  }

  /* ========== Mở panel bình luận (đa chiến lược, lặp lại) ========== */
  async ensureCommentsPanel() {
    const hasAnyItem = () =>
      document.querySelector('[data-e2e="comment-item"], [data-e2e="comment-content"], li div[data-e2e="comment-content"]');

    // Nếu đã có item => xác định container scroll rồi trả về
    if (hasAnyItem()) {
      const any = document.querySelector('[data-e2e="comment-item"]') || document.querySelector('[data-e2e="comment-content"]');
      const container = any ? this.findScrollableParent(any) : (document.scrollingElement || document.documentElement);
      return container;
    }

    // Thử tối đa 5 vòng: bấm nút, cuộn, đợi render
    for (let round = 0; round < 5; round++) {
      // các nút có thể mở comment
      const openBtn = this.selectOne([
        '[data-e2e="comment-icon"]',
        '[data-e2e="browse-comment-icon"]',
        '[data-e2e="detail-comment-icon"]',
        '[data-e2e="comment-button"]',
        'button[aria-label*="comment" i]',
        '[aria-label*="bình luận" i]',
        'div[role="dialog"] [data-e2e="comment-icon"]',
        'div[role="dialog"] button[aria-label*="comment" i]'
      ]);

      if (openBtn && this.visible(openBtn)) {
        try { openBtn.click(); } catch {}
      } else {
        // nếu không có nút: kéo xuống để TikTok tự mount dialog
        window.scrollBy(0, 800);
      }

      // đợi 2s xem có render item
      for (let i = 0; i < 8; i++) {
        if (hasAnyItem()) break;
        await this.sleep(250);
      }

      if (hasAnyItem()) {
        const any = document.querySelector('[data-e2e="comment-item"]') || document.querySelector('[data-e2e="comment-content"]');
        const container = any ? this.findScrollableParent(any) : (document.scrollingElement || document.documentElement);
        try { container.scrollIntoView?.({ behavior: "smooth", block: "center" }); } catch {}
        await this.sleep(200);
        return container;
      }
    }

    throw new Error("Không mở được bảng bình luận (có thể video tắt bình luận).");
  }

  /* ========== Lấy danh sách items & trích xuất dữ liệu ========== */
  getItems() {
    return document.querySelectorAll('[data-e2e="comment-item"], li:has([data-e2e="comment-content"])');
  }

  extract(item) {
    // Nội dung
    const textEl =
      item.querySelector('[data-e2e="comment-content"]') ||
      item.querySelector('p[data-e2e*="comment"]') ||
      item.querySelector('span[data-e2e="comment-text"]') ||
      item.querySelector('p, span');
    const text = textEl ? (textEl.textContent || "").trim() : "";
    if (!text) return null;

    // Tác giả
    const authorEl =
      item.querySelector('[data-e2e="comment-username"]') ||
      item.querySelector('a[href^="/@"]') ||
      item.querySelector('a');
    const author = authorEl ? (authorEl.textContent || "").trim() : "";

    // Thời gian
    const timeEl =
      item.querySelector('[data-e2e="comment-time"]') ||
      item.querySelector('time') ||
      item.querySelector('span[class*="time"], span:has(time)');
    const timestamp = timeEl ? (timeEl.textContent || "").trim() : "";

    // Likes
    const likeEl =
      item.querySelector('[data-e2e="comment-like-count"]') ||
      item.querySelector('button[aria-label*="like" i] span') ||
      item.querySelector('span[class*="like-count"]');
    const likes = this.parseNumber(likeEl ? likeEl.textContent : "");

    // Số replies (ước lượng từ nút "View replies")
    let replies = 0;
    const vr = this.findViewRepliesBtn(item);
    if (vr) {
      const m = (vr.textContent || "").match(/\d+/g);
      if (m && m.length) replies = parseInt(m[m.length - 1], 10) || 0;
    }

    return { author, text, timestamp, likes, replies };
  }

  /* ========== View replies / More comments ========== */
  findViewRepliesBtn(root) {
    const cands = root.querySelectorAll('button, a, div[role="button"]');
    for (const b of cands) {
      const t = (b.textContent || b.getAttribute("aria-label") || "").toLowerCase().trim();
      if (!t) continue;
      if (
        t.includes("view replies") || t.includes("more replies") || t.includes("show replies") ||
        t.includes("xem phản hồi") || t.includes("xem câu trả lời")
      ) return b;
    }
    return null;
  }

  clickSomeViewReplies(maxClicks = 20) {
    const items = this.getItems();
    const btns = [];
    items.forEach(it => {
      const b = this.findViewRepliesBtn(it);
      if (b && !b.disabled && this.visible(b)) btns.push(b);
    });
    let clicked = 0;
    for (const b of btns) {
      if (clicked >= maxClicks) break;
      try { b.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
      try { b.click(); } catch {}
      clicked++;
    }
    return clicked;
  }

  // “Xem thêm bình luận / More comments / Load more”
  clickLoadMore(maxClicks = 2) {
    const btn = this.selectOne([
      'button:has(span:matches-css-before("content:\'More\'"))', // không phải trình duyệt nào cũng hỗ trợ
      'button:has(span)',
      '[data-e2e="more-comment"]',
      'button:has(svg) + button',
      'button'
    ]);
    // Thay bằng nhận diện text:
    const all = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
    const txtMatch = (s) => /(more comments|view more|load more|see more|xem thêm|thêm bình luận)/i.test(s);
    const loadBtns = all.filter(b => {
      const t = (b.textContent || b.getAttribute("aria-label") || "").trim();
      return t && txtMatch(t) && this.visible(b);
    });

    let clicked = 0;
    for (const b of loadBtns) {
      if (clicked >= maxClicks) break;
      try { b.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
      try { b.click(); } catch {}
      clicked++;
    }
    return clicked;
  }

  /* ========== Vòng lặp thu thập ========== */
  async collectLoop(panel) {
    let stagnant = 0;
    let lastCount = -1;
    let lastScrollH = 0;

    const getCount = () => this.getItems().length;
    const getScrollH = () => (panel === document.documentElement ? panel.scrollHeight : panel.scrollHeight);

    while (this.isCollecting && this.collectedIds.size < this.settings.maxComments) {
      // 1) mở replies + load more nếu có
      const clickedReplies = this.clickSomeViewReplies(20);
      const clickedMore = this.clickLoadMore(2);
      if (clickedReplies + clickedMore > 0) {
        await this.waitForIncrease(getCount, 2500, panel);
      }

      // 2) thu thập hiện có
      this.getItems().forEach(item => {
        const data = this.extract(item);
        if (!data) return;
        if (this.collectedIds.has(data.text)) return;
        this.collectedIds.add(data.text);
        this.comments.push({
          ...data,
          videoTitle: document.title,
          videoUrl: location.href,
          collectedAt: new Date().toISOString()
        });
      });

      // 3) tiến độ
      chrome.runtime.sendMessage({
        action: "updateProgress",
        data: { current: this.collectedIds.size, total: this.settings.maxComments, positive: 0 }
      });

      if (this.collectedIds.size >= this.settings.maxComments) break;

      // 4) cuộn container xuống đáy để kích hoạt lazy-load
      const beforeH = getScrollH();
      if (panel === document.documentElement || panel === document.body) {
        window.scrollTo(0, beforeH);
      } else {
        panel.scrollTop = panel.scrollHeight;
      }

      await this.sleep(250);
      await this.waitForIncrease(getCount, 2000, panel); // đợi render chút

      const nowCount = getCount();
      const nowH = getScrollH();
      stagnant = (nowCount === lastCount && nowH === lastScrollH) ? (stagnant + 1) : 0;
      lastCount = nowCount;
      lastScrollH = nowH;

      if (stagnant >= 6) break; // coi như đã hết để tải
    }
  }

  /* ========== Kết thúc ========== */
  finish() {
    this.comments.sort((a, b) => (b.likes || 0) - (a.likes || 0));
    this.comments.forEach((c, i) => (c.rank = i + 1));
    chrome.runtime.sendMessage({ action: "collectionComplete", data: this.comments });
  }

  parseNumber(str) {
    if (!str) return 0;
    const s = String(str).toLowerCase().replace(/\s+/g, "").replace(/,/g, ".");
    const hasK = s.includes("k"), hasM = s.includes("m");
    const n = parseFloat(s.replace(/[^\d.]/g, ""));
    if (isNaN(n)) return 0;
    if (hasK) return Math.floor(n * 1000);
    if (hasM) return Math.floor(n * 1000000);
    return Math.floor(n);
  }
}

(new TikTokCommentCollector()).init();

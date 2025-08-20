// TikTok Comment Collector — v14
// + Hook fetch/XHR (page context) để bắt JSON comment từ API
// + Cuộn đúng scroller của panel bình luận
// + Tự mở panel bình luận (EN/VI, icon)
// + Quét xuyên Shadow DOM
// + Chống kẹt (retry bursts + heartbeat)

(() => {
  if (window.__TTC_V14_READY__) return;
  window.__TTC_V14_READY__ = true;

  /* ================= STATE ================= */
  let RUNNING = false;
  let TARGET = 0;
  let SPEED = "fast";       // "slow" | "normal" | "fast"
  let AUTO_RETRY = true;
  let DEBUG = true;

  const collected = [];
  const seenIds = new Set();        // dom or network id
  const seenHashes = new Set();     // dedupe by text
  let lastProgressAt = 0;
  let idleTicks = 0;

  let ROOT = null;                  // container comment list
  let SCROLLER = null;              // element with overflow-y

  /* ================= UTILS ================= */
  const log = (...a) => { if (DEBUG) console.log("[TTC v14]", ...a); };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();
  const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
  const rrand = (a,b)=> a + Math.random()*(b-a);
  const deaccent = (s="") => s.normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  const norm = (s) => deaccent(String(s||"")).replace(/\u00A0/g," ").replace(/\s+/g," ").trim();
  const lower = (s) => norm(s).toLowerCase();

  const hash = (s) => { // tiny stable hash
    s = String(s||"");
    let h = 2166136261 >>> 0;
    for (let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24); }
    return (h>>>0).toString(36);
  };

  /* ================= deep query (shadow DOM) ================= */
  function* deepWalkRoots() {
    const stack = [document];
    while (stack.length) {
      const root = stack.pop();
      yield root;
      const nodes = (root instanceof Document || root instanceof ShadowRoot ? root : root.shadowRoot)?.querySelectorAll?.("*") || [];
      for (const el of nodes) if (el.shadowRoot) stack.push(el.shadowRoot);
    }
  }
  function deepQuerySelectorAll(selector) {
    const out = [];
    for (const r of deepWalkRoots()) { try { r.querySelectorAll?.(selector)?.forEach(n=>out.push(n)); } catch {} }
    return out;
  }
  function deepQuerySelector(selector) {
    for (const r of deepWalkRoots()) { try { const n=r.querySelector?.(selector); if(n) return n; } catch {} }
    return null;
  }

  /* ================= selectors ================= */
  const SEL = {
    level1: '[data-e2e="comment-level-1"], [data-e2e="comment-list-item"]',
    level2: '[data-e2e="comment-reply-item"], [data-e2e="comment-level-2"]',
    author: 'a[data-e2e="comment-username"], a[href*="@"]',
    text:   '[data-e2e="comment-text"], [data-e2e="comment-content"]',
    time:   'time, span time',
    like:   '[data-e2e="comment-like-count"], [aria-label*="like"]',

    listRoots: [
      '[data-e2e="comment-list"]',
      '[data-e2e="browse-comment-list"]',
      '[data-e2e*="comment"] ul',
      'div[role="dialog"] [data-e2e*="comment"]',
      'aside [data-e2e*="comment"]'
    ],

    toggleButtons: [
      'button[aria-label*="comment" i]',
      'div[role="button"][aria-label*="comment" i]',
      'button:has(svg[aria-label*="comment" i])',
      'a[href*="#comments"]',
      // Vietnamese
      'button[aria-label*="bình luận" i]',
      'div[role="button"][aria-label*="bình luận" i]',
      // badge số comment
      '[data-e2e="comment-count"], [data-e2e="video-comment-count"]'
    ]
  };

  /* ================= speed profiles ================= */
  function speeds(preset){
    if (preset === "slow")   return { clickBatch: 6,  scrollStep: 0.7, delayClick:[120,220], delayScroll:[550,800], maxIdle:14 };
    if (preset === "normal") return { clickBatch: 12, scrollStep: 0.9, delayClick:[ 80,150], delayScroll:[380,520], maxIdle:10 };
    return { clickBatch: 24, scrollStep: 1.15, delayClick:[ 40, 90], delayScroll:[230,360], maxIdle: 8 }; // fast
  }

  /* ================= open panel & scroller ================= */
  function isScrollable(el){
    if (!el) return false;
    const st = getComputedStyle(el);
    const oy = st.overflowY;
    return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 10;
  }

  function findRootDeep() {
    for (const sel of SEL.listRoots) {
      const el = deepQuerySelector(sel);
      if (el) return el;
    }
    // fallback: ancestor quanh item đầu tiên
    const any = deepQuerySelector(SEL.level1) || deepQuerySelector(SEL.level2);
    if (any) {
      let cur = any.parentElement;
      for (let i=0; cur && i<8; i++) {
        if (cur.children?.length > 2) return cur;
        cur = cur.parentElement;
      }
    }
    return null;
  }

  function findScroller(root){
    if (!root) return null;
    if (isScrollable(root)) return root;
    const descendants = root.querySelectorAll?.('*') || [];
    for (const el of descendants) if (isScrollable(el)) return el;
    let cur = root.parentElement;
    for (let i=0; cur && i<8; i++) { if (isScrollable(cur)) return cur; cur = cur.parentElement; }
    return document.scrollingElement || document.documentElement || document.body;
  }

  async function ensureCommentsOpen(){
    if (deepQuerySelector(SEL.level1) || deepQuerySelector(SEL.level2)) return true;
    for (const sel of SEL.toggleButtons) {
      const btns = deepQuerySelectorAll(sel);
      for (const b of btns) {
        try { (b.closest?.('button,[role="button"],a') || b).click(); } catch {}
        await sleep(450);
        if (deepQuerySelector(SEL.level1) || deepQuerySelector(SEL.level2)) return true;
      }
    }
    // scroll page bottom 1 lần, đề phòng panel lazy
    (document.scrollingElement || document.documentElement).scrollTo({ top: 1e9, behavior: "smooth" });
    await sleep(700);
    return !!(deepQuerySelector(SEL.level1) || deepQuerySelector(SEL.level2));
  }

  /* ================= expanders in ROOT ================= */
  const isReplyBtnTxt = (t) =>
    /^view\s+([0-9,]+\s+)?repl/i.test(t) ||
    /xem\s+([0-9,]+\s+)?cau\s*tra\s*loi/i.test(t) ||
    /xem\s*tra\s*loi/i.test(t);
  const isMoreBtnTxt = (t) =>
    /^(load|view)\s+more$/i.test(t) ||
    /^view\s+more$/i.test(t) ||
    /^more$/i.test(t) ||
    /xem\s*them/i.test(t) ||
    /tai\s*them/i.test(t);

  function findExpandButtonsInRoot() {
    const arr = [];
    const scope = ROOT || document;
    const nodes = scope.querySelectorAll?.('button, div[role="button"]') || [];
    for (const b of nodes) {
      const t = lower(b.innerText || b.textContent || "");
      if (!t) continue;
      if (isReplyBtnTxt(t) || isMoreBtnTxt(t)) arr.push(b);
    }
    // shadow-root buttons
    if (!arr.length) {
      const deepBtns = deepQuerySelectorAll('button, div[role="button"]');
      for (const b of deepBtns) {
        const t = lower(b.innerText || b.textContent || "");
        if (!t) continue;
        if (isReplyBtnTxt(t) || isMoreBtnTxt(t)) arr.push(b);
      }
    }
    arr.sort((x,y)=>{
      const tx = lower(x.innerText||x.textContent);
      const ty = lower(y.innerText||y.textContent);
      return (isReplyBtnTxt(tx)?0:1) - (isReplyBtnTxt(ty)?0:1);
    });
    return arr;
  }

  async function clickExpandersBatch(profile){
    const btns = findExpandButtonsInRoot();
    const n = clamp(profile.clickBatch, 1, 30);
    for (let i=0;i<Math.min(n, btns.length);i++){
      try { btns[i].click(); } catch {}
      await sleep(rrand(...profile.delayClick));
    }
  }

  /* ================= scrolling ================= */
  async function strongScroll(profile){
    if (!SCROLLER) SCROLLER = findScroller(ROOT);
    const el = SCROLLER || document.scrollingElement;

    const max = (el === document.scrollingElement) ? el.scrollHeight : el.scrollHeight - el.clientHeight;
    const step = Math.max(300, Math.floor((el.clientHeight || window.innerHeight) * profile.scrollStep));

    el.scrollTop = Math.min(max, el.scrollTop + step);
    await sleep(rrand(...profile.delayScroll));

    if (Math.random() < 0.30) { el.scrollTop = max; await sleep(rrand(...profile.delayScroll)); }
    if (Math.random() < 0.25) { el.scrollTop = Math.max(0, el.scrollTop - Math.floor(step * 0.4)); await sleep(rrand(120,220)); }
  }

  /* ================= parse DOM items ================= */
  function domId(el){
    const did = el.getAttribute?.("data-id") || el.dataset?.id;
    if (did) return `c_${did}`;
    const key = (el.textContent || "").slice(0,80) + "|" + el.clientHeight + "|" + el.clientWidth;
    return "h_" + hash(key);
  }
  const getAuthor = (el)=>{ const a=el.querySelector?.(SEL.author); return a?norm(a.innerText||a.textContent):""; };
  const getText   = (el)=>{ const t=el.querySelector?.(SEL.text); const s=t?(t.innerText||t.textContent):(el.innerText||el.textContent); return norm(s); };
  const getTime   = (el)=>{ const n=el.querySelector?.(SEL.time); return n?norm(n.getAttribute("datetime")||n.innerText||n.textContent):""; };
  const getLikes  = (el)=>{ const n=el.querySelector?.(SEL.like); return n?norm(n.innerText||n.textContent):""; };

  function ensureTopParent(el){
    const top = el.closest?.(SEL.level1);
    if (!top) return "";
    const pid = domId(top);
    if (!seenIds.has(pid)) { const p = parseOne(top,""); if (!p) seenIds.add(pid); }
    return pid;
  }

  function parseOne(el, parentId=""){
    const id = domId(el);
    if (seenIds.has(id)) return null;

    const text = getText(el);
    if (!text) return null;

    const h = hash(text);
    if (seenHashes.has(h)) return null;

    const item = {
      id, parentId,
      author: getAuthor(el),
      text, time: getTime(el), likes: getLikes(el),
      collectedAt: new Date().toISOString()
    };
    seenIds.add(id);
    seenHashes.add(h);
    collected.push(item);
    return item;
  }

  function harvestVisible(){
    let added = 0;
    const level1 = deepQuerySelectorAll(SEL.level1);
    for (const el of level1) {
      const top = parseOne(el,""); if (top) added++;
      const replies = el.querySelectorAll?.(SEL.level2) || [];
      for (const rep of replies) {
        const pid = top ? top.id : ensureTopParent(rep);
        const child = parseOne(rep, pid || "");
        if (child) added++;
      }
    }
    return added;
  }

  /* ================= network hook (page context) ================= */
  function injectNetHook(){
    const code = `
    (function(){
      if (window.__TTC_NET_HOOKED__) return; window.__TTC_NET_HOOKED__=true;
      const send=(payload)=>window.postMessage({source:"ttc-ext",type:"TTC_NETDATA",payload}, "*");
      const isCommentUrl=(u)=>/\\\\bcomment\\\\/(list|reply)/i.test(u)||/aweme\\\\/v\\\\d+\\\\/comment/i.test(u);
      const safeParse=(t)=>{ try{return JSON.parse(t) }catch(_){ return null } };

      const origFetch=window.fetch;
      window.fetch = async function(...args){
        const res = await origFetch.apply(this,args);
        try{
          const url = String((args[0] && (args[0].url||args[0])) || "");
          if (isCommentUrl(url)) {
            const clone = res.clone();
            clone.text().then(t=>{ const j=safeParse(t); if(j) send({ url, data:j, via:"fetch" }); });
          }
        }catch(_){}
        return res;
      };

      const oOpen = XMLHttpRequest.prototype.open;
      const oSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(m,u){ this.__ttc_url = u; return oOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function(){
        this.addEventListener("load", function(){
          try{
            const url = String(this.responseURL || this.__ttc_url || "");
            if (isCommentUrl(url) && typeof this.responseText === "string") {
              const j = safeParse(this.responseText);
              if (j) send({ url, data:j, via:"xhr" });
            }
          }catch(_){}
        });
        return oSend.apply(this, arguments);
      };
    })();`;
    const s = document.createElement('script');
    s.textContent = code;
    (document.documentElement || document.head).appendChild(s);
    s.remove();
    log("net hook injected");
  }

  function extractFromNet(obj){
    // duyệt sâu tìm các phần tử trông giống comment
    const out = [];
    const walk = (v, parentId="") => {
      if (!v) return;
      if (Array.isArray(v)) { for (const it of v) walk(it, parentId); return; }
      if (typeof v === "object") {
        const id = v.cid || v.comment_id || v.id || v.aweme_id || null;
        const text = v.text || v.content || null;
        const author = v.user?.nickname || v.user?.unique_id || v.nickname || v.username || "";
        const likes = v.digg_count || v.diggCount || v.like_count || v.likes || "";
        const replyTo = v.reply_id || v.reply_to_comment_id || "";
        const created = v.create_time || v.createTime || v.created_at || v.createAt || "";

        if (id && text) {
          out.push({
            id: "n_" + id,
            parentId: replyTo ? "n_" + replyTo : parentId || "",
            author: String(author||""),
            text: String(text||""),
            time: String(created||""),
            likes: String(likes||""),
            collectedAt: new Date().toISOString()
          });
        }

        for (const k in v) { // walk children fields
          if (k === "text" || k === "content") continue;
          walk(v[k], replyTo ? ("n_"+replyTo) : (parentId || ""));
        }
      }
    };
    walk(obj);
    return out;
  }

  // nhận data từ page (network hook)
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.source !== "ttc-ext" || msg.type !== "TTC_NETDATA") return;
    const arr = extractFromNet(msg.payload?.data || {});
    let added = 0;
    for (const it of arr) {
      if (!it.text) continue;
      const h = hash(it.text);
      if (seenHashes.has(h) || seenIds.has(it.id)) continue;
      seenHashes.add(h); seenIds.add(it.id);
      collected.push(it); added++;
    }
    if (added > 0) sendProgress("net");
  });

  /* ================= observer ================= */
  let observer = null;
  function attachObserver(){
    if (observer) return;
    observer = new MutationObserver((list)=>{
      let added = 0;
      for (const m of list) {
        for (const n of (m.addedNodes || [])) {
          if (!(n instanceof HTMLElement)) continue;
          const sub = [n, ...(n.querySelectorAll?.("*") || [])];
          for (const el of sub) {
            if (el.matches?.(SEL.level1)) { if (parseOne(el,"")) added++; }
            else if (el.matches?.(SEL.level2)) { const pid = ensureTopParent(el); if (parseOne(el,pid)) added++; }
          }
        }
      }
      if (added > 0) sendProgress("observer");
    });
    observer.observe(document.body, { childList:true, subtree:true });
    log("observer attached");
  }

  /* ================= progress/done ================= */
  function sendProgress(reason=""){
    const t = now();
    if (t - lastProgressAt < 250) return;
    lastProgressAt = t;
    chrome.runtime?.sendMessage?.({
      type: "TTC_PROGRESS",
      payload: { total: collected.length, target: TARGET, reason, sample: collected[collected.length-1] || null }
    });
  }

  function finish(reason="done"){
    RUNNING = false;
    try { observer && observer.disconnect(); } catch {}
    observer = null;
    chrome.runtime?.sendMessage?.({
      type: "TTC_DONE",
      payload: { total: collected.length, data: collected, reason }
    });
    log("finish:", reason, "total:", collected.length);
  }

  function reset(){
    RUNNING = false;
    TARGET = 0;
    idleTicks = 0;
    collected.length = 0;
    seenIds.clear();
    seenHashes.clear();
    ROOT = null; SCROLLER = null;
  }

  /* ================= main loop ================= */
  async function run(){
    const profile = speeds(SPEED);

    injectNetHook();                // <-- bắt JSON comment từ API
    await ensureCommentsOpen();

    ROOT = findRootDeep();
    SCROLLER = findScroller(ROOT);
    log("root:", ROOT, "scroller:", SCROLLER);

    attachObserver();

    while (RUNNING) {
      const before = collected.length;

      await clickExpandersBatch(profile); // mở thêm replies/more
      harvestVisible();                   // hốt DOM hiện tại
      sendProgress("harvest");

      if (TARGET > 0 && collected.length >= TARGET) return finish("target_reached");

      await strongScroll(profile);        // cuộn đúng scroller của panel

      // stuck detection
      if (collected.length === before) idleTicks++; else idleTicks = 0;
      if (idleTicks >= profile.maxIdle) {
        if (AUTO_RETRY) {
          // bursts: mở thêm + chạm đáy panel + chạm đáy trang
          for (let i=0;i<3;i++){
            await clickExpandersBatch(profile);
            if (!SCROLLER) SCROLLER = findScroller(ROOT);
            if (SCROLLER) {
              SCROLLER.scrollTop = 0; await sleep(200);
              SCROLLER.scrollTop = SCROLLER.scrollHeight; await sleep(350);
            }
            const se = document.scrollingElement || document.documentElement;
            se.scrollTop = se.scrollHeight; await sleep(250);
            harvestVisible();
            sendProgress("retry");
            if (TARGET>0 && collected.length>=TARGET) break;
          }
        }
        break;
      }
    }
    finish("idle_end");
  }

  /* ================= message bridge ================= */
  chrome.runtime?.onMessage.addListener?.((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "TTC_START") {
      const { target=0, speed="fast", autoRetry=true, debug=true } = msg || {};
      reset();
      RUNNING = true;
      TARGET = Math.max(0, Number(target)||0);
      SPEED = String(speed||"fast").toLowerCase();
      AUTO_RETRY = !!autoRetry;
      DEBUG = !!debug;
      sendResponse?.({ ok:true, speed:SPEED, target:TARGET, autoRetry:AUTO_RETRY, debug:DEBUG });
      run();
      return true;
    }

    if (msg.type === "TTC_STOP") {
      RUNNING = false;
      sendResponse?.({ ok:true, stopped:true });
      finish("manual_stop");
      return true;
    }

    if (msg.type === "TTC_PING") {
      sendResponse?.({ ok:true, ready:true });
      return true;
    }
  });

  // Console helpers (khi popup không gửi START)
  window.TTC_start = (target=0, speed="fast", autoRetry=true, debug=true) => {
    reset(); RUNNING=true; TARGET=Number(target)||0; SPEED=String(speed||"fast"); AUTO_RETRY=!!autoRetry; DEBUG=!!debug; run();
  };
  window.TTC_stop = ()=>{ RUNNING=false; finish("manual_stop(self)"); };
})();

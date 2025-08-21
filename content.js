// TikTok Comment Collector — content.js (v16)
// - Tiêm pageHook.js (page world) để bắt fetch/XHR (vượt CSP, iframe, shadow DOM)
// - Cuộn đúng panel bình luận, tự mở panel, batch "Xem thêm / Xem trả lời"
// - Chống kẹt + auto-start nếu popup không gửi lệnh

(() => {
  if (window.__TTC_V16_READY__) return;
  window.__TTC_V16_READY__ = true;

  /* ===== STATE ===== */
  let RUNNING = false;
  let TARGET = 0;
  let SPEED = "fast";     // slow | normal | fast
  let AUTO_RETRY = true;
  let DEBUG = true;
  let gotStartMsg = false;

  const collected = [];
  const seenIds = new Set();
  const seenHashes = new Set();
  let lastProgressAt = 0;
  let idleTicks = 0;

  let ROOT = null;
  let SCROLLER = null;

  /* ===== UTILS ===== */
  const log = (...a)=>{ if (DEBUG) console.log("[TTC v16]", ...a); };
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const now = ()=>Date.now();
  const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
  const rrand = (a,b)=> a + Math.random()*(b-a);
  const deaccent = (s="")=>s.normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  const norm = (s)=>deaccent(String(s||"")).replace(/\u00A0/g," ").replace(/\s+/g," ").trim();
  const lower = (s)=>norm(s).toLowerCase();
  const hash = (s)=>{ s=String(s||""); let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h+=(h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24);} return (h>>>0).toString(36); };

  /* ===== deep query (shadow DOM) ===== */
  function* deepWalkRoots(){ const st=[document]; while(st.length){ const r=st.pop(); yield r;
    const nodes=(r instanceof Document||r instanceof ShadowRoot ? r : r.shadowRoot)?.querySelectorAll?.("*")||[];
    for(const el of nodes) if(el.shadowRoot) st.push(el.shadowRoot);
  } }
  function deepQSA(sel){ const out=[]; for(const r of deepWalkRoots()) try{ r.querySelectorAll?.(sel)?.forEach(n=>out.push(n)); }catch{} return out; }
  function deepQS(sel){ for(const r of deepWalkRoots()) try{ const n=r.querySelector?.(sel); if(n) return n; }catch{} return null; }

  /* ===== selectors ===== */
  const SEL = {
    level1:'[data-e2e="comment-level-1"], [data-e2e="comment-list-item"]',
    level2:'[data-e2e="comment-reply-item"], [data-e2e="comment-level-2"]',
    author:'a[data-e2e="comment-username"], a[href*="@"]',
    text:  '[data-e2e="comment-text"], [data-e2e="comment-content"]',
    time:  'time, span time',
    like:  '[data-e2e="comment-like-count"], [aria-label*="like"]',
    listRoots:[
      '[data-e2e="comment-list"]',
      '[data-e2e="browse-comment-list"]',
      '[data-e2e*="comment"] ul',
      'div[role="dialog"] [data-e2e*="comment"]',
      'aside [data-e2e*="comment"]'
    ],
    toggleButtons:[
      'button[aria-label*="comment" i]',
      'div[role="button"][aria-label*="comment" i]',
      'button:has(svg[aria-label*="comment" i])',
      'a[href*="#comments"]',
      'button[aria-label*="bình luận" i]',
      'div[role="button"][aria-label*="bình luận" i]',
      '[data-e2e="comment-count"], [data-e2e="video-comment-count"]'
    ]
  };

  /* ===== speed profiles ===== */
  function speeds(p){
    if(p==="slow")   return {clickBatch:6,  scrollStep:.7, delayClick:[120,220], delayScroll:[550,800], maxIdle:14};
    if(p==="normal") return {clickBatch:12, scrollStep:.9, delayClick:[ 80,150], delayScroll:[380,520], maxIdle:10};
    return               {clickBatch:24, scrollStep:1.15,delayClick:[ 40, 90], delayScroll:[230,360], maxIdle: 8};
  }

  /* ===== open panel + scroller ===== */
  function isScrollable(el){ if(!el) return false; const st=getComputedStyle(el); const oy=st.overflowY; return (oy==="auto"||oy==="scroll")&&el.scrollHeight>el.clientHeight+10; }
  function findRoot(){
    for(const s of SEL.listRoots){ const el=deepQS(s); if(el) return el; }
    const any=deepQS(SEL.level1)||deepQS(SEL.level2);
    if(any){ let cur=any.parentElement; for(let i=0;cur&&i<8;i++){ if(cur.children?.length>2) return cur; cur=cur.parentElement; } }
    return null;
  }
  function findScroller(root){
    if(!root) return null;
    if(isScrollable(root)) return root;
    const d=root.querySelectorAll?.('*')||[];
    for(const el of d) if(isScrollable(el)) return el;
    let cur=root.parentElement;
    for(let i=0;cur&&i<8;i++){ if(isScrollable(cur)) return cur; cur=cur.parentElement; }
    return document.scrollingElement||document.documentElement||document.body;
  }
  async function ensureCommentsOpen(){
    if(deepQS(SEL.level1)||deepQS(SEL.level2)) return true;
    for(const s of SEL.toggleButtons){
      const btns=deepQSA(s);
      for(const b of btns){
        try{ (b.closest?.('button,[role="button"],a')||b).click(); }catch{}
        await sleep(450);
        if(deepQS(SEL.level1)||deepQS(SEL.level2)) return true;
      }
    }
    (document.scrollingElement||document.documentElement).scrollTo({top:1e9,behavior:"smooth"});
    await sleep(700);
    return !!(deepQS(SEL.level1)||deepQS(SEL.level2));
  }

  /* ===== expanders ===== */
  const isReply=(t)=>/^view\s+([0-9,]+\s+)?repl/i.test(t)||/xem\s+([0-9,]+\s+)?cau\s*tra\s*loi/i.test(t)||/xem\s*tra\s*loi/i.test(t);
  const isMore =(t)=>/^(load|view)\s+more$/i.test(t)||/^view\s+more$/i.test(t)||/^more$/i.test(t)||/xem\s*them/i.test(t)||/tai\s*them/i.test(t);
  function findExpanders(){
    const arr=[]; const scope=ROOT||document;
    const nodes=scope.querySelectorAll?.('button, div[role="button"]')||[];
    for(const b of nodes){ const t=lower(b.innerText||b.textContent||""); if(!t) continue; if(isReply(t)||isMore(t)) arr.push(b); }
    if(!arr.length){
      const deepBtns=deepQSA('button, div[role="button"]');
      for(const b of deepBtns){ const t=lower(b.innerText||b.textContent||""); if(!t) continue; if(isReply(t)||isMore(t)) arr.push(b); }
    }
    arr.sort((x,y)=>{ const tx=lower(x.innerText||x.textContent); const ty=lower(y.innerText||y.textContent); return (isReply(tx)?0:1)-(isReply(ty)?0:1); });
    return arr;
  }
  async function clickExpanders(profile){
    const btns=findExpanders(); const n=clamp(profile.clickBatch,1,30);
    for(let i=0;i<Math.min(n,btns.length);i++){ try{btns[i].click();}catch{} await sleep(rrand(...profile.delayClick)); }
  }

  /* ===== scrolling ===== */
  async function strongScroll(profile){
    if(!SCROLLER) SCROLLER=findScroller(ROOT);
    const el=SCROLLER||document.scrollingElement;
    const max=(el===document.scrollingElement)?el.scrollHeight:el.scrollHeight-el.clientHeight;
    const step=Math.max(300, Math.floor((el.clientHeight||window.innerHeight)*profile.scrollStep));
    el.scrollTop=Math.min(max, el.scrollTop+step); await sleep(rrand(...profile.delayScroll));
    if(Math.random()<.30){ el.scrollTop=max; await sleep(rrand(...profile.delayScroll)); }
    if(Math.random()<.25){ el.scrollTop=Math.max(0, el.scrollTop-Math.floor(step*.4)); await sleep(rrand(120,220)); }
  }

  /* ===== parse DOM ===== */
  function domId(el){ const did=el.getAttribute?.("data-id")||el.dataset?.id; if(did) return `c_${did}`; const key=(el.textContent||"").slice(0,80)+"|"+el.clientHeight+"|"+el.clientWidth; return "h_"+hash(key); }
  const getAuthor=(el)=>{ const a=el.querySelector?.(SEL.author); return a?norm(a.innerText||a.textContent):""; };
  const getText  =(el)=>{ const t=el.querySelector?.(SEL.text); const s=t?(t.innerText||t.textContent):(el.innerText||el.textContent); return norm(s); };
  const getTime  =(el)=>{ const n=el.querySelector?.(SEL.time); return n?norm(n.getAttribute("datetime")||n.innerText||n.textContent):""; };
  const getLikes =(el)=>{ const n=el.querySelector?.(SEL.like); return n?norm(n.innerText||n.textContent):""; };
  function ensureTop(el){ const top=el.closest?.(SEL.level1); if(!top) return ""; const pid=domId(top); if(!seenIds.has(pid)){ const p=parseOne(top,""); if(!p) seenIds.add(pid);} return pid; }
  function parseOne(el,parentId=""){
    const id=domId(el); if(seenIds.has(id)) return null;
    const text=getText(el); if(!text) return null;
    const h=hash(text); if(seenHashes.has(h)) return null;
    const item={ id,parentId, author:getAuthor(el), text, time:getTime(el), likes:getLikes(el), collectedAt:new Date().toISOString() };
    seenIds.add(id); seenHashes.add(h); collected.push(item); return item;
  }
  function harvestVisible(){
    let added=0; const l1=deepQSA(SEL.level1);
    for(const el of l1){ const top=parseOne(el,""); if(top) added++;
      const reps=el.querySelectorAll?.(SEL.level2)||[];
      for(const rep of reps){ const pid=top?top.id:ensureTop(rep); const child=parseOne(rep,pid||""); if(child) added++; } }
    return added;
  }

  /* ===== network hook via pageHook.js ===== */
  function injectPageHook(){
    try{
      const src = (typeof chrome!=="undefined" && chrome.runtime?.getURL) ? chrome.runtime.getURL("pageHook.js") : null;
      if (!src) return;
      const s = document.createElement("script");
      s.src = src; s.async = false;
      (document.documentElement || document.head).appendChild(s);
      s.remove();
      log("pageHook injected:", src);
    }catch(e){ console.warn("injectPageHook error", e); }
  }
  function extractFromNet(obj){
    const out=[]; const walk=(v,pid="")=>{ if(!v) return;
      if(Array.isArray(v)){ for(const it of v) walk(it,pid); return; }
      if(typeof v==="object"){
        const id=v.cid||v.comment_id||v.id||null;
        const text=v.text||v.content||null;
        const author=v.user?.nickname||v.user?.unique_id||v.nickname||v.username||"";
        const likes=v.digg_count||v.like_count||v.likes||"";
        const reply=v.reply_id||v.reply_to_comment_id||v.reply_comment_id||"";
        const created=v.create_time||v.created_at||"";
        if(id&&text){
          out.push({ id:"n_"+id, parentId: reply?("n_"+reply):(pid||""), author:String(author||""), text:String(text||""), time:String(created||""), likes:String(likes||""), collectedAt:new Date().toISOString() });
        }
        for(const k in v){ if(k==="text"||k==="content") continue; walk(v[k], reply?("n_"+reply):(pid||"")); }
      }
    };
    walk(obj); return out;
  }
  // nhận data từ pageHook
  window.addEventListener("message",(e)=>{
    if(e.source!==window) return;
    const m=e.data||{};
    if(m.source==="ttc-pagehook" && m.type==="ready"){ log("pageHook ready"); return; }
    if(m.source!=="ttc-pagehook" || m.type!=="comments") return;
    const arr=extractFromNet(m.payload||{}); let added=0;
    for(const it of arr){
      if(!it.text) continue;
      const h=hash(it.text);
      if(seenHashes.has(h)||seenIds.has(it.id)) continue;
      seenHashes.add(h); seenIds.add(it.id);
      collected.push(it); added++;
    }
    if(added>0) sendProgress("net");
  });

  /* ===== observer ===== */
  let observer=null;
  function attachObserver(){ if(observer) return;
    observer=new MutationObserver(list=>{ let added=0;
      for(const m of list){
        for(const n of (m.addedNodes||[])){
          if(!(n instanceof HTMLElement)) continue;
          const sub=[n, ...(n.querySelectorAll?.("*")||[])];
          for(const el of sub){
            if(el.matches?.(SEL.level1)){ if(parseOne(el,"")) added++; }
            else if(el.matches?.(SEL.level2)){ const pid=ensureTop(el); if(parseOne(el,pid)) added++; }
          }
        }
      }
      if(added>0) sendProgress("observer");
    });
    observer.observe(document.body,{childList:true,subtree:true}); log("observer attached");
  }

  /* ===== progress / done ===== */
  function sendProgress(reason=""){
    const t=now(); if(t-lastProgressAt<250) return; lastProgressAt=t;
    try{
      chrome.runtime?.sendMessage?.({ type:"TTC_PROGRESS", payload:{ total:collected.length, target:TARGET, reason, sample:collected[collected.length-1]||null } });
    }catch{}
  }
  function finish(reason="done"){
    RUNNING=false; try{observer&&observer.disconnect();}catch{} observer=null;
    try{
      chrome.runtime?.sendMessage?.({ type:"TTC_DONE", payload:{ total:collected.length, data:collected, reason } });
    }catch{}
    log("finish:",reason,"total:",collected.length);
  }
  function reset(){ RUNNING=false; TARGET=0; idleTicks=0; collected.length=0; seenIds.clear(); seenHashes.clear(); ROOT=null; SCROLLER=null; }

  /* ===== main ===== */
  async function run(){
    const profile=speeds(SPEED);
    injectPageHook();                    // <-- hút JSON ở page world
    await ensureCommentsOpen();
    ROOT=findRoot(); SCROLLER=findScroller(ROOT);
    log("root:",ROOT,"scroller:",SCROLLER);
    attachObserver();

    while(RUNNING){
      const before=collected.length;
      await clickExpanders(profile);
      harvestVisible();
      sendProgress("harvest");
      if(TARGET>0 && collected.length>=TARGET) return finish("target_reached");
      await strongScroll(profile);

      if(collected.length===before) idleTicks++; else idleTicks=0;
      if(idleTicks>=profile.maxIdle){
        if(AUTO_RETRY){
          for(let i=0;i<3;i++){
            await clickExpanders(profile);
            if(!SCROLLER) SCROLLER=findScroller(ROOT);
            if(SCROLLER){ SCROLLER.scrollTop=0; await sleep(200); SCROLLER.scrollTop=SCROLLER.scrollHeight; await sleep(350); }
            const se=document.scrollingElement||document.documentElement; se.scrollTop=se.scrollHeight; await sleep(250);
            harvestVisible(); sendProgress("retry");
            if(TARGET>0 && collected.length>=TARGET) break;
          }
        }
        break;
      }
    }
    finish("idle_end");
  }

  /* ===== message bridge ===== */
  chrome.runtime?.onMessage.addListener?.((msg,s,sendResponse)=>{
    if(!msg||!msg.type) return;
    if(msg.type==="TTC_START"){
      gotStartMsg=true;
      const {target=0, speed="fast", autoRetry=true, debug=true}=msg||{};
      reset(); RUNNING=true; TARGET=Math.max(0,Number(target)||0); SPEED=String(speed||"fast"); AUTO_RETRY=!!autoRetry; DEBUG=!!debug;
      sendResponse?.({ok:true,speed:SPEED,target:TARGET,autoRetry:AUTO_RETRY,debug:DEBUG}); run(); return true;
    }
    if(msg.type==="TTC_STOP"){ RUNNING=false; sendResponse?.({ok:true,stopped:true}); finish("manual_stop"); return true; }
    if(msg.type==="TTC_PING"){ sendResponse?.({ok:true,ready:true}); return true; }
  });

  /* ===== auto-start nếu popup không gửi lệnh ===== */
  const onVideo = /tiktok\.com\/@.+\/video\//i.test(location.href);
  setTimeout(()=>{ if(!gotStartMsg && onVideo && !RUNNING){ RUNNING=true; TARGET=Number(window.__TTC_AUTO_TARGET__||300)||0; SPEED="fast"; AUTO_RETRY=true; DEBUG=true; log("AUTO-START (no popup msg)"); run(); } }, 3000);

  // console helpers
  window.TTC_start=(t=0,s="fast",a=true,d=true)=>{ reset(); RUNNING=true; TARGET=Number(t)||0; SPEED=String(s||"fast"); AUTO_RETRY=!!a; DEBUG=!!d; run(); };
  window.TTC_stop =()=>{ RUNNING=false; finish("manual_stop(self)"); };
})();

// TikTok Comment Collector — v4.1 (Respect Max: lấy đúng SỐ YÊU CẦU)
const __ric = window.requestIdleCallback || (cb => setTimeout(() => cb({ timeRemaining: () => 1 }), 0));

class TikTokCommentCollector {
  constructor() {
    this.isCollecting = false;
    this.collectedIds = new Set();
    this.comments = [];
    this.positiveCount = 0;

    this._panel = null; this._scroller = null; this._observer = null;
    this._queue = []; this._processing = false; this._lastNewAt = 0;
    this._scrollRAF = 0; this._progressTimer = 0;

    this.settings = {
      maxComments: 500,         // dừng chính xác tại số này nếu có đủ dữ liệu
      waitGrowMs: 2600, hardOpenBudgetMs: 30000, primeBudgetMs: 20000,
      scrollStepPx: 240, scrollBackoffMs: 650, scrollBackoffMax: 2200,
      clickDelay: 380, idleStopMs: 9000, stableRounds: 2
    };
  }

  /* utils */
  sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
  textOf(n){ return (n?.innerText||n?.textContent||n?.getAttribute?.("aria-label")||"").trim(); }
  visible(el){ if(!el) return false; const r=el.getBoundingClientRect(); return r.width>0 && r.height>0; }
  inDoc(n){ try{ return !!(n && document.contains(n)); }catch{ return false; } }
  normalize(s){return (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ").trim();}
  isPositive(txt){ const raw=txt||"", t=this.normalize(raw);
    if(/[😄😆😂🤣😊🙂😍🥰😘❤️💖💗💕👍👏🔥✨🌟💯]/.test(raw)) return true;
    const good=["tuyet","tuyet voi","qua da","qua xinh","de thuong","cute","xinh","dep","xuat sac","dinh","hay","rat hay","okela","cam on","thanks","thank you","good","great","awesome","amazing","nice","cool","love","best","legend","respect","xuat sac luon","qua chat","xin xo","xịn sò","xinh xiu","qua hay","qua xin"];
    if(good.some(w=>t.includes(w)) && !/(khong|ko|k|chang|cha)\s+(hay|tuyet|tot|dep|yeu|good|great|nice|love|xinh|amazing|awesome|cool)/.test(t)) return true;
    return false;
  }
  parseNumber(s){ if(!s) return 0; const t=String(s).toLowerCase().replace(/\s+/g,"").replace(/,/g,".");
    const k=t.includes("k"), m=t.includes("m"); const n=parseFloat(t.replace(/[^\d.]/g,"")); if(isNaN(n)) return 0;
    return k?Math.floor(n*1e3):m?Math.floor(n*1e6):Math.floor(n);
  }
  cleanCommentText(raw){ if(!raw) return ""; let t=raw;
    [/Translated by Google.*$/i,/\(by KOLSprite\)/i,/\b(Translate|See translation|View translation|Xem bản dịch|Dịch)\b/ig,
     /查看翻译|翻译|翻訳を見る|翻訳|번역 보기|번역/g,/\b(Ver traducción|Traduire|Mostrar traducción|Anzeigen.*Übersetzung)\b/ig,
     /\s*-\s*Creator\s*$/i].forEach(p=>t=t.replace(p," "));
    return t.replace(/\s+/g," ").trim();
  }
  toISODateFromRelative(txt){
    const s=(txt||"").toLowerCase().trim(), now=new Date();
    const apply=(u,n)=>{const d=new Date(now),v=+n||0; ({s:()=>d.setSeconds(d.getSeconds()-v),m:()=>d.setMinutes(d.getMinutes()-v),
      h:()=>d.setHours(d.getHours()-v),d:()=>d.setDate(d.getDate()-v),w:()=>d.setDate(d.getDate()-7*v),
      mo:()=>d.setMonth(d.getMonth()-v),y:()=>d.setFullYear(d.getFullYear()-v)}[u]?.()); return d.toISOString();};
    let m=s.match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|w|mo|y)\b/); if(m){const map={sec:"s",secs:"s",min:"m",mins:"m",hr:"h",hrs:"h"}; return apply(map[m[2]]||m[2],m[1]);}
    m=s.match(/^(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago/); if(m){const u=m[2][0]; return apply(u==="o"?"mo":({s:"s",m:"m",h:"h",d:"d",w:"w",y:"y"}[u]||"d"),m[1]);}
    m=s.match(/^(\d+)\s*(giay|giây|phut|phút|gio|giờ|ngay|ngày|tuan|tuần|thang|tháng|nam|năm)/);
    if(m){const u=this.normalize(m[2]); const map={giay:"s",phut:"m",gio:"h",ngay:"d",tuan:"w",thang:"mo",nam:"y"}; return apply(map[u]||"d",m[1]);}
    const d=new Date(s); return isNaN(d)? "": d.toISOString();
  }

  /* selectors */
  getCommentListNode(){ return document.querySelector('[data-e2e="comment-list"]') ||
    document.querySelector('div[class*="DivCommentList"]') || document.querySelector('div[class*="DivCommentsContainer"]') ||
    document.querySelector('ul[data-e2e="comment-list"]') || document.querySelector('[role="list"][data-e2e*="comment"]'); }
  repliesRegex(){ return new RegExp([String.raw`\b(view|show|see|more)\s*\d*\s*repl(?:y|ies)\b`,
    String.raw`xem\s*(\d+)?\s*(phản\s*hồi|câu\s*trả\s*lời|trả\s*lời)`, String.raw`xem\s*thêm\s*(phản\s*hồi|trả\s*lời)`,
    `查看回复`,`更多回复`,`显示回复`,`展开回复`,`返信を表示`,`さらに返信を表示`,`댓글\\s*더보기`,`답글\\s*보기`,`더 많은 답글`,
    `ver\\s*respuestas`,`mostrar\\s*respuestas`,`afficher\\s*les\\s*r?éponses`,`weitere\\s*antworten`,
    `risposte|vedi\\s*risposte`,`balasan|lihat\\s*balasan`,`odpowiedzi|pokaż\\s*odpowiedzi`].join("|"),"i"); }
  loadMoreRegex(){ return /(more\s+comments|view\s+more|load\s+more|see\s+more|show\s+more|more|xem\s+thêm|thêm\s+bình\s+luận|hiển\s*thị\s*thêm|更多评论|查看更多|更多|さらに表示|もっと見る|더보기)/i; }

  /* open/ensure panel */
  findOpenButtons(){
    const sels=['[data-e2e="comment-icon"]','[data-e2e="browse-comment-icon"]','[data-e2e="detail-comment-icon"]','[data-e2e="comment-button"]',
      'button[aria-label*="comment" i]','a[aria-label*="comment" i]','[aria-label*="bình luận" i]'];
    const btns = sels.flatMap(s=>Array.from(document.querySelectorAll(s)||[]));
    const txtBtns=[...document.querySelectorAll('button,a,div[role="button"]')].filter(b=>{
      const t=this.textOf(b).toLowerCase(); return t && /(comment|bình luận|comentarios|commentaires|komentar|kommentar|댓글|コメント|评论)/i.test(t);
    });
    return [...new Set([...btns,...txtBtns])].filter(b=>this.visible(b));
  }
  findComposerInputs(){
    return [
      ...Array.from(document.querySelectorAll('div[contenteditable][data-e2e*="comment"]')||[]),
      ...Array.from(document.querySelectorAll('div[contenteditable]')||[]),
      ...Array.from(document.querySelectorAll('textarea[placeholder*="comment" i]')||[]),
    ];
  }
  async forceOpenComments(){
    this.findOpenButtons().forEach(b=>{ try{ b.click(); }catch{} });
    this.findComposerInputs().forEach(i=>{ if(this.visible(i)){ try{i.focus();}catch{} }});
    const t=this.getCommentListNode()||document.scrollingElement||document.documentElement;
    for(let i=0;i<2;i++){ t.dispatchEvent(new WheelEvent("wheel",{deltaY:800,bubbles:true})); await this.sleep(60); }
  }
  async ensureCommentsPanel(){
    const hasAny = () => this.getCommentListNode() ||
      document.querySelector('[data-e2e="comment-item"],[data-e2e="comment-content"],[role="listitem"][data-e2e*="comment"]');
    if(hasAny()) return true;
    const deadline=Date.now()+this.settings.hardOpenBudgetMs;
    while(Date.now()<deadline){
      await this.forceOpenComments();
      for(let i=0;i<8;i++){ if(hasAny()) break; await this.sleep(120); }
      if(hasAny()) return true;
      window.scrollBy(0,800); await this.sleep(100); window.scrollBy(0,-600);
    }
    return false;
  }

  /* scroller / observer */
  findScrollableParent(el){
    let n=el; while(n&&n!==document.body){
      const st=getComputedStyle(n);
      if((st.overflowY==="auto"||st.overflowY==="scroll") && n.scrollHeight>n.clientHeight) return n;
      n=n.parentElement;
    }
    return document.scrollingElement||document.documentElement;
  }
  _calcScroller(){
    const list=this.getCommentListNode(); if(list) return this.findScrollableParent(list);
    const addBox=this.findComposerInputs()[0]; if(addBox){ const p=this.findScrollableParent(addBox); if(p) return p; }
    return document.scrollingElement||document.documentElement;
  }
  getScroller(){ if(!this._scroller || !this.inDoc(this._scroller)) this._scroller=this._calcScroller(); return this._scroller; }

  _installObserver(panel){
    if(this._observer){ try{ this._observer.disconnect(); }catch{} this._observer=null; }
    this._observer = new MutationObserver((muts)=>{
      let pushed=0;
      for(const m of muts){
        for(const n of m.addedNodes || []){
          if(!(n instanceof Element)) continue;
          if(n.matches?.('[data-e2e="comment-item"],[data-e2e="comment-reply-item"],[role="listitem"][data-e2e*="comment"],div[class*="CommentItem"],div[class*="DivCommentItem"]')){
            this._queue.push(n); pushed++;
          } else {
            const found=n.querySelectorAll?.('[data-e2e="comment-item"],[data-e2e="comment-reply-item"],[role="listitem"][data-e2e*="comment"],div[class*="CommentItem"],div[class*="DivCommentItem"]');
            if(found && found.length){ this._queue.push(...found); pushed += found.length; }
          }
        }
      }
      if (pushed){ this._lastNewAt = Date.now(); this._drainQueueSoon(); }
    });
    this._observer.observe(panel,{childList:true,subtree:true});

    const init=panel.querySelectorAll?.('[data-e2e="comment-item"],[data-e2e="comment-reply-item"],[role="listitem"][data-e2e*="comment"],div[class*="CommentItem"],div[class*="DivCommentItem"]');
    if(init && init.length){ this._queue.push(...init); this._lastNewAt = Date.now(); this._drainQueueSoon(); }
  }
  _drainQueueSoon(){
    if(this._processing) return;
    this._processing=true;
    const run=()=>{ __ric(async ()=>{
      const BATCH=50;
      for(let i=0;i<BATCH;i++){
        const node=this._queue.shift(); if(!node) break;
        const d=this.extract(node); if(!d) continue;
        const key=`${(d.author_username||d.author||"")}|${d.timestamp_iso||d.timestamp_text}|${(d.text||"").slice(0,180)}`;
        if(this.collectedIds.has(key)) continue;
        this.collectedIds.add(key);
        if(d.is_positive) this.positiveCount++;
        this.comments.push({
          videoUrl:location.href, videoTitle:document.title,
          author_name:d.author, author_username:d.author_username, author_profile_url:d.author_profile_url,
          comment_text:d.text, timestamp_text:d.timestamp_text, timestamp_iso:d.timestamp_iso,
          like_count:d.likes, is_reply:!!d.isReply, is_positive:!!d.is_positive, permalink:d.permalink,
          parent_author:d.parent_author||"", parent_text:d.parent_text||"",
          collectedAt:new Date().toISOString()
        });
        if (this.collectedIds.size >= Math.max(1,this.settings.maxComments)) break;
      }
      if(this._queue.length>0 && this.isCollecting && this.collectedIds.size < Math.max(1,this.settings.maxComments)) return run();
      this._processing=false;
    });};
    run();
  }

  /* extract */
  isComposerNode(node){
    if(!node) return false;
    if(node.querySelector?.('div[contenteditable],textarea,input[type="text"]')) return true;
    const txt=(node.textContent||"").toLowerCase();
    return /(add comment|add a reply|write a comment|viết bình luận|thêm trả lời|nhập bình luận|comment\.\.\.|reply\.\.\.)/i.test(txt);
  }
  extract(item){
    if(!item || this.isComposerNode(item)) return null;
    const linkEl=item.querySelector?.('[data-e2e="comment-username"] a[href*="/@"]')|| item.querySelector?.('a[href*="/@"]');
    const author_profile_url=linkEl?.href||"";
    const author_username=(linkEl?.getAttribute?.("href")||"").split("/@")[1]?.split(/[/?#]/)[0]||"";
    const displayEl=item.querySelector?.('[data-e2e="comment-nickname"]')|| item.querySelector?.('[data-e2e="comment-username"]')||linkEl;
    const author=(displayEl?.textContent||author_username||"").trim();

    let textNode=item.querySelector?.('[data-e2e="comment-content"] [data-e2e="comment-text"]')||
                 item.querySelector?.('[data-e2e="comment-text"]')||
                 item.querySelector?.('[data-e2e="comment-content"] p, [data-e2e="comment-content"] span')||
                 item.querySelector?.('p[data-e2e*="comment"]')||
                 item.querySelector?.('span[data-e2e*="comment"]')||
                 item.querySelector?.('p, span');
    let text="";
    try{
      if(textNode){
        const clone=textNode.cloneNode(true);
        clone.querySelectorAll('button,a').forEach(n=>{
          const w=(n.innerText||n.textContent||"").toLowerCase();
          if (/(translate|xem bản dịch|dịch|see translation|view translation|ver traducción|traduire|查看翻译|翻译|翻訳を見る|번역 보기)/i.test(w)) n.remove();
        });
        text=(clone.textContent||"").trim();
      }
    }catch{}
    text=this.cleanCommentText(text);
    if(!text) return null;

    const timeEl=item.querySelector?.('[data-e2e="comment-time"]')||item.querySelector?.('time');
    const rawTime=(timeEl?.getAttribute?.("datetime")||timeEl?.textContent||"").trim();
    const isoTime=this.toISODateFromRelative(rawTime)||"";

    const likeEl=item.querySelector?.('[data-e2e*="comment-like"], [data-e2e*="like-count"]')|| item.querySelector?.('button[aria-label*="Like"], button[aria-label*="Thích"]');
    const likes=this.parseNumber(likeEl?likeEl.textContent:"");
    const pl=item.querySelector?.('a[href*="comment"]'); const permalink=pl?.href||"";

    const isReply=!!item.closest?.('[data-e2e="comment-reply-item"]')||item.matches?.('[data-e2e="comment-reply-item"]');
    const is_positive=this.isPositive(text);

    let parent_author="", parent_text="";
    if(isReply){
      const root=item.closest('[data-e2e="comment-item"]')||item.parentElement;
      try{
        const ra=root?.querySelector?.('[data-e2e="comment-nickname"], [data-e2e="comment-username"]');
        parent_author=(ra?.textContent||"").trim();
        const rt=root?.querySelector?.('[data-e2e="comment-content"] [data-e2e="comment-text"], [data-e2e="comment-text"]');
        parent_text=this.cleanCommentText(rt?.textContent||"");
      }catch{}
    }

    return { author, author_username, author_profile_url, text,
      timestamp_text:rawTime, timestamp_iso:isoTime, likes, isReply,
      permalink, is_positive, parent_author, parent_text };
  }

  /* find buttons */
  _findReplyButtonsIn(root){
    const R=this.repliesRegex(), bad=/(hide|collapse|thu gọn|ẩn|接|숨|隱|隐|非表示)/i;
    const pool=root.querySelectorAll?.('button,a,div[role="button"],span,p')||[];
    const out=[];
    for(const b of pool){
      const t=this.textOf(b); if(!t) continue;
      if(bad.test(t)) continue;
      if(!R.test(t)) continue;
      const btn=b.closest('button,a,div[role="button"]')||b;
      if(this.visible(btn)) out.push(btn);
    }
    return [...new Set(out)];
  }
  _findReplyButtons(){ return this._findReplyButtonsIn(document); }
  _findLoadMoreButtons(){
    const pool=document.querySelectorAll('[data-e2e="more-comment"],[data-e2e*="more-comment"],[data-e2e*="comment-more"],[data-e2e*="browse-comment-load-more"],button,a,div[role="button"],span,p');
    const out=[];
    for(const b of pool){
      if(!(b instanceof Element)) continue;
      if(!this.visible(b)) continue;
      const txt=this.textOf(b);
      if(txt && this.loadMoreRegex().test(txt)){
        const btn=b.closest('button,a,div[role="button"]')||b;
        if(this.visible(btn)) out.push(btn);
      }
    }
    return [...new Set(out)];
  }

  /* greedy chậm rãi */
  async expandThreadFully(root){
    let guard=0;
    while(this.isCollecting && guard<50 && this.collectedIds.size < Math.max(1,this.settings.maxComments)){
      guard++;
      const btns=this._findReplyButtonsIn(root);
      if(!btns.length) break;
      const before = root.querySelectorAll?.('[data-e2e="comment-reply-item"]').length || 0;
      const b = btns[0];
      try{ b.scrollIntoView({block:"nearest"}); }catch{}
      try{ b.click(); }catch{}
      await this.sleep(this.settings.clickDelay);
      const ok = await this._waitIncrease(()=> root.querySelectorAll?.('[data-e2e="comment-reply-item"]').length || 0, this.settings.waitGrowMs);
      if (!ok || (root.querySelectorAll?.('[data-e2e="comment-reply-item"]').length||0) <= before) break;
      this._lastNewAt = Date.now();
    }
  }
  async expandAllThreadsSlow(){
    let index = 0;
    while(this.isCollecting && this.collectedIds.size < Math.max(1,this.settings.maxComments)){
      const roots = Array.from(document.querySelectorAll('[data-e2e="comment-item"]:not([data-e2e="comment-reply-item"]), div[class*="CommentItem"]:not([data-e2e="comment-reply-item"])'));
      if (!roots.length) break;
      if (index >= roots.length) index = 0;
      const r = roots[index++];
      if (!this.visible(r)) { await this._scrollIntoViewSlow(r); continue; }
      await this.expandThreadFully(r);
      await this.loadMoreTopLevelSlow();
    }
  }
  async loadMoreTopLevelSlow(){
    let stagnant=0;
    while(this.isCollecting && stagnant<2 && this.collectedIds.size < Math.max(1,this.settings.maxComments)){
      const before = this._countTopLevel();
      const btns = this._findLoadMoreButtons();
      if(!btns.length) break;
      const b = btns[0];
      try{ b.scrollIntoView({block:"nearest"}); }catch{}
      try{ b.click(); }catch{}
      await this.sleep(this.settings.clickDelay);
      const ok = await this._waitIncrease(()=> this._countTopLevel(), this.settings.waitGrowMs);
      const after = this._countTopLevel();
      if (!ok || after<=before) stagnant++; else stagnant = 0;
      this._lastNewAt = Date.now();
    }
  }

  _countTopLevel(){ try{
    return document.querySelectorAll('[data-e2e="comment-item"]:not([data-e2e="comment-reply-item"]), div[class*="CommentItem"]:not([data-e2e="comment-reply-item"])').length || 0;
  }catch{ return 0; } }
  _scrollIntoViewSlow(el){ return new Promise(res=>{ try{ el.scrollIntoView({block:"nearest"}); }catch{} setTimeout(res,this.settings.clickDelay); }); }
  _waitIncrease(counter, timeout){
    return new Promise(res=>{
      let base = Number(counter()||0);
      let done=false;
      const end=(ok)=>{ if(done) return; done=true; try{mo.disconnect();}catch{}; clearTimeout(t); res(!!ok); };
      const mo=new MutationObserver(()=>{ let cur=Number(counter()||0); if(cur>base) end(true); });
      try{ mo.observe(document.body,{childList:true,subtree:true}); }catch{}
      const t=setTimeout(()=>end(false), timeout||2000);
    });
  }

  _startSlowScroll(){
    const s = this.getScroller();
    let last=0, backoff=this.settings.scrollBackoffMs, phase=0;
    const step = (ts)=>{
      if(!this.isCollecting) return;
      if(this.collectedIds.size >= Math.max(1,this.settings.maxComments)) return;
      if (ts - last > backoff){
        const delta = this.settings.scrollStepPx * (phase%2?1:1.4);
        try{ s.scrollBy({top:delta, behavior:"smooth"}); }catch{ s.scrollTop += delta; }
        last = ts; phase++;
        const idle = Date.now()-this._lastNewAt;
        backoff = idle>1500 ? Math.min(backoff*1.25, this.settings.scrollBackoffMax) : this.settings.scrollBackoffMs;
      }
      this._scrollRAF = requestAnimationFrame(step);
    };
    this._scrollRAF = requestAnimationFrame(step);
  }

  async primeLoad(){
    const deadline = Date.now()+this.settings.primeBudgetMs;
    while(this.isCollecting && Date.now()<deadline && this.collectedIds.size < Math.max(1,this.settings.maxComments)){
      await this.forceOpenComments();
      await this.loadMoreTopLevelSlow();
      if (this._countTopLevel()>0) return;
      await this.sleep(180);
    }
  }
  _shouldStop(){
    const s = this.getScroller();
    const atBottom = s.scrollTop >= s.scrollHeight - s.clientHeight - 4;
    const noBtns = this._findReplyButtons().length===0 && this._findLoadMoreButtons().length===0;
    const idle = Date.now() - this._lastNewAt;
    return noBtns && atBottom && idle > this.settings.idleStopMs;
  }

  finish(){
    const target = Math.max(1, this.settings.maxComments);
    if (this.comments.length > target) this.comments = this.comments.slice(0, target);
    this.comments.sort((a,b)=>(b.like_count||0)-(a.like_count||0));
    this.comments.forEach((c,i)=>c.rank=i+1);
    chrome.runtime.sendMessage({action:"collectionComplete", data:this.comments});
  }

  stop(){
    this.isCollecting = false;
    try{ this._observer?.disconnect(); }catch{}
    this._observer=null; this._queue.length=0; this._processing=false;
    if (this._scrollRAF) cancelAnimationFrame(this._scrollRAF);
    this._scrollRAF = 0;
    if (this._progressTimer) clearInterval(this._progressTimer);
    this._progressTimer = 0;
  }

  async start(){
    if (this.isCollecting) return;
    this.isCollecting = true;
    this.collectedIds.clear(); this.comments.length=0; this.positiveCount=0;
    this._lastNewAt = Date.now();
    this.settings.maxComments = Math.max(1, parseInt(this.settings.maxComments||500,10));

    chrome.runtime.sendMessage({action:"collectionStarted"});

    try{
      const ok = await this.ensureCommentsPanel();
      if(!ok) throw new Error("Không mở được bảng bình luận (video có thể tắt bình luận).");

      this._panel = this.getCommentListNode() || document.body;
      this._installObserver(this._panel);

      this._progressTimer = setInterval(()=>{
        chrome.runtime.sendMessage({
          action:"updateProgress",
          data:{ current:this.collectedIds.size, total:this.settings.maxComments, positive:this.positiveCount }
        });
      }, 2000);

      await this.primeLoad();
      this._startSlowScroll();

      let stable = 0;
      while(this.isCollecting){
        if (this.collectedIds.size >= this.settings.maxComments) break;
        await this.expandAllThreadsSlow();
        await this.loadMoreTopLevelSlow();
        if (this._shouldStop()) stable++; else stable = 0;
        if (stable >= this.settings.stableRounds) break;
        await this.sleep(350);
      }

      this.finish();
    }catch(e){
      chrome.runtime.sendMessage({action:"collectionError", error:e?.message||String(e)});
    }finally{
      this.stop();
    }
  }

  init(){
    chrome.runtime.onMessage.addListener((req,_s,sendResponse)=>{
      if(req?.action==="startCollection"){ this.settings = { ...this.settings, ...(req.settings||{}) }; this.start(); sendResponse?.({ok:true}); return true; }
      if(req?.action==="stopCollection"){ this.stop(); sendResponse?.({ok:true}); return true; }
      if(req?.action==="__ping__"){ sendResponse?.({ok:true}); return true; }
    });
  }
}

/* bootstrap */
const __collector = new TikTokCommentCollector();
__collector.init();
window.TTC_start = (s)=>{ __collector.settings = { ...__collector.settings, ...s }; __collector.start(); };
window.TTC_stop  = ()=> __collector.stop();

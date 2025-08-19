// TikTok Comment Collector — DOM Strong v8
// Tập trung fix lỗi "lướt mà không lấy", "không bấm reply", "chỉ lấy được một nửa".
// Không phụ thuộc vào hook mạng. Mở sâu reply + bấm load more nhiều vòng + tránh ảo hoá.

(() => {
  if (window.TTC_ready) return; window.TTC_ready = true;

  /* ========== helpers ========== */
  const norm = s => (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ").trim();
  const txt  = n => { try{ return String((n&&(n.innerText||n.textContent||(n.getAttribute?n.getAttribute("aria-label"):"")))||"").trim(); }catch(_){ return ""; } };
  const vis  = el => { if(!el) return false; try{ const r=el.getBoundingClientRect(); return r.width>0 && r.height>0; }catch(_){ return false; } };
  const sleep= ms => new Promise(r=>setTimeout(r,ms));
  const nowISO = () => new Date().toISOString();
  const hash = s => { try{ let h=0; s=String(s); for(let i=0;i<s.length;i++) h=((h<<5)-h+s.charCodeAt(i))|0; return String(h); }catch(_){ return String(Math.random()).slice(2); } };
  const parseNum = s => { if(!s) return 0; const t=String(s).toLowerCase().replace(/\s+/g,"").replace(/,/g,"."); const k=t.includes("k"), m=t.includes("m"); const n=parseFloat(t.replace(/[^\d.]/g,"")); if(isNaN(n)) return 0; return k?Math.floor(n*1e3):(m?Math.floor(n*1e6):Math.floor(n)); };
  const toISOFromRelative = (txtRaw)=>{
    const s=String(txtRaw||"").toLowerCase().trim(), now=new Date();
    const apply=(u,n)=>{const d=new Date(now),v=+n||0; ({s:()=>d.setSeconds(d.getSeconds()-v),m:()=>d.setMinutes(d.getMinutes()-v),h:()=>d.setHours(d.getHours()-v),d:()=>d.setDate(d.getDate()-v),w:()=>d.setDate(d.getDate()-7*v),mo:()=>d.setMonth(d.getMonth()-v),y:()=>d.setFullYear(d.getFullYear()-v)}[u]||(()=>{}))(); return d.toISOString(); };
    let m=s.match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|w|mo|y)\b/); if(m){const mp={sec:"s",secs:"s",min:"m",mins:"m",hr:"h",hrs:"h"}; return apply(mp[m[2]]||m[2],m[1]);}
    m=s.match(/^(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago/); if(m){const u=m[2][0]; return apply(u==="o"?"mo":({s:"s",m:"m",h:"h",d:"d",w:"w",y:"y"}[u]||"d"),m[1]);}
    m=s.match(/^(\d+)\s*(giay|giây|phut|phút|gio|giờ|ngay|ngày|tuan|tuần|thang|tháng|nam|năm)/); if(m){const mp={giay:"s",phut:"m",gio:"h",ngay:"d",tuan:"w",thang:"mo",nam:"y"}; return apply(mp[norm(m[2])]||"d",m[1]);}
    const d=new Date(s); return isNaN(d)?"":d.toISOString();
  };
  const isPositive = (text) => {
    const raw=text||"", t=norm(raw);
    if(/[😄😆😂🤣😊🙂😍🥰😘❤️💖💗💕👍👏🔥✨🌟💯]/.test(raw)) return true;
    const good=["tuyet","tuyet voi","qua da","de thuong","cute","xinh","dep","xuat sac","hay","rat hay","cam on","thanks","good","great","awesome","amazing","nice","cool","love","best"];
    return good.some(w=>t.includes(w)) && !/(khong|ko|k|chang|cha)\s+(hay|tuyet|tot|dep|yeu|good|great|nice|love|amazing|awesome|cool)/.test(t);
  };

  function q(root, sel){ try{ return (root||document).querySelector(sel); }catch(_){ return null; } }
  function qa(root, sel){ try{ return Array.from((root||document).querySelectorAll(sel)); }catch(_){ return []; } }

  /* ========== Collector ========== */
  class Collector {
    constructor(){
      this.isCollecting=false;
      this.items=[];
      this.positiveCount=0;
      this.ids=new Set();
      this._scroller=null;
      this._mo=null;

      this.settings={
        maxComments: 500,
        waitGrowMs: 2200,
        stepRatio: 0.92,
        primeBudgetMs: 35000,
        openBudgetMs: 25000,
        stallLimit: 18
      };
    }

    uniqKeyOf(r){
      return [
        r.author_username || r.author_name || "",
        r.timestamp_iso || r.timestamp_text || "",
        hash(r.comment_text || "")
      ].join("|");
    }
    push(r){
      const key=this.uniqKeyOf(r);
      if(this.ids.has(key)) return false;
      this.ids.add(key);
      if (r.is_positive) this.positiveCount++;
      this.items.push(r);
      return true;
    }

    /* ---------- panel / scroller ---------- */
    getCommentListNode(){
      return q(document,'[data-e2e="comment-list"]') ||
             q(document,'ul[data-e2e="comment-list"]') ||
             q(document,'[role="list"][data-e2e*="comment"]') ||
             q(document,'div[class*="CommentList"],div[class*="CommentsContainer"],div[class*="CommentScroll"]');
    }
    openButtons(){
      const sels=['[data-e2e="browse-comment-icon"]','[data-e2e="detail-comment-icon"]','[data-e2e="comment-icon"]','[data-e2e="comment-button"]','button[aria-label*="comment" i]','[aria-label*="bình luận" i]'];
      const a=sels.flatMap(s=>qa(document,s));
      const b=qa(document,'button,a,div[role="button"]').filter(b=>/(comment|bình luận)/i.test(txt(b)));
      return Array.from(new Set([...a,...b])).filter(vis);
    }
    composerInputs(){
      return [].concat(
        qa(document,'div[contenteditable][data-e2e*="comment"]'),
        qa(document,'div[contenteditable]'),
        qa(document,'textarea[placeholder*="comment" i]')
      );
    }
    strongClick(el){ if(!el) return; try{ el.scrollIntoView({block:"center",inline:"center"});}catch(_){}
      try{ el.click(); }catch(_){}
      try{ el.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true})); el.dispatchEvent(new PointerEvent("pointerup",{bubbles:true})); }catch(_){}
    }
    async forceOpenComments(){
      this.openButtons().forEach(b=>this.strongClick(b));
      this.composerInputs().forEach(i=>{ if(vis(i)){ try{i.focus();}catch(_e){} this.strongClick(i);} });
      await sleep(200);
    }
    findScrollableParent(el){
      let n=el; try{ while(n && n!==document.body){ const st=getComputedStyle(n); if((st.overflowY==="auto"||st.overflowY==="scroll") && n.scrollHeight>n.clientHeight) return n; n=n.parentElement; }}catch(_){}
      return document.scrollingElement||document.documentElement;
    }
    _calcScroller(){
      const list=this.getCommentListNode(); if(list){ const p=this.findScrollableParent(list); if(p) return p; }
      const add=this.composerInputs()[0]; if(add){ const p=this.findScrollableParent(add); if(p) return p; }
      return document.scrollingElement||document.documentElement;
    }
    getScroller(){ if(!this._scroller || !document.contains(this._scroller)) this._scroller=this._calcScroller(); return this._scroller; }
    async forceBottom(){ const s=this.getScroller(); for(let i=0;i<4;i++){ try{s.scrollTop=s.scrollHeight;}catch(_){ } await sleep(80);} }
    async sweepDown(){ const s=this.getScroller(), step=Math.max(120,Math.floor(s.clientHeight*this.settings.stepRatio)); const target=s.scrollHeight-s.clientHeight;
      while(this.isCollecting && s.scrollTop<target-4){ s.scrollTop=Math.min(s.scrollTop+step,target); await sleep(45);} }

    /* ---------- buttons ---------- */
    loadMoreRegex(){ return /(more\s+comments|view\s+more|load\s+more|see\s+more|show\s+more|xem\s+thêm|thêm\s+bình\s+luận|hiển\s*thị\s*thêm|更多评论|查看更多|更多|さらに表示|もっと見る|더보기)/i; }
    repliesRegex(){ return new RegExp([
      String.raw`(?:\b(view|show|see)\s*\d*\s*repl(?:y|ies)\b)`,
      String.raw`(?:xem\s*(\d+)?\s*(phản\s*hồi|trả\s*lời))`,
      String.raw`(?:xem\s*thêm\s*(phản\s*hồi|trả\s*lời))`,
      `查看回复|更多回复|显示回复|全部回复|回复\\s*\\d+`,
      `返信を表示|さらに返信を表示`,
      `댓글\\s*더보기|답글\\s*보기|더\\s*많은\\s*답글`
    ].join("|"),"i"); }

    replyButtons(area=document){
      const R=this.repliesRegex(); const bad=/\b(hide|collapse|thu gọn|ẩn|접기|숨기기|隱藏|隐藏|非表示)\b/i;
      let nodes=[].concat(
        qa(area,'[data-e2e*="view-replies"], [data-e2e*="reply"] button, [data-e2e*="reply"] a, [aria-controls*="reply"], button[aria-expanded="false"]'),
        qa(area,'button,a,div[role="button"],span')
      ).map(n=>n?.closest?.('button,a,div[role="button"]')||n)
       .filter(el=>vis(el))
       .filter(el=>{
          const label=((el.getAttribute?.('aria-label')||"")+" "+txt(el)).trim();
          if(!label){
            const ok=(el.hasAttribute?.('aria-expanded')||el.hasAttribute?.('aria-controls'));
            const near=el.closest?.('[data-e2e*="comment"]')||el.closest?.('li,div');
            return !!(ok && near);
          }
          if(bad.test(label)) return false;
          return R.test(label) || /repl(y|ies)|trả\s*lời|phản\s*hồi/i.test(label);
       });
      nodes = Array.from(new Set(nodes));
      return nodes;
    }
    moreButtons(){
      const sel='[data-e2e="more-comment"],[data-e2e*="more-comment"],[data-e2e*="comment-more"],[data-e2e*="browse-comment-load-more"]';
      const dom=qa(document,sel);
      const byT=qa(document,'button,a,div[role="button"],span,p').filter(b=>this.loadMoreRegex().test(txt(b)));
      return Array.from(new Set([...dom,...byT])).filter(vis);
    }

    /* ---------- grab items ---------- */
    commentItems(){
      const bag=new Set();
      const add=n=>{ if(n) bag.add(n); };
      qa(document,'[data-e2e="comment-item"],[data-e2e="comment-reply-item"]').forEach(add);
      qa(document,'[role="listitem"][data-e2e*="comment"]').forEach(add);
      qa(document,'div[class*="CommentItem"],div[class*="DivCommentItem"]').forEach(add);
      // fallback khi ảo hoá: dựa vào text nodes rồi leo lên
      qa(document,'[data-e2e="comment-text"], p[data-e2e*="comment"], span[data-e2e*="comment"], span[dir], div[dir]').forEach(el=>{
        const t = txt(el).toLowerCase();
        if(/(see translation|view translation|xem bản dịch|dịch|ver traducción|traduire|翻译|번역)/i.test(t)) return;
        const item = el.closest?.('[data-e2e="comment-item"],[data-e2e="comment-reply-item"],[role="listitem"][data-e2e*="comment"],li,div[class*="CommentItem"],div[class*="DivCommentItem"]');
        if(item) add(item);
      });
      return Array.from(bag);
    }

    extract(item){
      if(!item) return null;

      const linkEl = q(item,'[data-e2e="comment-username"] a[href*="/@"]') || q(item,'a[href*="/@"]');
      const author_profile_url = linkEl ? (linkEl.href || "") : "";
      const href = linkEl ? (linkEl.getAttribute ? linkEl.getAttribute("href") : "") : "";
      const author_username = href ? ((href.split("/@")[1] || "").split(/[/?#]/)[0]) : "";

      const displayEl = q(item,'[data-e2e="comment-nickname"]') || q(item,'[data-e2e="comment-username"]') || linkEl;
      const author = txt(displayEl) || author_username || "";

      let textNode =
        q(item,'[data-e2e="comment-content"] [data-e2e="comment-text"]') ||
        q(item,'[data-e2e="comment-text"]') ||
        q(item,'[data-e2e="comment-content"] p, [data-e2e="comment-content"] span') ||
        q(item,'p[data-e2e*="comment"], span[data-e2e*="comment"]') ||
        q(item,'span[dir], div[dir]') ||
        q(item,'p, span, div');

      let text = "";
      if(textNode){
        try{
          const clone = textNode.cloneNode(true);
          clone.querySelectorAll('button,a').forEach(n=>{
            const w=(n.innerText||n.textContent||"").toLowerCase();
            if(/(translate|xem bản dịch|dịch|see translation|view translation|ver traducción|traduire|查看翻译|翻译|翻訳を見る|번역 보기)/i.test(w)){
              n.remove();
            }
          });
          text = String(clone.textContent||"").trim();
        }catch(_){ text = String(textNode.textContent||"").trim(); }
      }
      if(!text){
        const aria = item.getAttribute?.('aria-label') || "";
        if(aria) text = aria.trim();
      }
      if(!text) return null;

      const timeEl = q(item,'[data-e2e="comment-time"]') || q(item,'time');
      const rawTime = timeEl ? ( (timeEl.getAttribute ? timeEl.getAttribute("datetime") : "") || (timeEl.textContent || "") ) : "";
      const isoTime = toISOFromRelative(rawTime) || "";

      let likeTxt = "";
      const likeEl = q(item,'[data-e2e*="comment-like"], [data-e2e*="like-count"], button[aria-label*="Like"], button[aria-label*="Thích"], [aria-label*="Like"]');
      if(likeEl){
        likeTxt = (likeEl.getAttribute?.("aria-label")||"") + " " + (likeEl.textContent||"");
      }
      const likes = parseNum(likeTxt);

      const pl = q(item,'a[href*="comment"]');
      const permalink = pl ? (pl.href || "") : "";

      const isReply = !!((item.matches && item.matches('[data-e2e="comment-reply-item"]')) ||
                         (item.closest && item.closest('[data-e2e="comment-reply-item"]')));

      return {
        videoUrl: location.href,
        videoTitle: document.title,
        author_name: author,
        author_username,
        author_profile_url,
        comment_text: text,
        timestamp_text: rawTime,
        timestamp_iso: isoTime,
        like_count: likes,
        is_reply: !!isReply,
        is_positive: isPositive(text),
        permalink,
        parent_author: "",
        parent_text: "",
        collectedAt: nowISO()
      };
    }

    /* ---------- actions ---------- */
    async clickAllMore(loop=6){
      for(let i=0;i<loop;i++){
        const btns=this.moreButtons(); if(!btns.length) break;
        btns.slice(0,20).forEach(b=>this.strongClick(b));
        await sleep(this.settings.waitGrowMs);
      }
    }
    async openRepliesDeep(maxPass=10){
      for(let pass=0; pass<maxPass && this.isCollecting; pass++){
        const btns=this.replyButtons();
        if(!btns.length) break;
        btns.slice(0,80).forEach(b=>this.strongClick(b));
        await sleep(this.settings.waitGrowMs);
      }
    }

    /* ---------- main loop ---------- */
    async start(){
      if(this.isCollecting) return;
      this.isCollecting=true; this.items.length=0; this.ids.clear(); this.positiveCount=0;

      chrome.runtime.sendMessage({ action:"collectionStarted" });

      try{
        // mở panel để lộ list
        const ddl = Date.now()+this.settings.openBudgetMs;
        while(Date.now()<ddl && this.isCollecting){
          await this.forceOpenComments();
          if (this.getCommentListNode()) break;
          await this.forceBottom(); await this.sweepDown();
        }

        // quan sát DOM biến đổi → dùng để detect "đang lớn lên"
        try{
          this._mo && this._mo.disconnect();
          this._mo = new MutationObserver(()=>{});
          this._mo.observe(document.body, {childList:true, subtree:true});
        }catch(_){}

        let stalls=0;
        while(this.isCollecting && this.ids.size < this.settings.maxComments){
          const before=this.ids.size;

          // 1) bấm "xem thêm" + "xem phản hồi"
          await this.clickAllMore(6);
          await this.openRepliesDeep(8);

          // 2) gom dữ liệu hiện có
          const items=this.commentItems();
          for(const it of items){
            const d=this.extract(it);
            if(!d) continue;
            this.push(d);
            if(this.ids.size >= this.settings.maxComments) break;
          }

          // 3) kéo xuống để tải thêm (chống ảo hoá)
          await this.forceBottom();
          await this.sweepDown();
          await sleep(this.settings.waitGrowMs);

          const after=this.ids.size;
          stalls = (after===before) ? (stalls+1) : 0;

          chrome.runtime.sendMessage({ action:"updateProgress",
            data:{ current:this.ids.size, total:this.settings.maxComments, positive:this.positiveCount } });

          if (this.ids.size >= this.settings.maxComments) break;
          if (stalls >= this.settings.stallLimit) break;
        }

        // hoàn tất
        this.items.sort((a,b)=>(b.like_count||0)-(a.like_count||0));
        for(let i=0;i<this.items.length;i++) this.items[i].rank=i+1;
        chrome.runtime.sendMessage({ action:"collectionComplete", data:this.items });

      }catch(e){
        chrome.runtime.sendMessage({ action:"collectionError", error: e?.message || String(e) });
      }finally{
        this.isCollecting=false;
        try{ this._mo && this._mo.disconnect(); }catch(_){}
      }
    }

    stop(){ this.isCollecting=false; try{ this._mo && this._mo.disconnect(); }catch(_){} }
  }

  // bootstrap
  const __collector = new Collector();
  window.TTC_start = (s)=>{ __collector.settings = Object.assign({}, __collector.settings, s||{}); __collector.start(); };
  window.TTC_stop  = ()=>{ __collector.stop(); };
})();

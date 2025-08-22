// popup.js — POPUP v1.7
// - Chỉ xuất Excel (.xls) với bảng CHI TIẾT
// - Giữ auto-stop khi kẹt (90s) + làm sạch "(idle_end)"
// - Không cần thêm thư viện; Excel mở bình thường

(() => {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const btnToggle   = $('#btnToggle');
  const elStatusBox = $('.status');
  const elStatusTxt = $('.status .text') || elStatusBox;
  const elProgFill  = $('#progressFill');
  const elCountAll  = $('#countTotal')    || $$('.stat-number')[0];
  const elCountPos  = $('#countPositive') || $$('.stat-number')[1];
  const elMax       = $('#inputMax')      || $('input[type="number"]');
  const elSpeed     = $('#selectSpeed')   || $('select');
  const elAutoRetry = $('#autoRetry')     || $('input[type="checkbox"]');

  const LABELS = { start:'🚀 Bắt đầu thu thập', stop:'■ Dừng', restart:'↻ Làm lại' };

  // Watchdog (gợi ý kẹt & tự dừng mềm)
  const STALL_HINT_MS = 12_000;
  const AUTO_STOP_MS  = 90_000;

  let activeTabId=null, RUNNING=false, BUSY=false;
  let target=0, lastUpdate=0, stallTimer=null;
  let lastData=[], currentVideoUrl='';

  // ===== UI helpers
  const clean = (s='') => String(s)
    .replace(/\s*\([^)]*idle_end[^)]*\)\s*/i,' ')
    .replace(/\s{2,}/g,' ')
    .trim();
  const setText = (el, t) => { if (el) el.textContent = String(t ?? ''); };
  const setStatus = (msg, tone='info') => {
    if (!elStatusBox) return;
    elStatusBox.classList.remove('success','error','collecting');
    if (tone==='success') elStatusBox.classList.add('success');
    else if (tone==='error') elStatusBox.classList.add('error');
    else if (tone==='collecting') elStatusBox.classList.add('collecting');
    setText(elStatusTxt, clean(msg));
  };
  const setProgress = (n,tgt)=>{ if(!elProgFill) return; elProgFill.style.width = (tgt>0?Math.min(100,Math.round(n/tgt*100)):0) + '%'; };
  const setBtn = (m)=>{ if(!btnToggle) return; btnToggle.classList.remove('btn-primary','btn-stop');
    if(m==='stop'){ RUNNING=true; btnToggle.classList.add('btn-stop'); btnToggle.textContent=LABELS.stop; btnToggle.disabled=false; }
    else if(m==='restart'){ RUNNING=false; btnToggle.classList.add('btn-primary'); btnToggle.textContent=LABELS.restart; btnToggle.disabled=false; }
    else { RUNNING=false; btnToggle.classList.add('btn-primary'); btnToggle.textContent=LABELS.start; btnToggle.disabled=false; }
  };

  // ===== Export UI: 1 nút Excel
  let exportBox=null, btnExcel=null;
  function ensureExportUI(){
    if (exportBox) return;
    exportBox=document.createElement('div');
    exportBox.className='controls hidden';
    exportBox.innerHTML=`<button id="btnExportXLS" class="btn btn-success">⬇️ Tải Excel (.xls)</button>`;
    const stats=document.querySelector('.stats');
    (stats?.parentNode||document.body).insertBefore(exportBox, stats?.nextSibling||null);
    btnExcel=exportBox.querySelector('#btnExportXLS');
    btnExcel?.addEventListener('click',e=>{
      e.preventDefault();
      if(lastData.length) downloadExcel(lastData, currentVideoUrl);
    });
  }
  function showExport(b){ ensureExportUI(); exportBox?.classList.toggle('hidden', !b); }

  // ===== Excel helpers (HTML Spreadsheet)
  const tsFile=()=>{ const d=new Date(),p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
  function blob(data,mime,name){ const u=URL.createObjectURL(new Blob([data],{type:mime})); const a=document.createElement('a'); a.href=u; a.download=name; document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(u); a.remove();},100);}
  const escHTML = (s='') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Convert likes "1.2K" -> 1200
  function likesToNumber(raw){
    const s = String(raw||'').trim();
    const m = s.match(/^([\d.,]+)\s*([kKmMbB]?)/);
    if(!m){ const n = Number(s.replace(/[^\d]/g,'')); return Number.isFinite(n)?n:0; }
    let num = parseFloat(m[1].replace(',','.'));
    const unit = (m[2]||'').toLowerCase();
    const mult = unit==='k'?1e3:unit==='m'?1e6:unit==='b'?1e9:1;
    return Math.round(num*mult);
  }
  // Parse time
  function toISO(raw){
    const t=String(raw||'').trim();
    if(/^\d{13}$/.test(t)) return new Date(Number(t)).toISOString();
    if(/^\d{10}$/.test(t)) return new Date(Number(t)*1000).toISOString();
    const d=new Date(t); return isNaN(d.getTime())?'':d.toISOString();
  }

  function buildRows(data, videoUrl){
    return data.map((r,i)=>({
      idx: i+1,
      videoUrl: videoUrl||'',
      id: r.id,
      parentId: r.parentId||'',
      level: r.parentId ? 'reply' : 'root',
      author: r.author||'',
      text: r.text||'',
      likesRaw: r.likes||'',
      likesNum: likesToNumber(r.likes||''),
      timeRaw: r.time||'',
      timeISO: toISO(r.time||''),
      positive: r.positive ? 'Tích cực' : 'Khác',
      collectedAt: r.collectedAt||''
    }));
  }

  function toExcelHTML(rows){
    const headers = ['#','Video URL','ID','Parent ID','Cấp','Tác giả','Nội dung','Likes (thô)','Likes (số)','Thời gian (thô)','Thời gian ISO','Tích cực','Thu thập lúc'];
    const keys    = ['idx','videoUrl','id','parentId','level','author','text','likesRaw','likesNum','timeRaw','timeISO','positive','collectedAt'];
    let html = `<!doctype html><html><head><meta charset="utf-8"></head><body><table border="1"><thead><tr>`;
    html += headers.map(h=>`<th>${escHTML(h)}</th>`).join('');
    html += `</tr></thead><tbody>`;
    for(const r of rows){
      html += '<tr>' + keys.map(k=>`<td>${escHTML(r[k] ?? '')}</td>`).join('') + '</tr>';
    }
    html += `</tbody></table></body></html>`;
    return html;
  }

  function downloadExcel(data, videoUrl){
    const rows = buildRows(data, videoUrl);
    const html = toExcelHTML(rows);
    blob(html,'application/vnd.ms-excel;charset=utf-8',`tiktok_comments_${tsFile()}.xls`);
  }

  // ===== Chrome wrappers
  function getActiveTab(cb){ try{ chrome.tabs.query({active:true,currentWindow:true},(tabs)=>{ const err=chrome.runtime.lastError; if(err) return cb(null,err); cb(tabs?.[0]||null,null); }); }catch(e){ cb(null,e);} }
  function sendToContent(msg,cb){ if(!activeTabId) return cb?.(null,new Error('no tab')); try{ chrome.tabs.sendMessage(activeTabId,msg,(resp)=>{ const err=chrome.runtime.lastError; if(err) return cb?.(null,err); cb?.(resp||null,null); }); }catch(e){ cb?.(null,e);} }
  function injectAllFrames(cb){ try{ chrome.scripting.executeScript({target:{tabId:activeTabId,allFrames:true},files:['content.js']},()=>{ const err=chrome.runtime.lastError; if(err) return cb?.(false,err); setTimeout(()=>cb?.(true,null),300); }); }catch(e){ cb?.(false,e);} }

  async function loadSettings(){ try{ const {tca_settings={}}=await chrome.storage.local.get('tca_settings'); const {max=100,speed='fast',autoRetry=true}=tca_settings; elMax&&(elMax.value=max); elSpeed&&(elSpeed.value=speed); elAutoRetry&&(elAutoRetry.checked=!!autoRetry);}catch{} }
  async function saveSettings(){ const max=Number(elMax?.value||0)||0; const speed=String(elSpeed?.value||'fast').toLowerCase(); const autoRetry=!!(elAutoRetry?.checked); try{ await chrome.storage.local.set({tca_settings:{max,speed,autoRetry}});}catch{} return {max,speed,autoRetry}; }

  // ===== Watchdog (gợi ý + auto-stop)
  function startStallWatch(){
    clearInterval(stallTimer);
    stallTimer=setInterval(()=>{
      const gap=Date.now()-lastUpdate;
      if(gap>STALL_HINT_MS) setStatus(`⏳ Kẹt ${Math.floor(gap/1000)}s → đang thử lại...`,'collecting');
      if(RUNNING && gap>AUTO_STOP_MS){
        // tự dừng mềm + gom data cho export
        sendToContent({type:'TTC_GET_DATA'},(resp)=>{ if(resp?.ok && Array.isArray(resp.data)) lastData=resp.data; });
        sendToContent({type:'TTC_STOP'},()=>{});
        RUNNING=false; setBtn('restart'); setStatus(`ℹ️ Tự dừng do kẹt lâu. Thu được ${elCountAll?.textContent||'0'} dòng.`,'info');
        showExport(!!lastData.length);
        clearInterval(stallTimer);
      }
    },1000);
  }
  function stopStallWatch(){ clearInterval(stallTimer); stallTimer=null; }

  // ===== Start/Stop
  function startFlow(){
    if(!btnToggle||BUSY) return;
    BUSY=true; btnToggle.disabled=true;
    setBtn('stop'); setStatus('🔎 Đang khởi động...','collecting');
    setProgress(0, Number(elMax?.value||0)); showExport(false); lastData=[];

    getActiveTab(async (tab,err)=>{
      if(err||!tab){ BUSY=false; setBtn('start'); return setStatus('❌ Không lấy được tab hiện tại.','error'); }
      activeTabId=tab.id;
      currentVideoUrl = tab.url || '';
      if(!/:\/\/(www\.|m\.)?tiktok\.com\//i.test(currentVideoUrl)){ BUSY=false; setBtn('start'); return setStatus('⚠️ Hãy mở một trang video TikTok rồi thử lại.','error'); }

      const {max,speed,autoRetry}=await saveSettings();
      target=max; lastUpdate=Date.now(); startStallWatch();
      setText(elCountAll,'0'); setText(elCountPos,'0');

      const doStart=()=> sendToContent({type:'TTC_START',target:max,speed,autoRetry,debug:true},()=>{ BUSY=false; setBtn('stop'); setStatus('🚀 Đang thu thập...','collecting'); });

      sendToContent({type:'TTC_PING'},(resp)=>{
        if(resp&&resp.ready) return doStart();
        injectAllFrames((ok)=>{
          if(!ok){ BUSY=false; setBtn('start'); return setStatus('❌ Không thể nạp content.js.','error'); }
          sendToContent({type:'TTC_PING'},(resp2)=>{ if(!(resp2&&resp2.ready)){ BUSY=false; setBtn('start'); return setStatus('❌ Content chưa sẵn sàng.','error'); } doStart(); });
        });
      });
    });
  }

  function stopFlow(){
    if(BUSY) return; BUSY=true; btnToggle&&(btnToggle.disabled=true);
    sendToContent({type:'TTC_STOP'},()=>{ BUSY=false; stopStallWatch(); setBtn('start'); setStatus('■ Dừng','info'); });
  }
  const onToggle=()=> (RUNNING?stopFlow():startFlow());

  // ===== Listen from content
  chrome.runtime.onMessage.addListener((msg)=>{
    if(!msg||!msg.type) return;
    if(msg.type==='TTC_PROGRESS'){
      const {total=0,target:tg=0,positive}=msg.payload||{};
      lastUpdate = Date.now();
      if(!RUNNING) setBtn('stop');
      if(tg&&!target) target=tg;
      setProgress(total, target||tg);
      setText(elCountAll, String(total));
      if(elCountPos && positive!=null) setText(elCountPos, String(positive));
      setStatus('🚀 Đang thu thập...','collecting');
    }
    if(msg.type==='TTC_DONE'){
      const {total=0,positive}=msg.payload||{};
      stopStallWatch();
      setProgress(total, target);
      setText(elCountAll, String(total));
      if(elCountPos && positive!=null) setText(elCountPos, String(positive));
      setBtn('restart');
      setStatus(`ℹ️ Kết thúc. Thu được ${total} dòng.`,'info');

      // gom data để export Excel
      sendToContent({type:'TTC_GET_DATA'},(resp)=>{
        if(resp?.ok && Array.isArray(resp.data)){
          lastData=resp.data; showExport(true);
        }
      });
    }
  });

  // ===== Init
  document.addEventListener('DOMContentLoaded', async ()=>{
    await loadSettings();
    btnToggle?.addEventListener('click',(e)=>{ e.preventDefault(); onToggle(); },{passive:false});
    setBtn('start');
    setStatus('Hãy mở 1 trang video TikTok rồi bấm “Bắt đầu thu thập”.');
    showExport(false);
  });
})();

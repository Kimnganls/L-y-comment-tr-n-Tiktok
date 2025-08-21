// popup.js — 1 nút 3 trạng thái: Bắt đầu ↔ Dừng ↔ Làm lại
(() => {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // UI
  const btnToggle   = $('#btnToggle');
  const elStatusBox = $('.status');
  const elStatusTxt = $('.status .text') || elStatusBox;
  const elProgFill  = $('#progressFill');
  const elCountAll  = $('#countTotal')    || $$('.stat-number')[0];
  const elCountPos  = $('#countPositive') || $$('.stat-number')[1];
  const elMax       = $('#inputMax')      || $('input[type="number"]');
  const elSpeed     = $('#selectSpeed')   || $('select');
  const elAutoRetry = $('#autoRetry')     || $('input[type="checkbox"]');

  // Labels
  const LABEL_START   = '🚀 Bắt đầu thu thập';
  const LABEL_STOP    = '■ Dừng';
  const LABEL_RESTART = '↻ Làm lại';

  // State
  let activeTabId = null, RUNNING = false, BUSY = false;
  let target = 0, lastUpdate = 0, stallTimer = null;

  // ---- UI helpers
  const setText = (el, t) => { if (el) el.textContent = String(t ?? ''); };
  const setStatus = (msg, tone = 'info') => {
    if (!elStatusBox) return;
    elStatusBox.classList.remove('success','error','collecting');
    if (tone === 'success') elStatusBox.classList.add('success');
    else if (tone === 'error') elStatusBox.classList.add('error');
    else if (tone === 'collecting') elStatusBox.classList.add('collecting');
    setText(elStatusTxt, msg);
  };
  const setProgress = (n, tgt) => {
    if (!elProgFill) return;
    const pct = tgt > 0 ? Math.min(100, Math.round((n / tgt) * 100)) : 0;
    elProgFill.style.width = pct + '%';
  };
  const setBtnMode = (mode/* 'start'|'stop'|'restart' */) => {
    if (!btnToggle) return;
    btnToggle.classList.remove('btn-primary','btn-stop');
    if (mode === 'stop') {
      RUNNING = true;
      btnToggle.classList.add('btn-stop');
      btnToggle.textContent = LABEL_STOP;
      btnToggle.disabled = false;
    } else if (mode === 'restart') {
      RUNNING = false;
      btnToggle.classList.add('btn-primary');
      btnToggle.textContent = LABEL_RESTART;
      btnToggle.disabled = false;
    } else {
      RUNNING = false;
      btnToggle.classList.add('btn-primary');
      btnToggle.textContent = LABEL_START;
      btnToggle.disabled = false;
    }
  };

  // chống overlay chặn click
  (function antiOverlayCSS(){
    const st = document.createElement('style');
    st.textContent = `
      .container::before, .container::after,
      .controls::before, .controls::after { pointer-events:none !important; z-index:0 !important; }
      .controls, .btn, .btn * { position:relative; z-index:10 !important; pointer-events:auto !important; }
    `;
    document.head.appendChild(st);
  })();

  // ---- Chrome wrappers
  function getActiveTab(cb) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const err = chrome.runtime.lastError;
        if (err) return cb(null, err);
        cb(tabs?.[0] || null, null);
      });
    } catch (e) { cb(null, e); }
  }
  function sendToContent(msg, cb) {
    if (!activeTabId) return cb?.(null, new Error('no tab'));
    try {
      chrome.tabs.sendMessage(activeTabId, msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return cb?.(null, err);
        cb?.(resp || null, null);
      });
    } catch (e) { cb?.(null, e); }
  }
  function injectContentAllFrames(cb) {
    try {
      chrome.scripting.executeScript(
        { target: { tabId: activeTabId, allFrames: true }, files: ['content.js'] },
        () => {
          const err = chrome.runtime.lastError;
          if (err) return cb?.(false, err);
          setTimeout(() => cb?.(true, null), 300); // chờ listener content.js
        }
      );
    } catch (e) { cb?.(false, e); }
  }

  // ---- Settings
  async function loadSettings() {
    try {
      const { tca_settings = {} } = await chrome.storage.local.get('tca_settings');
      const { max = 100, speed = 'fast', autoRetry = true } = tca_settings;
      if (elMax) elMax.value = max;
      if (elSpeed) elSpeed.value = speed;
      if (elAutoRetry) elAutoRetry.checked = !!autoRetry;
    } catch {}
  }
  async function saveSettings() {
    const max = Number(elMax?.value || 0) || 0;
    const speed = String(elSpeed?.value || 'fast').toLowerCase();
    const autoRetry = !!(elAutoRetry?.checked);
    try { await chrome.storage.local.set({ tca_settings: { max, speed, autoRetry } }); } catch {}
    return { max, speed, autoRetry };
  }

  // ---- Watchdog
  function startStallWatch() {
    clearInterval(stallTimer);
    stallTimer = setInterval(() => {
      const gap = Date.now() - lastUpdate;
      if (gap > 12000) setStatus(`⏳ Kẹt ${Math.floor(gap/1000)}s → đang thử lại...`, 'collecting');
    }, 1000);
  }
  function stopStallWatch() { clearInterval(stallTimer); stallTimer = null; }

  // ---- Start/Stop flows
  function startFlow() {
    if (!btnToggle || BUSY) return;
    BUSY = true; btnToggle.disabled = true;
    setBtnMode('stop');
    setStatus('🔎 Đang khởi động...', 'collecting');
    setProgress(0, Number(elMax?.value || 0));

    getActiveTab(async (tab, err) => {
      if (err || !tab) {
        BUSY = false; setBtnMode('start');
        return setStatus('❌ Không lấy được tab hiện tại. Cần quyền "tabs".', 'error');
      }
      activeTabId = tab.id;

      const isTikTok = /:\/\/(www\.|m\.)?tiktok\.com\//i.test(tab.url || '');
      if (!isTikTok) {
        BUSY = false; setBtnMode('start');
        return setStatus('⚠️ Hãy mở một trang video TikTok rồi thử lại.', 'error');
      }

      const { max, speed, autoRetry } = await saveSettings();
      target = max; lastUpdate = Date.now(); startStallWatch();
      setText(elCountAll, '0'); setText(elCountPos, '0');

      const doStart = () => {
        sendToContent({ type:'TTC_START', target:max, speed, autoRetry, debug:true }, () => {
          BUSY = false; setBtnMode('stop');
          setStatus('🚀 Đang thu thập...', 'collecting');
        });
      };

      // Ping → inject nếu cần
      sendToContent({ type: 'TTC_PING' }, (resp) => {
        if (resp && resp.ready) return doStart();
        injectContentAllFrames((ok) => {
          if (!ok) { BUSY = false; setBtnMode('start');
            return setStatus('❌ Không thể nạp content.js (thiếu "scripting"/"host_permissions"?).', 'error'); }
          sendToContent({ type: 'TTC_PING' }, (resp2) => {
            if (!(resp2 && resp2.ready)) { BUSY = false; setBtnMode('start');
              return setStatus('❌ Content chưa sẵn sàng sau khi inject.', 'error'); }
            doStart();
          });
        });
      });
    });
  }

  function stopFlow() {
    if (BUSY) return;
    BUSY = true; btnToggle && (btnToggle.disabled = true);
    sendToContent({ type:'TTC_STOP' }, () => {
      BUSY = false;
      stopStallWatch();
      setBtnMode('start'); // nếu content gửi DONE sẽ đổi sang 'restart'
      setStatus('■ Dừng', 'info');
    });
  }

  const onToggle = () => (RUNNING ? stopFlow() : startFlow());

  // ---- Listen from content.js
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'TTC_PROGRESS') {
      const { total = 0, target: tg = 0 } = msg.payload || {};
      lastUpdate = Date.now();
      if (!RUNNING) setBtnMode('stop');
      if (tg && !target) target = tg;
      setProgress(total, target || tg);
      setText(elCountAll, String(total));
      if (elCountPos && msg.payload?.positive != null) setText(elCountPos, String(msg.payload.positive));
      setStatus('🚀 Đang thu thập...', 'collecting');
    }
    if (msg.type === 'TTC_DONE') {
      const { total = 0, reason = 'done' } = msg.payload || {};
      stopStallWatch();
      setProgress(total, target);
      setText(elCountAll, String(total));
      // Sau khi xong: chuyển nút thành "↻ Làm lại"
      setBtnMode('restart');
      if (reason === 'target_reached') setStatus(`✅ Hoàn thành! Thu được ${total} dòng.`, 'success');
      else if (reason === 'manual_stop') setStatus('■ Đã dừng theo yêu cầu.', 'info');
      else setStatus(`ℹ️ Kết thúc (${reason}). Thu được ${total} dòng.`, 'info');
    }
  });

  // ---- Init
  document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    btnToggle?.addEventListener('click', (e) => { e.preventDefault(); onToggle(); }, { passive:false });
    setBtnMode('start'); // ban đầu: Bắt đầu
    setStatus('Hãy mở 1 trang video TikTok rồi bấm “Bắt đầu thu thập”.');
  });
})();

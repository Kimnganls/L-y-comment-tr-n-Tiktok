document.addEventListener("DOMContentLoaded", () => {
  const $ = (s) => document.querySelector(s);

  const startBtn   = $("#startBtn");
  const stopBtn    = $("#stopBtn");
  const exportBtn  = $("#exportBtn");
  const clearBtn   = $("#clearBtn");

  const statusEl   = $("#status");
  const progressEl = $("#progressFill");
  const statsBox   = $("#stats");
  const commentNum = $("#commentCount");
  const positiveNum= $("#positiveCount");
  const maxInput   = $("#maxComments");
  const speedSel   = $("#speedProfile");
  const autoRetryCk= $("#autoRetry");

  let collected = [];
  let lastProgressAt = 0;
  let watchdogTimer  = null;
  let autoRetryAttempts = 0;
  let lastCountSnapshot = 0;

  const setStatus = (msg, type="info") => { statusEl.textContent = msg; statusEl.className = `status ${type}`; };
  const setProgress = (p) => { progressEl.style.width = `${Math.max(0,Math.min(100,Math.round(p)))}%`; };
  const toggleRun = (on) => { if (on){ startBtn.classList.add("hidden"); stopBtn.classList.remove("hidden"); } else { startBtn.classList.remove("hidden"); stopBtn.classList.add("hidden"); } };

  restoreSaved();

  startBtn.addEventListener("click", async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !/https?:\/\/(www\.)?tiktok\.com\//.test(tab.url||"")) {
      return setStatus("❌ Vui lòng mở một trang video TikTok rồi chạy.", "error");
    }

    const maxVal = Math.max(1, Math.min(100000, parseInt((maxInput && maxInput.value) || "500", 10) || 500));
    const profile = (speedSel && speedSel.value) || "normal";
    const presets = {
      normal: { waitGrowMs: 2200, stepRatio: 0.9,  maxIdleRounds: 18, primeBudgetMs: 20000, hardOpenBudgetMs: 30000 },
      fast:   { waitGrowMs: 900,  stepRatio: 1.2,  maxIdleRounds: 10, primeBudgetMs: 10000, hardOpenBudgetMs: 20000 },
      max:    { waitGrowMs: 600,  stepRatio: 1.35, maxIdleRounds: 6,  primeBudgetMs:  7000, hardOpenBudgetMs: 16000 }
    };
    const settings = Object.assign({ maxComments: maxVal }, presets[profile]);

    // 1) HOOK MẠNG Ở PAGE WORLD (MAIN) để bắt comment JSON (tránh DOM ảo hoá/CSP)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
          if (window.__TTC_NET_HOOKED__) return;
          window.__TTC_NET_HOOKED__ = true;

          function safePost(url, data){
            try{ window.postMessage({ __TTC_NET__: true, url: String(url||""), data }, "*"); }catch(_){}
          }

          // Hook fetch
          const _fetch = window.fetch;
          if (_fetch) {
            window.fetch = async function(){
              const res = await _fetch.apply(this, arguments);
              try{
                const url = arguments[0] && String(arguments[0].url || arguments[0]) || "";
                if (/comment/i.test(url)) {
                  res.clone().json().then(j => safePost(url, j)).catch(()=>{});
                }
              }catch(_){}
              return res;
            };
          }

          // Hook XHR
          const XO = XMLHttpRequest.prototype.open;
          const XS = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function(method, url){
            this.__ttc_url = url; return XO.apply(this, arguments);
          };
          XMLHttpRequest.prototype.send = function(){
            try{
              this.addEventListener("load", ()=>{
                try{
                  const url = String(this.__ttc_url || "");
                  if (/comment/i.test(url)) {
                    if (this.responseType === "" || this.responseType === "text" || this.responseType === "json" || this.responseType === undefined) {
                      let data = null;
                      try{ data = JSON.parse(this.responseText); }catch(_){}
                      if (data) safePost(url, data);
                    }
                  }
                }catch(_){}
              });
            }catch(_){}
            return XS.apply(this, arguments);
          };
        }
      });
    } catch (_hookErr) {
      // không sao, vẫn tiếp tục với DOM fallback
    }

    // 2) Nạp content.js (logic thu thập hybrid: mạng + DOM)
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); } catch(_e) {}
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); } catch(_e) {}

    setProgress(0); statsBox.classList.remove("hidden");
    commentNum.textContent = "0"; positiveNum.textContent = "0";
    exportBtn.classList.add("hidden"); clearBtn.classList.add("hidden");
    toggleRun(true); setStatus("🔄 Đang thu thập…", "collecting");

    // 3) Gọi TTC_start trong content world
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (s) => { if (window.TTC_start) window.TTC_start(s); },
        args: [settings]
      });
    } catch (_e) {
      toggleRun(false);
      return setStatus("❌ Không thể chạy trên trang. Hãy reload video rồi thử lại.", "error");
    }

    // Watchdog: nếu 12s không tiến triển → re-hook + restart với backoff
    lastProgressAt = Date.now();
    lastCountSnapshot = 0;
    autoRetryAttempts = 0;
    clearInterval(watchdogTimer);

    watchdogTimer = setInterval(async () => {
      const currentCount = parseInt((commentNum.textContent || "0").replace(/\D/g,"")) || 0;
      const progressing = currentCount > lastCountSnapshot;

      if (progressing) {
        lastProgressAt = Date.now();
        lastCountSnapshot = currentCount;
        autoRetryAttempts = 0;
        return;
      }

      const idleMs = Date.now() - lastProgressAt;
      if ((autoRetryCk && autoRetryCk.checked) && idleMs > 12000) {
        autoRetryAttempts = Math.min(autoRetryAttempts + 1, 5);
        const backoffMs = Math.min(30000, 2000 * Math.pow(1.7, autoRetryAttempts));
        setStatus(`⏳ Kẹt ${Math.round(idleMs/1000)}s → thử khởi động lại (lần ${autoRetryAttempts})…`, "collecting");
        lastProgressAt = Date.now();

        // Re-inject page-world hook (phòng khi trang reload/SPA)
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: () => {
              if (window.__TTC_NET_HOOKED__) return;
              window.__TTC_NET_HOOKED__ = true;
              function safePost(url, data){ try{ window.postMessage({ __TTC_NET__: true, url: String(url||""), data }, "*"); }catch(_){} }
              const _fetch = window.fetch;
              if (_fetch) {
                window.fetch = async function(){
                  const res = await _fetch.apply(this, arguments);
                  try{
                    const url = arguments[0] && String(arguments[0].url || arguments[0]) || "";
                    if (/comment/i.test(url)) {
                      res.clone().json().then(j => safePost(url, j)).catch(()=>{});
                    }
                  }catch(_){}
                  return res;
                };
              }
              const XO = XMLHttpRequest.prototype.open;
              const XS = XMLHttpRequest.prototype.send;
              XMLHttpRequest.prototype.open = function(method, url){
                this.__ttc_url = url; return XO.apply(this, arguments);
              };
              XMLHttpRequest.prototype.send = function(){
                try{
                  this.addEventListener("load", ()=>{
                    try{
                      const url = String(this.__ttc_url || "");
                      if (/comment/i.test(url)) {
                        if (this.responseType === "" || this.responseType === "text" || this.responseType === "json" || this.responseType === undefined) {
                          let data = null;
                          try{ data = JSON.parse(this.responseText); }catch(_){}
                          if (data) safePost(url, data);
                        }
                      }
                    }catch(_){}
                  });
                }catch(_){}
                return XS.apply(this, arguments);
              };
            }
          });
        } catch(_){}

        // Re-run content + start
        try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); } catch (_e) {}
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (s) => { if (window.TTC_start) window.TTC_start(s); },
            args: [settings]
          });
        } catch (_e) {}

        if (autoRetryAttempts >= 3) {
          settings.waitGrowMs = Math.min(5000, (settings.waitGrowMs || 900) + 600);
        }
        setTimeout(()=>{}, backoffMs);
      }
    }, 3000);
  });

  stopBtn.addEventListener("click", async () => {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (tab && tab.id) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => { if (window.TTC_stop) window.TTC_stop(); }
        });
      } catch (_e) {}
    }
    toggleRun(false);
    setStatus("⏹ Đã yêu cầu dừng.", "info");
  });

  clearBtn.addEventListener("click", () => {
    if (!confirm("Xóa toàn bộ dữ liệu đã thu thập?")) return;
    collected = [];
    chrome.storage.local.remove(["commentData"]);
    exportBtn.classList.add("hidden"); clearBtn.classList.add("hidden"); statsBox.classList.add("hidden");
    setProgress(0); commentNum.textContent = "0"; positiveNum.textContent = "0";
    setStatus("🗑️ Đã xóa dữ liệu.", "success");
  });

  exportBtn.addEventListener("click", () => {
    const rows = Array.isArray(collected) ? collected : [];
    if (!rows.length) return setStatus("❌ Chưa có dữ liệu để xuất.", "error");
    exportExcel(rows);
  });

  chrome.runtime.onMessage.addListener((req) => {
    if (req && req.action === "collectionStarted") {
      lastProgressAt = Date.now();
      setStatus("🔄 Đang thu thập…", "collecting");
    }
    if (req && req.action === "updateProgress") {
      const d = req.data || {};
      const current = d.current || 0, total = d.total || 1, positive = d.positive || 0;
      lastProgressAt = Date.now();
      setProgress((current/Math.max(total,1))*100);
      commentNum.textContent = String(current);
      positiveNum.textContent = String(positive);
      setStatus(`🔄 Đã thu thập ${current}/${total} bình luận…`, "collecting");
    }
    if (req && req.action === "collectionComplete") {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
      toggleRun(false);
      collected = Array.isArray(req.data) ? req.data : [];
      chrome.storage.local.set({ commentData: collected });
      setProgress(100);
      commentNum.textContent = String(collected.length);
      try { positiveNum.textContent = String(collected.filter(x => x && x.is_positive === true).length); } catch (_e) { positiveNum.textContent = "0"; }
      exportBtn.classList.remove("hidden"); clearBtn.classList.remove("hidden");
      setStatus(`✅ Hoàn thành! Thu được ${collected.length} dòng. Bạn có thể “Xuất Excel”.`, "success");
    }
    if (req && req.action === "collectionError") {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
      toggleRun(false);
      setStatus("❌ " + (req.error || "Đã xảy ra lỗi."), "error");
    }
  });

  function restoreSaved(){
    chrome.storage.local.get(["commentData"], (res)=>{
      const rows = Array.isArray(res && res.commentData) ? res.commentData : [];
      if (rows.length){
        collected = rows;
        commentNum.textContent = String(rows.length);
        try { positiveNum.textContent = String(rows.filter(x => x && x.is_positive === true).length); } catch (_e) {}
        statsBox.classList.remove("hidden");
        exportBtn.classList.remove("hidden");
        clearBtn.classList.remove("hidden");
        progressEl.style.width = "100%";
        setStatus(`📁 Đã tải ${rows.length} bình luận từ lần trước.`, "success");
      }
    });
  }

  function exportExcel(rows){
    const headers = [
      "STT","Tên hiển thị","Tên người dùng","Liên kết hồ sơ",
      "Thời gian (raw)","Thời gian (ISO)","Bình luận","Lượt thích",
      "Là phản hồi?","Tác giả cha","Nội dung cha",
      "Liên kết bình luận","Thời điểm thu thập","Xếp hạng","Tích cực?"
    ];
    const esc = (s) => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const yn  = (v) => (v ? "Có" : "Không");

    const meta = [
      ["PHÂN TÍCH BÌNH LUẬN TIKTOK"],
      ["Video:", rows[0] && rows[0].videoTitle || ""],
      ["URL:", rows[0] && rows[0].videoUrl || ""],
      ["Thời điểm xuất:", new Date().toLocaleString("vi-VN")],
      ["Tổng số dòng:", rows.length],
      [""]
    ];
    const metaRows = meta.map(r=>`<tr>${r.map(c=>`<td>${esc(c)}</td>`).join("")}</tr>`).join("");

    const body = rows.map((r,i)=>`
      <tr>
        <td>${i+1}</td>
        <td>${esc(r.author_name||r.author||"")}</td>
        <td>${esc(r.author_username||"")}</td>
        <td>${esc(r.author_profile_url||"")}</td>
        <td>${esc(r.timestamp_text||"")}</td>
        <td>${esc(r.timestamp_iso||"")}</td>
        <td>${esc(r.comment_text||r.text||"")}</td>
        <td>${r.like_count || r.likes || 0}</td>
        <td>${yn(!!r.is_reply)}</td>
        <td>${esc(r.parent_author||"")}</td>
        <td>${esc(r.parent_text||"")}</td>
        <td>${esc(r.permalink||"")}</td>
        <td>${esc(r.collectedAt||"")}</td>
        <td>${esc(r.rank||i+1)}</td>
        <td>${yn(!!r.is_positive)}</td>
      </tr>`).join("");

    const table = `
      <html xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:x="urn:schemas-microsoft-com:office:excel"
            xmlns="http://www.w3.org/TR/REC-html40">
      <head>
        <meta charset="UTF-8">
        <xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
          <x:Name>BinhLuan</x:Name>
          <x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
        </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml>
      </head>
      <body>
        <table border="1" cellpadding="3" cellspacing="0">
          ${metaRows}
          <tr>${headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr>
          ${body}
        </table>
      </body></html>`;

    const blob = new Blob([table], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: `tiktok_binh_luan_${Date.now()}.xls`, saveAs: true });
    setStatus("✅ Đã xuất Excel (.xls) tiếng Việt.", "success");
  }
});

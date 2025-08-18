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

  let collected = [];
  let lastProgressAt = 0;
  let watchdogTimer  = null;

  const setStatus = (msg, type="info") => { if(!statusEl) return; statusEl.textContent = msg; statusEl.className = `status ${type}`; };
  const setProgress = (p) => { if(progressEl) progressEl.style.width = `${Math.max(0,Math.min(100,Math.round(p)))}%`; };
  const toggleRun = (on) => {
    if (!startBtn || !stopBtn) return;
    if (on){ startBtn.classList.add("hidden"); stopBtn.classList.remove("hidden"); }
    else   { startBtn.classList.remove("hidden"); stopBtn.classList.add("hidden"); }
  };

  restoreSaved();

  // ===== helpers =====
  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }
  function isTikTok(url=""){ return /https?:\/\/(www\.)?tiktok\.com\//i.test(url||""); }
  function readMax(){
    const v = parseInt(maxInput?.value ?? "500", 10);
    return Math.max(1, Math.min(100000, isNaN(v) ? 500 : v));
  }

  async function pingContent(tabId){
    try { const r = await chrome.tabs.sendMessage(tabId, { action: "__ping__" }, { frameId: 0 }); return !!r; }
    catch { return false; }
  }
  function hasScriptingPermission(){
    const p = chrome.runtime.getManifest().permissions || [];
    return p.includes("scripting");
  }
  async function probeTTC(tabId){
    if (!hasScriptingPermission()) return false;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!window.TTC_start
      });
      return !!result;
    } catch { return false; }
  }
  async function injectContent(tabId){
    if (!hasScriptingPermission()) return false;
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }); return true; }
    catch { return false; }
  }
  async function ensureContent(tabId){
    // 1) đã có listener trong content?
    if (await pingContent(tabId)) return true;
    // 2) trong cùng isolated world đã có TTC_start?
    if (await probeTTC(tabId)) return true;
    // 3) inject file rồi probe lại
    if (await injectContent(tabId)) {
      if (await pingContent(tabId)) return true;
      if (await probeTTC(tabId)) return true;
    }
    return false;
  }

  // ===== start =====
  startBtn?.addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!tab || !isTikTok(tab.url)) {
      return setStatus("❌ Vui lòng mở một trang video TikTok rồi chạy.", "error");
    }

    const maxVal = readMax();
    const settings = { maxComments: maxVal };
    chrome.storage.local.set({ maxComments: maxVal });

    setProgress(0); statsBox?.classList.remove("hidden");
    if (commentNum) commentNum.textContent = "0";
    if (positiveNum) positiveNum.textContent = "0";
    exportBtn?.classList.add("hidden"); clearBtn?.classList.add("hidden");
    toggleRun(true); setStatus("🔄 Đang thu thập…", "collecting");

    // đảm bảo content có mặt
    const ready = await ensureContent(tab.id);
    if (!ready) {
      toggleRun(false);
      return setStatus("❌ Không inject được content vào trang (thiếu quyền scripting/host_permissions?).", "error");
    }

    // ưu tiên gửi message chính thống
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "startCollection", settings });
    } catch {
      // fallback: gọi hàm global nếu có
      if (hasScriptingPermission()) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            args: [settings],
            func: (s) => { window.TTC_start && window.TTC_start(s); }
          });
        } catch {
          toggleRun(false);
          return setStatus("❌ Không thể chạy trên trang. Hãy reload video rồi thử lại.", "error");
        }
      } else {
        toggleRun(false);
        return setStatus('❌ Không gửi được lệnh tới content. Thêm quyền "scripting" hoặc khai báo content_scripts.', "error");
      }
    }

    lastProgressAt = Date.now();
    clearInterval(watchdogTimer);
    watchdogTimer = setInterval(async () => {
      const idle = Date.now() - lastProgressAt;
      if (idle > 12000) {
        setStatus("⏳ Chưa nhận tín hiệu, đang thử khởi động lại…", "collecting");
        lastProgressAt = Date.now();
        try { await chrome.tabs.sendMessage(tab.id, { action: "startCollection", settings }); } catch {}
      }
    }, 3000);
  });

  // ===== stop =====
  stopBtn?.addEventListener("click", async () => {
    clearInterval(watchdogTimer); watchdogTimer=null;
    const tab = await getActiveTab();
    if (tab?.id) {
      try { await chrome.tabs.sendMessage(tab.id, { action: "stopCollection" }); } catch {}
      if (hasScriptingPermission()) {
        try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.TTC_stop && window.TTC_stop(); } }); } catch {}
      }
    }
    toggleRun(false);
    setStatus("⏹ Đã yêu cầu dừng.", "info");
  });

  // ===== clear & export =====
  clearBtn?.addEventListener("click", () => {
    if (!confirm("Xóa toàn bộ dữ liệu đã thu thập?")) return;
    collected = [];
    chrome.storage.local.remove(["commentData"]);
    exportBtn?.classList.add("hidden"); clearBtn?.classList.add("hidden"); statsBox?.classList.add("hidden");
    setProgress(0); commentNum && (commentNum.textContent = "0"); positiveNum && (positiveNum.textContent = "0");
    setStatus("🗑️ Đã xóa dữ liệu.", "success");
  });

  exportBtn?.addEventListener("click", () => {
    const rows = Array.isArray(collected) ? collected : [];
    if (!rows.length) return setStatus("❌ Chưa có dữ liệu để xuất.", "error");
    exportExcel(rows);
  });

  // ===== nhận sự kiện từ content =====
  chrome.runtime.onMessage.addListener((req) => {
    if (req?.action === "collectionStarted") {
      lastProgressAt = Date.now();
      setStatus("🔄 Đang thu thập…", "collecting");
    }
    if (req?.action === "updateProgress") {
      const { current=0, total=1, positive=0 } = req.data || {};
      lastProgressAt = Date.now();
      setProgress((current/Math.max(total,1))*100);
      commentNum && (commentNum.textContent = String(current));
      positiveNum && (positiveNum.textContent = String(positive));
      setStatus(`🔄 Đã thu thập ${current}/${total} bình luận…`, "collecting");
    }
    if (req?.action === "collectionComplete") {
      clearInterval(watchdogTimer); watchdogTimer=null;
      toggleRun(false);
      collected = Array.isArray(req.data) ? req.data : [];
      chrome.storage.local.set({ commentData: collected });
      setProgress(100);
      commentNum && (commentNum.textContent = String(collected.length));
      try { positiveNum && (positiveNum.textContent = String(collected.filter(x => x?.is_positive === true).length)); } catch { positiveNum && (positiveNum.textContent = "0"); }
      exportBtn?.classList.remove("hidden"); clearBtn?.classList.remove("hidden");
      setStatus(`✅ Hoàn thành! Thu được ${collected.length} dòng. Bạn có thể “Xuất Excel”.`, "success");
    }
    if (req?.action === "collectionError") {
      clearInterval(watchdogTimer); watchdogTimer=null;
      toggleRun(false);
      setStatus("❌ " + (req.error || "Đã xảy ra lỗi."), "error");
    }
  });

  // ===== restore & export =====
  function restoreSaved(){
    chrome.storage.local.get(["commentData","maxComments"], (res)=>{
      const rows = Array.isArray(res?.commentData) ? res.commentData : [];
      if (rows.length){
        collected = rows;
        commentNum && (commentNum.textContent = String(rows.length));
        try { positiveNum && (positiveNum.textContent = String(rows.filter(x => x?.is_positive === true).length)); } catch {}
        statsBox?.classList.remove("hidden");
        exportBtn?.classList.remove("hidden");
        clearBtn?.classList.remove("hidden");
        progressEl && (progressEl.style.width = "100%");
        setStatus(`📁 Đã tải ${rows.length} bình luận từ lần trước.`, "success");
      }
      if (res?.maxComments && maxInput && !maxInput.value) maxInput.value = res.maxComments;
    });
  }

  function exportExcel(rows){
    const headers = [
      "STT","Tên hiển thị","Tên người dùng","Liên kết hồ sơ",
      "Thời gian (raw)","Thời gian (ISO)","Bình luận","Lượt thích",
      "Là phản hồi?","Tác giả cha","Nội dung cha",
      "Liên kết bình luận","Thời điểm thu thập","Xếp hạng","Tích cực?"
    ];
    const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const yn  = (v) => (v ? "Có" : "Không");

    const meta = [
      ["PHÂN TÍCH BÌNH LUẬN TIKTOK"],
      ["Video:", rows[0]?.videoTitle || ""],
      ["URL:", rows[0]?.videoUrl || ""],
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
        <td>${r.like_count ?? r.likes ?? 0}</td>
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

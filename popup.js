document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBtn');
  const exportBtn = document.getElementById('exportBtn');
  const clearBtn = document.getElementById('clearBtn');
  const status = document.getElementById('status');
  const progressFill = document.getElementById('progressFill');
  const stats = document.getElementById('stats');
  const commentCount = document.getElementById('commentCount');
  const positiveCount = document.getElementById('positiveCount');
  const maxCommentsInput = document.getElementById('maxComments');

  let isCollecting = false;
  let collected = [];

  loadSaved();

  startBtn.addEventListener('click', async () => {
    if (isCollecting) { stopCollection(); return; }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    if (!(url.includes('tiktok.com'))) {
      updateStatus('❌ Vui lòng mở trang video TikTok', 'error');
      return;
    }

    if (chrome.scripting?.executeScript) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch (_) {}
    }

    isCollecting = true;
    startBtn.textContent = '⏹️ Dừng';
    startBtn.className = 'btn btn-secondary';
    progressFill.style.width = '0%';
    updateStatus('🔄 Đang thu thập comment...', 'collecting');

    chrome.tabs.sendMessage(tab.id, {
      action: 'startCollection',
      settings: { maxComments: parseInt(maxCommentsInput.value || '500', 10) }
    });
  });

  clearBtn.addEventListener('click', () => {
    if (!confirm('Xóa toàn bộ dữ liệu đã thu thập?')) return;
    collected = [];
    chrome.storage.local.remove(['commentData']);
    exportBtn.classList.add('hidden');
    clearBtn.classList.add('hidden');
    stats.classList.add('hidden');
    progressFill.style.width = '0%';
    commentCount.textContent = '0';
    positiveCount.textContent = '0';
    updateStatus('🗑️ Đã xóa dữ liệu', 'info');
  });

  exportBtn.addEventListener('click', () => {
    if (!collected.length) { updateStatus('❌ Chưa có dữ liệu để xuất', 'error'); return; }
    exportCSV(collected);
  });

  // Nhận update từ content.js
  chrome.runtime.onMessage.addListener((req) => {
    if (req.action === 'updateProgress') {
      const { current, total } = req.data || { current: 0, total: 1 };
      const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
      progressFill.style.width = pct + '%';
      commentCount.textContent = current;
      positiveCount.textContent = 0;
      stats.classList.remove('hidden');
      updateStatus(`🔄 Đã thu thập ${current}/${total} comment`, 'collecting');
    }
    if (req.action === 'collectionComplete') {
      isCollecting = false;
      startBtn.textContent = '🚀 Bắt đầu thu thập';
      startBtn.className = 'btn btn-primary';

      collected = req.data || [];
      chrome.storage.local.set({ commentData: collected });

      exportBtn.classList.remove('hidden');
      clearBtn.classList.remove('hidden');
      stats.classList.remove('hidden');

      progressFill.style.width = '100%';
      commentCount.textContent = collected.length;
      positiveCount.textContent = 0;

      updateStatus(`✅ Hoàn thành! Thu thập được ${collected.length} comment. Bấm "Xuất Excel" để tải.`, 'success');
    }
    if (req.action === 'collectionError') {
      isCollecting = false;
      startBtn.textContent = '🚀 Bắt đầu thu thập';
      startBtn.className = 'btn btn-primary';
      updateStatus('❌ ' + req.error, 'error');
    }
  });

  function stopCollection() {
    isCollecting = false;
    startBtn.textContent = '🚀 Bắt đầu thu thập';
    startBtn.className = 'btn btn-primary';
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'stopCollection' });
    });
  }

  function updateStatus(msg, type = 'info') {
    status.textContent = msg;
    status.className = `status ${type}`;
  }

  function exportCSV(rows) {
    const ws = [
      ['PHÂN TÍCH COMMENT TIKTOK'],
      ['Video:', rows[0]?.videoTitle || 'TikTok Video'],
      ['URL:', rows[0]?.videoUrl || ''],
      ['Thời gian phân tích:', new Date().toLocaleString('vi-VN')],
      ['Tổng số comment:', rows.length],
      [],
      ['STT','Tên người dùng','Thời gian','Comment','Số like','Phản hồi']
    ];
    rows.forEach((c, i) => {
      const text = (c.text || '').replace(/\r?\n/g, ' ').trim();
      ws.push([i+1, c.author || '', c.timestamp || '', text, c.likes || 0, c.replies || 0]);
    });

    const csv = ws.map(r => r.map(v => {
      const s = String(v ?? '');
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    }).join(',')).join('\n');

    const bom = '\uFEFF';
    const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `tiktok_comments_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    updateStatus('✅ Đã xuất file (CSV, mở bằng Excel).', 'success');
  }

  function loadSaved() {
    chrome.storage.local.get(['commentData'], (res) => {
      if (Array.isArray(res.commentData) && res.commentData.length) {
        collected = res.commentData;
        commentCount.textContent = collected.length;
        stats.classList.remove('hidden');
        exportBtn.classList.remove('hidden');
        clearBtn.classList.remove('hidden');
        updateStatus(`📁 Đã tải ${collected.length} comment từ lần trước`, 'success');
      }
    });
  }
});

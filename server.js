const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const https = require('https');
const fs = require('fs');
const QRCode = require('qrcode');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Server State
let state = {
  currentSong: null,
  queue: [],
  history: [],
  pendingApproval: [],
  settings: {
    maxDuration: 360, // 6 分鐘（秒）
    maxActivePerStudent: 2, // 每個學生待播中最多幾首
    allowDuplicates: false,
    autoApprove: true, // 直通模式 (true) vs 審核模式 (false)
    playMode: 'fifo', // 'fifo' (先點先播) 或 'votes' (高票優先)
    adminPassword: 'admin888'
  }
};

// 載入持久化資料 (如果有)
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      if (saved.queue) state.queue = saved.queue;
      if (saved.history) state.history = saved.history;
      if (saved.settings) state.settings = { ...state.settings, ...saved.settings };
      if (saved.pendingApproval) state.pendingApproval = saved.pendingApproval;
      console.log('✅ 已從 data.json 恢復點歌清單與設定');
    }
  } catch (err) {
    console.error('⚠️ 載入存檔失敗，使用初始狀態:', err.message);
  }
}

function saveState() {
  try {
    const toSave = {
      queue: state.queue,
      history: state.history.slice(-30),
      pendingApproval: state.pendingApproval,
      settings: state.settings
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (err) {
    console.error('⚠️ 存檔失敗:', err.message);
  }
}

loadState();

// 取得本機區域網路 IP
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// 解析 YouTube 網址取得 11 碼 Video ID
function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  // 若直接輸入 11 碼 ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  // 標準網址或分享網址
  const regExp = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([a-zA-Z0-9_-]{11})/;
  const match = trimmed.match(regExp);
  return match ? match[1] : null;
}

// 從 YouTube oEmbed 獲取標題與作者
function fetchOEmbed(videoId) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const parsed = JSON.parse(data);
            resolve({
              title: parsed.title,
              author: parsed.author_name,
              thumbnail: parsed.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
            });
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

// 解析 YouTube 影片時長（秒）
function fetchDuration(videoId) {
  return new Promise((resolve) => {
    https.get(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const msMatch = data.match(/"approxDurationMs":"(\d+)"/);
        if (msMatch) {
          return resolve(Math.round(parseInt(msMatch[1], 10) / 1000));
        }
        const secMatch = data.match(/"lengthSeconds":"(\d+)"/);
        if (secMatch) {
          return resolve(parseInt(secMatch[1], 10));
        }
        resolve(null);
      });
    }).on('error', () => resolve(null));
  });
}

// 排序佇列（依設定模式）
function sortQueue() {
  if (state.settings.playMode === 'votes') {
    state.queue.sort((a, b) => (b.votes ? b.votes.length : 0) - (a.votes ? a.votes.length : 0));
  }
}

// REST API
app.get('/api/info', async (req, res) => {
  const localIp = getLocalIp();
  const reqHost = req.get('host') || `${localIp}:${PORT}`;
  // 若從本機 localhost 開啟，手機 QR Code 需指向實體 IP 才能掃描成功
  const phoneHost = (reqHost.startsWith('localhost') || reqHost.startsWith('127.0.0.1'))
    ? `${localIp}:${PORT}`
    : reqHost;

  const protocol = req.protocol;
  const baseUrl = `${protocol}://${phoneHost}`;
  const studentUrl = `${baseUrl}/request.html`;

  let qrCodeDataUrl = '';
  try {
    qrCodeDataUrl = await QRCode.toDataURL(studentUrl, { width: 300, margin: 2 });
  } catch (err) {
    console.error('QR Code 生成失敗:', err);
  }

  res.json({
    localIp,
    port: PORT,
    studentUrl,
    qrCodeDataUrl,
    settings: {
      maxDuration: state.settings.maxDuration,
      maxActivePerStudent: state.settings.maxActivePerStudent,
      autoApprove: state.settings.autoApprove,
      playMode: state.settings.playMode
    }
  });
});

// 即時預覽 YouTube 網址 API
app.get('/api/preview', async (req, res) => {
  const { url } = req.query;
  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: '請提供有效的 YouTube 網址或影片 ID' });
  }

  const [meta, duration] = await Promise.all([
    fetchOEmbed(videoId),
    fetchDuration(videoId)
  ]);

  if (!meta) {
    return res.status(404).json({ error: '找不到此 YouTube 影片，請確認網址是否正確或影片是否公開' });
  }

  res.json({
    videoId,
    title: meta.title,
    author: meta.author,
    thumbnail: meta.thumbnail,
    duration: duration || 0
  });
});

// WebSocket 即時通訊
io.on('connection', (socket) => {
  // 發送當前完整狀態給新連線用戶
  socket.emit('state_update', {
    currentSong: state.currentSong,
    queue: state.queue,
    history: state.history.slice(-10),
    pendingApproval: state.pendingApproval,
    settings: {
      maxDuration: state.settings.maxDuration,
      maxActivePerStudent: state.settings.maxActivePerStudent,
      autoApprove: state.settings.autoApprove,
      playMode: state.settings.playMode
    }
  });

  // 學生點歌
  socket.on('request_song', async (data, callback) => {
    try {
      const { url, seat, nickname, note, clientId } = data;

      if (!url) {
        return callback && callback({ success: false, message: '請輸入 YouTube 網址' });
      }

      const videoId = extractVideoId(url);
      if (!videoId) {
        return callback && callback({ success: false, message: '無法識別此 YouTube 網址，請確認格式' });
      }

      const studentIdentifier = (seat ? `座號 ${seat}` : (nickname || '匿名同學')).trim();

      // 檢查 1：是否已有重複歌曲在待播清單中
      if (!state.settings.allowDuplicates) {
        const inQueue = state.queue.some(s => s.videoId === videoId);
        const inPending = state.pendingApproval.some(s => s.videoId === videoId);
        const isCurrent = state.currentSong && state.currentSong.videoId === videoId;
        if (inQueue || inPending || isCurrent) {
          return callback && callback({ success: false, message: '這首歌已經在播放清單或待播名單中了喔！' });
        }
      }

      // 檢查 2：學生個人待播上限配額
      const studentTag = seat ? `seat:${seat}` : `client:${clientId || socket.id}`;
      const activeCount = state.queue.filter(s => s.studentTag === studentTag).length +
                          state.pendingApproval.filter(s => s.studentTag === studentTag).length;

      if (activeCount >= state.settings.maxActivePerStudent) {
        return callback && callback({
          success: false,
          message: `您目前已有 ${activeCount} 首歌在排隊中，請等播完再點下一首喔！（每人上限 ${state.settings.maxActivePerStudent} 首）`
        });
      }

      // 獲取影片元數據與時長
      const [meta, duration] = await Promise.all([
        fetchOEmbed(videoId),
        fetchDuration(videoId)
      ]);

      const title = meta ? meta.title : `YouTube 影片 (${videoId})`;
      const author = meta ? meta.author : '未知頻道';
      const thumbnail = meta ? meta.thumbnail : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      const songDuration = duration || 0;

      // 檢查 3：時長限制
      if (state.settings.maxDuration > 0 && songDuration > state.settings.maxDuration) {
        const maxMins = Math.round(state.settings.maxDuration / 60);
        const songMins = Math.floor(songDuration / 60);
        const songSecs = songDuration % 60;
        return callback && callback({
          success: false,
          message: `這首歌長達 ${songMins}分${songSecs}秒，超過班級規定的 ${maxMins} 分鐘上限喔！請換一首～`
        });
      }

      const newSong = {
        id: 'song_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        videoId,
        title,
        author,
        thumbnail,
        duration: songDuration,
        seat: seat || '',
        nickname: nickname || '',
        requester: studentIdentifier,
        note: (note || '').trim(),
        studentTag,
        addedAt: Date.now(),
        votes: []
      };

      if (state.settings.autoApprove) {
        // 直通模式：直接進佇列
        state.queue.push(newSong);
        sortQueue();

        // 若當前沒有正在播放的歌，且大螢幕是空閒的，由大螢幕自動索取第一首
        io.emit('queue_updated', {
          queue: state.queue,
          message: `🎵 ${studentIdentifier} 點播了《${title}》`
        });

        saveState();
        return callback && callback({
          success: true,
          message: `點歌成功！《${title}》已排入播放清單`,
          song: newSong
        });
      } else {
        // 審核模式：加入待審核清單
        state.pendingApproval.push(newSong);
        io.emit('pending_updated', {
          pendingApproval: state.pendingApproval,
          message: `🔔 ${studentIdentifier} 點播了《${title}》（待老師審核）`
        });

        saveState();
        return callback && callback({
          success: true,
          message: `點歌已送出！《${title}》等待老師審核中`,
          song: newSong,
          pending: true
        });
      }
    } catch (err) {
      console.error('點歌處理錯誤:', err);
      callback && callback({ success: false, message: '點歌處理失敗，請稍後再試' });
    }
  });

  // 學生按讚投票
  socket.on('upvote_song', ({ songId, voterId }, callback) => {
    const voter = voterId || socket.id;
    const song = state.queue.find(s => s.id === songId);
    if (!song) {
      return callback && callback({ success: false, message: '歌曲不存在或已播畢' });
    }

    if (!song.votes) song.votes = [];
    const index = song.votes.indexOf(voter);
    let voted = false;
    if (index === -1) {
      song.votes.push(voter);
      voted = true;
    } else {
      song.votes.splice(index, 1);
      voted = false;
    }

    sortQueue();
    io.emit('queue_updated', { queue: state.queue });
    saveState();

    callback && callback({ success: true, voted, votesCount: song.votes.length });
  });

  // 播放端索取下一首 / 歌曲播畢
  socket.on('player_next', (data, callback) => {
    if (state.currentSong) {
      state.history.push({ ...state.currentSong, finishedAt: Date.now() });
      if (state.history.length > 50) state.history.shift();
    }

    if (state.queue.length > 0) {
      state.currentSong = state.queue.shift();
    } else {
      state.currentSong = null;
    }

    io.emit('now_playing', {
      currentSong: state.currentSong,
      queue: state.queue
    });

    saveState();
    callback && callback({ currentSong: state.currentSong, queue: state.queue });
  });

  // 播放端發生版權嵌入錯誤 (Error 101/150) 或時長過長跳過
  socket.on('player_error', (data) => {
    const { videoId, errorCode, reason } = data;
    console.log(`⚠️ 播放端回報錯誤: Video ID: ${videoId}, 代碼: ${errorCode}, 原因: ${reason}`);

    let errorNotice = '⚠️ 本歌曲發生播放錯誤，已自動為您跳至下一首！';
    if (errorCode === 101 || errorCode === 150) {
      errorNotice = '⚠️ 本歌曲因版權方限制無法於外部嵌入播放，已自動跳至下一首！';
    } else if (reason === 'duration_exceeded') {
      errorNotice = '⚠️ 本歌曲實際時長超過規定上限，已自動跳至下一首！';
    }

    // 將當前錯誤歌曲記入歷史並標記
    if (state.currentSong && state.currentSong.videoId === videoId) {
      state.history.push({ ...state.currentSong, error: errorNotice, finishedAt: Date.now() });
    }

    // 自動換下一首
    if (state.queue.length > 0) {
      state.currentSong = state.queue.shift();
    } else {
      state.currentSong = null;
    }

    io.emit('now_playing', {
      currentSong: state.currentSong,
      queue: state.queue,
      alert: errorNotice
    });

    saveState();
  });

  // 老師遠端/主機端管理操作
  socket.on('admin_action', ({ password, action, payload }, callback) => {
    // 驗證管理員密碼
    if (password !== state.settings.adminPassword) {
      return callback && callback({ success: false, message: '管理員密碼不正確' });
    }

    switch (action) {
      case 'skip': {
        // 切下一首
        if (state.currentSong) {
          state.history.push({ ...state.currentSong, skipped: true, finishedAt: Date.now() });
        }
        state.currentSong = state.queue.length > 0 ? state.queue.shift() : null;
        io.emit('now_playing', { currentSong: state.currentSong, queue: state.queue });
        io.emit('admin_command', { command: 'skip' });
        saveState();
        return callback && callback({ success: true, message: '已切換至下一首' });
      }

      case 'play_pause': {
        // 暫停 / 繼續
        io.emit('admin_command', { command: 'play_pause', isPlaying: payload.isPlaying });
        return callback && callback({ success: true });
      }

      case 'set_volume': {
        // 調整音量
        io.emit('admin_command', { command: 'set_volume', volume: payload.volume });
        return callback && callback({ success: true });
      }

      case 'remove_song': {
        // 從排隊清單刪除指定歌曲
        const idToRemove = payload.songId;
        const idx = state.queue.findIndex(s => s.id === idToRemove);
        if (idx !== -1) {
          const removed = state.queue.splice(idx, 1)[0];
          io.emit('queue_updated', { queue: state.queue, message: `🗑️ 老師移除了《${removed.title}》` });
          saveState();
          return callback && callback({ success: true, message: '已移除該歌曲' });
        }
        return callback && callback({ success: false, message: '找不到該歌曲' });
      }

      case 'approve_song': {
        // 審核通過
        const idToApprove = payload.songId;
        const idx = state.pendingApproval.findIndex(s => s.id === idToApprove);
        if (idx !== -1) {
          const approved = state.pendingApproval.splice(idx, 1)[0];
          state.queue.push(approved);
          sortQueue();
          io.emit('queue_updated', { queue: state.queue, message: `✅ 老師審核通過《${approved.title}》` });
          io.emit('pending_updated', { pendingApproval: state.pendingApproval });
          saveState();
          return callback && callback({ success: true, message: '已通過審核並排入播放清單' });
        }
        return callback && callback({ success: false, message: '找不到待審核歌曲' });
      }

      case 'reject_song': {
        // 審核拒絕
        const idToReject = payload.songId;
        const idx = state.pendingApproval.findIndex(s => s.id === idToReject);
        if (idx !== -1) {
          state.pendingApproval.splice(idx, 1);
          io.emit('pending_updated', { pendingApproval: state.pendingApproval });
          saveState();
          return callback && callback({ success: true, message: '已拒絕該點歌請求' });
        }
        return callback && callback({ success: false, message: '找不到待審核歌曲' });
      }

      case 'clear_queue': {
        // 清空待播清單
        state.queue = [];
        io.emit('queue_updated', { queue: state.queue, message: '🧹 老師已清空待播清單' });
        saveState();
        return callback && callback({ success: true, message: '已清空待播清單' });
      }

      case 'update_settings': {
        // 更新管理設定
        if (payload.maxDuration !== undefined) state.settings.maxDuration = parseInt(payload.maxDuration, 10);
        if (payload.maxActivePerStudent !== undefined) state.settings.maxActivePerStudent = parseInt(payload.maxActivePerStudent, 10);
        if (payload.autoApprove !== undefined) state.settings.autoApprove = Boolean(payload.autoApprove);
        if (payload.playMode !== undefined) {
          state.settings.playMode = payload.playMode;
          sortQueue();
        }
        if (payload.newPassword) state.settings.adminPassword = payload.newPassword;

        io.emit('settings_updated', { settings: state.settings, queue: state.queue });
        saveState();
        return callback && callback({ success: true, message: '設定已更新', settings: state.settings });
      }

      default:
        return callback && callback({ success: false, message: '未知操作' });
    }
  });
});

// 啟動伺服器
server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log(`
=====================================================
🎵 班級雲端 YouTube 點歌系統 已成功啟動！
=====================================================
🖥️ 老師播放端（大螢幕/投影機）：
   http://localhost:${PORT}/player.html
   http://${localIp}:${PORT}/player.html

📱 學生點歌端（手機/平板掃描）：
   http://${localIp}:${PORT}/request.html

🔐 老師行動控制後台：
   http://${localIp}:${PORT}/admin.html
   (預設管理密碼: ${state.settings.adminPassword})
=====================================================
`);
});

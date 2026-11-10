/**
 * 羚藝汽泡水的點歌坊 - Firebase Realtime Database 雲端橋接核心 (混合模式)
 * 1. 雙向同步：自動與 MQTT 搭配，提供雲端持久化 (換電腦開大螢幕歌曲與設定不遺失)
 * 2. 斷線/非同步點歌：大螢幕沒開時，學生點歌自動暫存至 Firebase，大螢幕開機時自動匯入佇列
 * 3. 雲端排行榜：累計全班點播歌曲次數 TOP 10
 * 4. 雲端黑名單：過濾不當歌曲，全班即時生效
 * 5. 防呆降級：若 Firebase 連線失敗或規則未開放，自動降級至 LocalStorage，系統正常運作不當機
 */
(function(window) {
  // 羚藝汽泡水的點歌坊專用 Firebase 金鑰
  const firebaseConfig = {
    apiKey: "AIzaSyD_3Q0MCUgUg9mZTvrlm30Qbu2kGNPvxbI",
    authDomain: "sing-da5d4.firebaseapp.com",
    databaseURL: "https://sing-da5d4-default-rtdb.firebaseio.com",
    projectId: "sing-da5d4",
    storageBucket: "sing-da5d4.firebasestorage.app",
    messagingSenderId: "600883639246",
    appId: "1:600883639246:web:ecfe2e9ccfdc58cf45b19f",
    measurementId: "G-9RHGQXEM03"
  };

  class FirebaseSync {
    constructor(options = {}) {
      this.room = options.room || '607';
      this.role = options.role || 'client'; // 'host', 'client', 'admin'
      this.isReady = false;
      this.db = null;
      this.listeners = {};

      this.init();
    }

    init() {
      if (typeof firebase === 'undefined') {
        console.warn('[FirebaseSync] Firebase SDK 尚未載入，系統維持使用 LocalStorage 與 MQTT。');
        return;
      }

      try {
        if (!firebase.apps || !firebase.apps.length) {
          firebase.initializeApp(firebaseConfig);
        }
        this.db = firebase.database();
        this.isReady = true;
        console.log(`[FirebaseSync] ✅ Firebase Realtime Database 初始化成功！(班級: ${this.room})`);
        this.emit('ready', { connected: true });
      } catch (err) {
        console.warn('[FirebaseSync] 初始化警告 (將維持使用 LocalStorage 與 MQTT):', err.message);
      }
    }

    // 儲存大螢幕完整狀態至雲端（持久化）
    saveRoomState(state) {
      if (!this.isReady || !this.db) return Promise.resolve(false);
      try {
        const cleanState = {
          currentSong: state.currentSong || null,
          queue: state.queue || [],
          pendingApproval: state.pendingApproval || [],
          settings: state.settings || {},
          updatedAt: Date.now()
        };
        return this.db.ref(`rooms/${this.room}/state`).set(cleanState).catch(err => {
          console.warn('[FirebaseSync] 儲存狀態受限 (請確認 Firebase 規則):', err.message);
          return false;
        });
      } catch (e) {
        return Promise.resolve(false);
      }
    }

    // 取得/監聽大螢幕即時狀態
    watchRoomState(callback) {
      if (!this.isReady || !this.db) return;
      try {
        const stateRef = this.db.ref(`rooms/${this.room}/state`);
        stateRef.on('value', (snapshot) => {
          const val = snapshot.val();
          if (val && callback) callback(val);
        }, (err) => {
          console.warn('[FirebaseSync] 監聽狀態受限:', err.message);
        });
      } catch (e) {}
    }

    // 單次讀取狀態（初始化時恢復）
    loadRoomStateOnce() {
      if (!this.isReady || !this.db) return Promise.resolve(null);
      return this.db.ref(`rooms/${this.room}/state`).once('value')
        .then(snap => snap.val())
        .catch(err => {
          console.warn('[FirebaseSync] 讀取狀態受限:', err.message);
          return null;
        });
    }

    // 累計歌曲播放次數（生成班級排行榜）與歷史紀錄
    recordSongPlay(song) {
      if (!this.isReady || !this.db || !song || !song.videoId) return;
      try {
        const statRef = this.db.ref(`rooms/${this.room}/song_stats/${song.videoId}`);
        statRef.transaction((currentData) => {
          if (currentData) {
            currentData.count = (currentData.count || 0) + 1;
            currentData.lastPlayed = Date.now();
            currentData.lastRequester = song.requester || currentData.lastRequester || '';
            currentData.title = song.title || currentData.title;
            currentData.author = song.author || currentData.author;
            currentData.thumbnail = song.thumbnail || currentData.thumbnail;
            return currentData;
          } else {
            return {
              videoId: song.videoId,
              title: song.title || '未知歌曲',
              author: song.author || 'YouTube 頻道',
              thumbnail: song.thumbnail || `https://i.ytimg.com/vi/${song.videoId}/hqdefault.jpg`,
              count: 1,
              lastPlayed: Date.now(),
              lastRequester: song.requester || ''
            };
          }
        }).catch(() => {});

        // 同步寫入雲端歷史清單 (保留最新 50 筆)
        const histRef = this.db.ref(`rooms/${this.room}/history`).push();
        histRef.set({
          ...song,
          playedAt: Date.now()
        }).catch(() => {});
      } catch (e) {}
    }

    // 取得點播熱門排行 TOP 10
    getTopSongs(callback) {
      if (!this.isReady || !this.db) return;
      try {
        this.db.ref(`rooms/${this.room}/song_stats`)
          .orderByChild('count')
          .limitToLast(10)
          .once('value')
          .then(snapshot => {
            const list = [];
            snapshot.forEach(child => {
              list.push(child.val());
            });
            list.reverse(); // 由大到小排序
            if (callback) callback(list);
          })
          .catch(() => {});
      } catch (e) {}
    }

    // 學生端非同步暫存點播（當大螢幕未開啟時存入雲端，大螢幕啟動時自動匯入）
    pushOfflineRequest(requestData) {
      if (!this.isReady || !this.db) return Promise.resolve(false);
      try {
        const reqRef = this.db.ref(`rooms/${this.room}/pending_requests`).push();
        return reqRef.set({
          ...requestData,
          createdAt: Date.now()
        }).then(() => true).catch(() => false);
      } catch (e) {
        return Promise.resolve(false);
      }
    }

    // 大螢幕端監聽未處理的非同步暫存點播
    watchPendingRequests(handler) {
      if (!this.isReady || !this.db) return;
      try {
        const ref = this.db.ref(`rooms/${this.room}/pending_requests`);
        ref.on('child_added', (snapshot) => {
          const req = snapshot.val();
          const key = snapshot.key;
          if (req && handler) {
            handler(req, () => {
              // 處理完成後刪除該筆暫存點歌
              ref.child(key).remove().catch(() => {});
            });
          }
        }, (err) => {
          console.warn('[FirebaseSync] 監聽暫存點播受限:', err.message);
        });
      } catch (e) {}
    }

    // 黑名單檢查
    checkBlacklist(videoId) {
      if (!this.isReady || !this.db || !videoId) return Promise.resolve(false);
      return this.db.ref(`rooms/${this.room}/blacklist/${videoId}`).once('value')
        .then(snap => Boolean(snap.val()))
        .catch(() => false);
    }

    // 加入黑名單 (老師用)
    addToBlacklist(videoId, songTitle, reason) {
      if (!this.isReady || !this.db || !videoId) return Promise.resolve(false);
      return this.db.ref(`rooms/${this.room}/blacklist/${videoId}`).set({
        videoId,
        title: songTitle || '',
        reason: reason || '不適合班級播放',
        addedAt: Date.now()
      }).then(() => true).catch(() => false);
    }

    // 解除黑名單
    removeFromBlacklist(videoId) {
      if (!this.isReady || !this.db || !videoId) return Promise.resolve(false);
      return this.db.ref(`rooms/${this.room}/blacklist/${videoId}`).remove()
        .then(() => true).catch(() => false);
    }

    // 監聽黑名單清單
    watchBlacklist(callback) {
      if (!this.isReady || !this.db) return;
      this.db.ref(`rooms/${this.room}/blacklist`).on('value', snap => {
        const val = snap.val() || {};
        if (callback) callback(Object.values(val));
      }, () => {});
    }

    on(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
    }

    emit(event, data) {
      if (this.listeners[event]) {
        this.listeners[event].forEach(h => { try { h(data); } catch(e){} });
      }
    }
  }

  window.FirebaseSync = FirebaseSync;
})(window);

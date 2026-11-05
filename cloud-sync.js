/**
 * CloudSync - 班級點歌系統 全球雲端即時同步核心 (MQTT over WSS)
 * 專為 GitHub Pages 靜態網站打造，具備斷線自動重連、手機休眠喚醒、QoS 1 傳遞保證
 */
(function(window) {
  // 全球超高速穩定 MQTT 節點 (EMQX)
  const PRIMARY_BROKER = 'wss://broker.emqx.io:8084/mqtt';

  class CloudSync {
    constructor(options = {}) {
      this.role = options.role || 'client'; // 'host' (大螢幕), 'client' (學生), 'admin' (老師)
      this.room = this.getRoomCode(options.room);
      this.clientId = options.clientId || ('user_' + Math.random().toString(36).substring(2, 9));
      this.client = null;
      this.listeners = {};
      this.isConnected = false;
      this.reconnectAttempts = 0;
      this.state = {
        currentSong: null,
        queue: [],
        settings: {
          maxDuration: 360,
          maxActivePerStudent: 2,
          allowDuplicates: false,
          autoApprove: true,
          playMode: 'fifo',
          adminPassword: 'admin888'
        }
      };

      this.initMQTT();
      this.initVisibilityWatcher();
    }

    getRoomCode(defaultRoom) {
      if (defaultRoom) return defaultRoom;
      const params = new URLSearchParams(window.location.search);
      return params.get('room') || '607';
    }

    // 監聽手機/平板螢幕休眠與切換 App 喚醒
    initVisibilityWatcher() {
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            console.log('[CloudSync] 頁面回到前景，檢查連線狀態...');
            if (!this.client || !this.client.connected) {
              console.log('[CloudSync] 偵測到斷線，立即執行前景快速重連！');
              this.reconnect();
            }
          }
        });
      }
    }

    initMQTT() {
      if (typeof mqtt === 'undefined') {
        console.warn('MQTT library not loaded yet, retrying in 200ms...');
        setTimeout(() => this.initMQTT(), 200);
        return;
      }

      console.log(`[CloudSync] 正在連線至雲端廣播節點: ${PRIMARY_BROKER} (班級房間: ${this.room})`);

      try {
        // 使用隨機 ClientId 避免同座號衝突
        const mqttClientId = `${this.role}_${this.clientId}_${Math.random().toString(36).substring(2, 6)}`;

        this.client = mqtt.connect(PRIMARY_BROKER, {
          clientId: mqttClientId,
          clean: true,
          connectTimeout: 8000,
          reconnectPeriod: 2500, // 自動重連間隔
          keepalive: 30
        });

        this.client.on('connect', () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          console.log('[CloudSync] ✅ 雲端即時連線建立成功！');
          this.emit('connection_status', { connected: true, broker: PRIMARY_BROKER });

          // 訂閱班級頻道
          const topics = [
            `jukebox/${this.room}/state`,
            `jukebox/${this.room}/response/${this.clientId}`
          ];

          if (this.role === 'host') {
            topics.push(`jukebox/${this.room}/request`);
            topics.push(`jukebox/${this.room}/admin`);
          }

          topics.forEach(t => {
            this.client.subscribe(t, { qos: 1 }, (err) => {
              if (err) console.warn(`[CloudSync] 訂閱頻道失敗: ${t}`, err);
            });
          });

          // 如果是學生或老師，連線成功時索取最新狀態
          if (this.role !== 'host') {
            this.client.publish(`jukebox/${this.room}/request`, JSON.stringify({
              action: 'ping',
              clientId: this.clientId
            }), { qos: 0 });
          }
        });

        this.client.on('message', (topic, payload) => {
          try {
            const data = JSON.parse(payload.toString());
            this.handleMessage(topic, data);
          } catch (e) {
            console.error('[CloudSync] 訊息解析失敗:', e);
          }
        });

        this.client.on('offline', () => {
          console.warn('[CloudSync] 雲端連線離線中...');
          this.isConnected = false;
          this.emit('connection_status', { connected: false });
        });

        this.client.on('reconnect', () => {
          this.reconnectAttempts++;
          console.log(`[CloudSync] 正在自動重新連線中 (第 ${this.reconnectAttempts} 次)...`);
        });

        this.client.on('error', (err) => {
          console.warn('[CloudSync] 網路傳輸異常:', err.message);
          this.isConnected = false;
          this.emit('connection_status', { connected: false });
        });
      } catch (err) {
        console.error('[CloudSync] 初始化錯誤:', err);
      }
    }

    // 強制重連方法
    reconnect() {
      if (this.client) {
        try {
          this.client.reconnect();
        } catch(e) {
          try { this.client.end(true); } catch(ex) {}
          this.initMQTT();
        }
      } else {
        this.initMQTT();
      }
    }

    handleMessage(topic, data) {
      if (topic === `jukebox/${this.room}/state`) {
        this.state = data;
        this.emit('state_update', data);
      } else if (topic === `jukebox/${this.room}/request` && this.role === 'host') {
        this.emit('client_request', data);
      } else if (topic === `jukebox/${this.room}/admin` && this.role === 'host') {
        this.emit('admin_command', data);
      } else if (topic === `jukebox/${this.room}/response/${this.clientId}`) {
        this.emit('server_response', data);
      }
    }

    // 發布狀態（僅 Host 使用，支援 retained 訊息）
    publishState(state) {
      if (!this.client || !this.isConnected) return;
      this.state = state;
      this.client.publish(`jukebox/${this.room}/state`, JSON.stringify(state), { retain: true, qos: 1 });
    }

    // 回覆特定學生（Host 使用，QoS 1 確保必達）
    sendResponse(targetClientId, response) {
      if (!this.client || !this.isConnected) return;
      this.client.publish(`jukebox/${this.room}/response/${targetClientId}`, JSON.stringify(response), { qos: 1 });
    }

    // 學生送出點歌或投票（加入強制限時回呼與重試保護，絕不卡死）
    sendRequest(action, payload, callback) {
      if (!this.client || !this.isConnected) {
        // 嘗試緊急快速重連
        this.reconnect();
        if (callback) callback({ success: false, message: '目前正在重新連線雲端，請等待 1~2 秒後再試一次！' });
        return;
      }

      const reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5);
      const message = {
        action,
        reqId,
        clientId: this.clientId,
        payload,
        timestamp: Date.now()
      };

      if (callback) {
        let isDone = false;
        const handler = (res) => {
          if (res.reqId === reqId && !isDone) {
            isDone = true;
            clearTimeout(timeoutId);
            this.off('server_response', handler);
            callback(res);
          }
        };

        this.on('server_response', handler);

        // 5.5 秒防呆超時保險機制：無論大螢幕是否在線，必定解鎖按鈕並告知學生
        const timeoutId = setTimeout(() => {
          if (!isDone) {
            isDone = true;
            this.off('server_response', handler);
            callback({
              success: false,
              message: '大螢幕尚未接收到（請確認教室大螢幕播放端已開啟），請稍後再試！'
            });
          }
        }, 5500);
      }

      // QoS 1 確保點歌請求不掉包
      this.client.publish(`jukebox/${this.room}/request`, JSON.stringify(message), { qos: 1 });
    }

    // 老師送出遙控操作
    sendAdmin(action, password, payload, callback) {
      if (!this.client || !this.isConnected) {
        this.reconnect();
        if (callback) callback({ success: false, message: '雲端同步連線中，請稍後再試' });
        return;
      }

      const reqId = 'admin_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5);
      const message = {
        action,
        password,
        reqId,
        clientId: this.clientId,
        payload,
        timestamp: Date.now()
      };

      if (callback) {
        let isDone = false;
        const handler = (res) => {
          if (res.reqId === reqId && !isDone) {
            isDone = true;
            clearTimeout(timeoutId);
            this.off('server_response', handler);
            callback(res);
          }
        };
        this.on('server_response', handler);

        const timeoutId = setTimeout(() => {
          if (!isDone) {
            isDone = true;
            this.off('server_response', handler);
            callback({ success: false, message: '操作逾時，請確認大螢幕是否開啟' });
          }
        }, 5500);
      }

      this.client.publish(`jukebox/${this.room}/admin`, JSON.stringify(message), { qos: 1 });
    }

    // 簡易事件發布/訂閱
    on(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
    }

    off(event, handler) {
      if (!this.listeners[event]) return;
      this.listeners[event] = this.listeners[event].filter(h => h !== handler);
    }

    emit(event, data) {
      if (this.listeners[event]) {
        this.listeners[event].forEach(h => {
          try { h(data); } catch(e) { console.error(e); }
        });
      }
    }
  }

  // YouTube 工具函式
  window.YTUtils = {
    extractVideoId(url) {
      if (!url || typeof url !== 'string') return null;
      const trimmed = url.trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
      const regExp = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([a-zA-Z0-9_-]{11})/;
      const match = trimmed.match(regExp);
      return match ? match[1] : null;
    },

    async fetchMetadata(videoId) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 秒強制逾時
        const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          const data = await res.json();
          return {
            title: data.title || `YouTube 歌曲 (${videoId})`,
            author: data.author_name || 'YouTube 頻道',
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
          };
        }
      } catch (e) {
        console.warn('oEmbed fetch error or timeout:', e.message);
      }
      return {
        title: `YouTube 歌曲 (${videoId})`,
        author: 'YouTube 頻道',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      };
    }
  };

  window.CloudSync = CloudSync;
})(window);

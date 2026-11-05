/**
 * CloudSync - 班級點歌系統 全球雲端即時同步核心 (MQTT over WSS)
 * 專為 GitHub Pages 靜態網站打造，免伺服器、免金鑰、抗防火牆、跨網段 100% 秒連
 */
(function(window) {
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];

  class CloudSync {
    constructor(options = {}) {
      this.role = options.role || 'client'; // 'host' (大螢幕), 'client' (學生), 'admin' (老師)
      this.room = this.getRoomCode(options.room);
      this.clientId = options.clientId || ('user_' + Math.random().toString(36).substring(2, 9));
      this.brokerIndex = 0;
      this.client = null;
      this.listeners = {};
      this.isConnected = false;
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
    }

    getRoomCode(defaultRoom) {
      if (defaultRoom) return defaultRoom;
      const params = new URLSearchParams(window.location.search);
      return params.get('room') || '607';
    }

    initMQTT() {
      if (typeof mqtt === 'undefined') {
        console.warn('MQTT library not loaded yet, retrying in 200ms...');
        setTimeout(() => this.initMQTT(), 200);
        return;
      }

      const brokerUrl = BROKERS[this.brokerIndex % BROKERS.length];
      console.log(`[CloudSync] 正在連線至雲端廣播節點: ${brokerUrl} (班級房間: ${this.room})`);

      try {
        this.client = mqtt.connect(brokerUrl, {
          clientId: `${this.role}_${this.clientId}`,
          clean: true,
          connectTimeout: 5000,
          reconnectPeriod: 3000
        });

        this.client.on('connect', () => {
          this.isConnected = true;
          console.log('[CloudSync] ✅ 雲端即時連線建立成功！');
          this.emit('connection_status', { connected: true, broker: brokerUrl });

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
            this.client.subscribe(t, { qos: 0 });
          });

          // 如果是 Client 或 Admin，發送一次 ping 要求最新狀態
          if (this.role !== 'host') {
            this.client.publish(`jukebox/${this.room}/request`, JSON.stringify({
              action: 'ping',
              clientId: this.clientId
            }));
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
          this.isConnected = false;
          this.emit('connection_status', { connected: false });
        });

        this.client.on('error', (err) => {
          console.warn('[CloudSync] 連線異常，切換至備援節點:', err.message);
          this.isConnected = false;
          this.emit('connection_status', { connected: false });
          this.client.end(true);
          this.brokerIndex++;
          setTimeout(() => this.initMQTT(), 1000);
        });
      } catch (err) {
        console.error('[CloudSync] 初始化錯誤:', err);
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
      this.client.publish(`jukebox/${this.room}/state`, JSON.stringify(state), { retain: true, qos: 0 });
    }

    // 回覆特定學生（Host 使用）
    sendResponse(targetClientId, response) {
      if (!this.client || !this.isConnected) return;
      this.client.publish(`jukebox/${this.room}/response/${targetClientId}`, JSON.stringify(response), { qos: 0 });
    }

    // 學生送出點歌或投票
    sendRequest(action, payload, callback) {
      if (!this.client || !this.isConnected) {
        if (callback) callback({ success: false, message: '雲端同步連線中，請稍後再試' });
        return;
      }

      const reqId = 'req_' + Date.now();
      const message = {
        action,
        reqId,
        clientId: this.clientId,
        payload,
        timestamp: Date.now()
      };

      if (callback) {
        const handler = (res) => {
          if (res.reqId === reqId) {
            this.off('server_response', handler);
            callback(res);
          }
        };
        this.on('server_response', handler);
        // 逾時處理
        setTimeout(() => {
          this.off('server_response', handler);
        }, 8000);
      }

      this.client.publish(`jukebox/${this.room}/request`, JSON.stringify(message), { qos: 0 });
    }

    // 老師送出遙控操作
    sendAdmin(action, password, payload, callback) {
      if (!this.client || !this.isConnected) {
        if (callback) callback({ success: false, message: '雲端同步連線中，請稍後再試' });
        return;
      }

      const reqId = 'admin_' + Date.now();
      const message = {
        action,
        password,
        reqId,
        clientId: this.clientId,
        payload,
        timestamp: Date.now()
      };

      if (callback) {
        const handler = (res) => {
          if (res.reqId === reqId) {
            this.off('server_response', handler);
            callback(res);
          }
        };
        this.on('server_response', handler);
        setTimeout(() => {
          this.off('server_response', handler);
        }, 8000);
      }

      this.client.publish(`jukebox/${this.room}/admin`, JSON.stringify(message), { qos: 0 });
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
        this.listeners[event].forEach(h => h(data));
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
        const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
        if (res.ok) {
          const data = await res.json();
          return {
            title: data.title,
            author: data.author_name,
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
          };
        }
      } catch (e) {
        console.warn('oEmbed fetch error:', e);
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

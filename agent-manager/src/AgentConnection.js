// Simple EventEmitter polyfill (since we removed the Hyperfy client)
class EventEmitter {
  constructor() {
    this.events = {};
  }

  on(event, listener) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(listener);
  }

  off(event, listener) {
    if (!this.events[event]) return;
    this.events[event] = this.events[event].filter(l => l !== listener);
  }

  emit(event, ...args) {
    if (!this.events[event]) return;
    this.events[event].forEach(listener => listener(...args));
  }

  once(event, listener) {
    const wrapped = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    this.on(event, wrapped);
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

const DIRECTION_KEYS = {
  forward: 'keyW',
  backward: 'keyS',
  left: 'keyA',
  right: 'keyD',
  jump: 'space',
  action: 'keyE',
};

const DIRECTION_YAWS = {
  forward: 0,
  backward: Math.PI,
  left: Math.PI / 2,
  right: -Math.PI / 2,
};

export class AgentConnection {
  constructor(id, name, avatar) {
    this.id = id;
    this.name = name;
    this.avatar = avatar || null;
    this.status = 'connecting';
    this.ws = null;
    this.world = null; // will be a fake/minimal object for events
    this._moveTimers = [];
    this._chatListener = null;
    this._navInterval = null;
    this._navResolve = null;
    this._navReject = null;
    this._navRunning = false;
    this._currentStreamId = null;
    this._audioSeq = 0;
    this._playbackTimer = null;
    this._playbackCleanup = null;

    // Callback hooks
    this.onWorldChat = null;
    this.onKick = null;
    this.onDisconnect = null;
  }

  connect(wsUrl) {
    return new Promise((resolve, reject) => {
      this.status = 'connecting';

      const timeout = setTimeout(() => {
        this.status = 'error';
        this.ws?.close();
        reject(new Error('Connection timed out'));
      }, 15000);

      this.ws = new WebSocket(wsUrl);

      // Fake "world" object for event compatibility
      this.world = {
        events: new EventEmitter(),
        chat: {
          send: (text) => {
            if (this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type: 'chat', message: text }));
            }
          }
        },
        network: {
          send: (type, data) => {
            if (this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type, ...data }));
            }
          },
          id: null // will be set on first message if needed
        },
        controls: {
          simulateLook: (yaw) => {
            // Optional: send look command if protocol supports it
            if (yaw !== null) {
              this.ws.send(JSON.stringify({ type: 'look', yaw }));
            }
          },
          simulateButton: (key, state) => {
            // Send key press/release
            this.ws.send(JSON.stringify({ type: 'input', key, state }));
          }
        },
        destroy: () => {
          this.ws?.close();
        }
      };

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.status = 'connected';
        console.log(`Agent ${this.name} (${this.id}) connected to Hyperfy WS`);

        // Emit 'ready' event to match original
        this.world.events.emit('ready');

        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Handle chat messages
          if (data.type === 'chat' && this._chatListener) {
            this._chatListener(data.message || data);
          }

          // Handle kick
          if (data.type === 'kick') {
            this.status = 'kicked';
            console.log(`Agent ${this.name} (${this.id}) kicked: ${data.code}`);
            if (this.onKick) this.onKick(data.code);
          }

          // Optional: handle other message types (position updates, etc.)
        } catch (err) {
          console.error('Invalid WS message:', err);
        }
      };

      this.ws.onclose = () => {
        clearTimeout(timeout);
        if (this.status !== 'disconnected') {
          this.status = 'disconnected';
          console.log(`Agent ${this.name} (${this.id}) disconnected`);
          if (this.onDisconnect) this.onDisconnect();
        }
      };

      this.ws.onerror = (err) => {
        clearTimeout(timeout);
        this.status = 'error';
        console.error(`Agent ${this.name} (${this.id}) WS error:`, err);
        reject(err);
      };
    });
  }

  // The rest of your class remains unchanged
  getPlayerId() {
    return this.world?.network?.id ?? null;
  }

  getPosition() {
    // Placeholder - implement if Hyperfy sends position updates
    return null;
  }

  getYaw() {
    return null;
  }

  speak(text) {
    if (this.status !== 'connected') {
      throw new Error(`Agent is not connected (status: ${this.status})`);
    }
    this.world.chat.send(text);
  }

  face(yawOrDirection) {
    if (this.status !== 'connected') {
      throw new Error(`Agent is not connected (status: ${this.status})`);
    }
    this.cancelNavigation();
    if (typeof yawOrDirection === 'number') {
      this.world.controls.simulateLook(yawOrDirection);
    } else if (typeof yawOrDirection === 'string') {
      const yaw = DIRECTION_YAWS[yawOrDirection];
      if (yaw === undefined) {
        throw new Error(`Invalid direction: ${yawOrDirection}`);
      }
      this.world.controls.simulateLook(yaw);
    } else if (yawOrDirection === null) {
      this.world.controls.simulateLook(null);
    }
  }

  move(direction, durationMs = 1000, run = false) {
    if (this.status !== 'connected') {
      throw new Error(`Agent is not connected (status: ${this.status})`);
    }
    this.cancelNavigation();
    const key = DIRECTION_KEYS[direction];
    if (!key) {
      throw new Error(`Invalid direction: ${direction}`);
    }
    if (run) this.world.controls.simulateButton('shiftLeft', true);
    this.world.controls.simulateButton(key, true);
    const timer = setTimeout(() => {
      this.world.controls.simulateButton(key, false);
      if (run) this.world.controls.simulateButton('shiftLeft', false);
      const idx = this._moveTimers.indexOf(timer);
      if (idx !== -1) this._moveTimers.splice(idx, 1);
    }, durationMs);
    this._moveTimers.push(timer);
  }

  navigateTo(targetX, targetZ, { arrivalRadius = 2.0, timeout = 30000, getTargetPos = null, run = false } = {}) {
    // Same as original - uses simulateLook and simulateButton
    if (this.status !== 'connected') {
      return Promise.reject(new Error(`Agent is not connected (status: ${this.status})`));
    }
    this.cancelNavigation();

    return new Promise((resolve) => {
      const startTime = Date.now();
      this._navResolve = resolve;
      this._navRunning = run;

      const tick = () => {
        // Position tracking placeholder - implement if needed
        const pos = this.getPosition() || { x: 0, z: 0 };
        let tx = targetX;
        let tz = targetZ;
        if (getTargetPos) {
          const tp = getTargetPos();
          if (tp) {
            tx = tp.x;
            tz = tp.z;
          }
        }
        const dx = tx - pos.x;
        const dz = tz - pos.z;
        const distance = Math.sqrt(dx * dx + dz * dz);

        if (distance <= arrivalRadius) {
          this.world.controls.simulateButton('keyW', false);
          if (run) this.world.controls.simulateButton('shiftLeft', false);
          this.world.controls.simulateLook(null);
          this._cleanupNav();
          resolve({ arrived: true, position: pos, distance: round2(distance) });
          return;
        }

        if (Date.now() - startTime > timeout) {
          this.world.controls.simulateButton('keyW', false);
          if (run) this.world.controls.simulateButton('shiftLeft', false);
          this.world.controls.simulateLook(null);
          this._cleanupNav();
          resolve({ arrived: false, position: pos, distance: round2(distance), error: 'Navigation timeout' });
          return;
        }

        const yaw = Math.atan2(-dz, -dx);
        this.world.controls.simulateLook(yaw);
        if (run) this.world.controls.simulateButton('shiftLeft', true);
        this.world.controls.simulateButton('keyW', true);
      };

      tick();
      this._navInterval = setInterval(tick, 200);
    });
  }

  cancelNavigation() {
    // Same as original
    if (this._navInterval) {
      clearInterval(this._navInterval);
      this._navInterval = null;
    }
    if (this._navResolve) {
      if (this.world && this.status === 'connected') {
        this.world.controls.simulateButton('keyW', false);
        if (this._navRunning) this.world.controls.simulateButton('shiftLeft', false);
        this.world.controls.simulateLook(null);
      }
      const resolve = this._navResolve;
      this._navResolve = null;
      this._navReject = null;
      this._navRunning = false;
      const pos = this.getPosition();
      resolve({ arrived: false, position: pos, distance: null, error: 'Cancelled' });
    }
  }

  _cleanupNav() {
    if (this._navInterval) {
      clearInterval(this._navInterval);
      this._navInterval = null;
    }
    this._navResolve = null;
    this._navReject = null;
  }

  // Audio methods remain unchanged - they use world.network.send which we defined as WS send
  startAudioStream({ sampleRate = 24000, channels = 1, format = 's16' } = {}) {
    if (this.status !== 'connected') {
      throw new Error(`Agent is not connected (status: ${this.status})`);
    }
    if (this._currentStreamId) {
      throw new Error('Audio stream already active. Stop it first.');
    }
    if (format !== 'f32' && format !== 's16') {
      throw new Error(`Invalid format: ${format}. Use 'f32' or 's16'`);
    }
    if (channels !== 1 && channels !== 2) {
      throw new Error('Channels must be 1 or 2');
    }
    if (sampleRate < 8000 || sampleRate > 48000) {
      throw new Error('Sample rate must be between 8000 and 48000');
    }

    this._currentStreamId = crypto.randomUUID();
    this._audioSeq = 0;

    this.world.network.send('audioStreamStart', {
      streamId: this._currentStreamId,
      playerId: this.getPlayerId(),
      sampleRate,
      channels,
      format,
    });

    return this._currentStreamId;
  }

  pushAudioData(seq, samples) {
    if (!this._currentStreamId) return;
    if (this.status !== 'connected') return;

    const samplesArray = samples instanceof Uint8Array
      ? samples
      : new Uint8Array(samples.buffer || samples);

    this.world.network.send('audioStreamData', {
      streamId: this._currentStreamId,
      seq: seq !== undefined ? seq : this._audioSeq++,
      samples: samplesArray,
    });
  }

  stopAudioStream() {
    if (!this._currentStreamId) return;

    if (this.status === 'connected') {
      this.world.network.send('audioStreamStop', {
        streamId: this._currentStreamId,
      });
    }

    this._currentStreamId = null;
    this._audioSeq = 0;
  }

  // ... rest of the class remains unchanged ...
  disconnect() {
    this._stopPlayback();
    this.stopAudioStream();
    this.cancelNavigation();
    for (const timer of this._moveTimers) {
      clearTimeout(timer);
    }
    this._moveTimers = [];
    if (this.world && this.status === 'connected') {
      this.world.controls.simulateButton('shiftLeft', false);
    }
    if (this.ws) {
      this.ws.close();
    }
    this.status = 'disconnected';
    this.ws = null;
    this.world = null;
    this.onWorldChat = null;
    this.onKick = null;
    this.onDisconnect = null;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      avatar: this.avatar,
      status: this.status,
    };
  }
}
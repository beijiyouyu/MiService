const { EventEmitter } = require("events");

const MUSIC_COMMANDS = [
  { pattern: /^播放音乐(.+)/, command: "play" },
  { pattern: /^播放歌曲(.+)/, command: "play" },
  { pattern: /^我想听\s*(.+)/, command: "play" },
  { pattern: /^我要听\s*(.+)/, command: "play" },
  { pattern: /^播放\s+(.+)/, command: "play" },
  { pattern: /^听\s+(.+)/, command: "play" },
  { pattern: /^(上一曲|上一首)$/, command: "prev", songName: null },
  { pattern: /^(下一曲|下一首)$/, command: "next", songName: null },
];

function parseMusicCommand(question) {
  const q = question.trim();
  for (const rule of MUSIC_COMMANDS) {
    const match = q.match(rule.pattern);
    if (match) {
      const songName =
        rule.songName !== undefined ? rule.songName : (match[1] || "").trim();
      if (rule.command !== "play") {
        return { command: rule.command, songName: null };
      }
      if (songName) {
        return { command: "play", songName };
      }
    }
  }
  return null;
}

class MiNAListener extends EventEmitter {
  constructor(minaService, deviceId, options = {}) {
    super();
    this.mina = minaService;
    this.deviceId = deviceId;
    this.mina.deviceId = deviceId; // 设置到 service 上供 API 调用使用
    this.interval = options.interval || 1000;
    this.running = false;
    this._timer = null;
    this._pollCount = 0;
    this._initialized = false;
  }

  async poll() {
    this._pollCount++;
    this.emit("poll", this._pollCount);
    try {
      const msg = await this.mina.fetchNextMessage();
      if (msg) {
        // 先检测音乐口令（在过滤之前，因为播放音乐时 answers 有 TTS+Audio 两条）
        const musicCmd = parseMusicCommand(msg.text);
        if (musicCmd) {
          this.emit("music", {
            ...musicCmd,
            question: msg.text,
            answer: "",
            requestId: msg.id,
            timestamp: msg.timestamp,
          });
          return; // 音乐口令不走普通消息
        }

        // 过滤：只处理 TTS/LLM 类型且只有一条 answer 的记录
        // 播放音乐时会有 TTS + Audio 两条 answer，跳过
        const answers = msg.answers || [];
        const isValid =
          ["TTS", "LLM"].includes(
            (answers[0] && answers[0].type) || ""
          ) && answers.length === 1;

        if (isValid) {
          const data = {
            question: msg.text,
            answer: answers[0] ? answers[0].tts || "" : "",
            domain: answers[0] ? answers[0].type || "" : "",
            action: "",
            requestId: msg.id,
            timestamp: msg.timestamp,
          };
          this.emit("message", data);
        }
      }
    } catch (e) {
      this.emit("error", e);
    }
  }

  async start() {
    if (this.running) return;
    // 初始化 hardware（对标参考代码 MiNA.getDevice）
    if (!this.mina.hardware) {
      const devices = await this.mina.device_list();
      const device = (devices || []).find(d => d.deviceID === this.deviceId);
      if (device) {
        this.mina.hardware = device.hardware || "";
      }
    }
    this.running = true;
    this._timer = setInterval(() => this.poll(), this.interval);
    this.poll();
    this.emit("start");
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.emit("stop");
  }
}

async function createListener(minaService, deviceId, options = {}) {
  return new MiNAListener(minaService, deviceId, options);
}

module.exports = { MiNAListener, createListener, parseMusicCommand };

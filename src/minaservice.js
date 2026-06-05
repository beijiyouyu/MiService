const { get_random } = require("./miaccount");

const _USE_PLAY_MUSIC_API = [
  "LX04",
  "LX05",
  "L05B",
  "L05C",
  "L06",
  "L06A",
  "X08A",
  "X10A",
  "X08C",
  "X08E",
  "X8F",
  "X4B",
  "OH2",
  "OH2P",
  "X6A",
];

class MiNAService {
  constructor(account) {
    this.account = account;
    this.device2hardware = {};
    this.deviceId = null; // 当前监听的设备 ID
    this.hardware = null; // 当前设备的 hardware
    // 对话轮询状态（对标参考代码 MiMessage）
    this._lastQueryMsg = null;
    this._tempQueryMsgs = [];
  }

  async mina_request(uri, data = null, baseUrl = "https://api2.mina.mi.com", extraCookies = {}) {
    const requestId = "app_ios_" + get_random(30);
    if (data !== null) {
      data.requestId = requestId;
    } else {
      uri += "&requestId=" + requestId;
    }
    const headers = {
      "User-Agent":
        "MiHome/6.0.103 (com.xiaomi.mihome; build:6.0.103.1; iOS 14.4.0) Alamofire/6.0.103 MICO/iOSApp/appStore/6.0.103",
    };
    return this.account.mi_request(
      "micoapi",
      baseUrl + uri,
      data,
      headers,
      extraCookies
    );
  }

  async device_list(master = 0) {
    const result = await this.mina_request(
      "/admin/v2/device_list?master=" + master
    );
    return result ? result.data : null;
  }

  async ubus_request(deviceId, method, path, message) {
    const messageStr = JSON.stringify(message);
    return this.mina_request("/remote/ubus", {
      deviceId: deviceId,
      message: messageStr,
      method: method,
      path: path,
    });
  }

  /**
   * 获取对话历史记录（对标参考代码 MiNA.getConversations）
   */
  async getConversations(options = {}) {
    const { limit = 10, timestamp } = options;
    let uri =
      "/device_profile/v2/conversation?limit=" +
      limit +
      "&source=dialogu" +
      "&hardware=" + encodeURIComponent(this.hardware || "");
    if (timestamp) {
      uri += "&timestamp=" + timestamp;
    }
    const result = await this.mina_request(
      uri,
      null,
      "https://userprofile.mina.mi.com",
      { deviceId: this.deviceId }
    );
    if (!result || !result.data) {
      return { records: [] };
    }
    return JSON.parse(result.data);
  }

  /**
   * 拉取并格式化对话记录（对标参考代码 _fetchHistoryMsgs）
   * filterAnswer=true 时过滤掉非 TTS/LLM 类型和多 answer 的记录
   */
  async fetchHistoryMsgs(options = {}) {
    const { limit = 10, timestamp } = options;
    const conversation = await this.getConversations({ limit, timestamp });
    const records = conversation.records || [];
    return records.map((e) => ({
      id: get_random(16),
      sender: "user",
      text: e.query,
      timestamp: e.time,
      // 保留原始 answers 供上层判断
      answers: e.answers || [],
    }));
  }

  /**
   * @deprecated 使用 fetchNextMessage 替代
   */
  async get_latest_ask(deviceId) {
    return this.fetchNextMessage();
  }

  /**
   * 获取下一条新消息（对标参考代码 MiMessage.fetchNextMessage）
   */
  async fetchNextMessage() {
    if (!this._lastQueryMsg) {
      return this._fetchFirstMessage();
    }
    return this._fetchNextMessage();
  }

  async _fetchFirstMessage() {
    const msgs = await this.fetchHistoryMsgs({
      limit: 1,
      filterAnswer: false,
    });
    this._lastQueryMsg = msgs[0];
    return undefined;
  }

  async _fetchNextMessage() {
    if (this._tempQueryMsgs.length > 0) {
      return this._fetchNextTempMessage();
    }
    const nextMsg = await this._fetchNext2Messages();
    if (nextMsg !== "continue") {
      return nextMsg;
    }
    return this._fetchNextRemainingMessages();
  }

  /**
   * 拉取最新的 2 条消息，用于和上一条消息比对是否连续
   */
  async _fetchNext2Messages() {
    const msgs = await this.fetchHistoryMsgs({ limit: 2 });
    if (
      msgs.length < 1 ||
      msgs[0].timestamp <= this._lastQueryMsg.timestamp
    ) {
      return;
    }
    if (
      msgs[0].timestamp > this._lastQueryMsg.timestamp &&
      (msgs.length === 1 ||
        msgs[msgs.length - 1].timestamp <= this._lastQueryMsg.timestamp)
    ) {
      this._lastQueryMsg = msgs[0];
      return this._lastQueryMsg;
    }
    for (const msg of msgs) {
      if (msg.timestamp > this._lastQueryMsg.timestamp) {
        this._tempQueryMsgs.push(msg);
      }
    }
    return "continue";
  }

  /**
   * 继续向上拉取其他新消息
   */
  async _fetchNextRemainingMessages(options) {
    let currentPage = 0;
    const { maxPage = 3, pageSize = 10 } = options ?? {};
    while (true) {
      currentPage++;
      if (currentPage > maxPage) {
        return this._fetchNextTempMessage();
      }
      const nextTimestamp =
        this._tempQueryMsgs[this._tempQueryMsgs.length - 1].timestamp;
      const msgs = await this.fetchHistoryMsgs({
        limit: pageSize,
        timestamp: nextTimestamp,
      });
      for (const msg of msgs) {
        if (msg.timestamp >= nextTimestamp) {
          // 跳过游标消息本身
        } else if (msg.timestamp > this._lastQueryMsg.timestamp) {
          this._tempQueryMsgs.push(msg);
        } else {
          return this._fetchNextTempMessage();
        }
      }
    }
  }

  /**
   * 读取暂存的消息
   */
  _fetchNextTempMessage() {
    const nextMsg = this._tempQueryMsgs.pop();
    this._lastQueryMsg = nextMsg;
    return nextMsg;
  }

  async text_to_speech(deviceId, text) {
    return this.ubus_request(deviceId, "text_to_speech", "mibrain", {
      text: text,
    });
  }

  async player_set_volume(deviceId, volume) {
    return this.ubus_request(
      deviceId,
      "player_set_volume",
      "mediaplayer",
      { volume: volume, media: "app_ios" }
    );
  }

  async player_pause(deviceId) {
    return this.ubus_request(
      deviceId,
      "player_play_operation",
      "mediaplayer",
      { action: "pause", media: "app_ios" }
    );
  }

  async player_stop(deviceId) {
    return this.ubus_request(
      deviceId,
      "player_play_operation",
      "mediaplayer",
      { action: "stop", media: "app_ios" }
    );
  }

  /**
   * 立即打断小爱 TTS 语音输出
   */
  async stop_tts(deviceId) {
    return this.ubus_request(
      deviceId,
      "stop_tts",
      "mibrain",
      {}
    );
  }

  async player_play(deviceId) {
    return this.ubus_request(
      deviceId,
      "player_play_operation",
      "mediaplayer",
      { action: "play", media: "app_ios" }
    );
  }

  async player_get_status(deviceId) {
    return this.ubus_request(
      deviceId,
      "player_get_play_status",
      "mediaplayer",
      { media: "app_ios" }
    );
  }

  async player_set_loop(deviceId, type = 1) {
    return this.ubus_request(
      deviceId,
      "player_set_loop",
      "mediaplayer",
      { media: "common", type: type }
    );
  }

  async play_by_url(deviceId, url, _type = 2) {
    if (!(deviceId in this.device2hardware)) {
      await this._init_devices();
    }
    const hardware = this.device2hardware[deviceId];
    if (_USE_PLAY_MUSIC_API.includes(hardware)) {
      return this.play_by_music_url(deviceId, url, _type);
    } else {
      return this.ubus_request(
        deviceId,
        "player_play_url",
        "mediaplayer",
        { url: url, type: _type, media: "app_ios" }
      );
    }
  }

  async _init_devices() {
    const hardwareData = await this.device_list();
    for (const h of hardwareData) {
      const deviceId = h.deviceID || "";
      const hardware = h.hardware || "";
      if (deviceId && hardware) {
        this.device2hardware[deviceId] = hardware;
      }
    }
  }

  async play_by_music_url(
    deviceId,
    url,
    _type = 2,
    audio_id = "1582971365183456177",
    id = "355454500"
  ) {
    let audio_type = "";
    if (_type === 1) {
      audio_type = "MUSIC";
    }
    const music = {
      payload: {
        audio_type: audio_type,
        audio_items: [
          {
            item_id: {
              audio_id: audio_id,
              cp: {
                album_id: "-1",
                episode_index: 0,
                id: id,
                name: "xiaowei",
              },
            },
            stream: { url: url },
          },
        ],
        list_params: {
          listId: "-1",
          loadmore_offset: 0,
          origin: "xiaowei",
          type: "MUSIC",
        },
      },
      play_behavior: "REPLACE_ALL",
    };
    return this.ubus_request(
      deviceId,
      "player_play_music",
      "mediaplayer",
      { startaudioid: audio_id, music: JSON.stringify(music) }
    );
  }

  async send_message(devices, devno, message, volume = null) {
    let result = false;
    for (let i = 0; i < devices.length; i++) {
      if (
        devno === -1 ||
        devno !== i + 1 ||
        (devices[i].capabilities && devices[i].capabilities.yunduantts)
      ) {
        const deviceId = devices[i].deviceID;
        result =
          volume === null
            ? true
            : await this.player_set_volume(deviceId, volume);
        if (result && message) {
          result = await this.text_to_speech(deviceId, message);
        }
        if (!result) {
          console.error("Send failed:", message || volume);
        }
        if (devno !== -1 || !result) break;
      }
    }
    return result;
  }
}

module.exports = { MiNAService };

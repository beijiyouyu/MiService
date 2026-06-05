# MiService
> Nodejs版本的小爱音箱控制服务，可以控制设备，拦截对话实现接管播放自己的音乐源

- 灵感来源1-主要实现设备控制和音频播放：https://github.com/yihong0618/MiService
- 灵感来源2-主要实现用户输入监听：https://github.com/idootop/migpt-next
- 使用原生 HTTP 请求解决跳转Cookies问题。

## 安装

### 作为依赖安装（推荐）

```bash
npm install @bjyy/miservice
pnpm add @bjyy/miservice
```

或使用 pnpm/yarn：

```bash
pnpm add miservice
yarn add miservice
```

### 全局安装（CLI 工具）

全局安装后可直接使用 `miservice` 命令：

```bash
npm install -g miservice
```

### 开发模式（克隆仓库）

```bash
git clone https://github.com/beijiyouyu/MiService.git
cd MiService
pnpm install
```

## 配置

在项目根目录创建 `.env` 文件：

```env
MI_USER=你的小米账号
MI_PASS=你的密码
MI_DID=你的设备miotDID（数字，可选，用于 MiNA 命令和 CLI 的 did 参数）
MI_PASS_TOKEN=你的passToken（可选，首次登录失败后自动填入）
POLL_INTERVAL=2000（可选，轮询间隔毫秒，默认2000）
MUSIC_API=https://your-music-api.com/search（可选，音乐搜索接口，接收歌名返回音频URL）
```

## 登录说明

首次运行时会自动尝试登录。如果登录失败，会提示手动输入 `passToken` 和 `userId`，输入后自动保存到 `.env` 和项目根目录的 `.mi.token` 文件中，后续运行无需重复输入。

手动获取方式：浏览器登录 https://account.xiaomi.com → F12 → Application → Cookies → account.xiaomi.com → 复制 `passToken` 和 `userId`。

## CLI 命令

全局安装后可直接使用 `miservice` 命令。开发模式下使用 `miservice`。

```bash
# 查看帮助
miservice

# 开启日志（-v 到 -v5，数字越大越详细）
miservice -v4 list
```

### 设备管理

```bash
# 列出所有设备
miservice list

# 按名称过滤设备
miservice list Light

# 列出完整设备信息（含虚拟模型和华米设备）
miservice list full true 1

# 查看 MiNA 设备列表（小爱音箱）
miservice mina
```

### MIoT 属性操作

```bash
# 获取属性（siid-piid 格式，逗号分隔）
miservice <did> 1,1-2,1-3,1-4,2-1,2-2,3

# 设置属性（值前加 # 表示数字）
miservice <did> 2=#60,2-2=#false,3=test

# 执行动作
miservice <did> 5 Hello
miservice <did> 5-4 Hello #1

# 使用 #NA 表示无参数
miservice <did> 2 #NA
```

### MIoT Spec查看可用的命令属性

```bash
# 查看所有 spec
miservice spec

# 按型号搜索
miservice spec speaker

# 指定设备型号，x08cRedmi小爱触屏音箱 8
miservice spec xiaomi.wifispeaker.x08c

# 指定 URN
miservice spec urn:miot-spec-v2:device:speaker:0000A015:xiaomi-lx04:1

# 输出格式（text/python/json）
miservice spec xiaomi.wifispeaker.lx04 json
```

### 原始 MiIO 请求

```bash
# 调用 MiIO API
miservice <did> /home/device_list '{"getVirtualModel":false,"getHuamiDevices":1}'

# 调用 MIoT 接口
miservice <did> action '{"did":"267090026","siid":5,"aiid":1,"in":["Hello"]}'
```

### 小爱音箱控制

需要设置 `MI_DID` 环境变量。

```bash
# TTS 播报
miservice message "你好，世界"

# 播放音频 URL
miservice play https://example.com/music.mp3

# 单曲循环
miservice loop https://example.com/music.mp3

# 暂停/停止
miservice pause
miservice stop

# 播放列表（文件每行一个 URL）
miservice play_list urls.txt

# 播放 Suno 热门歌曲
miservice suno

# 随机播放 Suno 热门歌曲
miservice suno_random
```

### 数据解密

```bash
# 解密 RC4 加密数据
miservice decode <ssecurity> <nonce> <data> [gzip]
```

### 监听用户对话

实时轮询音箱的对话记录，支持口令识别，适用于接入 AI 自动回复和音乐搜索。

克隆仓库后可直接运行独立脚本：

```bash
# 使用 .env 中的 POLL_INTERVAL（默认 2000ms）
node startMusicService.js

# 命令行参数覆盖轮询间隔
node startMusicService.js 1000
```

npm 用户请参考下方「编程调用」章节，通过 `MiNAListener` API 实现相同功能。

支持的口令：
- `播放音乐xxx` / `播放歌曲xxx` / `我想听xxx` / `我要听xxx` — 提取歌名，触发 `music` 事件（command=play）
- `上一曲` / `上一首` — 触发 `music` 事件（command=prev）
- `下一曲` / `下一首` — 触发 `music` 事件（command=next）

配置 `MUSIC_API` 后，说"我想听周杰伦的晴天"会自动调用接口搜索并播放。接口需接收 `name` 参数并返回音频 URL：

```bash
# 接口调用示例
curl "https://your-music-api.com/search?name=周杰伦的晴天"
# 返回 JSON：{ "url": "https://xxx.mp3" }
# 或直接返回纯文本 URL
```

## 编程调用

### 基础用法

```js
require('dotenv').config();
const path = require('path');
const { MiIOService, MiNAService, createAccount } = require('miservice');

async function main() {
  const TOKEN_PATH = path.join(process.cwd(), '.mi.token');
  const account = await createAccount(TOKEN_PATH);
  if (!account) return;

  // MiIO 服务
  const miio = new MiIOService(account);
  const devices = await miio.device_list();
  console.log(devices);

  // MiNA 服务（小爱音箱）
  // MI_DID 是 miotDID（数字），需要转换为 MiNA 的 deviceID（UUID）
  const mina = new MiNAService(account);
  const minaDevices = await mina.device_list();
  const device = minaDevices.find(d => d.miotDID === String(process.env.MI_DID));
  if (!device) throw new Error('Device not found: ' + process.env.MI_DID);
  const deviceId = device.deviceID;

  // TTS 播报
  await mina.text_to_speech(deviceId, '你好');

  // 播放音乐链接
  await mina.play_by_url(deviceId, 'https://example.com/music.mp3');

  // 设置音量 (0-100)
  await mina.player_set_volume(deviceId, 50);

  // 播放控制
  await mina.player_pause(deviceId);    // 暂停音乐
  await mina.player_play(deviceId);     // 继续播放
  await mina.player_stop(deviceId);     // 停止音乐
  await mina.player_set_loop(deviceId, 0);  // 单曲循环
  await mina.player_set_loop(deviceId, 1);  // 列表循环
  await mina.player_get_status(deviceId);   // 获取播放状态

  // 打断小爱语音输出（TTS 说的是 mibrain 服务，player_stop 打不断）
  await mina.stop_tts(deviceId);        // 立即打断小爱正在说的话
}

main();
```

### 监听用户对话

通过 `MiNAListener` 轮询音箱对话记录，自动识别用户输入的文字。支持普通对话和音乐口令两种事件。

```js
require('dotenv').config();
const path = require('path');
const { MiNAService, MiNAListener, createAccount } = require('miservice');

async function main() {
  const TOKEN_PATH = path.join(process.cwd(), '.mi.token');
  const account = await createAccount(TOKEN_PATH);
  if (!account) return;

  // MiNA 服务（小爱音箱）
  const mina = new MiNAService(account);
  const minaDevices = await mina.device_list();
  const device = minaDevices.find(d => d.miotDID === String(process.env.MI_DID));
  if (!device) throw new Error('Device not found: ' + process.env.MI_DID);
  const deviceId = device.deviceID;

  // 创建监听器（自动设置 deviceId 和 hardware）
  const listener = new MiNAListener(mina, deviceId, { interval: 1000 });

  // 普通对话（过滤掉播放音乐等非对话类消息）
  listener.on('message', (msg) => {
    console.log('用户问:', msg.question);
    console.log('音箱答:', msg.answer);
    console.log('消息类型:', msg.domain);   // "TTS" 或 "LLM"
    console.log('时间戳:', msg.timestamp);
  });

  // 音乐口令（播放音乐/我想听/上一曲/下一曲等）
  listener.on('music', async (msg) => {
    console.log('🎵 音乐口令:', msg.command, msg.songName || '');
    if (msg.command === 'play' && msg.songName) {
      const musicApi = process.env.MUSIC_API;
      if (musicApi) {
        try {
          await mina.stop_tts(deviceId);       // 先打断小爱语音
          // 自行实现搜索逻辑，返回音频 URL
          const audioUrl = await searchMusic(musicApi, msg.songName);
          await mina.play_by_url(deviceId, audioUrl);
          console.log('🎶 播放:', audioUrl);
        } catch (e) {
          console.error('❌ 搜索失败:', e.message);
        }
      }
    }
  });

  // 错误处理
  listener.on('error', (e) => console.error('[Error]', e.message));

  // 启动（会自动初始化 hardware，首次拉取基线消息）
  await listener.start();

  process.on('SIGINT', () => {
    listener.stop();
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
```

#### MiNAService 对话相关方法

```js
// 获取对话历史（对标 MiNA.getConversations）
// 返回原始记录，包含 query、time、answers 等字段
const conversation = await mina.getConversations({ limit: 10, timestamp: undefined });
console.log(conversation.records); // [{ query: "我想听周杰伦的晴天", time: 1234567890, answers: [...] }, ...]

// 拉取并格式化对话记录（对标 _fetchHistoryMsgs）
// 返回格式化后的消息数组：{ id, sender, text, timestamp, answers }
const msgs = await mina.fetchHistoryMsgs({ limit: 10 });
for (const msg of msgs) {
  console.log(msg.text);       // 用户输入的文字
  console.log(msg.timestamp);  // 时间戳
  console.log(msg.answers);    // 原始 answers 数组
}

// 获取下一条新消息（对标 MiMessage.fetchNextMessage）
// 内部维护 _lastQueryMsg 和 _tempQueryMsgs 状态，自动去重
// 返回单条消息 { id, sender, text, timestamp, answers } 或 undefined（无新消息）
const msg = await mina.fetchNextMessage();
```

#### 搜索音乐并播放

音乐搜索是业务逻辑，需要自行实现。示例（使用 `fetch`）：

```js
async function searchMusic(apiUrl, musicName) {
  const url = new URL(apiUrl);
  url.searchParams.set('musicName', musicName);
  const res = await fetch(url.href);
  const data = await res.json();
  const audioUrl = data.url || (data.data && data.data.url);
  if (!audioUrl) throw new Error('接口未返回音频地址');
  return audioUrl;
}

// 在 music 事件中使用
await mina.stop_tts(deviceId);        // 先打断小爱语音
const audioUrl = await searchMusic(process.env.MUSIC_API, '周杰伦的晴天');
await mina.play_by_url(deviceId, audioUrl);
```

#### 事件数据结构

**message 事件**：
```js
{
  question: "今天天气怎么样",  // 用户输入的文字
  answer: "今天晴天",          // 音箱回复（TTS 文本）
  domain: "TTS",               // 消息类型（TTS / LLM）
  action: "",
  requestId: "abc123",         // 请求 ID
  timestamp: 1234567890        // 时间戳
}
```

**music 事件**：
```js
{
  command: "play",             // "play" / "prev" / "next"
  songName: "周杰伦的晴天",    // 歌名（prev/next 时为 null）
  question: "我想听周杰伦的晴天",
  answer: "",
  requestId: "abc123",
  timestamp: 1234567890
}
```

## 技术说明

- HTTP 请求使用 Node.js 原生 `https`/`http` 模块，无第三方 HTTP 依赖
- 加密使用 Node.js 内置 `crypto` 模块（MD5/SHA1/SHA256/HMAC-SHA256/RC4）
- 小米 API 返回的 `nonce` 为大整数，从原始 JSON 文本提取字符串避免精度丢失
- 重定向链中的 cookies 自动累积，确保 `serviceToken` 正确获取

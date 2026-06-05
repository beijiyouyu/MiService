# MiService
> Nodejs版本的小爱音箱控制服务，可以控制设备，拦截对话实现接管播放自己的音乐源

- 灵感来源1-主要实现设备控制和音频播放：https://github.com/yihong0618/MiService
- 灵感来源2-主要实现用户输入监听：https://github.com/idootop/migpt-next
- 使用原生 HTTP 请求解决跳转Cookies问题。

## 安装

### 作为依赖安装（推荐）

```bash
npm install @bjyy/miservice
# 或
pnpm add @bjyy/miservice
# 或
yarn add @bjyy/miservice
```

### 全局安装（CLI 工具）

全局安装后可直接使用 `miservice` 命令：

```bash
npm install -g @bjyy/miservice
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

### 完整示例：监听对话并自动播放音乐

#### 依赖包模式

1. 安装依赖`pnpm add @bjyy/miservice`
2. 创建startMusicService.js文件，输入如下代码即可运行

```js
require('dotenv').config();
const path = require('path');
const { MiNAService, MiNAListener, createAccount } = require('@bjyy/miservice');

const TOKEN_PATH = path.join(process.cwd(), '.mi.token');

function findDeviceId(hardwareData, miDid) {
  for (const h of hardwareData) {
    if (h.miotDID === String(miDid)) return h.deviceID;
  }
  throw new Error('Device not found: ' + miDid);
}

/**
 * 调用音乐搜索接口，返回音频 URL
 * 接口约定：GET apiUrl?musicName=歌名 → { "data": { "url": "https://xxx.mp3" } }
 */
async function searchMusic(apiUrl, musicName) {
  const url = new URL(apiUrl);
  url.searchParams.set('musicName', musicName);
  const res = await fetch(url.href);
  const data = await res.json();
  const audioUrl = data.url || (data.data && data.data.url);
  if (!audioUrl) throw new Error('接口未返回音频地址: ' + JSON.stringify(data));
  return audioUrl;
}

async function main() {
  const env = process.env;
  if (!env.MI_DID) {
    console.error('请在 .env 中设置 MI_DID');
    process.exit(1);
  }

  // 轮询间隔：命令行参数 > .env POLL_INTERVAL > 默认 2000ms
  const interval = parseInt(process.argv[2]) || parseInt(env.POLL_INTERVAL) || 2000;

  // 登录小米账号（优先 .env 中的 MI_PASS_TOKEN，失败时提示手动输入）
  const account = await createAccount(TOKEN_PATH);
  if (!account) process.exit(1);

  // MiNA 服务（小爱音箱）
  const mina = new MiNAService(account);
  const devices = await mina.device_list();
  const deviceId = findDeviceId(devices, env.MI_DID);
  const musicApi = env.MUSIC_API;

  console.log(`设备: ${devices[0].name} (${deviceId})`);
  console.log(`轮询间隔: ${interval}ms`);
  if (musicApi) console.log(`音乐接口: ${musicApi}`);
  console.log('按 Ctrl+C 停止\n');

  // 创建监听器（自动设置 deviceId 和 hardware）
  const listener = new MiNAListener(mina, deviceId, { interval });

  // 普通对话（过滤掉播放音乐等非对话类消息）
  listener.on('message', (msg) => {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    console.log(`[${time}] 问: ${msg.question}`);
    console.log(`[${time}] 答: ${msg.answer}\n`);
  });

  // 音乐口令（播放音乐/我想听/上一曲/下一曲等）
  listener.on('music', async (msg) => {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const action =
      msg.command === 'play' ? `🎵 搜索: ${msg.songName}` :
      msg.command === 'prev' ? '⏮ 上一曲' : '⏭ 下一曲';
    console.log(`[${time}] ${action}`);
    console.log(`[${time}] 原文: ${msg.question}`);

    // 播放音乐
    if (msg.command === 'play' && msg.songName && musicApi) {
      try {
        await mina.stop_tts(deviceId);
        console.log(`🔍 正在搜索: ${msg.songName}`);
        const audioUrl = await searchMusic(musicApi, msg.songName);
        await mina.play_by_url(deviceId, audioUrl);
        console.log(`🎶 播放: ${audioUrl}`);
      } catch (e) {
        console.error(`❌ 搜索失败: ${e.message}`);
      }
    }
    console.log();
  });

  // 错误处理
  listener.on('error', (e) => {
    console.error('[Error]', e.message);
  });

  // 轮询状态
  listener.on('poll', (count) => {
    if (count <= 3 || count % 60 === 0) {
      console.log(`[${new Date().toLocaleTimeString()}] 轮询 #${count}`);
    }
  });

  // 启动（会自动初始化 hardware，首次拉取基线消息）
  listener.on('start', () => {
    console.log('监听已启动，试试对音箱说: 我想听周杰伦的晴天\n');
  });

  listener.start();

  process.on('SIGINT', () => {
    listener.stop();
    console.log('\n已停止');
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
```

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

### 快速开始

```bash
npm install @bjyy/miservice
```

创建 `.env` 文件配置账号信息，然后编写代码：

```js
require('dotenv').config();
const path = require('path');
const { createAccount, MiIOService, MiNAService, MiNAListener } = require('@bjyy/miservice');

async function main() {
  // 创建账号并登录（首次会自动登录，token 保存到 .mi.token）
  const TOKEN_PATH = path.join(process.cwd(), '.mi.token');
  const account = await createAccount(TOKEN_PATH);
  if (!account) return;

  // 创建服务实例
  const miio = new MiIOService(account);
  const mina = new MiNAService(account);

  // 获取设备列表
  const devices = await miio.device_list();
  console.log('设备列表:', devices);
}

main().catch(console.error);
```

### MiIOService — 设备控制

用于控制小米 IoT 设备（灯、插座、空调等）。

```js
const { MiIOService } = require('@bjyy/miservice');
const miio = new MiIOService(account);

// 获取设备列表
const devices = await miio.device_list();
// 返回: [{ name: "客厅灯", model: "yeelink.light.lamp1", did: "123456", token: "xxx" }, ...]

// 按名称过滤设备
const lights = await miio.device_list('Light');

// 获取单个属性 (siid, piid)
const brightness = await miio.miot_get_prop('123456', [2, 1]);

// 批量获取属性
const values = await miio.miot_get_props('123456', [[2, 1], [2, 2], [2, 3]]);

// 设置属性 (siid, piid, value)
await miio.miot_set_prop('123456', [2, 1], 100);

// 批量设置属性
await miio.miot_set_props('123456', [[2, 1, 100], [2, 2, true]]);

// 执行动作 (siid, aiid, args)
await miio.miot_action('123456', [5, 1], ['Hello']);

// 查看设备 MIoT Spec（属性和动作定义）
const spec = await miio.miot_spec('yeelink.light.lamp1');

// 解密 RC4 数据
const data = MiIOService.miot_decode(ssecurity, nonce, encryptedData);
```

### MiNAService — 小爱音箱控制

用于控制小爱音箱（TTS 播报、音乐播放、音量控制等）。`deviceId` 是小爱设备的 UUID（通过 `device_list()` 获取）。

```js
const { MiNAService } = require('@bjyy/miservice');
const mina = new MiNAService(account);

// 获取小爱设备列表
const minaDevices = await mina.device_list();
// 返回: [{ deviceID: "uuid-xxx", name: "小爱音箱", hardware: "LX06", miotDID: "123456", ... }, ...]

// 根据 miotDID 找到 deviceID
const device = minaDevices.find(d => d.miotDID === '123456');
const deviceId = device.deviceID;
```

#### TTS 语音播报

```js
// 文字转语音播报
await mina.text_to_speech(deviceId, '你好，世界');

// 打断小爱正在说的话（TTS 说的是 mibrain 服务，player_stop 打不断）
await mina.stop_tts(deviceId);
```

#### 音乐播放

```js
// 播放音频 URL
await mina.play_by_url(deviceId, 'https://example.com/music.mp3');

// 单曲循环播放
await mina.play_by_url(deviceId, 'https://example.com/music.mp3');
await mina.player_set_loop(deviceId, 0);  // 0 = 单曲循环

// 列表循环
await mina.player_set_loop(deviceId, 1);  // 1 = 列表循环
```

#### 播放控制

```js
await mina.player_pause(deviceId);         // 暂停
await mina.player_play(deviceId);          // 继续播放
await mina.player_stop(deviceId);          // 停止
await mina.player_set_volume(deviceId, 50); // 设置音量 (0-100)
const status = await mina.player_get_status(deviceId); // 获取播放状态
```

#### 对话记录

```js
// 获取对话历史（原始记录）
const conversation = await mina.getConversations({ limit: 10 });
console.log(conversation.records);
// [{ query: "我想听周杰伦的晴天", time: 1234567890, answers: [...] }, ...]

// 获取格式化的对话记录
const msgs = await mina.fetchHistoryMsgs({ limit: 10 });
for (const msg of msgs) {
  console.log(msg.text);       // 用户输入的文字
  console.log(msg.timestamp);  // 时间戳
  console.log(msg.answers);    // 原始 answers 数组
}

// 获取下一条新消息（自动去重，适合轮询场景）
const msg = await mina.fetchNextMessage();
if (msg) {
  console.log('新消息:', msg.text);
}
```

### MiNAListener — 实时监听对话

通过轮询音箱对话记录，自动识别用户输入。支持普通对话和音乐口令两种事件。

```js
const { MiNAService, MiNAListener, createAccount } = require('@bjyy/miservice');

const mina = new MiNAService(account);
const deviceId = 'your-device-uuid';

// 创建监听器
const listener = new MiNAListener(mina, deviceId, {
  interval: 1000,  // 轮询间隔（毫秒），默认 1000
});

// 监听普通对话
listener.on('message', (msg) => {
  console.log('用户问:', msg.question);
  console.log('音箱答:', msg.answer);
  console.log('消息类型:', msg.domain);   // "TTS" 或 "LLM"
  console.log('时间戳:', msg.timestamp);
});

// 监听音乐口令
listener.on('music', async (msg) => {
  console.log('🎵 音乐口令:', msg.command, msg.songName || '');
  // msg.command: "play" / "prev" / "next"
  // msg.songName: 歌名（prev/next 时为 null）

  if (msg.command === 'play' && msg.songName) {
    await mina.stop_tts(deviceId);
    const audioUrl = await searchMusic(msg.songName);
    await mina.play_by_url(deviceId, audioUrl);
  }
});

// 错误处理
listener.on('error', (e) => console.error('[Error]', e.message));

// 启动监听
await listener.start();

// 停止监听
listener.stop();
```

#### 支持的音乐口令

| 用户说 | command | songName |
|--------|---------|----------|
| `播放音乐xxx` / `播放歌曲xxx` / `我想听xxx` / `我要听xxx` | `"play"` | 提取的歌名 |
| `上一曲` / `上一首` | `"prev"` | `null` |
| `下一曲` / `下一首` | `"next"` | `null` |

#### 事件数据结构

**message 事件**：
```js
{
  question: "今天天气怎么样",  // 用户输入的文字
  answer: "今天晴天",          // 音箱回复
  domain: "TTS",               // "TTS" 或 "LLM"
  action: "",
  requestId: "abc123",
  timestamp: 1234567890
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

### API 速查表

| 类 | 方法 | 说明 |
|---|---|---|
| **MiIOService** | `device_list(name?)` | 获取设备列表，可按名称过滤 |
| | `miot_get_prop(did, [siid, piid])` | 获取单个属性 |
| | `miot_get_props(did, [[siid, piid], ...])` | 批量获取属性 |
| | `miot_set_prop(did, [siid, piid], value)` | 设置单个属性 |
| | `miot_set_props(did, [[siid, piid, value], ...])` | 批量设置属性 |
| | `miot_action(did, [siid, aiid], args?)` | 执行设备动作 |
| | `miot_spec(model?, format?)` | 查看设备 MIoT Spec |
| | `MiIOService.miot_decode(ssecurity, nonce, data)` | 解密 RC4 数据 |
| **MiNAService** | `device_list()` | 获取小爱设备列表 |
| | `text_to_speech(deviceId, text)` | TTS 语音播报 |
| | `stop_tts(deviceId)` | 打断 TTS 语音 |
| | `play_by_url(deviceId, url)` | 播放音频 URL |
| | `player_pause(deviceId)` | 暂停播放 |
| | `player_play(deviceId)` | 继续播放 |
| | `player_stop(deviceId)` | 停止播放 |
| | `player_set_volume(deviceId, volume)` | 设置音量 (0-100) |
| | `player_set_loop(deviceId, type)` | 设置循环模式 (0=单曲, 1=列表) |
| | `player_get_status(deviceId)` | 获取播放状态 |
| | `getConversations(options?)` | 获取对话历史（原始格式） |
| | `fetchHistoryMsgs(options?)` | 获取格式化的对话记录 |
| | `fetchNextMessage()` | 获取下一条新消息（自动去重） |
| **MiNAListener** | `start()` | 启动监听 |
| | `stop()` | 停止监听 |
| | 事件: `message` | 普通对话消息 |
| | 事件: `music` | 音乐口令 |
| | 事件: `error` | 错误 |
| | 事件: `poll` | 每次轮询触发 |

## 技术说明

- HTTP 请求使用 Node.js 原生 `https`/`http` 模块，无第三方 HTTP 依赖
- 加密使用 Node.js 内置 `crypto` 模块（MD5/SHA1/SHA256/HMAC-SHA256/RC4）
- 小米 API 返回的 `nonce` 为大整数，从原始 JSON 文本提取字符串避免精度丢失
- 重定向链中的 cookies 自动累积，确保 `serviceToken` 正确获取

## 更新发行npm包
```
npm publish --access public
```

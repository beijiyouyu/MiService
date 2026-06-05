#!/usr/bin/env node

require("dotenv").config();

const path = require("path");
const { MiNAService, createAccount } = require("./src");
const { MiNAListener } = require("./src/mi-listener");

const TOKEN_PATH = path.join(process.cwd(), ".mi.token");

function findDeviceId(hardwareData, miDid) {
  for (const h of hardwareData) {
    if (h.miotDID === String(miDid)) return h.deviceID;
  }
  throw new Error("Device not found: " + miDid);
}

/**
 * 调用音乐搜索接口，返回 { url, duration } 列表
 * 接口约定：GET apiUrl?musicName=歌名
 *   data 为数组 → [{ url, duration }, ...]
 *   data 为对象 → [{ url, duration }]
 */
async function searchMusic(apiUrl, musicName) {
  const url = new URL(apiUrl);
  url.searchParams.set("musicName", musicName);
  const res = await fetch(url.href);
  const json = await res.json();

  // 接口返回列表
  if (Array.isArray(json.data)) {
    return json.data
      .filter((item) => item.url)
      .map((item) => ({
        url: item.url,
        duration: (item.duration || 180000) / 1000,
      }));
  }
  // 接口返回单条
  const audioUrl = json.url || (json.data && json.data.url);
  const duration = (json.data && json.data.duration) || 180000;
  if (!audioUrl)
    throw new Error("接口未返回音频地址: " + JSON.stringify(json));
  return [{ url: audioUrl, duration: duration / 1000 }];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 批量播放音乐列表
 * @param {import('./src/minaservice')} mina
 * @param {string} deviceId
 * @param {{ url: string, duration: number }[]} tracks
 */
async function playList(mina, deviceId, tracks) {
  if (!tracks.length) return;

  await mina.player_set_loop(deviceId, 1);

  for (let i = 0; i < tracks.length; i++) {
    const { url, duration } = tracks[i];
    console.log(
      `[${i + 1}/${tracks.length}] 🎶 播放: ${url} (${Math.round(duration)}s)`
    );
    await mina.play_by_url(deviceId, url);
    await sleep(duration * 1000);
  }

  await mina.player_stop(deviceId);
  console.log("播放列表完毕");
}

async function main() {
  const env = process.env;
  if (!env.MI_DID) {
    console.error("请在 .env 中设置 MI_DID");
    process.exit(1);
  }

  // 轮询间隔：命令行参数 > .env POLL_INTERVAL > 默认 2000ms
  const interval =
    parseInt(process.argv[2]) || parseInt(env.POLL_INTERVAL) || 2000;

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
  console.log("按 Ctrl+C 停止\n");

  // 创建监听器（自动设置 deviceId 和 hardware）
  const listener = new MiNAListener(mina, deviceId, { interval });

  // 普通对话（过滤掉播放音乐等非对话类消息）
  listener.on("message", (msg) => {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    console.log(`[${time}] 问: ${msg.question}`);
    console.log(`[${time}] 答: ${msg.answer}\n`);
  });

  // 音乐口令（播放音乐/我想听/上一曲/下一曲等）
  listener.on("music", async (msg) => {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const action =
      msg.command === "play"
        ? `🎵 搜索: ${msg.songName}`
        : msg.command === "prev"
          ? "⏮ 上一曲"
          : "⏭ 下一曲";
    console.log(`[${time}] ${action}`);
    console.log(`[${time}] 原文: ${msg.question}`);

    // 播放音乐（支持播放列表）
    if (msg.command === "play" && msg.songName && musicApi) {
      try {
        await mina.stop_tts(deviceId);
        console.log(`🔍 正在搜索: ${msg.songName}`);
        const tracks = await searchMusic(musicApi, msg.songName);
        console.log(`📋 获取到 ${tracks.length} 个音频`);
        await playList(mina, deviceId, tracks);
      } catch (e) {
        console.error(`❌ 搜索失败: ${e.message}`);
      }
    }
    console.log();
  });

  // 错误处理
  listener.on("error", (e) => {
    console.error("[Error]", e.message);
  });

  // 轮询状态
  listener.on("poll", (count) => {
    if (count <= 3 || count % 60 === 0) {
      console.log(`[${new Date().toLocaleTimeString()}] 轮询 #${count}`);
    }
  });

  // 启动（会自动初始化 hardware，首次拉取基线消息）
  listener.on("start", () => {
    console.log("监听已启动，试试对音箱说: 我想听隐形的翅膀\n");
  });

  listener.start();

  process.on("SIGINT", () => {
    listener.stop();
    console.log("\n已停止");
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
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
 * 调用音乐搜索接口，返回音频 URL
 * 接口约定：GET apiUrl?musicName=歌名 → { "data": { "url": "https://xxx.mp3" } }
 */
async function searchMusic(apiUrl, musicName) {
  const url = new URL(apiUrl);
  url.searchParams.set("musicName", musicName);
  const res = await fetch(url.href);
  const data = await res.json();
  const audioUrl = data.url || (data.data && data.data.url);
  if (!audioUrl) throw new Error("接口未返回音频地址: " + JSON.stringify(data));
  return audioUrl;
}

async function main() {
  const env = process.env;
  if (!env.MI_DID) {
    console.error("请在 .env 中设置 MI_DID");
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
      msg.command === "play" ? `🎵 搜索: ${msg.songName}` :
      msg.command === "prev" ? "⏮ 上一曲" : "⏭ 下一曲";
    console.log(`[${time}] ${action}`);
    console.log(`[${time}] 原文: ${msg.question}`);

    // 播放音乐
    if (msg.command === "play" && msg.songName && musicApi) {
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
    console.log("监听已启动，试试对音箱说: 我想听周杰伦的晴天\n");
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

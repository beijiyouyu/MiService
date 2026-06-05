#!/usr/bin/env node

require("dotenv").config();

const path = require("path");
const {
  MiNAService,
  MiIOService,
  miio_command,
  miio_command_help,
  createAccount,
} = require("../src");
const { request } = require("../src/http");

const TOKEN_PATH = path.join(process.cwd(), ".mi.token");

function usage() {
  console.log("MiService - XiaoMi Cloud Service\n");
  console.log("Usage: The following variables must be set:");
  console.log("           export MI_USER=<Username>");
  console.log("           export MI_PASS=<Password>");
  console.log("           export MI_DID=<Device ID|Name>\n");
  console.log(miio_command_help(null, "micli "));
}

function find_device_id(hardware_data, mi_did) {
  for (const h of hardware_data) {
    if ((h.miotDID || "") === String(mi_did)) {
      return h.deviceID;
    }
  }
  throw new Error("we have no mi_did: please use `micli mina` to check");
}

async function get_duration(url, start = 0, end = 500) {
  url = url.trim();
  const urlBase = url.split("?")[0];
  if (!urlBase.endsWith(".mp3")) {
    const res = await request("GET", url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/39.0.2171.95 Safari/537.36",
      },
      maxRedirects: 5,
    });
    // Follow redirect - the final URL is used
    if (res.headers.location) {
      url = res.headers.location;
    }
  }

  const headers = { Range: `bytes=${start}-${end}` };
  const res = await request("GET", url, { headers: headers });
  // Simple MP3 duration estimation - try to read from the buffer
  // For a more accurate implementation, we'd need an MP3 parser
  // This is a simplified version that returns a default duration
  return 180; // Default 3 minutes
}

async function get_suno_playlist(is_random = false) {
  const suno_playlist_url =
    "https://studio-api.suno.ai/api/playlist/1190bf92-10dc-4ce5-968a-7a377f37f984/?page=1";
  const song_play_dict = {};
  const res = await request("GET", suno_playlist_url);
  const data = JSON.parse(res.body.toString("utf-8"));
  for (const d of data.playlist_clips) {
    const clip = d.clip;
    if (clip && clip.audio_url) {
      song_play_dict[clip.audio_url] = clip.title;
    }
  }
  return song_play_dict;
}

const device_id_list = [];

async function miservice_stop(device_id) {
  const account = await createAccount(TOKEN_PATH);
  if (!account) return;
  const mina_service = new MiNAService(account);
  await mina_service.player_stop(device_id);
  console.log("Stop");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(args) {
  try {
    const env = process.env;
    const account = await createAccount(TOKEN_PATH);
    if (!account) return;
    let result = "";
    const mina_service = new MiNAService(account);

    const firstArg = args.split(" ")[0].trim();
    const minaCommands = [
      "message",
      "play",
      "mina",
      "pause",
      "stop",
      "loop",
      "play_list",
      "suno",
      "suno_random",
    ];

    if (minaCommands.includes(firstArg)) {
      const arg = firstArg;
      result = await mina_service.device_list();
      if (!env.MI_DID) {
        throw new Error("Please export MI_DID in your env");
      }
      const device_id = find_device_id(result, env.MI_DID);
      device_id_list.push(device_id);
      const args_list = args.split(" ");

      if (args_list.length === 1) {
        if (["pause", "stop"].includes(args_list[0])) {
          await mina_service.player_stop(device_id);
        } else if (args_list[0] === "mina" && result.length > 0) {
          console.log(JSON.stringify(result[0], null, 2));
        } else if (args_list[0].includes("suno")) {
          const song_dict = await get_suno_playlist();
          console.log(song_dict);
          let song_urls = Object.keys(song_dict);
          if (args_list[0] === "suno_random") {
            song_urls = song_urls.sort(() => Math.random() - 0.5);
            console.log("Will play suno trending list randomly");
          } else {
            console.log("Will play suno trending list");
          }
          for (const song_url of song_urls) {
            const title = song_dict[song_url];
            console.log(`Will play ${song_url.trim()} title ${title}`);
            const duration = await get_duration(song_url);
            await mina_service.play_by_url(device_id, song_url.trim());
            await sleep(duration * 1000);
          }
          await mina_service.player_stop(device_id);
        } else {
          console.log("Please provide a play URL");
        }
        return;
      }

      if (arg === "loop") {
        const url = args_list[1];
        await mina_service.play_by_url(device_id, url);
        await mina_service.player_set_loop(device_id, 0);
        return;
      } else if (arg === "play") {
        await mina_service.play_by_url(device_id, args_list[1]);
        await mina_service.player_set_loop(device_id, 1);
        return;
      } else if (arg === "play_list") {
        try {
          await mina_service.player_set_loop(device_id, 1);
          const fileName = args_list[1];
          const fs = require("fs");
          const content = fs.readFileSync(fileName, "utf-8");
          const lines = content.split("\n").filter((l) => l.trim());
          for (const line of lines) {
            console.log(`Will play ${line.trim()}`);
            const duration = await get_duration(line);
            await mina_service.play_by_url(device_id, line.trim());
            await sleep(duration * 1000);
          }
          await mina_service.player_stop(device_id);
        } catch (e) {
          console.error(e.message);
          return;
        }
      } else if (arg === "message") {
        await mina_service.text_to_speech(device_id, args_list[1]);
        return;
      }
    } else {
      const service = new MiIOService(account);
      result = await miio_command(
        service,
        env.MI_DID,
        args,
        process.argv[1] + " "
      );
    }

    if (typeof result !== "string") {
      result = JSON.stringify(result, null, 2);
    }
    console.log(result);
  } catch (e) {
    console.error(e.message || e);
  }
}

function micli() {
  const argv = process.argv;
  const argc = argv.length;
  let argi, level;

  if (argc > 2 && argv[2].startsWith("-v")) {
    argi = 3;
    const index = argv[2].length > 2 ? parseInt(argv[2][2]) : 4;
    const levels = [0, 10, 20, 30, 40, 50];
    level = levels[index] || 40;
  } else {
    argi = 2;
    level = 30; // WARNING
  }

  if (argc > argi) {
    const args = argv.slice(argi).join(" ");
    main(args).catch((e) => {
      if (e.message && e.message.includes("KeyboardInterrupt")) {
        const device_id = device_id_list[0];
        if (device_id) miservice_stop(device_id);
      }
      console.error(e.message || e);
    });
  } else {
    usage();
  }
}

// Handle Ctrl+C
process.on("SIGINT", async () => {
  const device_id = device_id_list[0];
  if (device_id) {
    try {
      await miservice_stop(device_id);
    } catch (e) {
      // ignore
    }
  }
  process.exit(0);
});

micli();

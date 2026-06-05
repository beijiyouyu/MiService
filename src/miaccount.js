const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const readline = require("readline");
const { request } = require("./http");
const randomUseragent = require("random-useragent");

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function get_random(length) {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += ALPHANUMERIC.charAt(Math.floor(Math.random() * ALPHANUMERIC.length));
  }
  return result;
}

class MiTokenStore {
  constructor(tokenPath) {
    this.token_path = tokenPath;
  }

  load_token() {
    try {
      if (fs.existsSync(this.token_path)) {
        const data = fs.readFileSync(this.token_path, "utf-8");
        return JSON.parse(data);
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  save_token(token) {
    if (token) {
      try {
        fs.writeFileSync(this.token_path, JSON.stringify(token, null, 2));
      } catch (e) {
        // ignore
      }
    } else {
      try {
        if (fs.existsSync(this.token_path)) {
          fs.unlinkSync(this.token_path);
        }
      } catch (e) {
        // ignore
      }
    }
  }
}

class MiAccount {
  constructor(username, password, tokenStore) {
    this.username = username;
    this.password = password;
    if (typeof tokenStore === "string") {
      this.token_store = new MiTokenStore(tokenStore);
    } else {
      this.token_store = tokenStore;
    }
    this.token = this.token_store ? this.token_store.load_token() : null;
    this.now_ua = randomUseragent.getRandom();
  }

  async login(sid) {
    if (!this.token) {
      this.token = { deviceId: get_random(16).toUpperCase() };
    }
    try {
      let resp = await this._serviceLogin(`serviceLogin?sid=${sid}&_json=true`);

      if (resp.code !== 0) {
        const data = {
          _json: "true",
          qs: resp.qs,
          sid: resp.sid,
          _sign: resp._sign,
          callback: resp.callback,
          user: this.username,
          hash: crypto.createHash("md5").update(this.password).digest("hex").toUpperCase(),
        };
        resp = await this._serviceLogin("serviceLoginAuth2", data);
        if (resp.code !== 0) {
          throw new Error(JSON.stringify(resp));
        }
      }

      this.token.userId = resp.userId;
      this.token.passToken = resp.passToken;

      const serviceToken = await this._securityTokenService(
        resp.location, resp._nonce_str || resp.nonce, resp.ssecurity
      );
      this.token[sid] = [resp.ssecurity, serviceToken];
      if (this.token_store) {
        this.token_store.save_token(this.token);
      }
      return true;
    } catch (e) {
      this.token = null;
      if (this.token_store) {
        this.token_store.save_token(null);
      }
      console.error(`Exception on login ${this.username}:`, e.message);
      return false;
    }
  }

  async _serviceLogin(uri, data = null) {
    this.now_ua = randomUseragent.getRandom();
    const headers = { "User-Agent": this.now_ua };
    const cookies = { sdkVersion: "3.9", deviceId: this.token.deviceId };
    if (this.token.passToken) {
      cookies.userId = this.token.userId;
      cookies.passToken = this.token.passToken;
    } else {
      cookies.passToken = "";
    }
    const url = "https://account.xiaomi.com/pass/" + uri;
    const method = data ? "POST" : "GET";
    const res = await request(method, url, {
      data: data,
      headers: headers,
      cookies: cookies,
      rejectUnauthorized: false,
    });
    const raw = res.body.toString("utf-8");
    const jsonStr = raw.substring(11);
    const resp = JSON.parse(jsonStr);
    // Extract nonce as string from raw text to avoid JS number precision loss
    // (nonce can exceed Number.MAX_SAFE_INTEGER)
    const nonceMatch = jsonStr.match(/"nonce"\s*:\s*(\d+)/);
    if (nonceMatch) {
      resp._nonce_str = nonceMatch[1];
    }
    return resp;
  }

  async _securityTokenService(location, nonce, ssecurity) {
    const nsec = "nonce=" + nonce + "&" + ssecurity;
    const clientSign = crypto.createHash("sha1").update(nsec).digest("base64");
    const fullUrl = location + "&clientSign=" + encodeURIComponent(clientSign);
    const res = await request("GET", fullUrl, {
      rejectUnauthorized: false,
    });
    const serviceToken = res.cookies.serviceToken;
    if (!serviceToken) {
      const bodyText = res.body.toString("utf-8");
      throw new Error(bodyText || `securityTokenService failed: status=${res.status}`);
    }
    return serviceToken;
  }

  async mi_request(sid, url, data, headers, extraCookies = {}, relogin = true) {
    headers["User-Agent"] = this.now_ua;
    if ((this.token && sid in this.token) || await this.login(sid)) {
      const cookies = {
        userId: this.token.userId,
        serviceToken: this.token[sid][1],
        ...extraCookies,
      };
      const content = typeof data === "function" ? data(this.token, cookies) : data;
      const method = data === null ? "GET" : "POST";
      const res = await request(method, url, {
        data: content,
        headers: headers,
        cookies: cookies,
      });
      let status = res.status;
      if (status === 200) {
        const resp = JSON.parse(res.body.toString("utf-8"));
        const code = resp.code;
        if (code === 0) {
          return resp;
        }
        if ((resp.message || "").toLowerCase().includes("auth")) {
          status = 401;
        }
        if (status !== 401) {
          throw new Error(`Error ${url}: ${JSON.stringify(resp)}`);
        }
      } else {
        const respText = res.body.toString("utf-8");
        if (status === 401 && relogin) {
          this.token = null;
          return this.mi_request(sid, url, data, headers, extraCookies, false);
        }
        throw new Error(`Error ${url}: ${respText}`);
      }
      // status was 401 from code check
      if (relogin) {
        this.token = null;
        return this.mi_request(sid, url, data, headers, extraCookies, false);
      }
      throw new Error(`Error ${url}`);
    } else {
      throw new Error("Login failed");
    }
  }
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function updateEnvFile(key, value) {
  const envPath = path.resolve(process.cwd(), ".env");
  let content = "";
  try {
    content = fs.readFileSync(envPath, "utf-8");
  } catch (e) {
    // .env 不存在，新建
  }
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, content, "utf-8");
}

/**
 * 创建并登录小米账号
 * 优先从 .env 读取 MI_PASS_TOKEN，读取不到或登录失败时提示手动输入，
 * 手动输入后自动更新到 .env
 * @param {string} tokenPath - token 文件存储路径
 * @returns {Promise<MiAccount|null>}
 */
async function createAccount(tokenPath) {
  const env = process.env;
  const MI_USER = env.MI_USER;
  const MI_PASS = env.MI_PASS;
  if (!MI_USER || !MI_PASS) {
    console.error("❌ 请在 .env 中设置 MI_USER 和 MI_PASS");
    return null;
  }

  const store = new MiTokenStore(tokenPath);
  const account = new MiAccount(MI_USER, MI_PASS, store);

  // 如果 .env 中有 MI_PASS_TOKEN，预填到 token 中
  if (env.MI_PASS_TOKEN && account.token) {
    account.token.passToken = env.MI_PASS_TOKEN;
    account.token.userId = MI_USER;
  }

  // 尝试登录
  const success = await account.login("micoapi");
  if (success) {
    // 登录成功，把 passToken 持久化到 .env（方便下次使用）
    if (account.token && account.token.passToken) {
      updateEnvFile("MI_PASS_TOKEN", account.token.passToken);
    }
    return account;
  }

  // 登录失败，提示手动输入 passToken
  console.log("\n⚠️  登录失败，请手动输入 passToken");
  console.log("获取方式：浏览器登录 https://account.xiaomi.com");
  console.log("  → F12 → Application → Cookies → account.xiaomi.com");
  console.log("  → 复制 passToken\n");

  const passToken = await ask("请粘贴 passToken: ");

  if (!passToken) {
    console.error("❌ 未提供 passToken，登录中止");
    return null;
  }

  // 重试登录
  if (!account.token) {
    account.token = { deviceId: get_random(16).toUpperCase() };
  }
  account.token.passToken = passToken;
  account.token.userId = MI_USER;
  const retrySuccess = await account.login("micoapi");

  if (retrySuccess) {
    // 更新到 .env
    updateEnvFile("MI_PASS_TOKEN", passToken);
    console.log("✅ 登录成功，passToken 已保存到 .env");
    return account;
  }

  console.error("❌ 使用 passToken 登录仍然失败，请检查是否正确");
  return null;
}

module.exports = { MiAccount, MiTokenStore, get_random, createAccount };

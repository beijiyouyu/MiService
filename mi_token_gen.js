require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { MiAccount, MiTokenStore, get_random } = require("./src");
const { request } = require("./src/http");

const TOKEN_PATH = path.join(process.cwd(), ".mi.token");

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

// Enhanced login with SMS verification support
async function custom_login(self, sid) {
  if (!self.token) {
    self.token = { deviceId: get_random(16).toUpperCase() };
  }

  try {
    // Step 1: Get login environment parameters
    let resp = await self._serviceLogin(
      `serviceLogin?sid=${sid}&_json=true`
    );
    let data = null;

    if (resp.code !== 0) {
      // Safety check and diagnostics
      if (!("qs" in resp)) {
        console.error("\n❌ [第一步握手失败] 服务器未返回预期的参数 (qs)。");
        console.error(
          `📄 服务器实际返回: ${JSON.stringify(resp)}`
        );

        if (resp.code === 87001) {
          console.error(
            "\n⚠️ 诊断结果：触发了小米的【图形验证码 / 频繁请求风控】！"
          );
          console.error("💡 建议解决方案：");
          console.error("   1. 暂缓几小时后再试，或");
          console.error(
            "   2. 更换你当前运行脚本的网络 IP（比如把电脑连到手机的 4G/5G 热点上再试一次）。"
          );
        }

        throw new Error(
          `握手失败，缺少 qs 参数。详情: ${JSON.stringify(resp)}`
        );
      }

      // Build auth data for second step
      data = {
        _json: "true",
        qs: resp.qs,
        sid: resp.sid,
        _sign: resp._sign,
        callback: resp.callback,
        user: self.username,
        hash: crypto
          .createHash("md5")
          .update(self.password)
          .digest("hex")
          .toUpperCase(),
      };
      resp = await self._serviceLogin("serviceLoginAuth2", data);

      // Handle wrong password
      if (resp.code !== 0 && !("notificationUrl" in resp)) {
        console.error(
          `\n❌ [账号密码验证失败] 返回信息: ${JSON.stringify(resp)}`
        );
        if (resp.code === 70016) {
          console.error(
            "⚠️ 诊断结果：密码不正确！请检查 MI_PASS 是否填写正确。"
          );
        }
        throw new Error(`验证失败: ${JSON.stringify(resp)}`);
      }
    }

    // Handle SMS verification (notificationUrl)
    if (!("userId" in resp)) {
      const notification_url = resp.notificationUrl;
      if (!notification_url) {
        throw new Error(
          `无 userId 且无 notificationUrl: ${JSON.stringify(resp)}`
        );
      }

      console.log("\n" + "=".repeat(60));
      console.log("⚠️ 需要短信验证码验证");
      console.log("请按以下步骤操作：");
      console.log(
        `1. 在浏览器中打开下方链接（可右键复制）：\n   ${notification_url}\n`
      );
      console.log(
        "2. 点击「发送验证码」，输入手机/或邮箱收到的验证码并提交"
      );
      console.log(
        "3. 验证成功后，浏览器可能会跳401，没有关系，打开 https://account.xiaomi.com 完成登录"
      );
      console.log(
        "4. 打开开发者工具 (F12) → Application (存储) → Cookies"
      );
      console.log(
        "5. 找到 https://account.xiaomi.com 域下的以下两个值："
      );
      console.log("   - passToken (较长字符串)");
      console.log("   - userId (纯数字)\n");

      const pass_token = await ask("请粘贴 passToken: ");
      const user_id = await ask("请粘贴 userId (纯数字): ");

      if (!pass_token || !user_id) {
        throw new Error("未提供 passToken 或 userId，登录中止");
      }

      self.token.passToken = pass_token;
      self.token.userId = user_id;

      console.log("正在使用提供的 token 重新验证...");
      resp = await self._serviceLogin("serviceLoginAuth2", data);
      if (resp.code !== 0 || !("userId" in resp)) {
        throw new Error(
          `二次验证后登录失败: ${JSON.stringify(resp)}`
        );
      }
      console.log("✅ 二次验证通过，继续获取 serviceToken...");
    }

    console.log(`✅ Login successful for ${self.username}`);
    self.token.userId = resp.userId;
    self.token.passToken = resp.passToken;

    const serviceToken = await self._securityTokenService(
      resp.location,
      resp._nonce_str || resp.nonce,
      resp.ssecurity
    );
    self.token[sid] = [resp.ssecurity, serviceToken];
    if (self.token_store) {
      self.token_store.save_token(self.token);
    }
    return true;
  } catch (e) {
    self.token = null;
    if (self.token_store) {
      self.token_store.save_token(null);
    }
    console.error(`Exception on login ${self.username}:`, e.message);
    return false;
  }
}

async function main() {
  const MI_USER = process.env.MI_USER || "你的小米账户邮箱/手机号写在这里";
  const MI_PASS = process.env.MI_PASS || "你的真实密码写在这里";

  console.log(`准备生成小米凭证到: ${TOKEN_PATH}`);

  const store = new MiTokenStore(TOKEN_PATH);
  const account = new MiAccount(MI_USER, MI_PASS, store);

  // Monkey-patch login with enhanced version
  account.login = function (sid) {
    return custom_login(this, sid);
  };

  const success = await account.login("micoapi");

  if (success) {
    console.log(`\n🎉 凭证获取成功！已保存至 ${TOKEN_PATH}`);
  } else {
    console.log("\n❌ 凭证获取失败，请根据上方的日志排查问题。");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

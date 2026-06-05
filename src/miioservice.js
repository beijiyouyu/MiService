const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { request } = require("./http");
const { MiAccount } = require("./miaccount");

class MiIOService {
  constructor(account, region = null) {
    this.account = account;
    this.server =
      "https://" +
      (region === null || region === "cn" ? "" : region + ".") +
      "api.io.mi.com/app";
  }

  async miio_request(uri, data) {
    const prepareData = (token, cookies) => {
      cookies.PassportDeviceId = token.deviceId;
      return MiIOService.sign_data(uri, data, token.xiaomiio[0]);
    };

    const headers = {
      "User-Agent":
        "iOS-14.4-6.0.103-iPhone12,3--D7744744F7AF32F0544445285880DD63E47D9BE9-8816080-84A3F44E137B71AE-iPhone",
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
    };
    const resp = await this.account.mi_request(
      "xiaomiio",
      this.server + uri,
      prepareData,
      headers
    );
    if (!("result" in resp)) {
      throw new Error(`Error ${uri}: ${JSON.stringify(resp)}`);
    }
    return resp.result;
  }

  async home_request(did, method, params) {
    return this.miio_request("/home/rpc/" + did, {
      id: 1,
      method: method,
      accessKey: "IOS00026747c5acafc2",
      params: params,
    });
  }

  async home_get_props(did, props) {
    return this.home_request(did, "get_prop", props);
  }

  async home_set_props(did, props) {
    const results = [];
    for (const [prop, value] of props) {
      results.push(await this.home_set_prop(did, prop, value));
    }
    return results;
  }

  async home_get_prop(did, prop) {
    return (await this.home_get_props(did, [prop]))[0];
  }

  async home_set_prop(did, prop, value) {
    const result = (
      await this.home_request(
        did,
        "set_" + prop,
        Array.isArray(value) ? value : [value]
      )
    )[0];
    return result === "ok" ? 0 : result;
  }

  async miot_request(cmd, params) {
    return this.miio_request("/miotspec/" + cmd, { params: params });
  }

  async miot_get_props(did, iids) {
    const params = iids.map((i) => ({ did: did, siid: i[0], piid: i[1] }));
    const result = await this.miot_request("prop/get", params);
    return result.map((it) => (it.code === 0 ? it.value : null));
  }

  async miot_set_props(did, props) {
    const params = props.map((i) => ({
      did: did,
      siid: i[0],
      piid: i[1],
      value: i[2],
    }));
    const result = await this.miot_request("prop/set", params);
    return result.map((it) => (it.code !== undefined ? it.code : -1));
  }

  async miot_get_prop(did, iid) {
    return (await this.miot_get_props(did, [iid]))[0];
  }

  async miot_set_prop(did, iid, value) {
    return (await this.miot_set_props(did, [[iid[0], iid[1], value]]))[0];
  }

  async miot_action(did, iid, args = []) {
    const result = await this.miot_request("action", {
      did: did,
      siid: iid[0],
      aiid: iid[1],
      in: args,
    });
    return result.code !== undefined ? result.code : -1;
  }

  async device_list(name = null, getVirtualModel = false, getHuamiDevices = 0) {
    const result = await this.miio_request("/home/device_list", {
      getVirtualModel: !!getVirtualModel,
      getHuamiDevices: parseInt(getHuamiDevices) || 0,
    });
    const list = result.list;
    if (name === "full") {
      return list;
    }
    return list
      .filter((i) => !name || i.did.includes(name))
      .map((i) => ({
        name: i.name,
        model: i.model,
        did: i.did,
        token: i.token,
      }));
  }

  async miot_spec(type = null, format = null) {
    if (!type || !type.startsWith("urn")) {
      const getSpec = (all) => {
        if (!type) return all;
        const ret = {};
        for (const [m, t] of Object.entries(all)) {
          if (type === m) return { [m]: t };
          if (m.includes(type)) ret[m] = t;
        }
        return ret;
      };

      const specPath = path.join(os.tmpdir(), "miservice_miot_specs.json");
      let result;
      try {
        const cached = JSON.parse(fs.readFileSync(specPath, "utf-8"));
        result = getSpec(cached);
      } catch (e) {
        result = null;
      }
      if (!result) {
        const res = await request(
          "GET",
          "http://miot-spec.org/miot-spec-v2/instances?status=all"
        );
        const allData = JSON.parse(res.body.toString("utf-8"));
        const all = {};
        for (const i of allData.instances) {
          all[i.model] = i.type;
        }
        fs.writeFileSync(specPath, JSON.stringify(all));
        result = getSpec(all);
      }
      const keys = Object.keys(result);
      if (keys.length !== 1) return result;
      type = result[keys[0]];
    }

    const url = "http://miot-spec.org/miot-spec-v2/instance?type=" + type;
    const res = await request("GET", url);
    const specResult = JSON.parse(res.body.toString("utf-8"));

    const parseDesc = (node) => {
      const desc = node.description;
      let name = "";
      for (let i = 0; i < desc.length; i++) {
        const d = desc[i];
        if ("-—{「[【(（<《".includes(d)) {
          return [name, "  # " + desc.substring(i)];
        }
        name += d === " " ? "_" : d;
      }
      return [name, ""];
    };

    const makeLine = (siid, iid, desc, comment, readable = false) => {
      const value =
        format === "python" ? `(${siid}, ${iid})` : iid;
      return `    ${readable ? "" : "_"}${desc} = ${value}${comment}\n`;
    };

    if (format !== "json") {
      let STR_HEAD, STR_SRV, STR_VALUE;
      if (format === "python") {
        STR_HEAD = "from enum import Enum\n\n";
        STR_SRV = "\nclass {}(tuple, Enum):\n";
        STR_VALUE = "\nclass {}(int, Enum):\n";
      } else {
        STR_HEAD = "";
        STR_SRV = "{} = {}\n";
        STR_VALUE = "{}\n";
      }

      let text =
        "# Generated by https://github.com/Yonsm/MiService\n# " +
        url +
        "\n\n" +
        STR_HEAD;
      const svcs = [];
      const vals = [];

      for (const s of specResult.services) {
        const siid = s.iid;
        const svc = s.description.replace(/ /g, "_");
        svcs.push(svc);
        text += STR_SRV.replace("{}", svc).replace("{}", siid);

        for (const p of s.properties || []) {
          const [name, comment0] = parseDesc(p);
          const access = p.access;
          let comment = comment0;

          const extras = [];
          if (p.format && p.format !== "string")
            extras.push(p.format);
          const accessStr = access.map((a) => a[0]).join("");
          if (accessStr !== "r") extras.push(accessStr);
          for (const k of extras) {
            comment += "  # " + k;
          }

          text += makeLine(siid, p.iid, name, comment, access.includes("read"));

          let values;
          if (p["value-range"]) {
            const valuer = p["value-range"];
            const length = Math.min(3, valuer.length);
            values = {};
            const labels = ["MIN", "MAX", "STEP"];
            for (let i = 0; i < length; i++) {
              if (i !== 2 || valuer[i] !== 1) {
                values[labels[i]] = valuer[i];
              }
            }
          } else if (p["value-list"]) {
            values = {};
            for (const item of p["value-list"]) {
              const key = item.description
                ? item.description.replace(/ /g, "_")
                : String(item.value);
              values[key] = item.value;
            }
          } else {
            continue;
          }
          vals.push([svc + "_" + name, values]);
        }

        if (s.actions) {
          text += "\n";
          for (const a of s.actions) {
            const [name, comment0] = parseDesc(a);
            let comment = comment0;
            for (const io of ["in", "out"]) {
              if (a[io] && a[io].length) {
                comment += `  # ${io}=${JSON.stringify(a[io])}`;
              }
            }
            text += makeLine(siid, a.iid, name, comment);
          }
        }
        text += "\n";
      }

      for (const [name, values] of vals) {
        text += STR_VALUE.replace("{}", name);
        for (const [k, v] of Object.entries(values)) {
          const key = /^\d+$/.test(k) ? "_" + k : k;
          text += `    ${key} = ${v}\n`;
        }
        text += "\n";
      }

      if (format === "python") {
        text += "\nALL_SVCS = (" + svcs.join(", ") + ")\n";
      }
      return text;
    }
    return specResult;
  }

  static miot_decode(ssecurity, nonce, data, gzip = false) {
    const key = Buffer.from(MiIOService.sign_nonce(ssecurity, nonce), "base64");
    const decipher = crypto.createDecipheriv("rc4", key, "");
    // Drop first 1024 bytes of keystream
    decipher.update(Buffer.alloc(1024));
    const decrypted = decipher.update(Buffer.from(data, "base64"));
    decipher.final();

    if (gzip) {
      try {
        const zlib = require("zlib");
        return JSON.parse(zlib.gunzipSync(decrypted).toString("utf-8"));
      } catch (e) {
        // fall through
      }
    }
    return JSON.parse(decrypted.toString("utf-8"));
  }

  static sign_nonce(ssecurity, nonce) {
    const hash = crypto.createHash("sha256");
    hash.update(Buffer.from(ssecurity, "base64"));
    hash.update(Buffer.from(nonce, "base64"));
    return hash.digest("base64");
  }

  static sign_data(uri, data, ssecurity) {
    if (typeof data !== "string") {
      data = JSON.stringify(data);
    }
    const randomBytes = crypto.randomBytes(8);
    const timeBytes = Buffer.alloc(4);
    timeBytes.writeUInt32BE(Math.floor(Date.now() / 1000 / 60));
    const nonce = Buffer.concat([randomBytes, timeBytes]).toString("base64");
    const snonce = MiIOService.sign_nonce(ssecurity, nonce);
    const msg = [uri, snonce, nonce, "data=" + data].join("&");
    const sign = crypto
      .createHmac("sha256", Buffer.from(snonce, "base64"))
      .update(msg)
      .digest();
    return {
      _nonce: nonce,
      data: data,
      signature: sign.toString("base64"),
    };
  }
}

module.exports = { MiIOService };

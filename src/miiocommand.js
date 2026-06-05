const { MiIOService } = require("./miioservice");

function twins_split(str, sep, defaultVal = null) {
  const pos = str.indexOf(sep);
  if (pos === -1) return [str, defaultVal];
  return [str.substring(0, pos), str.substring(pos + 1)];
}

function string_to_value(str) {
  if (str === "null" || str === "none") return null;
  if (str === "false") return false;
  if (str === "true") return true;
  return parseInt(str);
}

function string_or_value(str) {
  return str[0] === "#" ? string_to_value(str.substring(1)) : str;
}

function miio_command_help(did = null, prefix = "?") {
  const quote = prefix === "?" ? "" : "'";
  return `Get Props: ${prefix}<siid[-piid]>[,...]\
\n           ${prefix}1,1-2,1-3,1-4,2-1,2-2,3\
\nSet Props: ${prefix}<siid[-piid]=[#]value>[,...]\
\n           ${prefix}2=#60,2-2=#false,3=test\
\nDo Action: ${prefix}<siid[-piid]> <arg1|#NA> [...] \
\n           ${prefix}2 #NA\
\n           ${prefix}5 Hello\
\n           ${prefix}5-4 Hello #1\n\
\nCall MIoT: ${prefix}<cmd=prop/get|/prop/set|action> <params>\
\n           ${prefix}action ${quote}{"did":"${did || "267090026"}","siid":5,"aiid":1,"in":["Hello"]}${quote}\n\
\nCall MiIO: ${prefix}/<uri> <data>\
\n           ${prefix}/home/device_list ${quote}{"getVirtualModel":false,"getHuamiDevices":1}${quote}\n\
\nDevs List: ${prefix}list [name=full|name_keyword] [getVirtualModel=false|true] [getHuamiDevices=0|1]\
\n           ${prefix}list Light true 0\n\
\nMIoT Spec: ${prefix}spec [model_keyword|type_urn] [format=text|python|json]\
\n           ${prefix}spec\
\n           ${prefix}spec speaker\
\n           ${prefix}spec xiaomi.wifispeaker.lx04\
\n           ${prefix}spec urn:miot-spec-v2:device:speaker:0000A015:xiaomi-lx04:1\n\
\nMIoT Decode: ${prefix}decode <ssecurity> <nonce> <data> [gzip]\
\n`;
}

async function miio_command(service, did, text, prefix = "?") {
  const [cmd, arg] = twins_split(text, " ");

  if (cmd.startsWith("/")) {
    return service.miio_request(cmd, arg);
  }

  if (cmd.startsWith("prop") || cmd === "action") {
    return service.miot_request(cmd, arg ? JSON.parse(arg) : null);
  }

  const argv = arg ? arg.split(" ") : [];
  const argc = argv.length;

  if (cmd === "list") {
    return service.device_list(
      argc > 0 ? argv[0] : null,
      argc > 1 ? string_to_value(argv[1]) : false,
      argc > 2 ? argv[2] : 0
    );
  }

  if (cmd === "spec") {
    return service.miot_spec(
      argc > 0 ? argv[0] : null,
      argc > 1 ? argv[1] : null
    );
  }

  if (cmd === "decode") {
    return MiIOService.miot_decode(
      argv[0],
      argv[1],
      argv[2],
      argc > 3 && argv[3] === "gzip"
    );
  }

  if (
    !did ||
    !cmd ||
    cmd === "?" ||
    cmd === "？" ||
    cmd === "help" ||
    cmd === "-h" ||
    cmd === "--help"
  ) {
    return miio_command_help(did, prefix);
  }

  if (!/^\d+$/.test(did)) {
    const devices = await service.device_list(did);
    if (!devices || devices.length === 0) {
      return "Device not found: " + did;
    }
    did = devices[0].did;
  }

  const props = [];
  let setp = true;
  let miot = true;

  for (const item of cmd.split(",")) {
    const [key, value] = twins_split(item, "=");
    const [siid, iid] = twins_split(key, "-", "1");
    let prop;
    if (/^\d+$/.test(siid) && /^\d+$/.test(iid)) {
      prop = [parseInt(siid), parseInt(iid)];
    } else {
      prop = [key];
      miot = false;
    }
    if (value === null) {
      setp = false;
    } else if (setp) {
      prop.push(string_or_value(value));
    }
    props.push(prop);
  }

  if (miot && argc > 0) {
    const args = arg === "#NA" ? [] : argv.map((a) => string_or_value(a));
    return service.miot_action(did, props[0], args);
  }

  const do_props = setp
    ? miot
      ? service.miot_set_props.bind(service)
      : service.home_set_props.bind(service)
    : miot
    ? service.miot_get_props.bind(service)
    : service.home_get_props.bind(service);

  return do_props(did, props);
}

module.exports = { miio_command, miio_command_help };

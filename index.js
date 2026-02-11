import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf } from "telegraf";
import { resolveSrv } from "dns/promises";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PING_USER_ID = process.env.PING_USER_ID ? Number(process.env.PING_USER_ID) : null;

const MC_HOST = (process.env.MC_HOST || "").trim();
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;

const MC_VERSION = process.env.MC_VERSION || "1.8.9";
const MC_PASSWORD = process.env.MC_PASSWORD;

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);
const AUTO_PREFIXES = (process.env.AUTO_PREFIXES || "").trim();

const READY_AFTER_MS = Number(process.env.READY_AFTER_MS || 1500);

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  throw new Error("Нужны BOT_TOKEN, MC_HOST, MC_USER");
}

/* ================== RULES ================== */
let RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));

/* ================== NORMALIZE ================== */
const cyr = { "а":"a","е":"e","о":"o","р":"p","с":"c","х":"x","у":"y","к":"k","м":"m","т":"t" };

const invisRe = new RegExp(
  RULES?.normalization?.strip_invisibles_regex || "[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]",
  "g"
);
const sepRe = new RegExp(
  RULES?.normalization?.separators_regex || "[\\s\\-_.:,;|/\\\\~`'\"^*+=()\\[\\]{}<>]+",
  "g"
);
const leetMap = RULES?.normalization?.leet_map || { "0":"o","1":"i","3":"e","4":"a","5":"s","7":"t","@":"a","$":"s" };
const collapseRepeats = RULES?.normalization?.collapse_repeats ?? true;
const maxRepeat = RULES?.normalization?.max_repeat ?? 2;

function stripColors(s = "") { return s.replace(/§./g, ""); }

function norm(s = "") {
  s = stripColors(s);
  if (RULES?.normalization?.lowercase ?? true) s = s.toLowerCase();
  s = s.replace(invisRe, "");
  s = [...s].map(ch => cyr[ch] || leetMap[ch] || ch).join("");
  s = s.replace(sepRe, "");
  if (collapseRepeats) {
    const re = new RegExp(`(.)\\1{${maxRepeat},}`, "g");
    s = s.replace(re, "$1".repeat(maxRepeat));
  }
  return s;
}

/* ================== CHECKER ================== */
function checkNick(name) {
  const n = norm(name);

  const wl = new Set((RULES.whitelist_exact || []).map(norm));
  if (wl.has(n)) return ["OK", ["whitelist"]];

  const banReasons = [];
  for (const rule of (RULES.rules || [])) {
    if ((rule.action || "").toUpperCase() !== "BAN") continue;
    for (const w0 of (rule.words || [])) {
      const w = norm(String(w0));
      if (w && n.includes(w)) banReasons.push(`${rule.reason || rule.id}:${w0}`);
    }
  }
  if (banReasons.length) return ["BAN", banReasons];

  const review = [];
  for (const w0 of (RULES.review || [])) {
    const w = norm(String(w0));
    if (w && n.includes(w)) review.push(`review:${w0}`);
  }
  if (review.length) return ["REVIEW", review];

  return ["OK", []];
}

/* ================== REPORT ================== */
function splitText(t, max = 3500) {
  const parts = [];
  let buf = "";
  for (const line of t.split("\n")) {
    if ((buf + line + "\n").length > max) {
      parts.push(buf);
      buf = "";
    }
    buf += line + "\n";
  }
  if (buf) parts.push(buf);
  return parts;
}

async function sendChunksReply(ctx, text) {
  for (const p of splitText(text)) if (p.trim()) await ctx.reply(p);
}

async function sendChunksChat(bot, chatId, text) {
  for (const p of splitText(text)) if (p.trim())
    await bot.telegram.sendMessage(chatId, p, { parse_mode: "Markdown" });
}

function report(title, names) {
  const ban = [];
  const rev = [];
  for (const nick of names) {
    const [s, r] = checkNick(nick);
    if (s === "BAN") ban.push({ nick, r });
    else if (s === "REVIEW") rev.push({ nick, r });
  }

  let out = `${title}\nНайдено: ${names.length}\n\n`;
  if (ban.length) {
    out += `❌ BAN (${ban.length}):\n`;
    ban.forEach((x,i)=> out+=`${i+1}) ${x.nick} → ${x.r.join("; ")}\n`);
    out += "\n";
  }
  if (rev.length) {
    out += `⚠️ REVIEW (${rev.length}):\n`;
    rev.forEach((x,i)=> out+=`${i+1}) ${x.nick} → ${x.r.join("; ")}\n`);
    out += "\n";
  }
  if (!ban.length && !rev.length) out += "✅ Некорректных ников не найдено.\n";

  return { out, ban: ban.length, rev: rev.length };
}

/* ================== SAFE MODE: DISABLE CHUNK PARSING ================== */
function disableChunkParsing(bot) {
  const c = bot?._client;
  if (!c) return;

  const packetNames = [
    "map_chunk",
    "map_chunk_bulk",
    "unload_chunk",
    "multi_block_change",
    "block_change",
    "update_block_entity",
    "block_action"
  ];

  for (const name of packetNames) {
    try {
      c.removeAllListeners(name);
      c.on(name, () => {});
    } catch {}
  }

  console.log("[MC] chunk parsing disabled (safe mode)");
}

/* ================== SRV RESOLVE ================== */
async function resolveMcEndpoint(host, port) {
  const h = String(host || "").trim();
  const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(h);

  if (!isIp) {
    try {
      const srv = await resolveSrv(`_minecraft._tcp.${h}`);
      if (srv && srv.length) {
        srv.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
        const best = srv[0];
        return { host: best.name, port: best.port, via: "SRV" };
      }
    } catch {}
  }

  return { host: h, port: Number(port || 25565), via: "DIRECT" };
}

/* ================== TAB COMPLETE ================== */
function tabComplete(bot, text) {
  return new Promise((res, rej) => {
    if (!bot?._client) return rej(new Error("CLIENT_NOT_READY"));
    const c = bot._client;

    const to = setTimeout(() => {
      cleanup();
      rej(new Error("TAB_TIMEOUT"));
    }, 2500);

    const on = (p) => {
      cleanup();
      res(p?.matches?.map(x => typeof x==="string" ? x : (x.text||x.match||"")) || []);
    };

    function cleanup() {
      clearTimeout(to);
      try { c.removeListener("tab_complete", on); } catch {}
      try { c.removeListener("tab_complete_response", on); } catch {}
    }

    c.once("tab_complete", on);
    c.once("tab_complete_response", on);

    try {
      c.write("tab_complete", { text, assumeCommand: true, lookedAtBlock: { x:0, y:0, z:0 } });
    } catch (e) {
      cleanup();
      rej(e);
    }
  });
}

/* ================== MINEFLAYER ================== */
let mc;
let mcReady = false;
let tabReady = false;     // ✅ READY через tab_complete
let mcOnline = false;
let mcLastError = "";
let loginSent = false;
let registerSent = false;
let reconnectTimer = null;
let connecting = false;

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMC().catch(() => {});
  }, 5000);
}

async function connectMC() {
  if (connecting) return;
  connecting = true;

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  if (mc) {
    try { mc.quit?.("reconnect"); } catch {}
    try { mc.end?.(); } catch {}
    try { mc._client?.end?.(); } catch {}
    mc = null;
  }

  mcReady = false;
  tabReady = false;
  mcOnline = false;
  mcLastError = "";
  loginSent = false;
  registerSent = false;

  const ep = await resolveMcEndpoint(MC_HOST, MC_PORT);

  console.log("[MC DEBUG]", {
    inputHost: MC_HOST,
    inputPort: MC_PORT,
    resolvedHost: ep.host,
    resolvedPort: ep.port,
    via: ep.via,
    version: MC_VERSION,
    user: MC_USER
  });

  try {
    mc = mineflayer.createBot({
      host: ep.host,
      port: ep.port,
      username: MC_USER,
      version: MC_VERSION,
      viewDistance: 1
    });
  } catch (e) {
    mcLastError = "createBot failed: " + String(e?.message || e);
    console.log("[MC]", mcLastError);
    scheduleReconnect("createBot");
    connecting = false;
    return;
  }

  mc.on("login", () => {
    // глушим чанки, чтобы не падало
    disableChunkParsing(mc);

    mcOnline = true;
    mcReady = false;
    mcLastError = "";
    console.log("[MC] login");

    // ✅ Если spawn не приходит (лимбо/антибот), считаем готов по tab_complete
    setTimeout(async () => {
      if (!mc || mcReady || tabReady) return;
      try {
        const r = await tabComplete(mc, "/msg a");
        if (Array.isArray(r)) {
          tabReady = true;
          mcReady = true;
          console.log("[MC] READY via TAB_COMPLETE");
        }
      } catch {}
    }, 2500);
  });

  mc.on("spawn", () => {
    console.log("[MC] spawn");
    setTimeout(() => {
      if (mc && mc.entity) {
        mcReady = true;
        console.log("[MC] READY via SPAWN");
      } else {
        mcReady = false;
        scheduleReconnect("no-entity");
      }
    }, READY_AFTER_MS);
  });

  mc.on("messagestr", (msg) => {
    const m = String(msg).toLowerCase();
    if (MC_PASSWORD && !loginSent && m.includes("login")) {
      loginSent = true;
      setTimeout(() => mc?.chat?.(`/login ${MC_PASSWORD}`), 1500);
    }
    if (MC_PASSWORD && !registerSent && m.includes("register")) {
      registerSent = true;
      setTimeout(() => mc?.chat?.(`/register ${MC_PASSWORD} ${MC_PASSWORD}`), 1500);
    }
  });

  const onDisconnect = (reason) => {
    mcReady = false;
    tabReady = false;
    mcOnline = false;
    mcLastError = reason;
    loginSent = false;
    registerSent = false;
    console.log("[MC] disconnected:", reason);
    scheduleReconnect(reason);
  };

  mc.on("end", () => onDisconnect("end"));
  mc.on("kicked", (r) => onDisconnect("kicked: " + String(r)));
  mc.on("error", (e) => {
    const msg = (e && (e.stack || e.message)) ? (e.stack || e.message) : String(e);
    onDisconnect("error: " + msg);
  });

  setTimeout(() => { connecting = false; }, 1200);
}

connectMC().catch((e) => console.log("[MC] connect error:", e?.message || e));

/* ================== SCAN HELPERS ================== */
function clean(s) { return String(s).replace(/[^A-Za-z0-9_]/g, ""); }

async function byPrefix(prefix) {
  const raw = await tabComplete(mc, `/msg ${prefix}`);
  const pref = clean(prefix).toLowerCase();
  return raw.map(clean).filter(n => n.length>=3 && n.length<=16 && n.toLowerCase().startsWith(pref));
}

function prefixes() {
  if (AUTO_PREFIXES) return AUTO_PREFIXES.split(",").map(x=>x.trim()).filter(Boolean);
  const a=[];
  for(let i=97;i<=122;i++) a.push(String.fromCharCode(i));
  for(let i=0;i<=9;i++) a.push(String(i));
  a.push("_");
  return a;
}

async function collect(ps) {
  if (!mcReady) throw new Error("MC_NOT_READY");
  const all = new Set();
  for (const p of ps) {
    if (!mcReady) throw new Error("MC_NOT_READY");
    try { (await byPrefix(p)).forEach(n=>all.add(n)); } catch {}
    await new Promise(r=>setTimeout(r, SCAN_DELAY_MS));
  }
  return [...all];
}

/* ================== TELEGRAM ================== */
const tg = new Telegraf(BOT_TOKEN);

tg.start(c=>c.reply("Готов.\n/tab <префикс>\n/tabcheck <префикс>\n/scanall\n/status"));

tg.command("status", c=>{
  let s = "❌ не в сети";
  if (mcOnline && mcReady) s="✅ на сервере (готов)";
  else if (mcOnline) s="🟡 подключён, но не готов";
  c.reply(`MC статус: ${s}\nНик: ${MC_USER}\nВерсия: ${MC_VERSION}\n${mcLastError||""}`);
});

tg.command("tab", async c=>{
  if (!mcReady) return c.reply("MC не готов");
  const a=c.message.text.split(" ").slice(1).join(" ");
  const n=[...new Set(await byPrefix(a))];
  let t=`Tab ${a}\nНайдено: ${n.length}\n\n`;
  n.forEach((x,i)=>t+=`${i+1}) ${x}\n`);
  sendChunksReply(c,t);
});

tg.command("tabcheck", async c=>{
  if (!mcReady) return c.reply("MC не готов");
  const a=c.message.text.split(" ").slice(1).join(" ");
  const n=await byPrefix(a);
  sendChunksReply(c, report(`Tabcheck ${a}`, n).out);
});

tg.command("scanall", async c=>{
  if (!mcReady) return c.reply("MC не готов");
  c.reply("Сканирую...");
  const n=await collect(prefixes());
  sendChunksReply(c, report("Full scan", n).out);
});

tg.launch({ dropPendingUpdates:true });
console.log("TG bot started");

/* ================== AUTO SCAN ================== */
if (AUTO_SCAN) {
  setInterval(async ()=>{
    try {
      if (!mcReady) return;
      if (!CHAT_ID) return;
      const n=await collect(prefixes());
      const r=report("Auto scan", n);
      if (r.ban||r.rev) await sendChunksChat(tg, CHAT_ID, r.out);
    } catch (e) {
      console.log("[AUTO] error:", String(e?.message||e));
    }
  }, AUTO_SCAN_MINUTES*60*1000);
  }

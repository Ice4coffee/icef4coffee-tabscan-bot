import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { resolveSrv } from "dns/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PING_USER_ID = process.env.PING_USER_ID ? Number(process.env.PING_USER_ID) : null;
const BOT_MODE = (process.env.BOT_MODE || "moderation").trim().toLowerCase();
const IS_HELPER_MODE = BOT_MODE === "helper";
const IS_MODERATION_MODE = !IS_HELPER_MODE;

const MC_HOST = (process.env.MC_HOST || "").trim();
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const HELPER_CHAT_BUFFER = Number(process.env.HELPER_CHAT_BUFFER || 40);
const HELPER_BRIDGE_NUMBER = Math.min(4, Math.max(1, Number(process.env.HELPER_BRIDGE_NUMBER || 1)));
const HELPER_RULES_FILE = (process.env.HELPER_RULES_FILE || "helper-rules.json").trim();

const MC_VERSION = process.env.MC_VERSION || "1.8.9";
const MC_PASSWORD = process.env.MC_PASSWORD; // РёСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ С‚РІРѕРёРј messagestr Р»РѕРіРёРЅРѕРј

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);
const AUTO_PREFIXES = (process.env.AUTO_PREFIXES || "").trim();

const READY_AFTER_MS = Number(process.env.READY_AFTER_MS || 1500);

// Gemini
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const AI_ENABLED = (process.env.AI_ENABLED || "1") === "1";
const AI_BUDGET_PER_CLICK = Number(process.env.AI_BUDGET_PER_CLICK || 30);
const AI_DELAY_MS = Number(process.env.AI_DELAY_MS || 350);
const AI_MIN_CONF_FOR_BAN = Number(process.env.AI_MIN_CONF_FOR_BAN || 0.75);
const AI_MIN_CONF_FOR_OK = Number(process.env.AI_MIN_CONF_FOR_OK || 0.75);

if (!BOT_TOKEN || !MC_USER || !MC_HOST) {
  throw new Error("Нужны BOT_TOKEN, MC_USER и MC_HOST");
}

/* ================== TELEGRAM BOT ================== */
const tg = new Telegraf(BOT_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

tg.catch((err) => console.log("вљ пёЏ TG handler error:", err?.message || err));

async function safeSend(chatId, text, extra) {
  try {
    await tg.telegram.sendMessage(chatId, text, extra);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ================== 409 FIX (Р±РµР· РїР°РґРµРЅРёР№) ================== */
async function launchTelegramSafely() {
  while (true) {
    try {
      console.log("рџ¤– Telegram startingвЂ¦");
      await tg.launch({ dropPendingUpdates: true });
      console.log("вњ… Telegram started");
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("409") || msg.includes("Conflict")) {
        console.log("вљ пёЏ 409 Conflict вЂ” РґСЂСѓРіРѕР№ РёРЅСЃС‚Р°РЅСЃ getUpdates. Р–РґСѓ 15СЃвЂ¦");
        await sleep(15000);
        continue;
      }
      console.log("вќЊ Telegram launch error:", msg);
      await sleep(5000);
    }
  }
}

/* ================== RULES ================== */
let RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));
let HELPER_RULES = JSON.parse(fs.readFileSync(HELPER_RULES_FILE, "utf8"));

function reloadRules() {
  RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));
  // РѕР±РЅРѕРІРёРј regex/РЅР°СЃС‚СЂРѕР№РєРё
  rebuildNormalization();
}

function reloadHelperRules() {
  HELPER_RULES = JSON.parse(fs.readFileSync(HELPER_RULES_FILE, "utf8"));
}

/* ================== NORMALIZE ================== */
const cyr = { "Р°":"a","Рµ":"e","Рѕ":"o","СЂ":"p","СЃ":"c","С…":"x","Сѓ":"y","Рє":"k","Рј":"m","С‚":"t" };

let invisRe, sepRe, leetMap, collapseRepeats, maxRepeat;

function stripColors(s = "") { return s.replace(/В§./g, ""); }

function rebuildNormalization() {
  invisRe = new RegExp(
    RULES?.normalization?.strip_invisibles_regex || "[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]",
    "g"
  );
  sepRe = new RegExp(
    RULES?.normalization?.separators_regex || "[\\s\\-_.:,;|/\\\\~`'\"^*+=()\\[\\]{}<>]+",
    "g"
  );
  leetMap = RULES?.normalization?.leet_map || { "0":"o","1":"i","3":"e","4":"a","5":"s","7":"t","@":"a","$":"s" };
  collapseRepeats = RULES?.normalization?.collapse_repeats ?? true;
  maxRepeat = RULES?.normalization?.max_repeat ?? 2;
}
rebuildNormalization();

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
  for (const p of splitText(text)) {
    if (!p.trim()) continue;
    const ok = await safeSend(chatId, p);
    if (!ok) throw new Error("TG_SEND_FAILED");
  }
}

async function sendChunksChatHtml(bot, chatId, html) {
  for (const p of splitText(html)) {
    if (!p.trim()) continue;
    const ok = await safeSend(chatId, p, { parse_mode: "HTML" });
    if (ok) continue;

    const fallback = p.replace(/<[^>]+>/g, "");
    const plainOk = await safeSend(chatId, fallback);
    if (!plainOk) throw new Error("TG_SEND_FAILED");
  }
}

function report(title, names) {
  const ban = [];
  const rev = [];
  for (const nick of names) {
    const [s, r] = checkNick(nick);
    if (s === "BAN") ban.push({ nick, r });
    else if (s === "REVIEW") rev.push({ nick, r });
  }

  let out = `${title}\nРќР°Р№РґРµРЅРѕ: ${names.length}\n\n`;
  if (ban.length) {
    out += `вќЊ BAN (${ban.length}):\n`;
    ban.forEach((x,i)=> out+=`${i+1}) ${x.nick} в†’ ${x.r.join("; ")}\n`);
    out += "\n";
  }
  if (rev.length) {
    out += `вљ пёЏ REVIEW (${rev.length}):\n`;
    rev.forEach((x,i)=> out+=`${i+1}) ${x.nick} в†’ ${x.r.join("; ")}\n`);
    out += "\n";
  }
  if (!ban.length && !rev.length) out += "вњ… РќРµРєРѕСЂСЂРµРєС‚РЅС‹С… РЅРёРєРѕРІ РЅРµ РЅР°Р№РґРµРЅРѕ.\n";

  return { out, ban: ban.length, rev: rev.length, reviewNicks: rev.map(x => x.nick) };
}

function helperNorm(s = "") {
  return norm(s);
}

function detectBadWordInText(text) {
  const normalizedText = helperNorm(text);
  const banRules = HELPER_RULES?.ban_rules || [];
  const keywordRules = HELPER_RULES?.keyword_rules || [];
  const allRules = [...banRules, ...keywordRules];

  for (const rule of allRules) {
    for (const sourceWord of (rule.words || [])) {
      const w = helperNorm(String(sourceWord));
      if (!w) continue;
      if (normalizedText.includes(w)) {
        return {
          ruleId: rule.id || "BAN_RULE",
          reason: rule.reason || "Нарушение правил",
          word: sourceWord
        };
      }
    }
  }
  return null;
}

function detectRule211Violation(text) {
  const src = String(text || "");
  const low = src.toLowerCase();
  const cfg = HELPER_RULES?.rule_211 || {};

  if (cfg.enabled === false) return null;

  const patterns = Array.isArray(cfg.patterns) ? cfg.patterns : [];
  for (const rx of patterns) {
    try {
      const re = new RegExp(rx, "i");
      const m = src.match(re);
      if (!m) continue;
      return {
        ruleId: "2.11",
        reason: "Распространение личной информации",
        word: m[0] || "personal-info"
      };
    } catch {}
  }

  const contains = Array.isArray(cfg.contains) ? cfg.contains : [];
  for (const marker of contains) {
    if (marker && low.includes(String(marker).toLowerCase())) {
      return {
        ruleId: "2.11",
        reason: "Распространение личной информации",
        word: String(marker)
      };
    }
  }

  return null;
}

function detectChatViolation(text) {
  return detectRule211Violation(text) || detectBadWordInText(text);
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
let tabReady = false;     // вњ… READY С‡РµСЂРµР· tab_complete
let mcOnline = false;
let mcLastError = "";
let loginSent = false;
let registerSent = false;
let reconnectTimer = null;
let connecting = false;
let autoScanPrimed = false;

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
  autoScanPrimed = false;
  helperBridgeJoined = false;

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
    // РіР»СѓС€РёРј С‡Р°РЅРєРё, С‡С‚РѕР±С‹ РЅРµ РїР°РґР°Р»Рѕ
    disableChunkParsing(mc);

    mcOnline = true;
    mcReady = false;
    mcLastError = "";
    console.log("[MC] login");

    // вњ… Р•СЃР»Рё spawn РЅРµ РїСЂРёС…РѕРґРёС‚ (Р»РёРјР±Рѕ/Р°РЅС‚РёР±РѕС‚), СЃС‡РёС‚Р°РµРј РіРѕС‚РѕРІ РїРѕ tab_complete
    setTimeout(async () => {
      if (!mc || mcReady || tabReady) return;
      try {
        const r = await tabComplete(mc, "/msg a");
        if (Array.isArray(r)) {
          tabReady = true;
          mcReady = true;
          primeAutoScan();
          if (IS_HELPER_MODE) setTimeout(() => helperTryJoinBridge().catch(() => {}), 2000);
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
        primeAutoScan();
        if (IS_HELPER_MODE) setTimeout(() => helperTryJoinBridge().catch(() => {}), 1500);
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

  if (IS_HELPER_MODE) {
    mc.on("messagestr", async (msg) => {
      const parsed = parseHelperChatMessage(msg);
      if (!parsed) return;

      helperPushChatLine(`${parsed.nick}: ${parsed.message}`);

      const violation = detectChatViolation(parsed.message);
      if (!violation) return;

      try {
        await sendHelperAlert(parsed.nick, violation, parsed.message);
      } catch (e) {
        console.log("[HELPER] alert send error:", String(e?.message || e));
      }
    });
  }

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

/* ================== HELPER MODE ================== */
let helperChatLogs = [];
let helperScanAlerts = 0;
let helperBridgeNumber = HELPER_BRIDGE_NUMBER;
let helperBridgeJoined = false;

function helperPushChatLine(line) {
  helperChatLogs.push(`[${new Date().toISOString()}] ${line}`);
  if (helperChatLogs.length > HELPER_CHAT_BUFFER) {
    helperChatLogs = helperChatLogs.slice(-HELPER_CHAT_BUFFER);
  }
}

function helperExtractItemText(item) {
  if (!item) return "";
  const parts = [];
  if (item.displayName) parts.push(String(item.displayName));
  if (item.name) parts.push(String(item.name));
  try {
    const nbt = JSON.stringify(item.nbt || {});
    if (nbt) parts.push(nbt);
  } catch {}
  return parts.join(" ").toLowerCase();
}

function helperFindSlotByKeywords(window, keywords = []) {
  if (!window?.slots) return -1;
  for (let i = 0; i < window.slots.length; i++) {
    const txt = helperExtractItemText(window.slots[i]);
    if (!txt) continue;
    if (keywords.some((v) => txt.includes(v))) return i;
  }
  return -1;
}

function helperFindBridgeHubSlot(window) {
  return helperFindSlotByKeywords(window, ["bridging", "бридж", "тренировк"]);
}

function helperFindBridgeServerSlot(window, bridgeNumber) {
  const n = Number(bridgeNumber);
  return helperFindSlotByKeywords(window, [
    `fastbridge-${n}`,
    `fast bridge-${n}`,
    `fastbridge ${n}`,
    `bridge-${n}`,
    `bridge ${n}`,
    `бридж ${n}`,
    `№${n}`
  ]);
}

async function helperTryJoinBridge() {
  if (!IS_HELPER_MODE || !mcReady || !mc) return;
  if (helperBridgeJoined) return;

  try { mc.chat(`/bridge ${helperBridgeNumber}`); } catch {}
  try { mc.chat(`/join fastbridge-${helperBridgeNumber}`); } catch {}

  try {
    mc.activateItem();
  } catch {}

  const startedAt = Date.now();
  const maxMs = 12000;

  const onWindowOpen = async (window) => {
    try {
      const serverSlot = helperFindBridgeServerSlot(window, helperBridgeNumber);
      if (serverSlot >= 0) {
        await mc.clickWindow(serverSlot, 0, 0);
        helperBridgeJoined = true;
        mc.removeListener("windowOpen", onWindowOpen);
        return;
      }

      const hubSlot = helperFindBridgeHubSlot(window);
      if (hubSlot >= 0) {
        await mc.clickWindow(hubSlot, 0, 0);
        return;
      }

      if (Date.now() - startedAt > maxMs) {
        mc.removeListener("windowOpen", onWindowOpen);
      }
    } catch (e) {
      console.log("[HELPER] bridge select error:", String(e?.message || e));
      mc.removeListener("windowOpen", onWindowOpen);
    }
  };

  mc.on("windowOpen", onWindowOpen);
  setTimeout(() => {
    try { mc.removeListener("windowOpen", onWindowOpen); } catch {}
  }, maxMs);
}

async function helperScreenshotBuffer(lines) {
  const width = 1200;
  const height = 720;
  const data = Buffer.alloc(width * height * 4, 255);

  const putPixel = (x, y, r, g, b) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };

  const drawRect = (x, y, w, h, r, g, b) => {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) putPixel(xx, yy, r, g, b);
    }
  };

  const drawTextLike = (x, y, text, type = "normal") => {
    let cursor = x;
    for (const ch of String(text)) {
      if (cursor > width - 10) break;
      if (ch === " ") {
        cursor += 7;
        continue;
      }
      const color = type === "title" ? [80, 190, 255] : type === "alert" ? [255, 120, 120] : [220, 220, 220];
      drawRect(cursor, y, 5, 8, color[0], color[1], color[2]);
      cursor += 7;
    }
  };

  drawRect(0, 0, width, height, 17, 22, 28);
  drawRect(0, 0, width, 44, 28, 38, 48);
  drawTextLike(20, 16, "TABSCAN HELPER MODE SNAPSHOT", "title");

  let y = 70;
  for (const line of lines.slice(-26)) {
    drawTextLike(24, y, line, line.includes("ALERT") ? "alert" : "normal");
    y += 22;
    if (y > height - 16) break;
  }

  const chunks = [];
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const chunk = (type, chunkData) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(chunkData.length, 0);
    const t = Buffer.from(type);
    const crcBuf = Buffer.concat([t, chunkData]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcBuf), 0);
    chunks.push(Buffer.concat([len, t, chunkData, crc]));
  };

  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk("IHDR", ihdr);

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y0 = 0; y0 < height; y0++) {
    const rowStart = y0 * (stride + 1);
    raw[rowStart] = 0;
    data.copy(raw, rowStart + 1, y0 * stride, y0 * stride + stride);
  }

  const { deflateSync } = await import("zlib");
  const compressed = deflateSync(raw, { level: 9 });
  chunk("IDAT", compressed);
  chunk("IEND", Buffer.alloc(0));

  return Buffer.concat([sig, ...chunks]);
}

async function sendHelperAlert(nick, violation, messageText) {
  if (!CHAT_ID) return;

  const alertLine = `ALERT ${nick}: ${messageText}`;
  helperPushChatLine(alertLine);

  const screenshotPath = `helper-chat-${Date.now()}.png`;
  const screenshot = await helperScreenshotBuffer([
    `Server: ${MC_HOST}:${MC_PORT} (bridge ${helperBridgeNumber})`,
    `Violation: ${violation.reason} (${violation.ruleId})`,
    `Word: ${violation.word}`,
    `Nick: ${nick}`,
    `Message: ${messageText}`,
    ...helperChatLogs
  ]);
  fs.writeFileSync(screenshotPath, screenshot);

  const text = [
    `🚨 Обнаружено нарушение в helper mode`,
    `Ник: ${nick}`,
    `Правило: ${violation.reason} (${violation.ruleId})`,
    `Слово: ${violation.word}`,
    `Сообщение: ${messageText}`,
    `Bridge: ${helperBridgeNumber}`
  ].join("\n");

  await safeSend(CHAT_ID, text);
  await tg.telegram.sendPhoto(CHAT_ID, { source: screenshotPath }, { caption: `Скрин чата: ${nick}` });
  helperScanAlerts += 1;
}

function parseHelperChatMessage(rawLine = "") {
  const line = String(rawLine).replace(/§./g, "").trim();
  if (!line) return null;

  let match = line.match(/^<([^>]{1,32})>\s+(.+)$/);
  if (match) return { nick: match[1], message: match[2] };

  match = line.match(/^\[.+?\]\s*([^:\s]{1,32})\s*:\s*(.+)$/);
  if (match) return { nick: match[1], message: match[2] };

  return null;
}

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
    await sleep(SCAN_DELAY_MS);
  }
  return [...all];
}

/* ================== GEMINI AI ================== */
let geminiModel = null;
if (GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
}

async function geminiReviewNick(nick) {
  if (!AI_ENABLED || !geminiModel) {
    return { decision: "REVIEW", confidence: 0, reason: "AI РІС‹РєР»СЋС‡РµРЅ" };
  }

  const normalized = norm(nick);

  const prompt = `
Р’РµСЂРЅРё РЎРўР РћР“Рћ JSON Р±РµР· С‚РµРєСЃС‚Р° РІРѕРєСЂСѓРі:
{"decision":"BAN|REVIEW|OK","confidence":0.0,"reason":"РєСЂР°С‚РєРѕ"}

BAN вЂ” СЏРІРЅС‹Р№ РјР°С‚/РѕСЃРєРѕСЂР±Р»РµРЅРёСЏ/СЂР°СЃРёР·Рј/СЌРєСЃС‚СЂРµРјРёР·Рј/18+/РЅР°СЂРєРѕС‚РёРєРё/С‡РёС‚С‹/РјР°СЃРєРёСЂРѕРІРєР° РїРѕРґ РїРµСЂСЃРѕРЅР°Р»/РїСЂРѕРµРєС‚.
REVIEW вЂ” СЃРѕРјРЅРёС‚РµР»СЊРЅРѕ/РЅР°РјС‘Рє/РґРІСѓСЃРјС‹СЃР»РµРЅРЅРѕ.
OK вЂ” С‡РёСЃС‚Рѕ.

РќРёРє: ${nick}
РќРѕСЂРјР°Р»РёР·Р°С†РёСЏ: ${normalized}
`;

  try {
    const result = await geminiModel.generateContent(prompt);
    const text = result?.response?.text?.()?.trim?.() || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { decision: "REVIEW", confidence: 0, reason: "AI РЅРµ РІРµСЂРЅСѓР» JSON" };

    const data = JSON.parse(m[0]);
    const decision = String(data.decision || "REVIEW").toUpperCase();
    const confidence = Math.max(0, Math.min(1, Number(data.confidence || 0)));
    const reason = String(data.reason || "вЂ”").slice(0, 120);

    if (!["BAN","REVIEW","OK"].includes(decision)) return { decision: "REVIEW", confidence: 0, reason: "AI decision РЅРµРєРѕСЂСЂРµРєС‚РЅС‹Р№" };
    return { decision, confidence, reason };
  } catch {
    return { decision: "REVIEW", confidence: 0, reason: "РћС€РёР±РєР° Gemini" };
  }
}

/* ================== LAST SCAN CACHE ================== */
let lastScan = null;
// { ts, names:[], reportText, reviewNicks:[] }

/* ================== STATUS HELPERS ================== */
let autoScanRunning = false;
let autoScanLastRunTs = 0;
let autoScanLastResult = "not_started";
let autoScanLastError = "";
let autoScanTimer = null;

function formatMcStatus() {
  if (mcOnline && mcReady) return "✅ на сервере (готов)";
  if (mcOnline) return "🟡 подключён, но не готов";
  return "❌ не в сети";
}

function formatAutoScanStatus() {
  if (!AUTO_SCAN) return "❌ выключен";
  if (autoScanRunning) return "🔄 идёт скан";
  if (autoScanLastResult === "not_started") return "⏳ ожидает первого запуска";
  if (autoScanLastResult === "waiting_mc") return "⏳ ожидает готовности MC";
  if (autoScanLastResult === "missing_chat") return "❌ нет CHAT_ID";
  if (autoScanLastResult === "ok_no_hits") return "✅ последний проход без совпадений";
  if (autoScanLastResult === "ok_hits") return "⚠️ последний проход нашёл совпадения";
  if (autoScanLastResult === "send_failed") return "❌ ошибка отправки в Telegram";
  if (autoScanLastResult === "error") return "❌ ошибка автоскана";
  return autoScanLastResult;
}

function formatStatusText() {
  const ai = (AI_ENABLED && geminiModel) ? "✅ включён" : "❌ выключен";
  const last = lastScan ? `✅ есть (${Math.round((Date.now()-lastScan.ts)/1000)}с назад)` : "❌ нет";
  const autoAge = autoScanLastRunTs ? `${Math.round((Date.now() - autoScanLastRunTs) / 1000)}с назад` : "ещё не запускался";

  return [
    `MC статус: ${formatMcStatus()}`,
    `Ник: ${MC_USER}`,
    `Версия: ${MC_VERSION}`,
    `AI (Gemini): ${ai}`,
    `Last scan: ${last}`,
    `Auto scan: ${formatAutoScanStatus()}`,
    `Auto scan last run: ${autoAge}`,
    mcLastError || "",
    autoScanLastError ? `Auto scan error: ${autoScanLastError}` : ""
  ].filter(Boolean).join("\n");
}

/* ================== BUTTONS MENU ================== */
function menuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("рџ”Ћ РЎРєР°РЅ РІСЃРµС… (rules)", "scan_all")],
    [Markup.button.callback("рџ¤– AI РїРѕ РїРѕСЃР»РµРґРЅРµРјСѓ СЃРєР°РЅСѓ", "ai_last")],
    [Markup.button.callback("рџ§Є AI РѕРґРёРЅ РЅРёРє", "ai_one")],
    [Markup.button.callback("рџ“Љ РЎС‚Р°С‚СѓСЃ", "status"), Markup.button.callback("рџ”Ѓ Reload rules", "reload_rules")]
  ]);
}

if (IS_MODERATION_MODE) {
/* ================== COMMANDS (РѕСЃС‚Р°РІР»СЏРµРј) ================== */
tg.start((c) => c.reply("Р“РѕС‚РѕРІ.\n/tab <РїСЂРµС„РёРєСЃ>\n/tabcheck <РїСЂРµС„РёРєСЃ>\n/scanall\n/status", menuKeyboard()));

tg.command("status", (c) => {
  c.reply(formatStatusText(), menuKeyboard());
});

tg.command("tab", async (c) => {
  if (!mcReady) return c.reply("MC РЅРµ РіРѕС‚РѕРІ", menuKeyboard());
  const a = c.message.text.split(" ").slice(1).join(" ");
  const n = [...new Set(await byPrefix(a))];
  let t = `Tab ${a}\nРќР°Р№РґРµРЅРѕ: ${n.length}\n\n`;
  n.forEach((x,i)=>t+=`${i+1}) ${x}\n`);
  await sendChunksReply(c, t);
  await c.reply("РњРµРЅСЋ:", menuKeyboard());
});

tg.command("tabcheck", async (c) => {
  if (!mcReady) return c.reply("MC РЅРµ РіРѕС‚РѕРІ", menuKeyboard());
  const a = c.message.text.split(" ").slice(1).join(" ");
  const n = await byPrefix(a);
  await sendChunksReply(c, report(`Tabcheck ${a}`, n).out);
  await c.reply("РњРµРЅСЋ:", menuKeyboard());
});

tg.command("scanall", async (c) => {
  if (!mcReady) return c.reply("MC РЅРµ РіРѕС‚РѕРІ", menuKeyboard());
  await c.reply("РЎРєР°РЅРёСЂСѓСЋ...", menuKeyboard());
  const n = await collect(prefixes());
  const r = report("Full scan", n);

  lastScan = { ts: Date.now(), names: n, reportText: r.out, reviewNicks: r.reviewNicks };

  await sendChunksReply(c, r.out);
  await c.reply("Р“РѕС‚РѕРІРѕ. РњРѕР¶РµС€СЊ РЅР°Р¶Р°С‚СЊ рџ¤– AI РїРѕ РїРѕСЃР»РµРґРЅРµРјСѓ СЃРєР°РЅСѓ", menuKeyboard());
});

/* ================== BUTTON HANDLERS ================== */
tg.action("status", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  await ctx.reply(formatStatusText(), menuKeyboard());
});

tg.action("reload_rules", async (ctx) => {
  try { await ctx.answerCbQuery("ReloadвЂ¦"); } catch {}
  try {
    reloadRules();
    await ctx.reply("вњ… rules.json РїРµСЂРµР·Р°РіСЂСѓР¶РµРЅ", menuKeyboard());
  } catch (e) {
    await ctx.reply("вќЊ rules.json reload error: " + String(e?.message || e), menuKeyboard());
  }
});

tg.action("scan_all", async (ctx) => {
  try { await ctx.answerCbQuery("ScanвЂ¦"); } catch {}
  if (!mcReady) return ctx.reply("MC РЅРµ РіРѕС‚РѕРІ", menuKeyboard());
  await ctx.reply("рџ”Ћ РЎРєР°РЅРёСЂСѓСЋ РІСЃРµС…вЂ¦", menuKeyboard());

  const n = await collect(prefixes());
  const r = report("Full scan (button)", n);

  lastScan = { ts: Date.now(), names: n, reportText: r.out, reviewNicks: r.reviewNicks };

  await sendChunksReply(ctx, r.out);
  await ctx.reply("Р“РѕС‚РѕРІРѕ. РќР°Р¶РјРё рџ¤– AI РїРѕ РїРѕСЃР»РµРґРЅРµРјСѓ СЃРєР°РЅСѓ", menuKeyboard());
});

/* ====== AI LAST SCAN ====== */
tg.action("ai_last", async (ctx) => {
  try { await ctx.answerCbQuery("AIвЂ¦"); } catch {}

  if (!lastScan) return ctx.reply("вќЊ РќРµС‚ РїРѕСЃР»РµРґРЅРµРіРѕ СЃРєР°РЅР°. РЎРЅР°С‡Р°Р»Р° СЃРґРµР»Р°Р№ /scanall РёР»Рё РєРЅРѕРїРєСѓ рџ”Ћ", menuKeyboard());
  if (!AI_ENABLED || !geminiModel) return ctx.reply("вќЊ AI РІС‹РєР»СЋС‡РµРЅ (РЅРµС‚ GEMINI_API_KEY РёР»Рё AI_ENABLED=0)", menuKeyboard());

  const candidates = [...(lastScan.reviewNicks || [])];
  if (!candidates.length) {
    return ctx.reply("вњ… Р’ РїРѕСЃР»РµРґРЅРµРј СЃРєР°РЅРµ РЅРµС‚ REVIEW. AI РЅРµС‡РµРіРѕ РїСЂРѕРІРµСЂСЏС‚СЊ.", menuKeyboard());
  }

  await ctx.reply(`рџ¤– AI РїСЂРѕРІРµСЂСЏСЋ REVIEW РёР· РїРѕСЃР»РµРґРЅРµРіРѕ СЃРєР°РЅР°вЂ¦ (${candidates.length})`, menuKeyboard());

  const ban = [];
  const ok = [];
  const review = [];

  let budget = Math.max(0, AI_BUDGET_PER_CLICK);

  for (const nick of candidates) {
    if (budget <= 0) {
      review.push(`${nick} (Р»РёРјРёС‚ AI РёСЃС‡РµСЂРїР°РЅ)`);
      continue;
    }
    budget--;

    const ai = await geminiReviewNick(nick);
    await sleep(AI_DELAY_MS);

    if (ai.decision === "BAN" && ai.confidence >= AI_MIN_CONF_FOR_BAN) {
      ban.push(`${nick} (AI: ${ai.reason}, ${Math.round(ai.confidence * 100)}%)`);
    } else if (ai.decision === "OK" && ai.confidence >= AI_MIN_CONF_FOR_OK) {
      ok.push(`${nick} (AI OK, ${Math.round(ai.confidence * 100)}%)`);
    } else {
      review.push(`${nick} (AI: ${ai.reason}, ${Math.round(ai.confidence * 100)}%)`);
    }
  }

  let out = `рџ¤– AI RESULT (РїРѕСЃР»РµРґРЅРёР№ СЃРєР°РЅ)\n\n`;
  out += `рџљ« BAN: ${ban.length}\n`;
  out += `вњ… OK: ${ok.length}\n`;
  out += `вљ пёЏ REVIEW: ${review.length}\n\n`;

  if (ban.length) out += `рџљ« BAN LIST:\n${ban.join("\n")}\n\n`;
  if (review.length) out += `вљ пёЏ REVIEW LIST:\n${review.join("\n")}\n\n`;
  if (ok.length) out += `вњ… OK LIST:\n${ok.join("\n")}\n\n`;

  await sendChunksReply(ctx, out);
  await ctx.reply("РњРµРЅСЋ:", menuKeyboard());
});

/* ====== AI ONE NICK (manual) ====== */
const awaitingNick = new Map(); // chatId -> userId

tg.action("ai_one", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  awaitingNick.set(ctx.chat.id, ctx.from.id);
  await ctx.reply("рџ§Є РћС‚РїСЂР°РІСЊ РЅРёРє РѕРґРЅРёРј СЃРѕРѕР±С‰РµРЅРёРµРј (С‚РѕР»СЊРєРѕ РЅРёРє).", menuKeyboard());
});

tg.on("text", async (ctx) => {
  const uid = awaitingNick.get(ctx.chat.id);
  if (!uid || uid !== ctx.from.id) return;

  awaitingNick.delete(ctx.chat.id);

  const nick = String(ctx.message.text || "").trim();
  if (!nick) return ctx.reply("вќЊ РџСѓСЃС‚Рѕ. РџСЂРёС€Р»Рё РЅРёРє.", menuKeyboard());

  const [s, reasons] = checkNick(nick);
  const ai = await geminiReviewNick(nick);

  const out =
    `рџ”Ћ РќРёРє: ${nick}\n` +
    `рџ“њ Rules: ${s}${reasons?.length ? ` вЂ” ${reasons.join("; ")}` : ""}\n` +
    `рџ¤– AI: ${ai.decision} вЂ” ${ai.reason} (${Math.round(ai.confidence * 100)}%)\n` +
    `РќРѕСЂРјР°Р»РёР·Р°С†РёСЏ: ${norm(nick)}`;

  await ctx.reply(out, menuKeyboard());
});

/* ================== AUTO SCAN ================== */
async function runAutoScan(trigger = "timer") {
  if (autoScanRunning) return;

  if (!mcReady) {
    autoScanLastResult = "waiting_mc";
    return;
  }

  if (!CHAT_ID) {
    autoScanLastResult = "missing_chat";
    autoScanLastError = "CHAT_ID not set";
    return;
  }

  autoScanRunning = true;
  autoScanLastError = "";

  try {
    const n = await collect(prefixes());
    const r = report("Auto scan", n);

    lastScan = { ts: Date.now(), names: n, reportText: r.out, reviewNicks: r.reviewNicks };
    autoScanLastRunTs = Date.now();

    if (r.ban || r.rev) {
      if (PING_USER_ID) {
        const html = `<a href="tg://user?id=${PING_USER_ID}">&#8203;</a>\n<pre>${escapeHtml(r.out)}</pre>`;
        await sendChunksChatHtml(tg, CHAT_ID, html);
      } else {
        await sendChunksChat(tg, CHAT_ID, r.out);
      }
      autoScanLastResult = "ok_hits";
    } else {
      autoScanLastResult = "ok_no_hits";
    }

    console.log(`[AUTO] ${trigger}: ${n.length} names, ban=${r.ban}, review=${r.rev}`);
  } catch (e) {
    autoScanLastResult = "error";
    autoScanLastError = String(e?.message || e);
    console.log("[AUTO] error:", autoScanLastError);
  } finally {
    autoScanRunning = false;
  }
}

function scheduleNextAutoScan(delayMs = AUTO_SCAN_MINUTES * 60 * 1000) {
  if (!AUTO_SCAN) return;
  if (autoScanTimer) clearTimeout(autoScanTimer);
  autoScanTimer = setTimeout(async () => {
    await runAutoScan("timer");
    scheduleNextAutoScan();
  }, Math.max(1000, delayMs));
}

function primeAutoScan() {
  if (!AUTO_SCAN || autoScanPrimed) return;
  autoScanPrimed = true;
  scheduleNextAutoScan(Math.min(15000, AUTO_SCAN_MINUTES * 60 * 1000));
  runAutoScan("ready").catch((e) => {
    autoScanLastResult = "error";
    autoScanLastError = String(e?.message || e);
  });
}

if (AUTO_SCAN) {
  scheduleNextAutoScan();
}

} else {
  tg.start((c) => c.reply(`Helper mode активен.
Сервер: ${MC_HOST}:${MC_PORT}
Сканирую чат на нарушения и отправляю алерты в CHAT_ID.\nПравила helper: ${HELPER_RULES_FILE}`));

  tg.command("status", (c) => {
    const lines = [
      `Mode: helper`,
      `MC статус: ${formatMcStatus()}`,
      `Сервер: ${MC_HOST}:${MC_PORT}`,
      `Bridge: ${helperBridgeNumber}`,
      `Helper rules: ${HELPER_RULES_FILE}`,
      `Алертов отправлено: ${helperScanAlerts}`,
      `Буфер чата: ${helperChatLogs.length}/${HELPER_CHAT_BUFFER}`
    ];
    c.reply(lines.join("\n"));
  });


  tg.command("reload_helper_rules", async (c) => {
    try {
      reloadHelperRules();
      await c.reply(`✅ helper rules перезагружены: ${HELPER_RULES_FILE}`);
    } catch (e) {
      await c.reply("❌ helper rules reload error: " + String(e?.message || e));
    }
  });

  tg.command("bridge", async (c) => {
    const raw = String(c.message.text || "").split(" ").slice(1).join(" ").trim();
    const next = Number(raw);
    if (!Number.isInteger(next) || next < 1 || next > 4) {
      return c.reply("Используй: /bridge 1|2|3|4 (это fastbridge-N)");
    }

    helperBridgeNumber = next;
    helperBridgeJoined = false;
    await c.reply(`Ок, выбрал bridge ${helperBridgeNumber}. Пробую переключиться...`);
    await helperTryJoinBridge().catch(() => {});
  });
}

/* ================== START ================== */
(async () => {
  await launchTelegramSafely();
  console.log("TG bot started");
})();







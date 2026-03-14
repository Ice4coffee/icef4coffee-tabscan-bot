import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { resolveSrv } from "dns/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PING_USER_ID = process.env.PING_USER_ID ? Number(process.env.PING_USER_ID) : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.ALLOWED_USER_IDS || process.env.PING_USER_ID || "")
    .split(",")
    .map((x) => Number(String(x).trim()))
    .filter((x) => Number.isInteger(x) && x > 0)
);

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
const STARTUP_SCAN_DELAY_MS = Number(process.env.STARTUP_SCAN_DELAY_MS || 8000);
const TAB_WARMUP_RETRIES = Number(process.env.TAB_WARMUP_RETRIES || 4);
const TAB_WARMUP_DELAY_MS = Number(process.env.TAB_WARMUP_DELAY_MS || 2000);
const AUTO_RETRY_ON_FAIL_MINUTES = Number(process.env.AUTO_RETRY_ON_FAIL_MINUTES || 2);
const MAX_PREFIX_ERRORS_IN_REPORT = Number(process.env.MAX_PREFIX_ERRORS_IN_REPORT || 8);

// Gemini
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const AI_ENABLED = (process.env.AI_ENABLED || "1") === "1";
const AI_BUDGET_PER_CLICK = Number(process.env.AI_BUDGET_PER_CLICK || 30);
const AI_DELAY_MS = Number(process.env.AI_DELAY_MS || 350);
const AI_MIN_CONF_FOR_BAN = Number(process.env.AI_MIN_CONF_FOR_BAN || 0.75);
const AI_MIN_CONF_FOR_OK = Number(process.env.AI_MIN_CONF_FOR_OK || 0.75);

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  throw new Error("Нужны BOT_TOKEN, MC_HOST, MC_USER");
}

/* ================== TELEGRAM BOT ================== */
const tg = new Telegraf(BOT_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString("ru-RU") : "—");

function isAllowedUser(userId) {
  if (!userId) return false;
  if (ALLOWED_USER_IDS.size === 0) return true;
  return ALLOWED_USER_IDS.has(Number(userId));
}

async function denyAccess(ctx) {
  try {
    if (ctx?.answerCbQuery) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true });
      return;
    }
  } catch {}

  try {
    await ctx.reply("⛔ У тебя нет доступа к этому боту.");
  } catch {}
}

function guard(handler) {
  return async (ctx, ...args) => {
    const uid = ctx?.from?.id;
    if (!isAllowedUser(uid)) {
      return denyAccess(ctx);
    }
    return handler(ctx, ...args);
  };
}

tg.catch((err) => {
  console.log("TG handler error:", err?.message || err);
});

async function safeSend(chatId, text, extra) {
  try {
    await tg.telegram.sendMessage(chatId, text, extra);
    return true;
  } catch (e) {
    console.log("[TG SEND ERROR]", e?.message || e);
    return false;
  }
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ================== 409 FIX ================== */
async function launchTelegramSafely() {
  while (true) {
    try {
      console.log("Telegram starting...");
      await tg.launch({ dropPendingUpdates: true });
      console.log("Telegram started");
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("409") || msg.includes("Conflict")) {
        console.log("409 Conflict — другой инстанс getUpdates. Жду 15с...");
        await sleep(15000);
        continue;
      }
      console.log("Telegram launch error:", msg);
      await sleep(5000);
    }
  }
}

/* ================== RULES ================== */
let RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));

function reloadRules() {
  RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));
  rebuildNormalization();
}

/* ================== NORMALIZE ================== */
const cyr = {
  "а": "a",
  "е": "e",
  "о": "o",
  "р": "p",
  "с": "c",
  "х": "x",
  "у": "y",
  "к": "k",
  "м": "m",
  "т": "t",
};

let invisRe;
let sepRe;
let leetMap;
let collapseRepeats;
let maxRepeat;

function stripColors(s = "") {
  return s.replace(/§./g, "");
}

function rebuildNormalization() {
  invisRe = new RegExp(
    RULES?.normalization?.strip_invisibles_regex ||
      "[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]",
    "g"
  );

  sepRe = new RegExp(
    RULES?.normalization?.separators_regex ||
      "[\\s\\-_.:,;|/\\\\~`'\"^*+=()\\[\\]{}<>]+",
    "g"
  );

  leetMap =
    RULES?.normalization?.leet_map || {
      "0": "o",
      "1": "i",
      "3": "e",
      "4": "a",
      "5": "s",
      "7": "t",
      "@": "a",
      "$": "s",
    };

  collapseRepeats = RULES?.normalization?.collapse_repeats ?? true;
  maxRepeat = RULES?.normalization?.max_repeat ?? 2;
}
rebuildNormalization();

function norm(s = "") {
  s = stripColors(s);
  if (RULES?.normalization?.lowercase ?? true) s = s.toLowerCase();
  s = s.replace(invisRe, "");
  s = [...s].map((ch) => cyr[ch] || leetMap[ch] || ch).join("");
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
  for (const rule of RULES.rules || []) {
    if ((rule.action || "").toUpperCase() !== "BAN") continue;
    for (const w0 of rule.words || []) {
      const w = norm(String(w0));
      if (w && n.includes(w)) {
        banReasons.push(`${rule.reason || rule.id}:${w0}`);
      }
    }
  }
  if (banReasons.length) return ["BAN", banReasons];

  const review = [];
  for (const w0 of RULES.review || []) {
    const w = norm(String(w0));
    if (w && n.includes(w)) {
      review.push(`review:${w0}`);
    }
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

async function sendChunksReply(ctx, text, extra) {
  for (const p of splitText(text)) {
    if (p.trim()) {
      await ctx.reply(p, extra);
    }
  }
}

async function sendChunksChat(chatId, text, extra) {
  for (const p of splitText(text)) {
    if (!p.trim()) continue;
    const ok = await safeSend(chatId, p, extra);
    if (!ok) throw new Error("TG_SEND_FAILED");
  }
}

async function sendChunksChatHtml(chatId, html) {
  for (const p of splitText(html)) {
    if (!p.trim()) continue;

    const ok = await safeSend(chatId, p, { parse_mode: "HTML", disable_web_page_preview: true });
    if (ok) continue;

    const fallback = p.replace(/<[^>]+>/g, "");
    const plainOk = await safeSend(chatId, fallback);
    if (!plainOk) throw new Error("TG_SEND_FAILED");
  }
}

function report(title, names, meta = {}) {
  const ban = [];
  const rev = [];

  for (const nick of names) {
    const [s, r] = checkNick(nick);
    if (s === "BAN") ban.push({ nick, r });
    else if (s === "REVIEW") rev.push({ nick, r });
  }

  let out = `📦 ${title}\n`;
  out += `👥 Найдено ников: ${names.length}\n`;
  if (meta.okPrefixes != null || meta.failedPrefixes != null) {
    out += `🧩 Префиксы: ok=${meta.okPrefixes || 0}, fail=${meta.failedPrefixes || 0}\n`;
  }
  out += "\n";

  if (ban.length) {
    out += `⛔ BAN (${ban.length}):\n`;
    ban.forEach((x, i) => {
      out += `${i + 1}) ${x.nick} -> ${x.r.join("; ")}\n`;
    });
    out += "\n";
  }

  if (rev.length) {
    out += `🟡 REVIEW (${rev.length}):\n`;
    rev.forEach((x, i) => {
      out += `${i + 1}) ${x.nick} -> ${x.r.join("; ")}\n`;
    });
    out += "\n";
  }

  if (!ban.length && !rev.length) {
    out += "✅ Некорректных ников не найдено.\n";
  }

  if (meta.errors?.length) {
    out += `\n⚠️ Ошибки префиксов (${meta.errors.length}):\n`;
    for (const err of meta.errors.slice(0, MAX_PREFIX_ERRORS_IN_REPORT)) {
      out += `• ${err}\n`;
    }
  }

  return {
    out,
    ban: ban.length,
    rev: rev.length,
    reviewNicks: rev.map((x) => x.nick),
    banNicks: ban.map((x) => x.nick),
  };
}

function reportHtml(title, names, meta = {}) {
  const r = report(title, names, meta);
  return `<b>${escapeHtml(title)}</b>\n<pre>${escapeHtml(r.out)}</pre>`;
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
    "block_action",
  ];

  for (const name of packetNames) {
    try {
      c.removeAllListeners(name);
      c.on(name, () => {});
    } catch (e) {
      console.log("[MC] disableChunkParsing error:", e?.message || e);
    }
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
    } catch (e) {
      console.log("[MC] SRV resolve failed:", e?.message || e);
    }
  }

  return { host: h, port: Number(port || 25565), via: "DIRECT" };
}

/* ================== TAB COMPLETE ================== */
function tabComplete(bot, text) {
  return new Promise((res, rej) => {
    if (!bot?._client) {
      rej(new Error("CLIENT_NOT_READY"));
      return;
    }

    const c = bot._client;

    const to = setTimeout(() => {
      cleanup();
      rej(new Error("TAB_TIMEOUT"));
    }, 2500);

    const on = (p) => {
      cleanup();
      const matches =
        p?.matches?.map((x) =>
          typeof x === "string" ? x : x.text || x.match || ""
        ) || [];
      res(matches);
    };

    function cleanup() {
      clearTimeout(to);
      try {
        c.removeListener("tab_complete", on);
      } catch {}
      try {
        c.removeListener("tab_complete_response", on);
      } catch {}
    }

    try {
      c.once("tab_complete", on);
      c.once("tab_complete_response", on);

      c.write("tab_complete", {
        text,
        assumeCommand: true,
        lookedAtBlock: { x: 0, y: 0, z: 0 },
      });
    } catch (e) {
      cleanup();
      rej(e);
    }
  });
}

/* ================== MINEFLAYER ================== */
let mc = null;
let mcReady = false;
let tabReady = false;
let mcOnline = false;
let mcLastError = "";
let loginSent = false;
let registerSent = false;
let reconnectTimer = null;
let connecting = false;
let autoScanPrimed = false;

function scheduleReconnect(reason) {
  if (reconnectTimer) return;

  console.log("[MC] reconnect scheduled:", reason);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMC().catch((e) => {
      console.log("[MC] reconnect error:", e?.message || e);
    });
  }, 5000);
}

async function warmupTabReady(bot) {
  for (let i = 1; i <= TAB_WARMUP_RETRIES; i++) {
    try {
      const r = await tabComplete(bot, "/msg a");
      if (Array.isArray(r)) {
        tabReady = true;
        mcReady = true;
        console.log(`[MC] TAB ready on try ${i}`);
        return true;
      }
    } catch (e) {
      console.log(`[MC] TAB warmup ${i}/${TAB_WARMUP_RETRIES} failed:`, e?.message || e);
      await sleep(TAB_WARMUP_DELAY_MS);
    }
  }
  return false;
}

async function connectMC() {
  if (connecting) return;
  connecting = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (mc) {
      try {
        if (typeof mc.quit === "function") mc.quit("reconnect");
      } catch {}
      try {
        if (typeof mc.end === "function") mc.end();
      } catch {}
      try {
        if (mc._client && typeof mc._client.end === "function") mc._client.end();
      } catch {}
      mc = null;
    }

    mcReady = false;
    tabReady = false;
    mcOnline = false;
    mcLastError = "";
    loginSent = false;
    registerSent = false;
    autoScanPrimed = false;

    const ep = await resolveMcEndpoint(MC_HOST, MC_PORT);

    console.log("[MC DEBUG]", {
      inputHost: MC_HOST,
      inputPort: MC_PORT,
      resolvedHost: ep.host,
      resolvedPort: ep.port,
      via: ep.via,
      version: MC_VERSION,
      user: MC_USER,
    });

    mc = mineflayer.createBot({
      host: ep.host,
      port: ep.port,
      username: MC_USER,
      version: MC_VERSION,
      viewDistance: 1,
    });

    mc.on("login", () => {
      disableChunkParsing(mc);
      mcOnline = true;
      mcReady = false;
      mcLastError = "";
      console.log("[MC] login");
    });

    mc.on("spawn", async () => {
      console.log("[MC] spawn");
      await sleep(READY_AFTER_MS);

      const ok = await warmupTabReady(mc);
      if (!ok) {
        mcReady = false;
        tabReady = false;
        mcLastError = "TAB warmup failed after spawn";
        console.log("[MC] TAB warmup failed, reconnecting...");
        scheduleReconnect("tab_warmup_failed");
        return;
      }

      primeAutoScan();
      console.log("[MC] READY via SPAWN+TAB");
    });

    mc.on("messagestr", (msg) => {
      const m = String(msg).toLowerCase();

      if (MC_PASSWORD && !loginSent && m.includes("login")) {
        loginSent = true;
        setTimeout(() => {
          try {
            mc?.chat?.(`/login ${MC_PASSWORD}`);
          } catch (e) {
            console.log("[MC] login command error:", e?.message || e);
          }
        }, 1500);
      }

      if (MC_PASSWORD && !registerSent && m.includes("register")) {
        registerSent = true;
        setTimeout(() => {
          try {
            mc?.chat?.(`/register ${MC_PASSWORD} ${MC_PASSWORD}`);
          } catch (e) {
            console.log("[MC] register command error:", e?.message || e);
          }
        }, 1500);
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
      const msg = e?.stack || e?.message || String(e);
      onDisconnect("error: " + msg);
    });
  } catch (e) {
    mcLastError = "createBot/connect failed: " + String(e?.message || e);
    console.log("[MC]", mcLastError);
    scheduleReconnect("createBot");
  } finally {
    connecting = false;
  }
}

connectMC().catch((e) => {
  console.log("[MC] connect error:", e?.message || e);
});

/* ================== SCAN HELPERS ================== */
function clean(s) {
  return String(s).replace(/[^A-Za-z0-9_]/g, "");
}

async function byPrefix(prefix) {
  if (!mc || !mcReady || !tabReady) {
    throw new Error("MC_OR_TAB_NOT_READY");
  }

  const raw = await tabComplete(mc, `/msg ${prefix}`);
  const pref = clean(prefix).toLowerCase();

  const result = raw
    .map(clean)
    .filter((n) => n.length >= 3 && n.length <= 16)
    .filter((n) => (pref ? n.toLowerCase().startsWith(pref) : true));

  console.log(`[TAB] prefix=${prefix} raw=${raw.length} filtered=${result.length}`);
  return [...new Set(result)];
}

function prefixes() {
  if (AUTO_PREFIXES) {
    return AUTO_PREFIXES
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  const a = [];
  for (let i = 97; i <= 122; i++) a.push(String.fromCharCode(i));
  for (let i = 0; i <= 9; i++) a.push(String(i));
  a.push("_");
  return a;
}

async function collect(ps) {
  if (!mcReady || !tabReady) throw new Error("MC_NOT_READY");

  const all = new Set();
  let okPrefixes = 0;
  let failedPrefixes = 0;
  const errors = [];

  for (const p of ps) {
    if (!mcReady || !tabReady) throw new Error("MC_NOT_READY");

    try {
      const found = await byPrefix(p);
      found.forEach((n) => all.add(n));
      okPrefixes++;
    } catch (e) {
      failedPrefixes++;
      const msg = String(e?.message || e);
      errors.push(`${p}: ${msg}`);
      console.log("[AUTO][PREFIX ERROR]", p, msg);
    }

    await sleep(SCAN_DELAY_MS);
  }

  console.log(
    `[AUTO][COLLECT] ok=${okPrefixes} fail=${failedPrefixes} totalNames=${all.size}`
  );

  if (okPrefixes === 0) {
    throw new Error("ALL_PREFIXES_FAILED: " + errors.slice(0, 5).join(" | "));
  }

  return {
    names: [...all],
    okPrefixes,
    failedPrefixes,
    errors,
  };
}

/* ================== GEMINI AI ================== */
let geminiModel = null;
if (GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
}

async function geminiReviewNick(nick) {
  if (!AI_ENABLED || !geminiModel) {
    return { decision: "REVIEW", confidence: 0, reason: "AI выключен" };
  }

  const normalized = norm(nick);

  const prompt = `Верни СТРОГО JSON без текста вокруг:\n{"decision":"BAN|REVIEW|OK","confidence":0.0,"reason":"кратко"}\n\nBAN — явный мат/оскорбления/расизм/экстремизм/18+/наркотики/читы/маскировка под персонал/проект.\nREVIEW — сомнительно/намёк/двусмысленно.\nOK — чисто.\n\nНик: ${nick}\nНормализация: ${normalized}`;

  try {
    const result = await geminiModel.generateContent(prompt);
    const text = result?.response?.text?.()?.trim?.() || "";
    const m = text.match(/\{[\s\S]*\}/);

    if (!m) {
      return { decision: "REVIEW", confidence: 0, reason: "AI не вернул JSON" };
    }

    const data = JSON.parse(m[0]);
    const decision = String(data.decision || "REVIEW").toUpperCase();
    const confidence = Math.max(0, Math.min(1, Number(data.confidence || 0)));
    const reason = String(data.reason || "—").slice(0, 120);

    if (!["BAN", "REVIEW", "OK"].includes(decision)) {
      return {
        decision: "REVIEW",
        confidence: 0,
        reason: "AI decision некорректный",
      };
    }

    return { decision, confidence, reason };
  } catch {
    return { decision: "REVIEW", confidence: 0, reason: "Ошибка Gemini" };
  }
}

/* ================== LAST SCAN CACHE ================== */
let lastScan = null;

/* ================== STATUS HELPERS ================== */
let autoScanRunning = false;
let autoScanLastRunTs = 0;
let autoScanLastDurationMs = 0;
let autoScanLastResult = "not_started";
let autoScanLastError = "";
let autoScanTimer = null;
let autoScanNextRunTs = 0;

function formatMcStatus() {
  if (mcOnline && mcReady && tabReady) return "✅ на сервере и готов к tab";
  if (mcOnline) return "🟡 подключён, но не прогрет";
  return "❌ не в сети";
}

function formatAutoScanStatus() {
  if (!AUTO_SCAN) return "❌ выключен";
  if (autoScanRunning) return "🔄 идёт скан";
  if (autoScanLastResult === "not_started") return "⏳ ожидает первого запуска";
  if (autoScanLastResult === "waiting_mc") return "⏳ ждёт готовности Minecraft";
  if (autoScanLastResult === "missing_chat") return "❌ нет CHAT_ID";
  if (autoScanLastResult === "ok_no_hits") return "✅ последний проход без совпадений";
  if (autoScanLastResult === "ok_hits") return "⚠️ последний проход нашёл совпадения";
  if (autoScanLastResult === "send_failed") return "❌ ошибка отправки в Telegram";
  if (autoScanLastResult === "error") return "❌ ошибка автоскана";
  return autoScanLastResult;
}

function formatStatusText() {
  const ai = AI_ENABLED && geminiModel ? "✅ включён" : "❌ выключен";
  const last = lastScan
    ? `✅ ${lastScan.names.length} ников, ${Math.round((Date.now() - lastScan.ts) / 1000)}с назад`
    : "❌ нет";
  const autoAge = autoScanLastRunTs
    ? `${Math.round((Date.now() - autoScanLastRunTs) / 1000)}с назад`
    : "ещё не запускался";
  const nextRun = autoScanNextRunTs ? fmtTime(autoScanNextRunTs) : "—";

  return [
    `🎮 MC статус: ${formatMcStatus()}`,
    `👤 Ник: ${MC_USER}`,
    `🧱 Версия: ${MC_VERSION}`,
    `🤖 AI (Gemini): ${ai}`,
    `📦 Last scan: ${last}`,
    `🔁 Auto scan: ${formatAutoScanStatus()}`,
    `🕒 Auto last run: ${autoAge}`,
    `⏱ Последняя длительность: ${autoScanLastDurationMs}ms`,
    `⏭ Следующий запуск: ${nextRun}`,
    `✅ MC ready: ${mcReady}`,
    `✅ TAB ready: ${tabReady}`,
    `✅ MC online: ${mcOnline}`,
    `🔄 Auto running: ${autoScanRunning}`,
    `📌 Auto result: ${autoScanLastResult}`,
    mcLastError ? `❗ MC error: ${mcLastError}` : "",
    autoScanLastError ? `❗ Auto error: ${autoScanLastError}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/* ================== BUTTONS MENU ================== */
function menuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔎 Скан всех", "scan_all")],
    [Markup.button.callback("🤖 AI по последнему", "ai_last")],
    [Markup.button.callback("🧪 AI один ник", "ai_one")],
    [Markup.button.callback("🔁 Автоскан сейчас", "auto_now")],
    [
      Markup.button.callback("📊 Статус", "status"),
      Markup.button.callback("♻️ Reload rules", "reload_rules"),
    ],
  ]);
}

/* ================== COMMANDS ================== */
tg.start(guard((c) => {
  return c.reply(
    [
      "🚀 Бот запущен.",
      "",
      "/tab <префикс> — показать ники по префиксу",
      "/tabcheck <префикс> — проверить по rules",
      "/scanall — полный ручной скан",
      "/autoscan — запустить автоскан сейчас",
      "/status — статус",
    ].join("
"),
    menuKeyboard()
  );
}));

tg.command("status", guard((c) => c.reply(formatStatusText(), menuKeyboard())));

tg.command("autoscan", guard(async (c) => {
  await c.reply("🔁 Запускаю автоскан вручную...", menuKeyboard());
  await runAutoScan("manual_command");
  await c.reply(formatStatusText(), menuKeyboard());
}));

tg.command("tab", guard(async (c) => {
  if (!mcReady || !tabReady) return c.reply("MC/TAB не готовы", menuKeyboard());

  const a = c.message.text.split(" ").slice(1).join(" ");
  const n = [...new Set(await byPrefix(a))];

  let t = `🔎 Tab ${a}
Найдено: ${n.length}

`;
  n.forEach((x, i) => {
    t += `${i + 1}) ${x}
`;
  });

  await sendChunksReply(c, t);
  await c.reply("Меню:", menuKeyboard());
}));

tg.command("tabcheck", guard(async (c) => {
  if (!mcReady || !tabReady) return c.reply("MC/TAB не готовы", menuKeyboard());

  const a = c.message.text.split(" ").slice(1).join(" ");
  const n = await byPrefix(a);

  await sendChunksReply(c, report(`Tabcheck ${a}`, n).out);
  await c.reply("Меню:", menuKeyboard());
}));

tg.command("scanall", guard(async (c) => {
  if (!mcReady || !tabReady) return c.reply("MC/TAB не готовы", menuKeyboard());

  await c.reply("🔎 Сканирую всех...", menuKeyboard());

  const scan = await collect(prefixes());
  const r = report("Ручной full scan", scan.names, scan);

  lastScan = {
    ts: Date.now(),
    names: scan.names,
    reportText: r.out,
    reviewNicks: r.reviewNicks,
  };

  await sendChunksReply(c, r.out);
  await c.reply("✅ Готово. Можно нажать AI по последнему скану.", menuKeyboard());
}));

/* ================== BUTTON HANDLERS ================== */
tg.action("status", guard(async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch {}

  await ctx.reply(formatStatusText(), menuKeyboard());
}));

tg.action("reload_rules", guard(async (ctx) => {
  try {
    await ctx.answerCbQuery("Reload...");
  } catch {}

  try {
    reloadRules();
    await ctx.reply("♻️ rules.json перезагружен", menuKeyboard());
  } catch (e) {
    await ctx.reply(
      "rules.json reload error: " + String(e?.message || e),
      menuKeyboard()
    );
  }
}));

tg.action("scan_all", guard(async (ctx) => {
  try {
    await ctx.answerCbQuery("Scan...");
  } catch {}

  if (!mcReady || !tabReady) return ctx.reply("MC/TAB не готовы", menuKeyboard());

  await ctx.reply("🔎 Сканирую всех...", menuKeyboard());

  const scan = await collect(prefixes());
  const r = report("Full scan (button)", scan.names, scan);

  lastScan = {
    ts: Date.now(),
    names: scan.names,
    reportText: r.out,
    reviewNicks: r.reviewNicks,
  };

  await sendChunksReply(ctx, r.out);
  await ctx.reply("✅ Готово. Нажми AI по последнему скану.", menuKeyboard());
}));

tg.action("auto_now", guard(async (ctx) => {
  try {
    await ctx.answerCbQuery("Auto scan...");
  } catch {}

  await ctx.reply("🔁 Форсирую автоскан...", menuKeyboard());
  await runAutoScan("manual_button");
  await ctx.reply(formatStatusText(), menuKeyboard());
}));

/* ====== AI LAST SCAN ====== */
tg.action("ai_last", guard(async (ctx) => {
  try {
    await ctx.answerCbQuery("AI...");
  } catch {}

  if (!lastScan) {
    return ctx.reply(
      "Нет последнего скана. Сначала сделай /scanall или кнопку скана",
      menuKeyboard()
    );
  }

  if (!AI_ENABLED || !geminiModel) {
    return ctx.reply(
      "AI выключен (нет GEMINI_API_KEY или AI_ENABLED=0)",
      menuKeyboard()
    );
  }

  const candidates = [...(lastScan.reviewNicks || [])];
  if (!candidates.length) {
    return ctx.reply(
      "В последнем скане нет REVIEW. AI нечего проверять.",
      menuKeyboard()
    );
  }

  await ctx.reply(
    `🤖 AI проверяю REVIEW из последнего скана... (${candidates.length})`,
    menuKeyboard()
  );

  const ban = [];
  const ok = [];
  const review = [];
  let budget = Math.max(0, AI_BUDGET_PER_CLICK);

  for (const nick of candidates) {
    if (budget <= 0) {
      review.push(`${nick} (лимит AI исчерпан)`);
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

  let out = `🤖 AI RESULT (последний скан)

`;
  out += `⛔ BAN: ${ban.length}
`;
  out += `✅ OK: ${ok.length}
`;
  out += `🟡 REVIEW: ${review.length}

`;

  if (ban.length) out += `BAN LIST:
${ban.join("
")}

`;
  if (review.length) out += `REVIEW LIST:
${review.join("
")}

`;
  if (ok.length) out += `OK LIST:
${ok.join("
")}

`;

  await sendChunksReply(ctx, out);
  await ctx.reply("Меню:", menuKeyboard());
}));

/* ====== AI ONE NICK ====== */
const awaitingNick = new Map();

tg.action("ai_one", guard(async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch {}

  awaitingNick.set(ctx.chat.id, ctx.from.id);
  await ctx.reply("🧪 Отправь ник одним сообщением.", menuKeyboard());
}));

tg.on("text", guard(async (ctx) => {
  const uid = awaitingNick.get(ctx.chat.id);
  if (!uid || uid !== ctx.from.id) return;

  awaitingNick.delete(ctx.chat.id);

  const nick = String(ctx.message.text || "").trim();
  if (!nick) {
    return ctx.reply("Пусто. Пришли ник.", menuKeyboard());
  }

  const [s, reasons] = checkNick(nick);
  const ai = await geminiReviewNick(nick);

  const out =
    `🧪 Ник: ${nick}\n` +
    `📏 Rules: ${s}${reasons?.length ? ` — ${reasons.join("; ")}` : ""}\n` +
    `🤖 AI: ${ai.decision} — ${ai.reason} (${Math.round(ai.confidence * 100)}%)\n` +
    `🧹 Нормализация: ${norm(nick)}`;

  await ctx.reply(out, menuKeyboard());
}));

/* ================== AUTO SCAN ================== */
async function runAutoScan(trigger = "timer") {
  if (autoScanRunning) {
    console.log("[AUTO] skipped: already running");
    return;
  }

  const startedAt = Date.now();
  autoScanLastRunTs = startedAt;

  console.log("[AUTO] start", {
    trigger,
    mcReady,
    tabReady,
    mcOnline,
    hasChatId: !!CHAT_ID,
  });

  if (!mcReady || !tabReady) {
    autoScanLastResult = "waiting_mc";
    autoScanLastError = "MC/TAB not ready";
    console.log("[AUTO] waiting_mc");
    scheduleNextAutoScan(Math.min(AUTO_RETRY_ON_FAIL_MINUTES, AUTO_SCAN_MINUTES) * 60 * 1000);
    return;
  }

  if (!CHAT_ID) {
    autoScanLastResult = "missing_chat";
    autoScanLastError = "CHAT_ID not set";
    console.log("[AUTO] missing_chat");
    return;
  }

  autoScanRunning = true;
  autoScanLastError = "";

  try {
    const scan = await collect(prefixes());
    const r = report("Auto scan", scan.names, scan);

    lastScan = {
      ts: Date.now(),
      names: scan.names,
      reportText: r.out,
      reviewNicks: r.reviewNicks,
    };

    console.log(`[AUTO] collected names=${scan.names.length} ban=${r.ban} review=${r.rev}`);

    if (r.ban || r.rev) {
      if (PING_USER_ID) {
        const html = `<a href="tg://user?id=${PING_USER_ID}">&#8203;</a>\n${reportHtml("⚠️ Автоскан: найдены совпадения", scan.names, scan)}`;
        await sendChunksChatHtml(CHAT_ID, html);
      } else {
        await sendChunksChat(CHAT_ID, r.out);
      }
      autoScanLastResult = "ok_hits";
    } else {
      autoScanLastResult = "ok_no_hits";
    }
  } catch (e) {
    autoScanLastResult = "error";
    autoScanLastError = String(e?.message || e);
    console.log("[AUTO] error:", autoScanLastError);

    try {
      await safeSend(CHAT_ID, `❌ Auto scan error:\n${autoScanLastError}`);
    } catch {}

    scheduleNextAutoScan(AUTO_RETRY_ON_FAIL_MINUTES * 60 * 1000);
  } finally {
    autoScanRunning = false;
    autoScanLastDurationMs = Date.now() - startedAt;
    console.log("[AUTO] finish in", autoScanLastDurationMs, "ms");
  }
}

function scheduleNextAutoScan(delayMs = AUTO_SCAN_MINUTES * 60 * 1000) {
  if (!AUTO_SCAN) return;

  if (autoScanTimer) {
    clearTimeout(autoScanTimer);
  }

  const safeDelay = Math.max(1000, delayMs);
  autoScanNextRunTs = Date.now() + safeDelay;

  autoScanTimer = setTimeout(async () => {
    await runAutoScan("timer");
    scheduleNextAutoScan();
  }, safeDelay);
}

function primeAutoScan() {
  if (!AUTO_SCAN || autoScanPrimed) return;

  autoScanPrimed = true;
  scheduleNextAutoScan(AUTO_SCAN_MINUTES * 60 * 1000);

  setTimeout(() => {
    runAutoScan("ready").catch((e) => {
      autoScanLastResult = "error";
      autoScanLastError = String(e?.message || e);
    });
  }, STARTUP_SCAN_DELAY_MS);
}

if (AUTO_SCAN) {
  scheduleNextAutoScan(STARTUP_SCAN_DELAY_MS);
}

/* ================== WATCHDOG ================== */
setInterval(() => {
  if (mcOnline && (!mcReady || !tabReady) && !connecting) {
    console.log("[WATCHDOG] mcOnline=true but mcReady/tabReady=false, reconnecting");
    scheduleReconnect("watchdog_not_ready");
  }
}, 30000);

/* ================== START ================== */
(async () => {
  await launchTelegramSafely();
  console.log("TG bot started");
})();

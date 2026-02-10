/* ================== IMPORTS ================== */
import fs from "fs";
import http from "http";
import mineflayer from "mineflayer";
import { Telegraf } from "telegraf";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || null;

const MC_HOST = process.env.MC_HOST;
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = "1.8.9";

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);

const LOGIN_CMD = (process.env.MC_LOGIN_CMD || "").trim();
const WAIT_AFTER_SPAWN_MS = 3000;

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  throw new Error("Нужны BOT_TOKEN, MC_HOST, MC_USER");
}

/* ================== HEALTH SERVER (Railway Ready) ================== */
const PORT = Number(process.env.PORT || 3000);
http.createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("OK\n");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Health server listening on ${PORT}`);
});

/* ================== RULES ================== */
function loadRules() {
  try {
    return JSON.parse(fs.readFileSync("rules.json", "utf8"));
  } catch {
    return { ban: [], review: [], normalize: {} };
  }
}
let RULES = loadRules();

/* ================== GLOBAL ================== */
const tg = new Telegraf(BOT_TOKEN);
let bot = null;
let autoScanTimer = null;
let scanLock = false;

const mcState = {
  connected: false,
  lastError: null
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isInGame = () => !!bot?.player?.entity;

/* ================== SAFETY ================== */
process.on("uncaughtException", e => console.error("uncaughtException", e));
process.on("unhandledRejection", e => console.error("unhandledRejection", e));

process.once("SIGTERM", () => tg.stop("SIGTERM"));
process.once("SIGINT", () => tg.stop("SIGINT"));

/* ================== NICK CHECK ================== */
function normalizeNick(nick) {
  let s = String(nick).replace(/\s+/g, "").toLowerCase();
  for (const [k, v] of Object.entries(RULES.normalize || {})) {
    try { s = s.replace(new RegExp(k, "gi"), v); } catch {}
  }
  return s;
}

function matchAny(list, text) {
  return list.some(p => {
    try { return new RegExp(p, "i").test(text); }
    catch { return text.includes(p); }
  });
}

function checkNick(nick) {
  const norm = normalizeNick(nick);
  if (matchAny(RULES.ban || [], nick) || matchAny(RULES.ban || [], norm)) return "BAN";
  if (matchAny(RULES.review || [], nick) || matchAny(RULES.review || [], norm)) return "REVIEW";
  return "OK";
}

/* ================== MC BOT ================== */
function createMcBot() {
  if (bot) return;

  console.log("🧱 MC bot connecting...");
  bot = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    username: MC_USER,
    version: MC_VERSION,
    hideErrors: true
  });

  bot._client?.on("packet", (_, meta) => {
    if (meta?.name === "plugin_message") return;
  });

  bot.on("login", () => mcState.connected = true);

  bot.on("spawn", async () => {
    console.log("✅ MC spawn");
    await sleep(WAIT_AFTER_SPAWN_MS);
    if (LOGIN_CMD) bot.chat(LOGIN_CMD);
    if (AUTO_SCAN) startAutoScan();
  });

  bot.on("end", () => {
    console.log("❌ MC disconnected");
    mcState.connected = false;
    bot = null;
    stopAutoScan();
    setTimeout(createMcBot, 5000);
  });

  bot.on("error", e => mcState.lastError = String(e));
}

/* ================== SCAN ================== */
function getPlayers() {
  return Object.keys(bot?.players || {}).filter(n => n !== MC_USER);
}

async function scan() {
  if (!isInGame() || scanLock) return null;
  scanLock = true;

  const res = { ban: [], review: [] };
  for (const n of getPlayers()) {
    const v = checkNick(n);
    if (v === "BAN") res.ban.push(n);
    else if (v === "REVIEW") res.review.push(n);
    await sleep(SCAN_DELAY_MS);
  }

  scanLock = false;
  return res;
}

/* ================== AUTO SCAN ================== */
function startAutoScan() {
  stopAutoScan();
  autoScanTimer = setInterval(async () => {
    const r = await scan();
    if (!r) return;
    if (CHAT_ID && (r.ban.length || r.review.length)) {
      tg.telegram.sendMessage(
        CHAT_ID,
        `🚨 Scan result\nBAN: ${r.ban.join(", ") || "—"}\nREVIEW: ${r.review.join(", ") || "—"}`
      );
    }
  }, AUTO_SCAN_MINUTES * 60 * 1000);
}

function stopAutoScan() {
  if (autoScanTimer) clearInterval(autoScanTimer);
  autoScanTimer = null;
}

/* ================== TG ================== */
tg.start(ctx => ctx.reply("Готов\n/status\n/scan"));

tg.command("status", ctx => {
  ctx.reply(
    `MC статус: ${isInGame() ? "✅ в игре" : "❌ не в сети"}\n` +
    `Ник: ${MC_USER}\nВерсия: ${MC_VERSION}`
  );
});

tg.command("scan", async ctx => {
  const r = await scan();
  if (!r) return ctx.reply("❌ MC не в игре");
  ctx.reply(`BAN: ${r.ban.join(", ") || "—"}\nREVIEW: ${r.review.join(", ") || "—"}`);
});

/* ================== TG LAUNCH (409 FIX) ================== */
async function launchTelegram() {
  while (true) {
    try {
      await tg.launch();
      console.log("🤖 Telegram bot started");
      return;
    } catch (e) {
      if (String(e).includes("409")) {
        console.log("⚠️ 409 Conflict, retry in 10s");
        await sleep(10000);
      } else throw e;
    }
  }
}

/* ================== START ================== */
(async () => {
  await launchTelegram();
  createMcBot();
  console.log("✅ ALL STARTED");
})();

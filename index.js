/* ================== IMPORTS ================== */
import fs from "fs";
import http from "http";
import mineflayer from "mineflayer";
import { Telegraf } from "telegraf";

/* ================== HEALTH SERVER FIRST (Railway Ready) ================== */
const PORT = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("OK\n");
});

server.on("error", (e) => console.error("🌐 Health server error:", e));
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Health server listening on ${PORT}`);
});

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================== SAFETY ================== */
process.on("uncaughtException", (e) => console.error("🔥 uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("🔥 unhandledRejection:", e));

/* ================== RULES ================== */
function loadRules() {
  try {
    return JSON.parse(fs.readFileSync("rules.json", "utf8"));
  } catch {
    return { ban: [], review: [], normalize: {} };
  }
}
let RULES = loadRules();

/* ================== NICK CHECK ================== */
function normalizeNick(nick) {
  let s = String(nick).replace(/\s+/g, "").toLowerCase();
  for (const [k, v] of Object.entries(RULES.normalize || {})) {
    try {
      s = s.replace(new RegExp(k, "gi"), v);
    } catch {}
  }
  return s;
}
function matchAny(list, text) {
  if (!Array.isArray(list)) return false;
  return list.some((p) => {
    try {
      return new RegExp(p, "i").test(text);
    } catch {
      return String(text).includes(String(p));
    }
  });
}
function checkNick(nick) {
  const norm = normalizeNick(nick);
  if (matchAny(RULES.ban || [], nick) || matchAny(RULES.ban || [], norm)) return "BAN";
  if (matchAny(RULES.review || [], nick) || matchAny(RULES.review || [], norm)) return "REVIEW";
  return "OK";
}

/* ================== TELEGRAM ================== */
const tg = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

async function launchTelegramSafely() {
  if (!tg) {
    console.log("⚠️ BOT_TOKEN пустой — Telegram не запущен (health всё равно работает).");
    return;
  }

  // graceful stop
  process.once("SIGTERM", () => tg.stop("SIGTERM"));
  process.once("SIGINT", () => tg.stop("SIGINT"));

  tg.start((ctx) => ctx.reply("Готов\n/status\n/scan\n/reload"));
  tg.command("reload", (ctx) => {
    RULES = loadRules();
    return ctx.reply("✅ rules.json перезагружен");
  });

  tg.command("status", (ctx) => {
    const st = mcInGame() ? "✅ в игре" : "❌ не в сети";
    ctx.reply(`MC статус: ${st}\nНик: ${MC_USER}\nВерсия: ${MC_VERSION}`);
  });

  tg.command("scan", async (ctx) => {
    const r = await scan();
    if (!r) return ctx.reply("❌ MC не в игре");
    ctx.reply(`BAN: ${r.ban.join(", ") || "—"}\nREVIEW: ${r.review.join(", ") || "—"}`);
  });

  while (true) {
    try {
      console.log("🤖 Telegram starting…");
      await tg.launch();
      console.log("✅ Telegram started");
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("409") || msg.includes("Conflict")) {
        console.log("⚠️ Telegram 409 Conflict (второй инстанс). Повтор через 10с…");
        await sleep(10000);
        continue;
      }
      console.error("❌ Telegram launch error:", e);
      await sleep(5000);
    }
  }
}

/* ================== MINECRAFT ================== */
let bot = null;
let autoScanTimer = null;
let scanLock = false;

function mcInGame() {
  return !!bot?.player?.entity;
}

function createMcBot() {
  if (!MC_HOST || !MC_USER) {
    console.log("⚠️ MC_HOST/MC_USER пустые — MC не запущен (health всё равно работает).");
    return;
  }
  if (bot) return;

  console.log("🧱 MC connecting…", MC_HOST, MC_PORT, MC_USER);

  bot = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    username: MC_USER,
    version: MC_VERSION,
    hideErrors: true,
  });

  // FIX sourceStart 8192
  bot._client?.on("packet", (_, meta) => {
    if (meta?.name === "plugin_message") return;
  });

  bot.on("spawn", async () => {
    console.log("✅ MC spawn");
    await sleep(WAIT_AFTER_SPAWN_MS);
    if (LOGIN_CMD) {
      try {
        bot.chat(LOGIN_CMD);
        console.log("🔐 /login sent");
      } catch (e) {
        console.log("⚠️ login send error:", e?.message || e);
      }
    }
    if (AUTO_SCAN) startAutoScan();
  });

  bot.on("end", () => {
    console.log("❌ MC disconnected");
    stopAutoScan();
    bot = null;
    setTimeout(createMcBot, 5000);
  });

  bot.on("error", (e) => console.log("❌ MC error:", e?.message || e));
  bot.on("kicked", (r) => console.log("⛔ MC kicked:", r));
}

function getPlayers() {
  return Object.keys(bot?.players || {}).filter((n) => n && n !== MC_USER);
}

async function scan() {
  if (!mcInGame() || scanLock) return null;
  scanLock = true;
  try {
    const res = { ban: [], review: [] };
    for (const n of getPlayers()) {
      const v = checkNick(n);
      if (v === "BAN") res.ban.push(n);
      else if (v === "REVIEW") res.review.push(n);
      await sleep(SCAN_DELAY_MS);
    }
    return res;
  } finally {
    scanLock = false;
  }
}

function startAutoScan() {
  stopAutoScan();
  const interval = Math.max(1, AUTO_SCAN_MINUTES) * 60 * 1000;
  console.log(`⏱️ AUTO_SCAN каждые ${AUTO_SCAN_MINUTES} мин`);
  autoScanTimer = setInterval(async () => {
    const r = await scan();
    if (!r) return;
    if (!CHAT_ID) return;
    if (!r.ban.length && !r.review.length) return;
    tg?.telegram?.sendMessage(CHAT_ID, `🚨 Scan\nBAN: ${r.ban.join(", ") || "—"}\nREVIEW: ${r.review.join(", ") || "—"}`);
  }, interval);
}
function stopAutoScan() {
  if (autoScanTimer) clearInterval(autoScanTimer);
  autoScanTimer = null;
}

/* ================== START ================== */
(async () => {
  console.log("✅ Process started (health is up)");
  // запускаем Telegram и MC параллельно, чтобы health никогда не зависел от них
  launchTelegramSafely();
  createMcBot();
})();

import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf } from "telegraf";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID; // можно пустым — тогда /scan отвечает в чат, где вызвали
const PING_USER_ID = process.env.PING_USER_ID ? Number(process.env.PING_USER_ID) : null;

const MC_HOST = process.env.MC_HOST;
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = process.env.MC_VERSION || "1.8.9";

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);

const LOGIN_CMD = (process.env.MC_LOGIN_CMD || "").trim(); // например: "/login password"
const WAIT_AFTER_SPAWN_MS = Number(process.env.WAIT_AFTER_SPAWN_MS || 3000);

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  throw new Error("Нужны BOT_TOKEN, MC_HOST, MC_USER");
}

/* ================== RULES ================== */
function loadRules() {
  try {
    return JSON.parse(fs.readFileSync("rules.json", "utf8"));
  } catch (e) {
    console.error("❌ Не могу прочитать rules.json:", e?.message || e);
    return { ban: [], review: [], normalize: {} };
  }
}
let RULES = loadRules();
function reloadRules() {
  RULES = loadRules();
  console.log("✅ rules.json перезагружен");
}

/* ================== HELPERS ================== */
const tg = new Telegraf(BOT_TOKEN);

let bot = null;

let mcState = {
  online: false, // “соединение есть”
  username: MC_USER,
  version: MC_VERSION,
  lastError: null,
  spawnedAt: null,
  connecting: false,
};

let scanLock = false;
let autoScanTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isMcInGame() {
  // честный признак “в игре”: есть entity
  return !!bot?.player?.entity;
}

/* ================== SAFETY: не даём процессу умирать ================== */
process.on("uncaughtException", (err) => {
  console.error("🔥 uncaughtException:", err?.stack || err);
  mcState.lastError = String(err?.message || err);
});

process.on("unhandledRejection", (err) => {
  console.error("🔥 unhandledRejection:", err);
  mcState.lastError = String(err?.message || err);
});

/* ================== NICK CHECK ================== */
function normalizeNick(nick) {
  if (!nick) return "";
  let s = String(nick);
  s = s.replace(/\s+/g, "");
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");

  const map = RULES?.normalize || {};
  for (const [from, to] of Object.entries(map)) {
    try {
      s = s.replace(new RegExp(from, "gi"), to);
    } catch {}
  }
  return s.toLowerCase();
}

function matchAny(patterns, text) {
  if (!Array.isArray(patterns) || !text) return false;
  for (const p of patterns) {
    if (!p) continue;
    try {
      const re = new RegExp(p, "i");
      if (re.test(text)) return true;
    } catch {
      if (String(text).toLowerCase().includes(String(p).toLowerCase())) return true;
    }
  }
  return false;
}

function checkNick(nick) {
  const raw = String(nick);
  const norm = normalizeNick(raw);

  const ban = RULES?.ban || [];
  const review = RULES?.review || [];

  const isBan = matchAny(ban, raw) || matchAny(ban, norm);
  const isReview = !isBan && (matchAny(review, raw) || matchAny(review, norm));

  return { nick: raw, norm, verdict: isBan ? "BAN" : isReview ? "REVIEW" : "OK" };
}

/* ================== MC BOT ================== */
function createMcBot() {
  if (mcState.connecting) return;
  mcState.connecting = true;

  if (bot) {
    try {
      bot.removeAllListeners();
      bot.end();
    } catch {}
    bot = null;
  }

  console.log("🔌 Подключаюсь к MC…", MC_HOST, MC_PORT, MC_USER, MC_VERSION);

  bot = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    username: MC_USER,
    version: "1.8.9", // фиксируем 1.8.9
    hideErrors: true,
  });

  // ✅ ФИКС “sourceStart 8192”: гасим plugin_message
  bot._client?.on("packet", (_data, meta) => {
    if (meta?.name === "plugin_message") return;
  });

  bot.on("login", () => {
    console.log("✅ MC login");
    mcState.online = true;
    mcState.lastError = null;
  });

  bot.on("spawn", async () => {
    console.log("✅ MC spawn");
    mcState.spawnedAt = Date.now();

    await sleep(WAIT_AFTER_SPAWN_MS);

    if (LOGIN_CMD) {
      try {
        bot.chat(LOGIN_CMD);
        console.log("🔐 Отправил команду логина");
      } catch (e) {
        console.log("⚠️ Не смог отправить логин:", e?.message || e);
      }
    }

    if (AUTO_SCAN) startAutoScan();
  });

  bot.on("kicked", (reason) => {
    console.log("⛔ MC kicked:", reason);
    mcState.lastError = String(reason);
  });

  bot.on("error", (err) => {
    console.log("❌ MC error:", err?.message || err);
    mcState.lastError = String(err?.message || err);
  });

  bot.on("end", () => {
    console.log("🔌 MC end/disconnect");
    mcState.online = false;
    mcState.connecting = false;
    stopAutoScan();

    // ✅ авто-реконнект
    setTimeout(() => createMcBot(), 5000);
  });

  // отпускаем “connecting” на всякий
  setTimeout(() => {
    mcState.connecting = false;
  }, 1500);
}

function getOnlinePlayers() {
  const playersObj = bot?.players || {};
  const names = Object.keys(playersObj).filter((n) => n && n !== bot?.username);
  return names.filter((n) => /^[A-Za-z0-9_]{3,16}$/.test(n));
}

/* ================== SCAN ================== */
async function scanNow() {
  if (!bot) return { ok: false, error: "MC бот не создан" };
  if (!isMcInGame()) return { ok: false, error: "MC: не в игре (нет entity)" };
  if (scanLock) return { ok: false, error: "Скан уже идёт" };

  scanLock = true;
  try {
    const online = getOnlinePlayers();

    const ban = [];
    const review = [];
    const ok = [];

    for (const nick of online) {
      const res = checkNick(nick);
      if (res.verdict === "BAN") ban.push(res);
      else if (res.verdict === "REVIEW") review.push(res);
      else ok.push(res);

      if (SCAN_DELAY_MS > 0) await sleep(SCAN_DELAY_MS);
    }

    return { ok: true, onlineCount: online.length, ban, review, ok };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    scanLock = false;
  }
}

/* ================== AUTO SCAN ================== */
function startAutoScan() {
  stopAutoScan();
  const intervalMs = Math.max(1, AUTO_SCAN_MINUTES) * 60 * 1000;
  console.log(`⏱️ AUTO_SCAN: каждые ${AUTO_SCAN_MINUTES} минут`);

  autoScanTimer = setInterval(async () => {
    try {
      if (!isMcInGame()) return;
      const res = await scanNow();
      if (!res.ok) return;

      const hasFlags = (res.ban?.length || 0) + (res.review?.length || 0) > 0;
      if (!hasFlags) return;

      if (CHAT_ID) {
        await tg.telegram.sendMessage(CHAT_ID, formatScan(res));
      }
    } catch (e) {
      console.log("⚠️ AUTO_SCAN ошибка:", e?.message || e);
    }
  }, intervalMs);
}

function stopAutoScan() {
  if (autoScanTimer) clearInterval(autoScanTimer);
  autoScanTimer = null;
}

/* ================== TG TEXT ================== */
function formatStatus() {
  const status = isMcInGame()
    ? "✅ в игре"
    : mcState.online
      ? "⚠️ подключён, но не в игре"
      : "❌ не в сети";

  const lines = [
    `MC статус: ${status}`,
    `Ник: ${mcState.username}`,
    `Версия: ${mcState.version}`,
  ];
  if (mcState.lastError) lines.push(`Ошибка: ${mcState.lastError}`);
  return lines.join("\n");
}

function formatScan(res) {
  const lines = [];
  lines.push(formatStatus());
  lines.push("");
  lines.push(`Онлайн: ${res.onlineCount}`);

  if (res.ban?.length) {
    lines.push("");
    lines.push(`🚫 BAN (${res.ban.length}):`);
    for (const x of res.ban.slice(0, 40)) lines.push(`- ${x.nick}`);
    if (res.ban.length > 40) lines.push(`…и ещё ${res.ban.length - 40}`);
  }

  if (res.review?.length) {
    lines.push("");
    lines.push(`⚠️ REVIEW (${res.review.length}):`);
    for (const x of res.review.slice(0, 40)) lines.push(`- ${x.nick}`);
    if (res.review.length > 40) lines.push(`…и ещё ${res.review.length - 40}`);
  }

  return lines.join("\n");
}

/* ================== TG COMMANDS ================== */
tg.start((ctx) => ctx.reply("Готов.\n/status\n/scan\n/reload\n/autoscan_on\n/autoscan_off"));

tg.command("status", (ctx) => ctx.reply(formatStatus()));

tg.command("reload", (ctx) => {
  reloadRules();
  return ctx.reply("✅ rules.json перезагружен");
});

tg.command("autoscan_on", (ctx) => {
  startAutoScan();
  return ctx.reply("✅ AUTO_SCAN включён");
});

tg.command("autoscan_off", (ctx) => {
  stopAutoScan();
  return ctx.reply("✅ AUTO_SCAN выключен");
});

tg.command("scan", async (ctx) => {
  const msg = await ctx.reply("🔎 Сканирую…");
  const res = await scanNow();

  if (!res.ok) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      undefined,
      `❌ Не могу сканировать: ${res.error}\n(Подожди spawn/логин или сервер кикнул)`
    );
  }

  return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, formatScan(res));
});

/* ================== FIX 409 CONFLICT ================== */
async function launchTelegramSafely() {
  while (true) {
    try {
      await tg.launch();
      console.log("✅ Telegram bot запущен");
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      // 409 Conflict: другой инстанс уже получает updates
      if (msg.includes("409") || msg.includes("Conflict")) {
        console.log("⚠️ 409 Conflict: другой инстанс бота получает updates. Повтор через 10с…");
        await sleep(10000);
        continue;
      }
      throw e;
    }
  }
}

/* ================== GRACEFUL STOP ================== */
function setupGracefulShutdown() {
  process.once("SIGINT", () => {
    try {
      tg.stop("SIGINT");
    } catch {}
    try {
      bot?.end();
    } catch {}
  });

  process.once("SIGTERM", () => {
    try {
      tg.stop("SIGTERM");
    } catch {}
    try {
      bot?.end();
    } catch {}
  });
}

/* ================== START ================== */
async function main() {
  setupGracefulShutdown();

  console.log("🤖 Telegram bot запускается…");
  await launchTelegramSafely();

  console.log("🧱 MC bot запускается…");
  createMcBot();

  console.log("✅ Всё запущено");
}

main().catch((e) => {
  console.error("❌ main() error:", e?.stack || e);
});

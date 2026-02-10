import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID; // можно оставить пустым — тогда ответы в тот чат, где команда
const PING_USER_ID = process.env.PING_USER_ID ? Number(process.env.PING_USER_ID) : null;

const MC_HOST = process.env.MC_HOST;
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = process.env.MC_VERSION || "1.8.9";

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);

const AUTO_PREFIXES = (process.env.AUTO_PREFIXES || "").trim(); // опционально
const LOGIN_CMD = (process.env.MC_LOGIN_CMD || "/login PASSWORD").trim(); // если нужно
const WAIT_AFTER_SPAWN_MS = Number(process.env.WAIT_AFTER_SPAWN_MS || 3000);

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  throw new Error("Нужны BOT_TOKEN, MC_HOST, MC_USER (и желательно CHAT_ID)");
}

/* ================== RULES ================== */
function loadRules() {
  try {
    const raw = fs.readFileSync("rules.json", "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("❌ Не могу прочитать rules.json:", e?.message || e);
    return { ban: [], review: [], normalize: {} };
  }
}
let RULES = loadRules();

function safeReloadRules() {
  RULES = loadRules();
  console.log("✅ rules.json перезагружен");
}

/* ================== GLOBAL STATE ================== */
const tg = new Telegraf(BOT_TOKEN);

let bot = null;
let mcState = {
  online: false,
  username: MC_USER,
  version: MC_VERSION,
  lastError: null,
  spawnedAt: null,
  connecting: false,
  lastDisconnectAt: null,
};

let scanLock = false;
let autoScanTimer = null;

function isMcOnline() {
  // Самый честный признак “в игре”: есть entity
  return !!bot?.player?.entity;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ================== SAFETY: НЕ ДАЁМ ПРОЦЕССУ УМЕРЕТЬ ================== */
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

  // базовая нормализация (убираем пробелы/нулевую ширину/цвета и т.п.)
  s = s.replace(/\s+/g, "");
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");

  // если у тебя в rules.json есть normalize map — применим
  const map = RULES?.normalize || {};
  for (const [from, to] of Object.entries(map)) {
    try {
      s = s.replace(new RegExp(from, "gi"), to);
    } catch {
      // если from не валидный regex — просто пропускаем
    }
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
      // если p не regex, пробуем как подстроку
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

  return {
    nick: raw,
    norm,
    verdict: isBan ? "BAN" : isReview ? "REVIEW" : "OK",
  };
}

/* ================== MC BOT CREATE / CONNECT ================== */
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
    version: "1.8.9",        // принудительно 1.8.9
    hideErrors: true,
    // viewDistance: "tiny",  // можно включить, если сервер лагает
  });

  // ✅ ФИКС ОТ 8192 / plugin_message
  bot._client?.on("packet", (data, meta) => {
    if (!meta?.name) return;

    // Частая причина “sourceStart 8192” — огромные plugin_message
    if (meta.name === "plugin_message") return;

    // иногда ломают бренд/регистры — тоже через plugin_message идут
  });

  bot.on("login", () => {
    console.log("✅ MC login");
    mcState.online = true; // пока “соединение есть”
    mcState.lastError = null;
  });

  bot.on("spawn", async () => {
    console.log("✅ MC spawn");
    mcState.spawnedAt = Date.now();

    // подождём, чтобы сервер дослал всё служебное
    await sleep(WAIT_AFTER_SPAWN_MS);

    // автологин (если нужно) — можешь выключить переменной окружения MC_LOGIN_CMD=""
    if (LOGIN_CMD && LOGIN_CMD.startsWith("/login")) {
      try {
        bot.chat(LOGIN_CMD);
        console.log("🔐 Отправил login команду");
      } catch (e) {
        console.log("⚠️ Не смог отправить login:", e?.message || e);
      }
    }

    // запускаем авто-сканы только когда реально в игре
    if (AUTO_SCAN) startAutoScan();
  });

  bot.on("kicked", (reason) => {
    console.log("⛔ MC kicked:", reason);
    mcState.lastError = String(reason);
  });

  bot.on("end", () => {
    console.log("🔌 MC end/disconnect");
    mcState.online = false;
    mcState.connecting = false;
    mcState.lastDisconnectAt = Date.now();
    stopAutoScan();

    // ✅ авто-реконнект
    setTimeout(() => createMcBot(), 5000);
  });

  bot.on("error", (err) => {
    console.log("❌ MC error:", err?.message || err);
    mcState.lastError = String(err?.message || err);
  });

  // когда уже создали — отпускаем флаг
  setTimeout(() => {
    mcState.connecting = false;
  }, 1500);
}

/* ================== TAB / PLAYER LIST ================== */
// Для 1.8.9 у mineflayer обычно есть bot.players
function getOnlinePlayers() {
  const playersObj = bot?.players || {};
  const names = Object.keys(playersObj).filter((n) => n && n !== bot?.username);

  // иногда список засорён — фильтруем совсем мусор
  return names.filter((n) => /^[A-Za-z0-9_]{3,16}$/.test(n));
}

/* ================== SCAN ================== */
async function scanNow() {
  if (!bot) return { ok: false, error: "MC бот не создан" };
  if (!isMcOnline()) return { ok: false, error: "MC: не в игре (нет entity)" };
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
  console.log(`⏱️ AUTO_SCAN включён: каждые ${AUTO_SCAN_MINUTES} мин`);

  autoScanTimer = setInterval(async () => {
    try {
      if (!isMcOnline()) return;

      const res = await scanNow();
      if (!res.ok) return;

      const hasFlags = (res.ban?.length || 0) + (res.review?.length || 0) > 0;
      if (!hasFlags) return;

      await sendScanResult(res, CHAT_ID);
    } catch (e) {
      console.log("⚠️ AUTO_SCAN ошибка:", e?.message || e);
    }
  }, intervalMs);
}

function stopAutoScan() {
  if (autoScanTimer) clearInterval(autoScanTimer);
  autoScanTimer = null;
}

/* ================== TG OUTPUT ================== */
function formatScan(res) {
  const lines = [];
  lines.push(`MC статус: ${isMcOnline() ? "✅ в игре" : (mcState.online ? "⚠️ подключён, но не в игре" : "❌ не в сети")}`);
  lines.push(`Ник: ${mcState.username}`);
  lines.push(`Версия: ${mcState.version}`);
  if (mcState.lastError) lines.push(`Ошибка: ${mcState.lastError}`);

  lines.push("");
  lines.push(`Онлайн: ${res.onlineCount}`);

  if (res.ban?.length) {
    lines.push("");
    lines.push(`🚫 BAN (${res.ban.length}):`);
    for (const x of res.ban.slice(0, 30)) lines.push(`- ${x.nick}`);
    if (res.ban.length > 30) lines.push(`…и ещё ${res.ban.length - 30}`);
  }

  if (res.review?.length) {
    lines.push("");
    lines.push(`⚠️ REVIEW (${res.review.length}):`);
    for (const x of res.review.slice(0, 30)) lines.push(`- ${x.nick}`);
    if (res.review.length > 30) lines.push(`…и ещё ${res.review.length - 30}`);
  }

  return lines.join("\n");
}

async function sendScanResult(res, chatId) {
  const text = formatScan(res);
  const target = chatId || undefined;

  if (target) {
    return tg.telegram.sendMessage(target, text);
  }
  // если CHAT_ID не задан — функция должна вызываться только из контекста команды
}

/* ================== TG COMMANDS ================== */
tg.start((ctx) => {
  ctx.reply(
    "Готов.\nКоманды:\n/status — статус MC\n/scan — скан онлайна\n/reload — перезагрузить rules.json\n/autoscan_on — включить авто-сканы\n/autoscan_off — выключить авто-сканы"
  );
});

tg.command("status", async (ctx) => {
  const statusLines = [
    `MC статус: ${isMcOnline() ? "✅ в игре" : (mcState.online ? "⚠️ подключён, но не в игре" : "❌ не в сети")}`,
    `Ник: ${mcState.username}`,
    `Версия: ${mcState.version}`,
  ];
  if (mcState.lastError) statusLines.push(`Ошибка: ${mcState.lastError}`);
  await ctx.reply(statusLines.join("\n"));
});

tg.command("reload", async (ctx) => {
  safeReloadRules();
  await ctx.reply("✅ rules.json перезагружен");
});

tg.command("autoscan_on", async (ctx) => {
  startAutoScan();
  await ctx.reply("✅ AUTO_SCAN включён");
});

tg.command("autoscan_off", async (ctx) => {
  stopAutoScan();
  await ctx.reply("✅ AUTO_SCAN выключён");
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

  const text = formatScan(res);
  await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, text);
});

/* ================== START ================== */
async function main() {
  console.log("🤖 Telegram bot запускается…");
  await tg.launch();

  console.log("🧱 MC bot запускается…");
  createMcBot();

  console.log("✅ Всё запущено");
}

main().catch((e) => {
  console.error("❌ main() error:", e?.stack || e);
});

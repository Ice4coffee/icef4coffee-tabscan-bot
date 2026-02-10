/* ================== IMPORTS (ESM) ================== */
import fs from "fs";
import http from "http";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ================== HEALTH SERVER (Railway READY) ================== */
const PORT = Number(process.env.PORT || 3000);
http
  .createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("OK\n");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Health server listening on ${PORT}`);
  });

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = (process.env.CHAT_ID || "").trim() || null;

const MC_HOST = process.env.MC_HOST;
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = "1.8.9";

const LOGIN_CMD = (process.env.MC_LOGIN_CMD || "").trim(); // пример: "/login password"
const WAIT_AFTER_SPAWN_MS = Number(process.env.WAIT_AFTER_SPAWN_MS || 3000);

const AUTO_SCAN = (process.env.AUTO_SCAN || "0") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();

if (!BOT_TOKEN) throw new Error("Нужен BOT_TOKEN");
if (!MC_HOST || !MC_USER) console.log("⚠️ MC_HOST/MC_USER не заданы — MC часть не запустится.");

/* ================== HELPERS ================== */
const tg = new Telegraf(BOT_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on("uncaughtException", (e) => console.error("🔥 uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("🔥 unhandledRejection:", e));

process.once("SIGINT", () => {
  try { tg.stop("SIGINT"); } catch {}
  try { bot?.end(); } catch {}
});
process.once("SIGTERM", () => {
  try { tg.stop("SIGTERM"); } catch {}
  try { bot?.end(); } catch {}
});

/* ================== RULES LOADER ================== */
function loadRules() {
  try {
    return JSON.parse(fs.readFileSync("rules.json", "utf8"));
  } catch (e) {
    console.error("❌ Не могу прочитать rules.json:", e?.message || e);
    // безопасный дефолт под твой формат v2
    return {
      version: 2,
      normalization: {
        lowercase: true,
        strip_invisibles_regex: "[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]",
        separators_regex: "[\\s\\-_.:,;|/\\\\~`'\"^*+=()\\[\\]{}<>]+",
        collapse_repeats: true,
        max_repeat: 2,
        leet_map: { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" }
      },
      rules: [],
      review: [],
      whitelist_exact: []
    };
  }
}
let RULES = loadRules();

/* ================== RULES ENGINE (v2) ================== */
function normalizeByRules(nick) {
  let s = String(nick);
  const norm = RULES.normalization || {};

  if (norm.lowercase) s = s.toLowerCase();

  if (norm.strip_invisibles_regex) {
    try { s = s.replace(new RegExp(norm.strip_invisibles_regex, "g"), ""); } catch {}
  }

  if (norm.separators_regex) {
    try { s = s.replace(new RegExp(norm.separators_regex, "g"), ""); } catch {}
  }

  // leet replacements
  if (norm.leet_map) {
    for (const [k, v] of Object.entries(norm.leet_map)) {
      s = s.split(k).join(v);
    }
  }

  // collapse repeats
  if (norm.collapse_repeats) {
    const max = Number(norm.max_repeat || 2);
    s = s.replace(/(.)\1+/g, (_m, c) => String(c).repeat(Math.max(1, Math.min(5, max))));
  }

  return s;
}

function checkNickByRules(nick) {
  const raw = String(nick);
  const norm = normalizeByRules(raw);

  // whitelist_exact (в твоём файле — уже нормализованные строки)
  if ((RULES.whitelist_exact || []).includes(norm)) {
    return { verdict: "OK", reason: "WHITELIST", rule: "WHITELIST" };
  }

  // BAN rules
  for (const rule of RULES.rules || []) {
    const words = rule.words || [];
    for (const w of words) {
      if (w && norm.includes(String(w).toLowerCase())) {
        return { verdict: String(rule.action || "BAN").toUpperCase(), reason: rule.reason || "Правило", rule: rule.id || "RULE" };
      }
    }
  }

  // REVIEW list
  for (const w of RULES.review || []) {
    if (!w) continue;
    if (norm.includes(String(w).toLowerCase())) {
      return { verdict: "REVIEW", reason: "Подозрительное слово", rule: "REVIEW_LIST" };
    }
  }

  return { verdict: "OK", reason: "OK", rule: "OK" };
}

/* ================== GEMINI AI ================== */
let geminiModel = null;
if (GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
} else {
  console.log("⚠️ GEMINI_API_KEY не задан — AI REVIEW выключен.");
}

async function geminiReviewNick({ nick }) {
  if (!geminiModel) {
    return { decision: "REVIEW", confidence: 0, reason: "AI выключен (нет GEMINI_API_KEY)" };
  }

  const normalized = normalizeByRules(nick);

  const prompt = `
Ты помощник модератора Minecraft. Оцени НИК игрока.

Верни СТРОГО JSON без текста вокруг:
{"decision":"BAN|REVIEW|OK","confidence":0.0,"reason":"кратко"}

BAN — если явный мат/оскорбления/расизм/экстремизм/18+/наркотики/читы/маскировка под персонал/проект.
REVIEW — если сомнительно/намёк/двусмысленно.
OK — если чисто.

Ник: ${nick}
Нормализованный: ${normalized}
`;

  try {
    const result = await geminiModel.generateContent(prompt);
    const text = result?.response?.text?.()?.trim?.() || "";

    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { decision: "REVIEW", confidence: 0, reason: "AI не вернул JSON" };

    const data = JSON.parse(m[0]);
    const decision = String(data.decision || "REVIEW").toUpperCase();
    const confidence = Math.max(0, Math.min(1, Number(data.confidence || 0)));
    const reason = String(data.reason || "—").slice(0, 120);

    if (!["BAN", "REVIEW", "OK"].includes(decision)) {
      return { decision: "REVIEW", confidence: 0, reason: "AI decision некорректный" };
    }

    return { decision, confidence, reason };
  } catch (e) {
    return { decision: "REVIEW", confidence: 0, reason: "Ошибка Gemini" };
  }
}

/* ================== MINEFLAYER ================== */
let bot = null;
let scanLock = false;
let autoScanTimer = null;

function mcInGame() {
  return !!bot?.player?.entity;
}

function createMcBot() {
  if (!MC_HOST || !MC_USER) return;
  if (bot) return;

  console.log("🧱 MC connecting…", MC_HOST, MC_PORT, MC_USER, MC_VERSION);

  bot = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    username: MC_USER,
    version: MC_VERSION,
    hideErrors: true
  });

  // FIX sourceStart 8192: игнорим plugin_message (часто огромные)
  bot._client?.on("packet", (_data, meta) => {
    if (meta?.name === "plugin_message") return;
  });

  bot.on("login", () => console.log("✅ MC login"));

  bot.on("spawn", async () => {
    console.log("✅ MC spawn");
    await sleep(WAIT_AFTER_SPAWN_MS);

    if (LOGIN_CMD) {
      try {
        bot.chat(LOGIN_CMD);
        console.log("🔐 MC login cmd sent");
      } catch (e) {
        console.log("⚠️ MC login cmd error:", e?.message || e);
      }
    }

    if (AUTO_SCAN) startAutoScan();
  });

  bot.on("kicked", (reason) => console.log("⛔ MC kicked:", reason));
  bot.on("error", (e) => console.log("❌ MC error:", e?.message || e));

  bot.on("end", () => {
    console.log("❌ MC disconnected");
    stopAutoScan();
    bot = null;
    setTimeout(createMcBot, 5000);
  });
}

/* ================== PLAYER LIST (TAB COMPLETE) ================== */
async function getPlayersTabComplete() {
  if (!bot) return [];
  return new Promise((resolve) => {
    // На 1.8.9 чаще всего работает /msg (иногда /tell или /w)
    bot.tabComplete("/msg ", (err, results) => {
      if (err || !Array.isArray(results)) return resolve([]);

      const names = results
        .map((x) => (typeof x === "string" ? x : x?.match))
        .filter(Boolean)
        .map((s) => String(s).trim())
        .filter((n) => /^[A-Za-z0-9_]{3,16}$/.test(n))
        .filter((n) => n !== MC_USER);

      resolve([...new Set(names)]);
    });
  });
}

function getPlayersFromBotPlayers() {
  const names = Object.keys(bot?.players || {})
    .filter((n) => n && n !== MC_USER)
    .filter((n) => /^[A-Za-z0-9_]{3,16}$/.test(n));
  return [...new Set(names)];
}

async function getOnlinePlayersSmart() {
  const tab = await getPlayersTabComplete();
  if (tab.length) return tab;
  return getPlayersFromBotPlayers();
}

/* ================== SCAN (rules + AI for REVIEW) ================== */
async function scanAll({ useAI = true } = {}) {
  if (!mcInGame() || scanLock) return null;
  scanLock = true;

  try {
    const players = await getOnlinePlayersSmart();

    const res = {
      total: players.length,
      ban: [],
      review: [],
      ok: []
    };

    // лимит AI на один скан, чтобы не спамить API
    let aiBudget = 25;

    for (const nick of players) {
      const r = checkNickByRules(nick);

      if (r.verdict === "BAN") {
        res.ban.push(`${nick} (${r.reason})`);
      } else if (r.verdict === "REVIEW") {
        if (useAI && geminiModel && aiBudget > 0) {
          aiBudget--;
          const ai = await geminiReviewNick({ nick });
          await sleep(350);

          if (ai.decision === "BAN" && ai.confidence >= 0.75) {
            res.ban.push(`${nick} (AI: ${ai.reason}, ${Math.round(ai.confidence * 100)}%)`);
          } else if (ai.decision === "OK" && ai.confidence >= 0.75) {
            res.ok.push(`${nick} (AI OK, ${Math.round(ai.confidence * 100)}%)`);
          } else {
            res.review.push(`${nick} (AI: ${ai.reason}, ${Math.round(ai.confidence * 100)}%)`);
          }
        } else {
          res.review.push(`${nick} (${r.reason})`);
        }
      } else {
        res.ok.push(nick);
      }

      await sleep(SCAN_DELAY_MS);
    }

    return res;
  } finally {
    scanLock = false;
  }
}

function formatScan(res) {
  const lines = [];
  lines.push(`👥 Онлайн: ${res.total}`);

  lines.push("");
  lines.push(`🚫 BAN (${res.ban.length}):`);
  lines.push(res.ban.length ? res.ban.slice(0, 50).join("\n") : "—");

  lines.push("");
  lines.push(`⚠️ REVIEW (${res.review.length}):`);
  lines.push(res.review.length ? res.review.slice(0, 50).join("\n") : "—");

  // OK не спамим огромным списком — покажем первые 30
  lines.push("");
  lines.push(`✅ OK (${res.ok.length}):`);
  lines.push(res.ok.length ? res.ok.slice(0, 30).join(", ") + (res.ok.length > 30 ? ` …(+${res.ok.length - 30})` : "") : "—");

  return lines.join("\n").slice(0, 3900);
}

/* ================== AUTO SCAN ================== */
function startAutoScan() {
  stopAutoScan();
  const interval = Math.max(1, AUTO_SCAN_MINUTES) * 60 * 1000;
  console.log(`⏱️ AUTO_SCAN: каждые ${AUTO_SCAN_MINUTES} мин`);

  autoScanTimer = setInterval(async () => {
    try {
      if (!mcInGame()) return;
      const r = await scanAll({ useAI: true });
      if (!r) return;

      const hasFlags = r.ban.length + r.review.length > 0;
      if (!hasFlags) return;

      if (CHAT_ID) await tg.telegram.sendMessage(CHAT_ID, "🚨 AUTO SCAN\n\n" + formatScan(r));
    } catch (e) {
      console.log("⚠️ AUTO_SCAN error:", e?.message || e);
    }
  }, interval);
}

function stopAutoScan() {
  if (autoScanTimer) clearInterval(autoScanTimer);
  autoScanTimer = null;
}

/* ================== TELEGRAM UI ================== */
function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔎 Скан всех", "scan_all")],
    [Markup.button.callback("📊 Статус", "status")],
    [Markup.button.callback("🤖 AI проверить ник", "ai_check")],
    [Markup.button.callback("🔁 Reload rules", "reload_rules")]
  ]);
}

function formatStatusText() {
  const st = mcInGame() ? "✅ в игре" : "❌ не в сети";
  const ai = geminiModel ? "✅ включён" : "❌ выключен";
  return (
    `MC статус: ${st}\n` +
    `Ник: ${MC_USER}\n` +
    `Версия: ${MC_VERSION}\n` +
    `AI (Gemini): ${ai}`
  );
}

// состояние для ручной AI проверки
const awaitingAiNick = new Map(); // key: chatId -> userId

tg.start((ctx) => {
  ctx.reply("🤖 TabScan Bot\n\nВыбери действие:", mainKeyboard());
});

tg.command("status", (ctx) => ctx.reply(formatStatusText(), mainKeyboard()));
tg.command("scanall", async (ctx) => {
  const msg = await ctx.reply("🔎 Сканирую…");
  const r = await scanAll({ useAI: true });
  if (!r) return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, "❌ MC не в игре", mainKeyboard());
  return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, formatScan(r), mainKeyboard());
});

tg.action("status", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.editMessageText(formatStatusText(), mainKeyboard());
});

tg.action("reload_rules", async (ctx) => {
  RULES = loadRules();
  await ctx.answerCbQuery("rules.json обновлён");
  return ctx.editMessageText("✅ rules.json перезагружен", mainKeyboard());
});

tg.action("scan_all", async (ctx) => {
  await ctx.answerCbQuery("Сканирую…");
  const r = await scanAll({ useAI: true });
  if (!r) return ctx.editMessageText("❌ MC не в игре", mainKeyboard());
  return ctx.editMessageText(formatScan(r), mainKeyboard());
});

tg.action("ai_check", async (ctx) => {
  await ctx.answerCbQuery();
  awaitingAiNick.set(ctx.chat.id, ctx.from.id);
  return ctx.editMessageText(
    "🤖 Отправь ник одним сообщением (только ник).\n\nНапример: `xX_Nick_123_Xx`",
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "back")]])
  );
});

tg.action("back", async (ctx) => {
  await ctx.answerCbQuery();
  awaitingAiNick.delete(ctx.chat.id);
  return ctx.editMessageText("🤖 TabScan Bot\n\nВыбери действие:", mainKeyboard());
});

tg.on("text", async (ctx) => {
  const expectedUser = awaitingAiNick.get(ctx.chat.id);
  if (!expectedUser || expectedUser !== ctx.from.id) return;

  const nick = String(ctx.message.text || "").trim();
  awaitingAiNick.delete(ctx.chat.id);

  if (!nick || nick.length > 32) {
    return ctx.reply("❌ Пришли один ник (короткий).", mainKeyboard());
  }

  // сначала правила
  const ruleRes = checkNickByRules(nick);

  // затем AI (если включен)
  const ai = await geminiReviewNick({ nick });

  const text =
    `🔎 Проверка ника: ${nick}\n\n` +
    `📜 Rules: ${ruleRes.verdict}${ruleRes.reason ? ` — ${ruleRes.reason}` : ""}\n` +
    `🤖 AI: ${ai.decision} — ${ai.reason} (${Math.round(ai.confidence * 100)}%)\n\n` +
    `Нормализация: ${normalizeByRules(nick)}`;

  return ctx.reply(text.slice(0, 3900), mainKeyboard());
});

/* ================== TELEGRAM LAUNCH (409 FIX) ================== */
async function launchTelegramSafely() {
  while (true) {
    try {
      console.log("🤖 Telegram starting…");
      await tg.launch();
      console.log("✅ Telegram started");
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("409") || msg.includes("Conflict")) {
        console.log("⚠️ Telegram 409 Conflict (два инстанса). Повтор через 10с…");
        await sleep(10000);
        continue;
      }
      console.error("❌ Telegram launch error:", e);
      await sleep(5000);
    }
  }
}

/* ================== START ================== */
(async () => {
  await launchTelegramSafely();
  createMcBot();
  console.log("✅ ALL STARTED");
})();

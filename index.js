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
  .listen(PORT, "0.0.0.0", () => console.log(`🌐 Health server listening on ${PORT}`));

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = (process.env.CHAT_ID || "").trim() || null;

const MC_HOST = process.env.MC_HOST;
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = "1.8.9";

const LOGIN_CMD = (process.env.MC_LOGIN_CMD || "").trim(); // "/login password"
const WAIT_AFTER_SPAWN_MS = Number(process.env.WAIT_AFTER_SPAWN_MS || 3000);

const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();

// AI настройки
const AI_ENABLED = (process.env.AI_ENABLED || "1") === "1";
const AI_BUDGET_PER_AI_CLICK = Number(process.env.AI_BUDGET_PER_AI_CLICK || 30); // сколько REVIEW прогоняем по кнопке
const AI_MIN_CONF_FOR_BAN = Number(process.env.AI_MIN_CONF_FOR_BAN || 0.75);
const AI_MIN_CONF_FOR_OK = Number(process.env.AI_MIN_CONF_FOR_OK || 0.75);
const AI_DELAY_MS = Number(process.env.AI_DELAY_MS || 350);

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

/* ================== SAFE TG WRAPPERS ================== */
async function safeAnswerCbQuery(ctx, text) {
  try {
    await ctx.answerCbQuery(text);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("query is too old") || msg.includes("timeout expired")) return;
    console.log("⚠️ answerCbQuery error:", msg);
  }
}

async function safeEditMessageText(ctx, text, extra) {
  try {
    if (!ctx?.callbackQuery?.message) return ctx.reply(text, extra);
    return await ctx.editMessageText(text, extra);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("message is not modified")) return;
    if (msg.includes("message can't be edited") || msg.includes("MESSAGE_ID_INVALID")) return ctx.reply(text, extra);
    console.log("⚠️ editMessageText error:", msg);
  }
}

tg.catch((err) => console.log("⚠️ Telegraf handler error:", err?.message || err));

/* ================== RULES LOADER ================== */
function loadRules() {
  try {
    return JSON.parse(fs.readFileSync("rules.json", "utf8"));
  } catch (e) {
    console.error("❌ Не могу прочитать rules.json:", e?.message || e);
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
  if (norm.leet_map) {
    for (const [k, v] of Object.entries(norm.leet_map)) s = s.split(k).join(v);
  }
  if (norm.collapse_repeats) {
    const max = Number(norm.max_repeat || 2);
    s = s.replace(/(.)\1+/g, (_m, c) => String(c).repeat(Math.max(1, Math.min(5, max))));
  }
  return s;
}

function checkNickByRules(nick) {
  const raw = String(nick);
  const norm = normalizeByRules(raw);

  if ((RULES.whitelist_exact || []).includes(norm)) {
    return { verdict: "OK", reason: "WHITELIST", rule: "WHITELIST" };
  }

  for (const rule of RULES.rules || []) {
    for (const w of rule.words || []) {
      if (w && norm.includes(String(w).toLowerCase())) {
        return {
          verdict: String(rule.action || "BAN").toUpperCase(),
          reason: rule.reason || "Правило",
          rule: rule.id || "RULE"
        };
      }
    }
  }

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
  console.log("⚠️ GEMINI_API_KEY не задан — AI выключен.");
}

async function geminiReviewNick({ nick }) {
  if (!geminiModel) return { decision: "REVIEW", confidence: 0, reason: "AI выключен (нет GEMINI_API_KEY)" };

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

    if (!["BAN", "REVIEW", "OK"].includes(decision)) return { decision: "REVIEW", confidence: 0, reason: "AI decision некорректный" };
    return { decision, confidence, reason };
  } catch {
    return { decision: "REVIEW", confidence: 0, reason: "Ошибка Gemini" };
  }
}

/* ================== MINEFLAYER ================== */
let bot = null;
let scanLock = false;

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

  // FIX sourceStart 8192: игнорим plugin_message
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
  });

  bot.on("kicked", (reason) => console.log("⛔ MC kicked:", reason));
  bot.on("error", (e) => console.log("❌ MC error:", e?.message || e));

  bot.on("end", () => {
    console.log("❌ MC disconnected");
    bot = null;
    setTimeout(createMcBot, 5000);
  });
}

/* ================== PLAYER LIST (TAB COMPLETE) ================== */
async function getPlayersTabComplete() {
  if (!bot) return [];
  return new Promise((resolve) => {
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
  return [...new Set(Object.keys(bot?.players || {}).filter((n) => n && n !== MC_USER))].filter((n) =>
    /^[A-Za-z0-9_]{3,16}$/.test(n)
  );
}

async function getOnlinePlayersSmart() {
  const tab = await getPlayersTabComplete();
  if (tab.length) return tab;
  return getPlayersFromBotPlayers();
}

/* ================== LAST SCAN CACHE ================== */
// Здесь сохраняем последний скан "по rules" (без AI).
let lastScan = null;
// lastScan = { ts, total, ban[], reviewCandidates[], ok[] }

/* ================== SCAN: RULES ONLY ================== */
async function scanRulesOnly() {
  if (!mcInGame() || scanLock) return null;
  scanLock = true;

  try {
    const players = await getOnlinePlayersSmart();
    const res = {
      ts: Date.now(),
      total: players.length,
      ban: [],
      reviewCandidates: [],
      ok: []
    };

    for (const nick of players) {
      const r = checkNickByRules(nick);

      if (r.verdict === "BAN") res.ban.push(`${nick} (${r.reason})`);
      else if (r.verdict === "REVIEW") res.reviewCandidates.push(nick);
      else res.ok.push(nick);

      await sleep(SCAN_DELAY_MS);
    }

    lastScan = res;
    return res;
  } finally {
    scanLock = false;
  }
}

/* ================== AI: PROCESS LAST SCAN REVIEW ================== */
async function aiProcessLastScan() {
  if (!lastScan) return { ok: false, error: "Нет последнего скана. Сначала нажми 🔎 Скан всех" };

  if (!AI_ENABLED) return { ok: false, error: "AI выключен (AI_ENABLED=0)" };
  if (!geminiModel) return { ok: false, error: "AI выключен (нет GEMINI_API_KEY)" };

  const candidates = [...(lastScan.reviewCandidates || [])];
  if (!candidates.length) {
    return {
      ok: true,
      total: lastScan.total,
      ban: [...lastScan.ban],
      review: [],
      okList: [...lastScan.ok],
      note: "В последнем скане нет REVIEW ников"
    };
  }

  const ban = [...lastScan.ban];
  const okList = [...lastScan.ok];
  const review = [];

  let budget = Math.max(0, AI_BUDGET_PER_AI_CLICK);

  for (const nick of candidates) {
    if (budget <= 0) {
      review.push(`${nick} (лимит AI исчерпан)`);
      continue;
    }
    budget--;

    const ai = await geminiReviewNick({ nick });
    await sleep(AI_DELAY_MS);

    if (ai.decision === "BAN" && ai.confidence >= AI_MIN_CONF_FOR_BAN) {
      ban.push(`${nick} (AI: ${ai.reason}, ${Math.round(ai.confidence * 100)}%)`);
    } else if (ai.decision === "OK" && ai.confidence >= AI_MIN_CONF_FOR_OK) {
      okList.push(`${nick} (AI OK, ${Math.round(ai.confidence * 100)}%)`);
    } else {
      review.push(`${nick} (AI: ${ai.reason}, ${Math.round(ai.confidence * 100)}%)`);
    }
  }

  return {
    ok: true,
    total: lastScan.total,
    ban,
    review,
    okList,
    note: `AI проверил: ${Math.min(AI_BUDGET_PER_AI_CLICK, candidates.length)} из ${candidates.length}`
  };
}

/* ================== FORMATTERS ================== */
function formatStatusText() {
  const st = mcInGame() ? "✅ в игре" : "❌ не в сети";
  const ai = geminiModel && AI_ENABLED ? "✅ включён" : "❌ выключен";
  const last = lastScan ? `✅ есть (REVIEW: ${lastScan.reviewCandidates.length})` : "❌ нет";
  return `MC статус: ${st}\nНик: ${MC_USER}\nВерсия: ${MC_VERSION}\nAI (Gemini): ${ai}\nLast scan: ${last}`;
}

function formatRulesScan(res) {
  const lines = [];
  lines.push(`👥 Онлайн: ${res.total}`);
  lines.push("");
  lines.push(`🚫 BAN (${res.ban.length}):`);
  lines.push(res.ban.length ? res.ban.slice(0, 50).join("\n") : "—");
  lines.push("");
  lines.push(`⚠️ REVIEW (rules) (${res.reviewCandidates.length}):`);
  lines.push(res.reviewCandidates.length ? res.reviewCandidates.slice(0, 50).join("\n") : "—");
  lines.push("");
  lines.push(`✅ OK (${res.ok.length}):`);
  lines.push(res.ok.length ? res.ok.slice(0, 30).join(", ") + (res.ok.length > 30 ? ` …(+${res.ok.length - 30})` : "") : "—");
  return lines.join("\n").slice(0, 3900);
}

function formatAiResult(r) {
  const lines = [];
  lines.push(`👥 Онлайн (посл. скан): ${r.total}`);
  if (r.note) lines.push(`🧠 ${r.note}`);
  lines.push("");
  lines.push(`🚫 BAN (${r.ban.length}):`);
  lines.push(r.ban.length ? r.ban.slice(0, 50).join("\n") : "—");
  lines.push("");
  lines.push(`⚠️ REVIEW (${r.review.length}):`);
  lines.push(r.review.length ? r.review.slice(0, 50).join("\n") : "—");
  lines.push("");
  lines.push(`✅ OK (${r.okList.length}):`);
  lines.push(
    r.okList.length
      ? r.okList.slice(0, 30).join(", ") + (r.okList.length > 30 ? ` …(+${r.okList.length - 30})` : "")
      : "—"
  );
  return lines.join("\n").slice(0, 3900);
}

/* ================== TELEGRAM UI ================== */
function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔎 Скан всех (rules)", "scan_rules")],
    [Markup.button.callback("🤖 AI по последнему скану", "ai_last")],
    [Markup.button.callback("🧪 AI один ник", "ai_one")],
    [Markup.button.callback("📊 Статус", "status"), Markup.button.callback("🔁 Reload rules", "reload_rules")]
  ]);
}

/* ================== MANUAL AI ONE NICK STATE ================== */
const awaitingAiNick = new Map(); // chatId -> userId

tg.start((ctx) => ctx.reply("🤖 TabScan Bot\n\nВыбери действие:", mainKeyboard()));

tg.action("status", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  return safeEditMessageText(ctx, formatStatusText(), mainKeyboard());
});

tg.action("reload_rules", async (ctx) => {
  RULES = loadRules();
  await safeAnswerCbQuery(ctx, "rules.json обновлён");
  return safeEditMessageText(ctx, "✅ rules.json перезагружен", mainKeyboard());
});

/* ====== SCAN RULES BUTTON ====== */
tg.action("scan_rules", async (ctx) => {
  await safeAnswerCbQuery(ctx, "Сканирую…");

  // сразу покажем, что идёт скан (чтобы пользователь видел)
  await safeEditMessageText(ctx, "🔎 Скан (rules) запущен…", mainKeyboard());

  const res = await scanRulesOnly();
  if (!res) return safeEditMessageText(ctx, "❌ MC не в игре", mainKeyboard());

  return safeEditMessageText(ctx, formatRulesScan(res), mainKeyboard());
});

/* ====== AI LAST SCAN BUTTON ====== */
tg.action("ai_last", async (ctx) => {
  await safeAnswerCbQuery(ctx, "AI проверяю REVIEW…");

  // мгновенно обновим сообщение
  await safeEditMessageText(ctx, "🤖 AI проверяет ники из последнего скана…", mainKeyboard());

  const r = await aiProcessLastScan();
  if (!r.ok) return safeEditMessageText(ctx, `❌ ${r.error}`, mainKeyboard());

  return safeEditMessageText(ctx, formatAiResult(r), mainKeyboard());
});

/* ====== AI ONE NICK (manual) ====== */
tg.action("ai_one", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  awaitingAiNick.set(ctx.chat.id, ctx.from.id);
  return safeEditMessageText(
    ctx,
    "🧪 Отправь ник одним сообщением (только ник).\nПример: xX_Nick_123_Xx",
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "back")]])
  );
});

tg.action("back", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  awaitingAiNick.delete(ctx.chat.id);
  return safeEditMessageText(ctx, "🤖 TabScan Bot\n\nВыбери действие:", mainKeyboard());
});

tg.on("text", async (ctx) => {
  const expectedUser = awaitingAiNick.get(ctx.chat.id);
  if (!expectedUser || expectedUser !== ctx.from.id) return;

  const nick = String(ctx.message.text || "").trim();
  awaitingAiNick.delete(ctx.chat.id);

  if (!nick || nick.length > 32) return ctx.reply("❌ Пришли один ник (короткий).", mainKeyboard());

  const ruleRes = checkNickByRules(nick);
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

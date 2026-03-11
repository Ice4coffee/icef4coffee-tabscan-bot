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

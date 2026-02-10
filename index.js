/* ================== IMPORTS ================== */
import fs from "fs";
import http from "http";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ================== HEALTH SERVER ================== */
const PORT = Number(process.env.PORT || 3000);
http.createServer((_, res) => {
  res.writeHead(200);
  res.end("OK");
}).listen(PORT, "0.0.0.0");

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || null;

const MC_HOST = process.env.MC_HOST; // СТАВЬ mc.agerapvp.club
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = "1.8.9";
const MC_LOGIN_CMD = process.env.MC_LOGIN_CMD || "";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN not set");

/* ================== TELEGRAM ================== */
const tg = new Telegraf(BOT_TOKEN);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

tg.catch(e => console.log("TG error:", e.message));

/* ================== MC STATE ================== */
const mcState = {
  stage: "OFFLINE",
  lastKick: null,
  lastError: null,
};

function mcStatusText() {
  return [
    `MC: ${mcState.stage === "SPAWNED" ? "✅ ONLINE" : "❌ OFFLINE"}`,
    `Stage: ${mcState.stage}`,
    `Host: ${MC_HOST}`,
    `User: ${MC_USER}`,
    mcState.lastKick ? `Kicked: ${mcState.lastKick}` : "",
    mcState.lastError ? `Error: ${mcState.lastError}` : ""
  ].filter(Boolean).join("\n");
}

async function notify(text) {
  if (!CHAT_ID) return;
  try { await tg.telegram.sendMessage(CHAT_ID, text); } catch {}
}

/* ================== RULES ================== */
function loadRules() {
  return JSON.parse(fs.readFileSync("rules.json", "utf8"));
}
let RULES = loadRules();

function normalize(nick) {
  let s = nick.toLowerCase();
  s = s.replace(/[^\w]/g, "");
  s = s.replace(/(.)\1+/g, "$1$1");
  return s;
}

function checkNickByRules(nick) {
  const n = normalize(nick);

  if ((RULES.whitelist_exact || []).includes(n))
    return { verdict: "OK" };

  for (const r of RULES.rules || []) {
    for (const w of r.words || []) {
      if (n.includes(w)) {
        return { verdict: r.action, reason: r.reason };
      }
    }
  }

  for (const w of RULES.review || []) {
    if (n.includes(w)) return { verdict: "REVIEW" };
  }

  return { verdict: "OK" };
}

/* ================== GEMINI ================== */
let gemini = null;
if (GEMINI_API_KEY) {
  gemini = new GoogleGenerativeAI(GEMINI_API_KEY)
    .getGenerativeModel({ model: "gemini-1.5-flash" });
}

async function aiCheckNick(nick) {
  if (!gemini) return { decision: "REVIEW", confidence: 0 };

  const prompt = `
Return JSON only:
{"decision":"BAN|REVIEW|OK","confidence":0.0}

Nickname: ${nick}
`;

  const r = await gemini.generateContent(prompt);
  const t = r.response.text();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return { decision: "REVIEW", confidence: 0 };
  return JSON.parse(m[0]);
}

/* ================== MINEFLAYER ================== */
let bot = null;

function startMc() {
  mcState.stage = "CONNECTING";
  mcState.lastKick = null;
  mcState.lastError = null;

  bot = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    username: MC_USER,
    version: MC_VERSION
  });

  bot.on("login", async () => {
    mcState.stage = "LOGIN";
    await notify("✅ MC login");
  });

  bot.on("spawn", async () => {
    mcState.stage = "SPAWNED";
    await notify("✅ MC SPAWN — бот на сервере");
    if (MC_LOGIN_CMD) bot.chat(MC_LOGIN_CMD);
  });

  bot.on("kicked", async (r) => {
    mcState.stage = "OFFLINE";
    mcState.lastKick = String(r);
    await notify("⛔ MC kicked:\n" + mcState.lastKick);
  });

  bot.on("error", async (e) => {
    mcState.lastError = e.message;
    await notify("❌ MC error:\n" + e.message);
  });

  bot.on("end", async () => {
    mcState.stage = "OFFLINE";
    await notify("❌ MC disconnected");
    setTimeout(startMc, 5000);
  });
}

/* ================== SCAN ================== */
let lastScan = null;

async function getPlayers() {
  return Object.keys(bot.players || {});
}

async function scanRules() {
  if (mcState.stage !== "SPAWNED") return null;

  const players = await getPlayers();
  const res = { ban: [], review: [], ok: [] };

  for (const p of players) {
    const r = checkNickByRules(p);
    if (r.verdict === "BAN") res.ban.push(p);
    else if (r.verdict === "REVIEW") res.review.push(p);
    else res.ok.push(p);
  }

  lastScan = res;
  return res;
}

async function aiLastScan() {
  if (!lastScan) return null;

  const ban = [...lastScan.ban];
  const ok = [...lastScan.ok];
  const review = [];

  for (const p of lastScan.review) {
    const ai = await aiCheckNick(p);
    if (ai.decision === "BAN" && ai.confidence >= 0.75) ban.push(p);
    else if (ai.decision === "OK" && ai.confidence >= 0.75) ok.push(p);
    else review.push(p);
    await sleep(300);
  }

  return { ban, review, ok };
}

/* ================== TELEGRAM UI ================== */
function kb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔎 Скан (rules)", "scan")],
    [Markup.button.callback("🤖 AI по последнему скану", "ai")],
    [Markup.button.callback("📊 Статус MC", "status")]
  ]);
}

tg.start(ctx => ctx.reply("🤖 AgeraPvP Scan Bot", kb()));

tg.action("status", async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(mcStatusText(), kb());
});

tg.action("scan", async ctx => {
  await ctx.answerCbQuery("Скан...");
  const r = await scanRules();
  if (!r) return ctx.editMessageText("❌ MC не в сети\n\n" + mcStatusText(), kb());

  await ctx.editMessageText(
    `BAN: ${r.ban.length}\nREVIEW: ${r.review.length}\nOK: ${r.ok.length}`,
    kb()
  );
});

tg.action("ai", async ctx => {
  await ctx.answerCbQuery("AI...");
  const r = await aiLastScan();
  if (!r) return ctx.editMessageText("❌ Нет последнего скана", kb());

  await ctx.editMessageText(
    `AI RESULT\nBAN: ${r.ban.length}\nREVIEW: ${r.review.length}\nOK: ${r.ok.length}`,
    kb()
  );
});

/* ================== START ================== */
(async () => {
  await tg.launch();
  startMc();
})();

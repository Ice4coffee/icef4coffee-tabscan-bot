/* ================== IMPORTS ================== */
import fs from "fs";
import http from "http";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";

/* ================== HEALTH SERVER (Railway) ================== */
const PORT = Number(process.env.PORT || 3000);
http.createServer((_, res) => {
  res.writeHead(200);
  res.end("OK");
}).listen(PORT, "0.0.0.0", () => {
  console.log("🌐 Health server listening on", PORT);
});

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || null;

const MC_HOST = process.env.MC_HOST;       // mc.agerapvp.club
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = "1.8.9";
const MC_LOGIN_CMD = process.env.MC_LOGIN_CMD || "";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN not set");

/* ================== TELEGRAM ================== */
const tg = new Telegraf(BOT_TOKEN);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

tg.catch(err => console.log("⚠️ TG handler error:", err?.message || err));

/* ================== MC STATE ================== */
const mcState = {
  stage: "OFFLINE", // OFFLINE | CONNECTING | LOGIN | SPAWNED
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
let RULES = {};
try {
  RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));
} catch {
  RULES = { rules: [], review: [], whitelist_exact: [] };
}

function normalizeNick(nick) {
  return nick.toLowerCase().replace(/[^\w]/g, "").replace(/(.)\1+/g, "$1$1");
}

function checkNick(nick) {
  const n = normalizeNick(nick);

  if (RULES.whitelist_exact?.includes(n)) return "OK";

  for (const r of RULES.rules || []) {
    for (const w of r.words || []) {
      if (n.includes(w)) return r.action;
    }
  }

  for (const w of RULES.review || []) {
    if (n.includes(w)) return "REVIEW";
  }

  return "OK";
}

/* ================== MINEFLAYER ================== */
let bot = null;

function startMc() {
  if (!MC_HOST || !MC_USER) {
    console.log("⚠️ MC_HOST or MC_USER missing");
    return;
  }

  console.log("🧱 MC connecting…", MC_HOST);

  mcState.stage = "CONNECTING";
  mcState.lastKick = null;
  mcState.lastError = null;

  bot = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    username: MC_USER,
    version: MC_VERSION,
    hideErrors: true
  });

  bot.on("login", async () => {
    mcState.stage = "LOGIN";
    console.log("✅ MC login");
    await notify("✅ MC login (жду spawn)");
  });

  bot.on("spawn", async () => {
    mcState.stage = "SPAWNED";
    console.log("✅ MC spawn");
    await notify("✅ MC SPAWN — бот на сервере");

    if (MC_LOGIN_CMD) {
      setTimeout(() => {
        bot.chat(MC_LOGIN_CMD);
        console.log("🔐 sent login cmd");
      }, 1500);
    }
  });

  bot.on("kicked", async (reason) => {
    mcState.stage = "OFFLINE";
    mcState.lastKick = String(reason);
    console.log("⛔ MC kicked:", mcState.lastKick);
    await notify("⛔ MC kicked:\n" + mcState.lastKick);
  });

  bot.on("error", async (err) => {
    mcState.lastError = err?.message || String(err);
    console.log("❌ MC error:", mcState.lastError);
    await notify("❌ MC error:\n" + mcState.lastError);
  });

  bot.on("end", async () => {
    mcState.stage = "OFFLINE";
    console.log("❌ MC disconnected");
    await notify("❌ MC disconnected\n\n" + mcStatusText());
    setTimeout(startMc, 8000);
  });
}

/* ================== SCAN ================== */
let lastScan = null;

function getPlayers() {
  return Object.keys(bot?.players || {}).filter(p => p !== MC_USER);
}

async function scanRules() {
  if (mcState.stage !== "SPAWNED") return null;

  const res = { ban: [], review: [], ok: [] };

  for (const p of getPlayers()) {
    const r = checkNick(p);
    if (r === "BAN") res.ban.push(p);
    else if (r === "REVIEW") res.review.push(p);
    else res.ok.push(p);
  }

  lastScan = res;
  return res;
}

/* ================== TELEGRAM UI ================== */
function keyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔎 Скан (rules)", "scan")],
    [Markup.button.callback("📊 Статус MC", "status")]
  ]);
}

tg.start(ctx => ctx.reply("🤖 AgeraPvP Scan Bot", keyboard()));

tg.action("status", async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(mcStatusText(), keyboard());
});

tg.action("scan", async ctx => {
  await ctx.answerCbQuery("Скан…");
  const r = await scanRules();
  if (!r) {
    return ctx.editMessageText("❌ MC не в сети\n\n" + mcStatusText(), keyboard());
  }

  await ctx.editMessageText(
    `👥 Players: ${r.ban.length + r.review.length + r.ok.length}\n\n🚫 BAN: ${r.ban.length}\n⚠️ REVIEW: ${r.review.length}\n✅ OK: ${r.ok.length}`,
    keyboard()
  );
});

/* ================== TELEGRAM LAUNCH (409 FIX) ================== */
async function launchTelegramSafely() {
  while (true) {
    try {
      console.log("🤖 Telegram starting…");
      await tg.launch({ dropPendingUpdates: true });
      console.log("✅ Telegram started");
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("409") || msg.includes("Conflict")) {
        console.log("⚠️ 409 Conflict — другой инстанс. Жду 15с…");
        await sleep(15000);
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
  startMc();
})();

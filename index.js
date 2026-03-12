IceF4ry, [12.03.2026 10:24]
import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { resolveSrv } from "dns/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ================== ENV ================== */

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const MC_HOST = (process.env.MC_HOST || "").trim();
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;

const MC_VERSION = process.env.MC_VERSION || "1.8.9";
const MC_PASSWORD = process.env.MC_PASSWORD;

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const AI_ENABLED = (process.env.AI_ENABLED || "1") === "1";

if (!BOT_TOKEN  !MC_HOST  !MC_USER) {
  throw new Error("Нужны BOT_TOKEN, MC_HOST и MC_USER");
}

/* ================== TELEGRAM ================== */

const tg = new Telegraf(BOT_TOKEN);

tg.catch((err) => {
  console.log("⚠️ Telegram error:", err?.message || err);
});

async function launchTelegramSafely() {
  while (true) {
    try {
      console.log("🤖 Telegram starting...");
      await tg.launch({ dropPendingUpdates: true });
      console.log("✅ Telegram started");
      return;
    } catch (e) {
      console.log("❌ Telegram start error:", e?.message || e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/* ================== RULES ================== */

let RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));

function reloadRules() {
  RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));
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
  "т": "t"
};

function stripColors(s = "") {
  return s.replace(/§./g, "");
}

function norm(s = "") {
  s = stripColors(s);
  s = s.toLowerCase();

  s = [...s].map(ch => cyr[ch] || ch).join("");

  return s.replace(/[^a-z0-9_]/g, "");
}

/* ================== CHECK NICK ================== */

function checkNick(name) {
  const n = norm(name);

  const banReasons = [];

  for (const rule of RULES.rules || []) {
    if ((rule.action || "").toUpperCase() !== "BAN") continue;

    for (const word of rule.words || []) {
      const w = norm(word);
      if (n.includes(w)) banReasons.push(word);
    }
  }

  if (banReasons.length) return ["BAN", banReasons];

  return ["OK", []];
}

/* ================== REPORT ================== */

function report(title, names) {

  const ban = [];

  for (const nick of names) {
    const [status, reasons] = checkNick(nick);

    if (status === "BAN") {
      ban.push({ nick, reasons });
    }
  }

  let out = ${title}\nНайдено игроков: ${names.length}\n\n;

  if (ban.length) {
    out += ❌ BAN (${ban.length}):\n;

    ban.forEach((x, i) => {
      out += ${i + 1}) ${x.nick} → ${x.reasons.join(", ")}\n;
    });

  } else {
    out += "✅ Нарушений не найдено";
  }

  return out;
}

/* ================== MINEFLAYER ================== */

let mc;
let mcReady = false;

async function resolveMcEndpoint(host, port) {

  try {

    const srv = await resolveSrv(_minecraft._tcp.${host});

    if (srv.length) {
      return {
        host: srv[0].name,
        port: srv[0].port
      };
    }

  } catch {}

  return {
    host,
    port
  };
}

async function connectMC() {

  const ep = await resolveMcEndpoint(MC_HOST, MC_PORT);

  mc = mineflayer.createBot({
    host: ep.host,
    port: ep.port,
    username: MC_USER,
    version: MC_VERSION
  });

  mc.on("login", () => {
    console.log("✅ MC login");
  });

  mc.on("spawn", () => {
    mcReady = true;
    console.log("✅ MC ready");
  });

  mc.on("messagestr", (msg) => {

    const m = msg.toLowerCase();

    if (MC_PASSWORD && m.includes("login")) {
      setTimeout(() => {
        mc.chat(/login ${MC_PASSWORD});
      }, 1500);
    }

IceF4ry, [12.03.2026 10:24]
if (MC_PASSWORD && m.includes("register")) {
      setTimeout(() => {
        mc.chat(/register ${MC_PASSWORD} ${MC_PASSWORD});
      }, 1500);
    }

  });

  mc.on("end", () => {
    console.log("MC disconnected");
    mcReady = false;
    setTimeout(connectMC, 5000);
  });

}

/* ================== TAB SCAN ================== */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function tabComplete(prefix) {

  return new Promise((resolve) => {

    const client = mc._client;

    const on = (packet) => {

      const names = packet.matches || [];

      resolve(names);

    };

    client.once("tab_complete", on);

    client.write("tab_complete", {
      text: /msg ${prefix},
      assumeCommand: true
    });

  });

}

async function collectPlayers() {

  const prefixes = "abcdefghijklmnopqrstuvwxyz0123456789_".split("");

  const all = new Set();

  for (const p of prefixes) {

    const res = await tabComplete(p);

    res.forEach(n => all.add(n));

    await sleep(SCAN_DELAY_MS);

  }

  return [...all];

}

/* ================== GEMINI ================== */

let geminiModel = null;

if (GEMINI_API_KEY) {

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  geminiModel = genAI.getGenerativeModel({
    model: "gemini-1.5-flash"
  });

}

/* ================== TELEGRAM MENU ================== */

function menuKeyboard() {

  return Markup.inlineKeyboard([
    [Markup.button.callback("🔎 Скан всех", "scan_all")],
    [Markup.button.callback("📊 Статус", "status")],
    [Markup.button.callback("🔁 Reload rules", "reload_rules")]
  ]);

}

/* ================== COMMANDS ================== */

tg.start((ctx) => {

  ctx.reply(
    "Бот запущен.\n\n" +
    "/scanall — полный скан\n" +
    "/status — статус",
    menuKeyboard()
  );

});

tg.command("status", (ctx) => {

  ctx.reply(
    mcReady
      ? "✅ Бот на сервере"
      : "❌ Бот не подключён",
    menuKeyboard()
  );

});

tg.command("scanall", async (ctx) => {

  if (!mcReady) {
    return ctx.reply("MC не готов");
  }

  ctx.reply("🔎 Сканирую игроков...");

  const players = await collectPlayers();

  const result = report("Full scan", players);

  ctx.reply(result);

});

/* ================== BUTTONS ================== */

tg.action("scan_all", async (ctx) => {

  await ctx.answerCbQuery();

  if (!mcReady) {
    return ctx.reply("MC не готов");
  }

  ctx.reply("🔎 Сканирую игроков...");

  const players = await collectPlayers();

  const result = report("Full scan", players);

  ctx.reply(result);

});

tg.action("status", async (ctx) => {

  await ctx.answerCbQuery();

  ctx.reply(
    mcReady
      ? "✅ Бот подключён к серверу"
      : "❌ Бот не подключён",
    menuKeyboard()
  );

});

tg.action("reload_rules", async (ctx) => {

  await ctx.answerCbQuery();

  reloadRules();

  ctx.reply("✅ rules.json перезагружен", menuKeyboard());

});

/* ================== AUTO SCAN ================== */

if (AUTO_SCAN) {

  setInterval(async () => {

    if (!mcReady) return;

    const players = await collectPlayers();

    const result = report("Auto scan", players);

    if (CHAT_ID) {
      tg.telegram.sendMessage(CHAT_ID, result);
    }

  }, AUTO_SCAN_MINUTES * 60000);

}

/* ================== START ================== */

(async () => {

  await launchTelegramSafely();

  await connectMC();

})();

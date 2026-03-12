import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { resolveSrv } from "dns/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PING_USER_ID = process.env.PING_USER_ID ? Number(process.env.PING_USER_ID) : null;

const MC_HOST = (process.env.MC_HOST || "").trim();
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;

const MC_VERSION = process.env.MC_VERSION || "1.8.9";
const MC_PASSWORD = process.env.MC_PASSWORD;

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

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  throw new Error("Нужны BOT_TOKEN, MC_HOST, MC_USER");
}

/* ================== TELEGRAM BOT ================== */
const tg = new Telegraf(BOT_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

tg.catch((err) => {
  console.log("TG handler error:", err?.message || err);
});

async function safeSend(chatId, text, extra) {
  try {
    await tg.telegram.sendMessage(chatId, text, extra);
    return true;
  } catch (e) {
    console.log("[TG SEND ERROR]", e?.message || e);
    return false;
  }
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ================== 409 FIX ================== */
async function launchTelegramSafely() {
  while (true) {
    try {
      console.log("Telegram starting...");
      await tg.launch({ dropPendingUpdates: true });
      console.log("Telegram started");
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("409") || msg.includes("Conflict")) {
        console.log("409 Conflict — другой инстанс getUpdates. Жду 15с...");
        await sleep(15000);
        continue;
      }
      console.log("Telegram launch error:", msg);
      await sleep(5000);
    }
  }
}

/* ================== RULES ================== */
let RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));

function reloadRules() {
  RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));
  rebuildNormalization();
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
  "т": "t",
};

let invisRe;
let sepRe;
let leetMap;
let collapseRepeats;
let maxRepeat;

function stripColors(s = "") {
  return s.replace(/§./g, "");
}

function rebuildNormalization() {
  invisRe = new RegExp(
    RULES?.normalization?.strip_invisibles_regex ||
      "[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]",
    "g"
  );

  sepRe = new RegExp(
    RULES?.normalization?.separators_regex ||
      "[\\s\\-_.:,;|/\\\\~`'\"^*+=()\\[\\]{}<>]+",
    "g"
  );

  leetMap =
    RULES?.normalization?.leet_map || {
      "0": "o",
      "1": "i",
      "3": "e",
      "4": "a",
      "5": "s",
      "7": "t",
      "@": "a",
      "$": "s",
    };

  collapseRepeats = RULES?.normalization?.collapse_repeats ?? true;
  maxRepeat = RULES?.normalization?.max_repeat ?? 2;
}
rebuildNormalization();

function norm(s = "") {
  s = stripColors(s);
  if (RULES?.normalization?.lowercase ?? true) s = s.toLowerCase();
  s = s.replace(invisRe, "");
  s = [...s].map((ch) => cyr[ch] || leetMap[ch] || ch).join("");
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
  for (const rule of RULES.rules || []) {
    if ((rule.action || "").toUpperCase() !== "BAN") continue;
    for (const w0 of rule.words || []) {
      const w = norm(String(w0));
      if (w && n.includes(w)) {
        banReasons.push(`${rule.reason || rule.id}:${w0}`);
      }
    }
  }
  if (banReasons.length) return ["BAN", banReasons];

  const review = [];
  for (const w0 of RULES.review || []) {
    const w = norm(String(w0));
    if (w && n.includes(w)) {
      review.push(`review:${w0}`);
    }
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
  for (const p of splitText(text)) {
    if (p.trim()) {
      await ctx.reply(p);
    }
  }
}

async function sendChunksChat(chatId, text) {
  for (const p of splitText(text)) {
    if (!p.trim()) continue;
    const ok = await safeSend(chatId, p);
    if (!ok) throw new Error("TG_SEND_FAILED");
  }
}

async function sendChunksChatHtml(chatId, html) {
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

  let out = `${title}\nНайдено: ${names.length}\n\n`;

  if (ban.length) {
    out += `BAN (${ban.length}):\n`;
    ban.forEach((x, i) => {
      out += `${i + 1}) ${x.nick} -> ${x.r.join("; ")}\n`;
    });
    out += "\n";
  }

  if (rev.length) {
    out += `REVIEW (${rev.length}):\n`;
    rev.forEach((x, i) => {
      out += `${i + 1}) ${x.nick} -> ${x.r.join("; ")}\n`;
    });
    out += "\n";
  }

  if (!ban.length && !rev.length) {
    out += "OK: некорректных ников не найдено.\n";
  }

  return {
    out,
    ban: ban.length,
    rev: rev.length,
    reviewNicks: rev.map((x) => x.nick),
  };
}

/* ================== SAFE MODE: DISABLE CHUNK PARSING ================== */
function disableChunkParsing(bot) {
  const c = bot?._client;
  if (!c) return;

  const packetNames = [
    "map_chunk",
    "map_chunk_bulk",
    "unload_chunk",
    "multi_block_change",
    "block_change",
    "update_block_entity",
    "block_action",
  ];

  for (const name of packetNames) {
    try {
      c.removeAllListeners(name);
      c.on(name, () => {});
    } catch (e) {
      console.log("[MC] disableChunkParsing error:", e?.message || e);
    }
  }

  console.log("[MC] chunk parsing disabled (safe mode)");
}

/* ================== SRV RESOLVE ================== */
async function resolveMcEndpoint(host, port) {
  const h = String(host || "").trim();
  const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(h);

  if (!isIp) {
    try {
      const srv = await resolveSrv(`_minecraft._tcp.${h}`);
      if (srv && srv.length) {
        srv.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
        const best = srv[0];
        return { host: best.name, port: best.port, via: "SRV" };
      }
    } catch (e) {
      console.log("[MC] SRV resolve failed:", e?.message || e);
    }
  }

  return { host: h, port: Number(port || 25565), via: "DIRECT" };
}

/* ================== TAB COMPLETE ================== */
function tabComplete(bot, text) {
  return new Promise((res, rej) => {
    if (!bot?._client) {
      rej(new Error("CLIENT_NOT_READY"));
      return;
    }

    const c = bot._client;

    const to = setTimeout(() => {
      cleanup();
      rej(new Error("TAB_TIMEOUT"));
    }, 2500);

    const on = (p) => {
      cleanup();
      const matches =
        p?.matches?.map((x) =>
          typeof x === "string" ? x : x.text || x.match || ""
        ) || [];
      res(matches);
    };

    function cleanup() {
      clearTimeout(to);
      try {
        c.removeListener("tab_complete", on);
      } catch (e) {}
      try {
        c.removeListener("tab_complete_response", on);
      } catch (e) {}
    }

    try {
      c.once("tab_complete", on);
      c.once("tab_complete_response", on);

      c.write("tab_complete", {
        text,
        assumeCommand: true,
        lookedAtBlock: { x: 0, y: 0, z: 0 },
      });
    } catch (e) {
      cleanup();
      rej(e);
    }
  });
}

/* ================== MINEFLAYER ================== */
let mc = null;
let mcReady = false;
let tabReady = false;
let mcOnline = false;
let mcLastError = "";
let loginSent = false;
let registerSent = false;
let reconnectTimer = null;
let connecting = false;
let autoScanPrimed = false;

function scheduleReconnect(reason) {
  if (reconnectTimer) return;

  console.log("[MC] reconnect scheduled:", reason);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMC().catch((e) => {
      console.log("[MC] reconnect error:", e?.message || e);
    });
  }, 5000);
}

async function connectMC() {
  if (connecting) return;
  connecting = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (mc) {
    try {
      if (typeof mc.quit === "function") mc.quit("reconnect");
    } catch (e) {}

    try {
      if (typeof mc.end === "function") mc.end();
    } catch (e) {}

    try {
      if (mc._client && typeof mc._client.end === "function") mc._client.end();
    } catch (e) {}

    mc = null;
  }

  mcReady = false;
  tabReady = false;
  mcOnline = false;
  mcLastError = "";
  loginSent = false;
  registerSent = false;
  autoScanPrimed = false;

  const ep = await resolveMcEndpoint(MC_HOST, MC_PORT);

  console.log("[MC DEBUG]", {
    inputHost: MC_HOST,
    inputPort: MC_PORT,
    resolvedHost: ep.host,
    resolvedPort: ep.port,
    via: ep.via,
    version: MC_VERSION,
    user: MC_USER,
  });

  try {
    mc = mineflayer.createBot({
      host: ep.host,
      port: ep.port,
      username: MC_USER,
      version: MC_VERSION,
      viewDistance: 1,
    });
  } catch (e) {
    mcLastError = "createBot failed: " + String(e?.message || e);
    console.log("[MC]", mcLastError);
    scheduleReconnect("createBot");
    connecting = false;
    return;
  }

  mc.on("login", () => {
    disableChunkParsing(mc);

    mcOnline = true;
    mcReady = false;
    mcLastError = "";
    console.log("[MC] login");

    setTimeout(async () => {
      if (!mc || mcReady || tabReady) return;

      try {
        const r = await tabComplete(mc, "/msg a");
        if (Array.isArray(r)) {
          tabReady = true;
          mcReady = true;
          primeAutoScan();
          console.log("[MC] READY via TAB_COMPLETE");
        }
      } catch (e) {
        console.log("[MC] TAB readiness failed:", e?.message || e);
      }
    }, 2500);
  });

  mc.on("spawn", () => {
    console.log("[MC] spawn");
    setTimeout(() => {
      mcReady = true;
      primeAutoScan();
      console.log("[MC] READY via SPAWN");
    }, READY_AFTER_MS);
  });

  mc.on("messagestr", (msg) => {
    const m = String(msg).toLowerCase();

    if (MC_PASSWORD && !loginSent && m.includes("login")) {
      loginSent = true;
      setTimeout(() => {
        try {
          mc?.chat?.(`/login ${MC_PASSWORD}`);
        } catch (e) {
          console.log("[MC] login command error:", e?.message || e);
        }
      }, 1500);
    }

    if (MC_PASSWORD && !registerSent && m.includes("register")) {
      registerSent = true;
      setTimeout(() => {
        try {
          mc?.chat?.(`/register ${MC_PASSWORD} ${MC_PASSWORD}`);
        } catch (e) {
          console.log("[MC] register command error:", e?.message || e);
        }
      }, 1500);
    }
  });

  const onDisconnect = (reason) => {
    mcReady = false;
    tabReady = false;
    mcOnline = false;
    mcLastError = reason;
    loginSent = false;
    registerSent = false;
    console.log("[MC] disconnected:", reason);
    scheduleReconnect(reason);
  };

  mc.on("end", () => onDisconnect("end"));
  mc.on("kicked", (r) => onDisconnect("kicked: " + String(r)));
  mc.on("error", (e) => {
    const msg = e?.stack || e?.message || String(e);
    onDisconnect("error: " + msg);
  });

  setTimeout(() => {
    connecting = false;
  }, 1200);
}

connectMC().catch((e) => {
  console.log("[MC] connect error:", e?.message || e);
});

/* ================== SCAN HELPERS ================== */
function clean(s) {
  return String(s).replace(/[^A-Za-z0-9_]/g, "");
}

async function byPrefix(prefix) {
  const raw = await tabComplete(mc, `/msg ${prefix}`);
  const pref = clean(prefix).toLowerCase();

  const result = raw
    .map(clean)
    .filter(
      (n) => n.length >= 3 && n.length <= 16 && n.toLowerCase().startsWith(pref)
    );

  console.log(`[TAB] prefix=${prefix} raw=${raw.length} filtered=${result.length}`);
  return result;
}

function prefixes() {
  if (AUTO_PREFIXES) {
    return AUTO_PREFIXES
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  const a = [];
  for (let i = 97; i <= 122; i++) a.push(String.fromCharCode(i));
  for (let i = 0; i <= 9; i++) a.push(String(i));
  a.push("_");
  return a;
}

async function collect(ps) {
  if (!mcReady) throw new Error("MC_NOT_READY");

  const all = new Set();
  let okPrefixes = 0;
  let failedPrefixes = 0;
  const errors = [];

  for (const p of ps) {
    if (!mcReady) throw new Error("MC_NOT_READY");

    try {
      const found = await byPrefix(p);
      found.forEach((n) => all.add(n));
      okPrefixes++;
    } catch (e) {
      failedPrefixes++;
      const msg = String(e?.message || e);
      errors.push(`${p}: ${msg}`);
      console.log("[AUTO][PREFIX ERROR]", p, msg);
    }

    await sleep(SCAN_DELAY_MS);
  }

  console.log(
    `[AUTO][COLLECT] ok=${okPrefixes} fail=${failedPrefixes} totalNames=${all.size}`
  );

  if (okPrefixes === 0) {
    throw new Error("ALL_PREFIXES_FAILED: " + errors.slice(0, 5).join(" | "));
  }

  return [...all];
}

/* ================== GEMINI AI ================== */
let geminiModel = null;
if (GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
}

async function geminiReviewNick(nick) {
  if (!AI_ENABLED || !geminiModel) {
    return { decision: "REVIEW", confidence: 0, reason: "AI выключен" };
  }

  const normalized = norm(nick);

  const prompt = `
Верни СТРОГО JSON без текста вокруг:
{"decision":"BAN|REVIEW|OK","confidence":0.0,"reason":"кратко"}

BAN — явный мат/оскорбления/расизм/экстремизм/18+/наркотики/читы/маскировка под персонал/проект.
REVIEW — сомнительно/намёк/двусмысленно.
OK — чисто.

Ник: ${nick}
Нормализация: ${normalized}
`;

  try {
    const result = await geminiModel.generateContent(prompt);
    const text = result?.response?.text?.()?.trim?.() || "";
    const m = text.match(/\{[\s\S]*\}/);

    if (!m) {
      return { decision: "REVIEW", confidence: 0, reason: "AI не вернул JSON" };
    }

    const data = JSON.parse(m[0]);
    const decision = String(data.decision || "REVIEW").toUpperCase();
    const confidence = Math.max(0, Math.min(1, Number(data.confidence || 0)));
    const reason = String(data.reason || "—").slice(0, 120);

    if (!["BAN", "REVIEW", "OK"].includes(decision)) {
      return {
        decision: "REVIEW",
        confidence: 0,
        reason: "AI decision некорректный",
      };
    }

    return { decision, confidence, reason };
  } catch (e) {
    return { decision: "REVIEW", confidence: 0, reason: "Ошибка Gemini" };
  }
}

/* ================== LAST SCAN CACHE ================== */
let lastScan = null;

/* ================== STATUS HELPERS ================== */
let autoScanRunning = false;
let autoScanLastRunTs = 0;
let autoScanLastResult = "not_started";
let autoScanLastError = "";
let autoScanTimer = null;

function formatMcStatus() {
  if (mcOnline && mcReady) return "✅ на сервере (готов)";
  if (mcOnline) return "🟡 подключён, но не готов";
  return "❌ не в сети";
}

function formatAutoScanStatus() {
  if (!AUTO_SCAN) return "❌ выключен";
  if (autoScanRunning) return "🔄 идёт скан";
  if (autoScanLastResult === "not_started") return "⏳ ожидает первого запуска";
  if (autoScanLastResult === "waiting_mc") return "⏳ ожидает готовности MC";
  if (autoScanLastResult === "missing_chat") return "❌ нет CHAT_ID";
  if (autoScanLastResult === "ok_no_hits") return "✅ последний проход без совпадений";
  if (autoScanLastResult === "ok_hits") return "⚠️ последний проход нашёл совпадения";
  if (autoScanLastResult === "send_failed") return "❌ ошибка отправки в Telegram";
  if (autoScanLastResult === "error") return "❌ ошибка автоскана";
  return autoScanLastResult;
}

function formatStatusText() {
  const ai = AI_ENABLED && geminiModel ? "✅ включён" : "❌ выключен";
  const last = lastScan
    ? `✅ есть (${Math.round((Date.now() - lastScan.ts) / 1000)}с назад)`
    : "❌ нет";
  const autoAge = autoScanLastRunTs
    ? `${Math.round((Date.now() - autoScanLastRunTs) / 1000)}с назад`
    : "ещё не запускался";

  return [
    `MC статус: ${formatMcStatus()}`,
    `Ник: ${MC_USER}`,
    `Версия: ${MC_VERSION}`,
    `AI (Gemini): ${ai}`,
    `Last scan: ${last}`,
    `Auto scan: ${formatAutoScanStatus()}`,
    `Auto scan last run: ${autoAge}`,
    `MC ready: ${mcReady}`,
    `MC online: ${mcOnline}`,
    `Auto running: ${autoScanRunning}`,
    `Auto result: ${autoScanLastResult}`,
    mcLastError ? `MC error: ${mcLastError}` : "",
    autoScanLastError ? `Auto scan error: ${autoScanLastError}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/* ================== BUTTONS MENU ================== */
function menuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔎 Скан всех (rules)", "scan_all")],
    [Markup.button.callback("🤖 AI по последнему скану", "ai_last")],
    [Markup.button.callback("🧪 AI один ник", "ai_one")],
    [
      Markup.button.callback("📊 Статус", "status"),
      Markup.button.callback("🔃 Reload rules", "reload_rules"),
    ],
  ]);
}

/* ================== COMMANDS ================== */
tg.start((c) => {
  return c.reply(
    "Готов.\n/tab <префикс>\n/tabcheck <префикс>\n/scanall\n/status",
    menuKeyboard()
  );
});

tg.command("status", (c) => {
  return c.reply(formatStatusText(), menuKeyboard());
});

tg.command("tab", async (c) => {
  if (!mcReady) return c.reply("MC не готов", menuKeyboard());

  const a = c.message.text.split(" ").slice(1).join(" ");
  const n = [...new Set(await byPrefix(a))];

  let t = `Tab ${a}\nНайдено: ${n.length}\n\n`;
  n.forEach((x, i) => {
    t += `${i + 1}) ${x}\n`;
  });

  await sendChunksReply(c, t);
  await c.reply("Меню:", menuKeyboard());
});

tg.command("tabcheck", async (c) => {
  if (!mcReady) return c.reply("MC не готов", menuKeyboard());

  const a = c.message.text.split(" ").slice(1).join(" ");
  const n = await byPrefix(a);

  await sendChunksReply(c, report(`Tabcheck ${a}`, n).out);
  await c.reply("Меню:", menuKeyboard());
});

tg.command("scanall", async (c) => {
  if (!mcReady) return c.reply("MC не готов", menuKeyboard());

  await c.reply("Сканирую...", menuKeyboard());

  const n = await collect(prefixes());
  const r = report("Full scan", n);

  lastScan = {
    ts: Date.now(),
    names: n,
    reportText: r.out,
    reviewNicks: r.reviewNicks,
  };

  await sendChunksReply(c, r.out);
  await c.reply("Готово. Можешь нажать AI по последнему скану", menuKeyboard());
});

/* ================== BUTTON HANDLERS ================== */
tg.action("status", async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (e) {}

  await ctx.reply(formatStatusText(), menuKeyboard());
});

tg.action("reload_rules", async (ctx) => {
  try {
    await ctx.answerCbQuery("Reload...");
  } catch (e) {}

  try {
    reloadRules();
    await ctx.reply("rules.json перезагружен", menuKeyboard());
  } catch (e) {
    await ctx.reply(
      "rules.json reload error: " + String(e?.message || e),
      menuKeyboard()
    );
  }
});

tg.action("scan_all", async (ctx) => {
  try {
    await ctx.answerCbQuery("Scan...");
  } catch (e) {}

  if (!mcReady) return ctx.reply("MC не готов", menuKeyboard());

  await ctx.reply("Сканирую всех...", menuKeyboard());

  const n = await collect(prefixes());
  const r = report("Full scan (button)", n);

  lastScan = {
    ts: Date.now(),
    names: n,
    reportText: r.out,
    reviewNicks: r.reviewNicks,
  };

  await sendChunksReply(ctx, r.out);
  await ctx.reply("Готово. Нажми AI по последнему скану", menuKeyboard());
});

/* ====== AI LAST SCAN ====== */
tg.action("ai_last", async (ctx) => {
  try {
    await ctx.answerCbQuery("AI...");
  } catch (e) {}

  if (!lastScan) {
    return ctx.reply(
      "Нет последнего скана. Сначала сделай /scanall или кнопку скана",
      menuKeyboard()
    );
  }

  if (!AI_ENABLED || !geminiModel) {
    return ctx.reply(
      "AI выключен (нет GEMINI_API_KEY или AI_ENABLED=0)",
      menuKeyboard()
    );
  }

  const candidates = [...(lastScan.reviewNicks || [])];
  if (!candidates.length) {
    return ctx.reply(
      "В последнем скане нет REVIEW. AI нечего проверять.",
      menuKeyboard()
    );
  }

  await ctx.reply(
    `AI проверяю REVIEW из последнего скана... (${candidates.length})`,
    menuKeyboard()
  );

  const ban = [];
  const ok = [];
  const review = [];
  let budget = Math.max(0, AI_BUDGET_PER_CLICK);

  for (const nick of candidates) {
    if (budget <= 0) {
      review.push(`${nick} (лимит AI исчерпан)`);
      continue;
    }

    budget--;

    const ai = await geminiReviewNick(nick);
    await sleep(AI_DELAY_MS);

    if (ai.decision === "BAN" && ai.confidence >= AI_MIN_CONF_FOR_BAN) {
      ban.push(`${nick} (AI: ${ai.reason}, ${Math.round(ai.confidence * 100)}%)`);
    } else if (ai.decision === "OK" && ai.confidence >= AI_MIN_CONF_FOR_OK) {
      ok.push(`${nick} (AI OK, ${Math.round(ai.confidence * 100)}%)`);
    } else {
      review.push(`${nick} (AI: ${ai.reason}, ${Math.round(ai.confidence * 100)}%)`);
    }
  }

  let out = `AI RESULT (последний скан)\n\n`;
  out += `BAN: ${ban.length}\n`;
  out += `OK: ${ok.length}\n`;
  out += `REVIEW: ${review.length}\n\n`;

  if (ban.length) out += `BAN LIST:\n${ban.join("\n")}\n\n`;
  if (review.length) out += `REVIEW LIST:\n${review.join("\n")}\n\n`;
  if (ok.length) out += `OK LIST:\n${ok.join("\n")}\n\n`;

  await sendChunksReply(ctx, out);
  await ctx.reply("Меню:", menuKeyboard());
});

/* ====== AI ONE NICK ====== */
const awaitingNick = new Map();

tg.action("ai_one", async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (e) {}

  awaitingNick.set(ctx.chat.id, ctx.from.id);
  await ctx.reply("Отправь ник одним сообщением (только ник).", menuKeyboard());
});

tg.on("text", async (ctx) => {
  const uid = awaitingNick.get(ctx.chat.id);
  if (!uid || uid !== ctx.from.id) return;

  awaitingNick.delete(ctx.chat.id);

  const nick = String(ctx.message.text || "").trim();
  if (!nick) {
    return ctx.reply("Пусто. Пришли ник.", menuKeyboard());
  }

  const [s, reasons] = checkNick(nick);
  const ai = await geminiReviewNick(nick);

  const out =
    `Ник: ${nick}\n` +
    `Rules: ${s}${reasons?.length ? ` — ${reasons.join("; ")}` : ""}\n` +
    `AI: ${ai.decision} — ${ai.reason} (${Math.round(ai.confidence * 100)}%)\n` +
    `Нормализация: ${norm(nick)}`;

  await ctx.reply(out, menuKeyboard());
});

/* ================== AUTO SCAN ================== */
async function runAutoScan(trigger = "timer") {
  if (autoScanRunning) {
    console.log("[AUTO] skipped: already running");
    return;
  }

  console.log("[AUTO] start", {
    trigger,
    mcReady,
    mcOnline,
    hasChatId: !!CHAT_ID,
  });

  if (!mcReady) {
    autoScanLastResult = "waiting_mc";
    console.log("[AUTO] waiting_mc");
    return;
  }

  if (!CHAT_ID) {
    autoScanLastResult = "missing_chat";
    autoScanLastError = "CHAT_ID not set";
    console.log("[AUTO] missing_chat");
    return;
  }

  autoScanRunning = true;
  autoScanLastError = "";

  try {
    const n = await collect(prefixes());
    const r = report("Auto scan", n);

    lastScan = {
      ts: Date.now(),
      names: n,
      reportText: r.out,
      reviewNicks: r.reviewNicks,
    };
    autoScanLastRunTs = Date.now();

    console.log(`[AUTO] collected names=${n.length} ban=${r.ban} review=${r.rev}`);

    if (r.ban || r.rev) {
      if (PING_USER_ID) {
        const html = `<a href="tg://user?id=${PING_USER_ID}">&#8203;</a>\n<pre>${escapeHtml(r.out)}</pre>`;
        await sendChunksChatHtml(CHAT_ID, html);
      } else {
        await sendChunksChat(CHAT_ID, r.out);
      }
      autoScanLastResult = "ok_hits";
    } else {
      autoScanLastResult = "ok_no_hits";
    }

    console.log(`[AUTO] ${trigger}: ${n.length} names, ban=${r.ban}, review=${r.rev}`);
  } catch (e) {
    autoScanLastResult = "error";
    autoScanLastError = String(e?.message || e);
    console.log("[AUTO] error:", autoScanLastError);

    try {
      await safeSend(CHAT_ID, `Auto scan error:\n${autoScanLastError}`);
    } catch (err) {}
  } finally {
    autoScanRunning = false;
    console.log("[AUTO] finish");
  }
}

function scheduleNextAutoScan(delayMs = AUTO_SCAN_MINUTES * 60 * 1000) {
  if (!AUTO_SCAN) return;

  if (autoScanTimer) {
    clearTimeout(autoScanTimer);
  }

  autoScanTimer = setTimeout(async () => {
    await runAutoScan("timer");
    scheduleNextAutoScan();
  }, Math.max(1000, delayMs));
}

function primeAutoScan() {
  if (!AUTO_SCAN || autoScanPrimed) return;

  autoScanPrimed = true;
  scheduleNextAutoScan(Math.min(15000, AUTO_SCAN_MINUTES * 60 * 1000));

  runAutoScan("ready").catch((e) => {
    autoScanLastResult = "error";
    autoScanLastError = String(e?.message || e);
  });
}

if (AUTO_SCAN) {
  scheduleNextAutoScan();
}

/* ================== WATCHDOG ================== */
setInterval(() => {
  if (mcOnline && !mcReady) {
    console.log("[WATCHDOG] mcOnline=true but mcReady=false, reconnecting");
    scheduleReconnect("watchdog_not_ready");
  }
}, 30000);

/* ================== START ================== */
(async () => {
  await launchTelegramSafely();
  console.log("TG bot started");
})();

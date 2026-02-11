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
const MC_PASSWORD = process.env.MC_PASSWORD; // используется твоим messagestr логином

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

tg.catch((err) => console.log("⚠️ TG handler error:", err?.message || err));

async function safeSend(chatId, text, extra) {
  try {
    await tg.telegram.sendMessage(chatId, text, extra);
  } catch {}
}

/* ================== 409 FIX (без падений) ================== */
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
        console.log("⚠️ 409 Conflict — другой инстанс getUpdates. Жду 15с…");
        await sleep(15000);
        continue;
      }
      console.log("❌ Telegram launch error:", msg);
      await sleep(5000);
    }
  }
}

/* ================== RULES ================== */
let RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));

function reloadRules() {
  RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));
  // обновим regex/настройки
  rebuildNormalization();
}

/* ================== NORMALIZE ================== */
const cyr = { "а":"a","е":"e","о":"o","р":"p","с":"c","х":"x","у":"y","к":"k","м":"m","т":"t" };

let invisRe, sepRe, leetMap, collapseRepeats, maxRepeat;

function stripColors(s = "") { return s.replace(/§./g, ""); }

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
  for (const p of splitText(text)) if (p.trim())
    await bot.telegram.sendMessage(chatId, p, { parse_mode: "Markdown" });
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
    out += `❌ BAN (${ban.length}):\n`;
    ban.forEach((x,i)=> out+=`${i+1}) ${x.nick} → ${x.r.join("; ")}\n`);
    out += "\n";
  }
  if (rev.length) {
    out += `⚠️ REVIEW (${rev.length}):\n`;
    rev.forEach((x,i)=> out+=`${i+1}) ${x.nick} → ${x.r.join("; ")}\n`);
    out += "\n";
  }
  if (!ban.length && !rev.length) out += "✅ Некорректных ников не найдено.\n";

  return { out, ban: ban.length, rev: rev.length, reviewNicks: rev.map(x => x.nick) };
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
    "block_action"
  ];

  for (const name of packetNames) {
    try {
      c.removeAllListeners(name);
      c.on(name, () => {});
    } catch {}
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
    } catch {}
  }

  return { host: h, port: Number(port || 25565), via: "DIRECT" };
}

/* ================== TAB COMPLETE ================== */
function tabComplete(bot, text) {
  return new Promise((res, rej) => {
    if (!bot?._client) return rej(new Error("CLIENT_NOT_READY"));
    const c = bot._client;

    const to = setTimeout(() => {
      cleanup();
      rej(new Error("TAB_TIMEOUT"));
    }, 2500);

    const on = (p) => {
      cleanup();
      res(p?.matches?.map(x => typeof x==="string" ? x : (x.text||x.match||"")) || []);
    };

    function cleanup() {
      clearTimeout(to);
      try { c.removeListener("tab_complete", on); } catch {}
      try { c.removeListener("tab_complete_response", on); } catch {}
    }

    c.once("tab_complete", on);
    c.once("tab_complete_response", on);

    try {
      c.write("tab_complete", { text, assumeCommand: true, lookedAtBlock: { x:0, y:0, z:0 } });
    } catch (e) {
      cleanup();
      rej(e);
    }
  });
}

/* ================== MINEFLAYER ================== */
let mc;
let mcReady = false;
let tabReady = false;     // ✅ READY через tab_complete
let mcOnline = false;
let mcLastError = "";
let loginSent = false;
let registerSent = false;
let reconnectTimer = null;
let connecting = false;

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMC().catch(() => {});
  }, 5000);
}

async function connectMC() {
  if (connecting) return;
  connecting = true;

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  if (mc) {
    try { mc.quit?.("reconnect"); } catch {}
    try { mc.end?.(); } catch {}
    try { mc._client?.end?.(); } catch {}
    mc = null;
  }

  mcReady = false;
  tabReady = false;
  mcOnline = false;
  mcLastError = "";
  loginSent = false;
  registerSent = false;

  const ep = await resolveMcEndpoint(MC_HOST, MC_PORT);

  console.log("[MC DEBUG]", {
    inputHost: MC_HOST,
    inputPort: MC_PORT,
    resolvedHost: ep.host,
    resolvedPort: ep.port,
    via: ep.via,
    version: MC_VERSION,
    user: MC_USER
  });

  try {
    mc = mineflayer.createBot({
      host: ep.host,
      port: ep.port,
      username: MC_USER,
      version: MC_VERSION,
      viewDistance: 1
    });
  } catch (e) {
    mcLastError = "createBot failed: " + String(e?.message || e);
    console.log("[MC]", mcLastError);
    scheduleReconnect("createBot");
    connecting = false;
    return;
  }

  mc.on("login", () => {
    // глушим чанки, чтобы не падало
    disableChunkParsing(mc);

    mcOnline = true;
    mcReady = false;
    mcLastError = "";
    console.log("[MC] login");

    // ✅ Если spawn не приходит (лимбо/антибот), считаем готов по tab_complete
    setTimeout(async () => {
      if (!mc || mcReady || tabReady) return;
      try {
        const r = await tabComplete(mc, "/msg a");
        if (Array.isArray(r)) {
          tabReady = true;
          mcReady = true;
          console.log("[MC] READY via TAB_COMPLETE");
        }
      } catch {}
    }, 2500);
  });

  mc.on("spawn", () => {
    console.log("[MC] spawn");
    setTimeout(() => {
      if (mc && mc.entity) {
        mcReady = true;
        console.log("[MC] READY via SPAWN");
      } else {
        mcReady = false;
        scheduleReconnect("no-entity");
      }
    }, READY_AFTER_MS);
  });

  mc.on("messagestr", (msg) => {
    const m = String(msg).toLowerCase();
    if (MC_PASSWORD && !loginSent && m.includes("login")) {
      loginSent = true;
      setTimeout(() => mc?.chat?.(`/login ${MC_PASSWORD}`), 1500);
    }
    if (MC_PASSWORD && !registerSent && m.includes("register")) {
      registerSent = true;
      setTimeout(() => mc?.chat?.(`/register ${MC_PASSWORD} ${MC_PASSWORD}`), 1500);
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
    const msg = (e && (e.stack || e.message)) ? (e.stack || e.message) : String(e);
    onDisconnect("error: " + msg);
  });

  setTimeout(() => { connecting = false; }, 1200);
}

connectMC().catch((e) => console.log("[MC] connect error:", e?.message || e));

/* ================== SCAN HELPERS ================== */
function clean(s) { return String(s).replace(/[^A-Za-z0-9_]/g, ""); }

async function byPrefix(prefix) {
  const raw = await tabComplete(mc, `/msg ${prefix}`);
  const pref = clean(prefix).toLowerCase();
  return raw.map(clean).filter(n => n.length>=3 && n.length<=16 && n.toLowerCase().startsWith(pref));
}

function prefixes() {
  if (AUTO_PREFIXES) return AUTO_PREFIXES.split(",").map(x=>x.trim()).filter(Boolean);
  const a=[];
  for(let i=97;i<=122;i++) a.push(String.fromCharCode(i));
  for(let i=0;i<=9;i++) a.push(String(i));
  a.push("_");
  return a;
}

async function collect(ps) {
  if (!mcReady) throw new Error("MC_NOT_READY");
  const all = new Set();
  for (const p of ps) {
    if (!mcReady) throw new Error("MC_NOT_READY");
    try { (await byPrefix(p)).forEach(n=>all.add(n)); } catch {}
    await sleep(SCAN_DELAY_MS);
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
    if (!m) return { decision: "REVIEW", confidence: 0, reason: "AI не вернул JSON" };

    const data = JSON.parse(m[0]);
    const decision = String(data.decision || "REVIEW").toUpperCase();
    const confidence = Math.max(0, Math.min(1, Number(data.confidence || 0)));
    const reason = String(data.reason || "—").slice(0, 120);

    if (!["BAN","REVIEW","OK"].includes(decision)) return { decision: "REVIEW", confidence: 0, reason: "AI decision некорректный" };
    return { decision, confidence, reason };
  } catch {
    return { decision: "REVIEW", confidence: 0, reason: "Ошибка Gemini" };
  }
}

/* ================== LAST SCAN CACHE ================== */
let lastScan = null;
// { ts, names:[], reportText, reviewNicks:[] }

/* ================== BUTTONS MENU ================== */
function menuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔎 Скан всех (rules)", "scan_all")],
    [Markup.button.callback("🤖 AI по последнему скану", "ai_last")],
    [Markup.button.callback("🧪 AI один ник", "ai_one")],
    [Markup.button.callback("📊 Статус", "status"), Markup.button.callback("🔁 Reload rules", "reload_rules")]
  ]);
}

/* ================== COMMANDS (оставляем) ================== */
tg.start((c) => c.reply("Готов.\n/tab <префикс>\n/tabcheck <префикс>\n/scanall\n/status", menuKeyboard()));

tg.command("status", (c) => {
  let s = "❌ не в сети";
  if (mcOnline && mcReady) s="✅ на сервере (готов)";
  else if (mcOnline) s="🟡 подключён, но не готов";

  const ai = (AI_ENABLED && geminiModel) ? "✅ включён" : "❌ выключен";
  const last = lastScan ? `✅ есть (${Math.round((Date.now()-lastScan.ts)/1000)}с назад)` : "❌ нет";

  c.reply(
    `MC статус: ${s}\nНик: ${MC_USER}\nВерсия: ${MC_VERSION}\nAI (Gemini): ${ai}\nLast scan: ${last}\n${mcLastError||""}`,
    menuKeyboard()
  );
});

tg.command("tab", async (c) => {
  if (!mcReady) return c.reply("MC не готов", menuKeyboard());
  const a = c.message.text.split(" ").slice(1).join(" ");
  const n = [...new Set(await byPrefix(a))];
  let t = `Tab ${a}\nНайдено: ${n.length}\n\n`;
  n.forEach((x,i)=>t+=`${i+1}) ${x}\n`);
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

  lastScan = { ts: Date.now(), names: n, reportText: r.out, reviewNicks: r.reviewNicks };

  await sendChunksReply(c, r.out);
  await c.reply("Готово. Можешь нажать 🤖 AI по последнему скану", menuKeyboard());
});

/* ================== BUTTON HANDLERS ================== */
tg.action("status", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  return ctx.reply("📊\n" + (ctx.updateType ? "" : "") + `\n${""}${""}` + `${""}` + `${""}` + `${""}` + `${""}` + `${""}` , { disable_web_page_preview: true })
    .catch(async () => {
      // fallback
      await ctx.reply("📊 " + (ctx.updateType || ""), menuKeyboard());
    })
    .finally(async () => {
      let s = "❌ не в сети";
      if (mcOnline && mcReady) s="✅ на сервере (готов)";
      else if (mcOnline) s="🟡 подключён, но не готов";
      const ai = (AI_ENABLED && geminiModel) ? "✅ включён" : "❌ выключен";
      const last = lastScan ? `✅ есть (${Math.round((Date.now()-lastScan.ts)/1000)}с назад)` : "❌ нет";
      await ctx.reply(
        `MC статус: ${s}\nНик: ${MC_USER}\nВерсия: ${MC_VERSION}\nAI (Gemini): ${ai}\nLast scan: ${last}\n${mcLastError||""}`,
        menuKeyboard()
      );
    });
});

tg.action("reload_rules", async (ctx) => {
  try { await ctx.answerCbQuery("Reload…"); } catch {}
  try {
    reloadRules();
    await ctx.reply("✅ rules.json перезагружен", menuKeyboard());
  } catch (e) {
    await ctx.reply("❌ rules.json reload error: " + String(e?.message || e), menuKeyboard());
  }
});

tg.action("scan_all", async (ctx) => {
  try { await ctx.answerCbQuery("Scan…"); } catch {}
  if (!mcReady) return ctx.reply("MC не готов", menuKeyboard());
  await ctx.reply("🔎 Сканирую всех…", menuKeyboard());

  const n = await collect(prefixes());
  const r = report("Full scan (button)", n);

  lastScan = { ts: Date.now(), names: n, reportText: r.out, reviewNicks: r.reviewNicks };

  await sendChunksReply(ctx, r.out);
  await ctx.reply("Готово. Нажми 🤖 AI по последнему скану", menuKeyboard());
});

/* ====== AI LAST SCAN ====== */
tg.action("ai_last", async (ctx) => {
  try { await ctx.answerCbQuery("AI…"); } catch {}

  if (!lastScan) return ctx.reply("❌ Нет последнего скана. Сначала сделай /scanall или кнопку 🔎", menuKeyboard());
  if (!AI_ENABLED || !geminiModel) return ctx.reply("❌ AI выключен (нет GEMINI_API_KEY или AI_ENABLED=0)", menuKeyboard());

  const candidates = [...(lastScan.reviewNicks || [])];
  if (!candidates.length) {
    return ctx.reply("✅ В последнем скане нет REVIEW. AI нечего проверять.", menuKeyboard());
  }

  await ctx.reply(`🤖 AI проверяю REVIEW из последнего скана… (${candidates.length})`, menuKeyboard());

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

  let out = `🤖 AI RESULT (последний скан)\n\n`;
  out += `🚫 BAN: ${ban.length}\n`;
  out += `✅ OK: ${ok.length}\n`;
  out += `⚠️ REVIEW: ${review.length}\n\n`;

  if (ban.length) out += `🚫 BAN LIST:\n${ban.join("\n")}\n\n`;
  if (review.length) out += `⚠️ REVIEW LIST:\n${review.join("\n")}\n\n`;
  if (ok.length) out += `✅ OK LIST:\n${ok.join("\n")}\n\n`;

  await sendChunksReply(ctx, out);
  await ctx.reply("Меню:", menuKeyboard());
});

/* ====== AI ONE NICK (manual) ====== */
const awaitingNick = new Map(); // chatId -> userId

tg.action("ai_one", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  awaitingNick.set(ctx.chat.id, ctx.from.id);
  await ctx.reply("🧪 Отправь ник одним сообщением (только ник).", menuKeyboard());
});

tg.on("text", async (ctx) => {
  const uid = awaitingNick.get(ctx.chat.id);
  if (!uid || uid !== ctx.from.id) return;

  awaitingNick.delete(ctx.chat.id);

  const nick = String(ctx.message.text || "").trim();
  if (!nick) return ctx.reply("❌ Пусто. Пришли ник.", menuKeyboard());

  const [s, reasons] = checkNick(nick);
  const ai = await geminiReviewNick(nick);

  const out =
    `🔎 Ник: ${nick}\n` +
    `📜 Rules: ${s}${reasons?.length ? ` — ${reasons.join("; ")}` : ""}\n` +
    `🤖 AI: ${ai.decision} — ${ai.reason} (${Math.round(ai.confidence * 100)}%)\n` +
    `Нормализация: ${norm(nick)}`;

  await ctx.reply(out, menuKeyboard());
});

/* ================== AUTO SCAN (оставляем) ================== */
if (AUTO_SCAN) {
  setInterval(async () => {
    try {
      if (!mcReady) return;
      if (!CHAT_ID) return;

      const n = await collect(prefixes());
      const r = report("Auto scan", n);

      // сохраняем "последний скан" и с авто тоже
      lastScan = { ts: Date.now(), names: n, reportText: r.out, reviewNicks: r.reviewNicks };

      if (r.ban || r.rev) {
        let text = r.out;
        if (PING_USER_ID) text = `[\u2063](tg://user?id=${PING_USER_ID})` + "\n" + text;
        await sendChunksChat(tg, CHAT_ID, text);
      }
    } catch (e) {
      console.log("[AUTO] error:", String(e?.message || e));
    }
  }, AUTO_SCAN_MINUTES * 60 * 1000);
}

/* ================== START ================== */
(async () => {
  await launchTelegramSafely();
  console.log("TG bot started");
})();

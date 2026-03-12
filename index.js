import fs from "fs";
import path from "path";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { resolveSrv } from "dns/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PING_USER_ID = process.env.PING_USER_ID ? Number(process.env.PING_USER_ID) : null;
const PARTY_OWNER = (process.env.PARTY_OWNER || "").trim().toLowerCase();

let currentMode = (process.env.BOT_MODE || "moderation").trim().toLowerCase();
if (!["moderation", "helper"].includes(currentMode)) currentMode = "moderation";

// moderation connection
const MC_HOST = (process.env.MC_HOST || "").trim();
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = (process.env.MC_USER || "").trim();
const MC_PASSWORD = process.env.MC_PASSWORD || "";
const MC_VERSION = process.env.MC_VERSION || "1.8.9";

// helper connection
const HELPER_MC_HOST = (process.env.HELPER_MC_HOST || MC_HOST || "").trim();
const HELPER_MC_PORT = Number(process.env.HELPER_MC_PORT || MC_PORT || 25565);
const HELPER_MC_USER = (process.env.HELPER_MC_USER || MC_USER || "").trim();
const HELPER_MC_PASSWORD = process.env.HELPER_MC_PASSWORD || MC_PASSWORD || "";
const HELPER_MC_VERSION = process.env.HELPER_MC_VERSION || MC_VERSION || "1.8.9";

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);
const AUTO_PREFIXES = (process.env.AUTO_PREFIXES || "").trim();
const READY_AFTER_MS = Number(process.env.READY_AFTER_MS || 1500);

const HELPER_CHAT_BUFFER = Number(process.env.HELPER_CHAT_BUFFER || 40);
const HELPER_BRIDGE_NUMBER_DEFAULT = Math.min(4, Math.max(1, Number(process.env.HELPER_BRIDGE_NUMBER || 1)));
const HELPER_RULES_FILE = (process.env.HELPER_RULES_FILE || "helper-rules.json").trim();
const VIEWER_PORT = Number(process.env.VIEWER_PORT || 3007);
const HELPER_SCREENSHOT_WAIT_MS = Number(process.env.HELPER_SCREENSHOT_WAIT_MS || 3000);

// Gemini
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const AI_ENABLED = (process.env.AI_ENABLED || "1") === "1";
const AI_BUDGET_PER_CLICK = Number(process.env.AI_BUDGET_PER_CLICK || 30);
const AI_DELAY_MS = Number(process.env.AI_DELAY_MS || 350);
const AI_MIN_CONF_FOR_BAN = Number(process.env.AI_MIN_CONF_FOR_BAN || 0.75);
const AI_MIN_CONF_FOR_OK = Number(process.env.AI_MIN_CONF_FOR_OK || 0.75);

if (!BOT_TOKEN) throw new Error("Нужен BOT_TOKEN");
if (!MC_HOST || !MC_USER) throw new Error("Нужны MC_HOST и MC_USER");

/* ================== HELPERS ================== */
const tg = new Telegraf(BOT_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isHelperMode() {
  return currentMode === "helper";
}
function isModerationMode() {
  return currentMode === "moderation";
}

function stripColors(s = "") {
  return String(s).replace(/§./g, "");
}

function stripMcFormatting(s = "") {
  return String(s).replace(/§./g, "").trim();
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function splitText(t, max = 3500) {
  const parts = [];
  let buf = "";
  for (const line of String(t || "").split("\n")) {
    if ((buf + line + "\n").length > max) {
      if (buf.trim()) parts.push(buf);
      buf = "";
    }
    buf += line + "\n";
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

async function safeSend(chatId, text, extra) {
  try {
    await tg.telegram.sendMessage(chatId, text, extra);
    return true;
  } catch (e) {
    console.log("[TG] send error:", e?.message || e);
    return false;
  }
}

async function sendChunksReply(ctx, text, extra) {
  for (const p of splitText(text)) {
    if (p.trim()) await ctx.reply(p, extra);
  }
}

async function sendChunksChat(chatId, text, extra) {
  for (const p of splitText(text)) {
    if (!p.trim()) continue;
    const ok = await safeSend(chatId, p, extra);
    if (!ok) throw new Error("TG_SEND_FAILED");
  }
}

async function sendChunksChatHtml(chatId, html) {
  for (const p of splitText(html)) {
    if (!p.trim()) continue;
    const ok = await safeSend(chatId, p, { parse_mode: "HTML" });
    if (ok) continue;
    const fallback = p.replace(/<[^>]+>/g, "");
    const ok2 = await safeSend(chatId, fallback);
    if (!ok2) throw new Error("TG_SEND_FAILED");
  }
}

function mentionHtml(uid) {
  return uid ? `<a href="tg://user?id=${uid}">&#8203;</a>` : "";
}

tg.catch((err) => {
  console.log("⚠️ TG handler error:", err?.message || err);
});

/* ================== TG START SAFE ================== */
async function launchTelegramSafely() {
  while (true) {
    try {
      console.log("🤖 Telegram starting...");
      try {
        await tg.telegram.deleteWebhook({ drop_pending_updates: true });
      } catch {}
      await tg.launch({ dropPendingUpdates: true });
      console.log("✅ Telegram started");
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("409") || msg.includes("Conflict")) {
        console.log("⚠️ 409 Conflict — жду 15с...");
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
let HELPER_RULES = JSON.parse(fs.readFileSync(HELPER_RULES_FILE, "utf8"));

function reloadRules() {
  RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));
  rebuildNormalization();
}

function reloadHelperRules() {
  HELPER_RULES = JSON.parse(fs.readFileSync(HELPER_RULES_FILE, "utf8"));
}

/* ================== NORMALIZATION ================== */
const cyr = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "к": "k", "м": "m", "т": "t",
  "ё": "e", "в": "b", "н": "h"
};

let invisRe, sepRe, leetMap, collapseRepeats, maxRepeat;

function rebuildNormalization() {
  invisRe = new RegExp(
    RULES?.normalization?.strip_invisibles_regex || "[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]",
    "g"
  );
  sepRe = new RegExp(
    RULES?.normalization?.separators_regex || "[\\s\\-_.:,;|/\\\\~`'\"^*+=()\\[\\]{}<>]+",
    "g"
  );
  leetMap = RULES?.normalization?.leet_map || {
    "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "6": "b", "7": "t", "8": "b", "9": "g", "@": "a", "$": "s"
  };
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

/* ================== MODERATION CHECKER ================== */
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
    ban.forEach((x, i) => { out += `${i + 1}) ${x.nick} → ${x.r.join("; ")}\n`; });
    out += "\n";
  }

  if (rev.length) {
    out += `⚠️ REVIEW (${rev.length}):\n`;
    rev.forEach((x, i) => { out += `${i + 1}) ${x.nick} → ${x.r.join("; ")}\n`; });
    out += "\n";
  }

  if (!ban.length && !rev.length) {
    out += "✅ Некорректных ников не найдено.\n";
  }

  return {
    out,
    ban: ban.length,
    rev: rev.length,
    reviewNicks: rev.map(x => x.nick)
  };
}

/* ================== HELPER RULE CHECKER ================== */
function helperNorm(s = "") {
  return norm(s);
}

function detectBadWordInText(text) {
  const normalizedText = helperNorm(text);
  const banRules = HELPER_RULES?.ban_rules || [];
  const keywordRules = (HELPER_RULES?.keyword_rules || []).filter(r => String(r.id || "") !== "2.4");
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

function detectCapsViolation(text) {
  const src = String(text || "");
  const letters = src.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
  if (letters.length < 7) return null;

  const upper = letters.replace(/[^A-ZА-ЯЁ]/g, "");
  if (upper.length >= 7 || (letters.length > 0 && upper.length / letters.length >= 0.5)) {
    return {
      ruleId: "2.4",
      reason: "Caps Lock / верхний регистр",
      word: "CAPS"
    };
  }

  return null;
}

function detectRule211Violation(text) {
  const src = String(text || "");
  const low = src.toLowerCase();
  const cfg = HELPER_RULES?.rule_211 || {};

  if (cfg.enabled === false) return null;

  const patterns = Array.isArray(cfg.patterns) ? cfg.patterns : [];
  for (const rx of patterns) {
    try {
      const re = new RegExp(rx, "i");
      const m = src.match(re);
      if (!m) continue;
      return {
        ruleId: "2.11",
        reason: "Распространение личной информации",
        word: m[0] || "personal-info"
      };
    } catch {}
  }

  const contains = Array.isArray(cfg.contains) ? cfg.contains : [];
  for (const marker of contains) {
    if (marker && low.includes(String(marker).toLowerCase())) {
      return {
        ruleId: "2.11",
        reason: "Распространение личной информации",
        word: String(marker)
      };
    }
  }

  return null;
}

const floodHistory = Object.create(null);

function detectFlood(nick, message) {
  const now = Date.now();
  const key = String(nick || "").toLowerCase();
  const msg = String(message || "").trim().toLowerCase();
  if (!key || !msg) return null;

  if (!floodHistory[key]) floodHistory[key] = [];
  floodHistory[key].push({ msg, time: now });
  floodHistory[key] = floodHistory[key].filter(x => now - x.time < 12000);

  const same = floodHistory[key].filter(x => x.msg === msg);
  if (same.length >= 3) {
    return {
      ruleId: "2.3",
      reason: "Флуд / спам",
      word: message
    };
  }

  return null;
}

function detectChatViolation(text, nick) {
  return (
    detectRule211Violation(text) ||
    detectCapsViolation(text) ||
    detectFlood(nick, text) ||
    detectBadWordInText(text)
  );
}

/* ================== SRV ================== */
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

/* ================== ACTIVE CONFIG ================== */
function getActiveMcConfig() {
  if (isHelperMode()) {
    return {
      label: "helper",
      host: HELPER_MC_HOST,
      port: HELPER_MC_PORT,
      username: HELPER_MC_USER,
      password: HELPER_MC_PASSWORD,
      version: HELPER_MC_VERSION
    };
  }

  return {
    label: "moderation",
    host: MC_HOST,
    port: MC_PORT,
    username: MC_USER,
    password: MC_PASSWORD,
    version: MC_VERSION
  };
}

/* ================== PARTY CLICK HELPER ================== */
function extractClickCommandFromMessage(jsonMsg) {
  const commands = [];

  function walk(node) {
    if (!node) return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    if (typeof node === "object") {
      if (
        node.clickEvent &&
        node.clickEvent.action === "run_command" &&
        typeof node.clickEvent.value === "string"
      ) {
        commands.push(node.clickEvent.value);
      }

      if (node.extra) walk(node.extra);
      if (node.with) walk(node.with);

      for (const key of Object.keys(node)) {
        if (key !== "extra" && key !== "with" && key !== "clickEvent") {
          const value = node[key];
          if (typeof value === "object") walk(value);
        }
      }
    }
  }

  walk(jsonMsg);
  return commands;
}

/* ================== MC STATE ================== */
let mc = null;
let mcReady = false;
let tabReady = false;
let mcOnline = false;
let mcLastError = "";
let reconnectTimer = null;
let connecting = false;
let loginSent = false;
let registerSent = false;

let lastScan = null;
let autoScanRunning = false;
let autoScanLastRunTs = 0;
let autoScanLastResult = "not_started";
let autoScanLastError = "";

let helperChatLogs = [];
let helperScanAlerts = 0;
let helperBridgeNumber = HELPER_BRIDGE_NUMBER_DEFAULT;
let helperBridgeJoined = false;
let helperJoinInProgress = false;
let helperJoinTimer = null;
let helperJoinAttempts = 0;
let helperRecentAlerts = new Map();
let sidebarLines = [];
let helperInBridging = false;

let viewerStarted = false;
let viewerBotRef = null;

/* ================== SIDEBAR DETECT ================== */
function resetSidebarState() {
  sidebarLines = [];
  helperInBridging = false;
}

function updateHelperPresenceFromText(text = "") {
  const t = stripMcFormatting(text).toLowerCase();
  if (
    t.includes("bridging") ||
    t.includes("fastbridge") ||
    t.includes("bridge-") ||
    t.includes("bridge ")
  ) {
    helperInBridging = true;
  }
}

function helperLooksInBridging() {
  if (helperInBridging) return true;
  const joined = sidebarLines.join(" ").toLowerCase();
  return (
    joined.includes("bridging") ||
    joined.includes("fastbridge") ||
    joined.includes("bridge")
  );
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
      const matches = p?.matches?.map(x => typeof x === "string" ? x : (x.text || x.match || "")) || [];
      res(matches);
    };

    function cleanup() {
      clearTimeout(to);
      try { c.removeListener("tab_complete", on); } catch {}
      try { c.removeListener("tab_complete_response", on); } catch {}
    }

    c.once("tab_complete", on);
    c.once("tab_complete_response", on);

    try {
      c.write("tab_complete", {
        text,
        assumeCommand: true,
        lookedAtBlock: { x: 0, y: 0, z: 0 }
      });
    } catch (e) {
      cleanup();
      rej(e);
    }
  });
}

/* ================== SAFE CHUNK PARSE OFF ================== */
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

/* ================== HELPER CHAT BUFFER ================== */
function helperPushChatLine(line) {
  helperChatLogs.push(`[${new Date().toISOString()}] ${stripColors(line)}`);
  if (helperChatLogs.length > HELPER_CHAT_BUFFER) {
    helperChatLogs = helperChatLogs.slice(-HELPER_CHAT_BUFFER);
  }
}

function getHelperChatContext(limit = 12) {
  return helperChatLogs.slice(-limit).join("\n");
}

/* ================== REAL VIEWER + SCREENSHOT ================== */
async function startViewerIfNeeded() {
  if (!isHelperMode()) return;
  if (!mc) return;
  if (viewerStarted && viewerBotRef === mc) return;

  try {
    const mod = await import("prismarine-viewer");
    const viewerFn = mod?.mineflayer || mod?.default?.mineflayer || mod?.default;
    if (typeof viewerFn !== "function") {
      console.log("[HELPER] prismarine-viewer import failed");
      return;
    }

    viewerFn(mc, {
      port: VIEWER_PORT,
      firstPerson: true,
      viewDistance: 4
    });

    viewerStarted = true;
    viewerBotRef = mc;
    console.log(`[HELPER] prismarine-viewer started on :${VIEWER_PORT}`);
  } catch (e) {
    console.log("[HELPER] viewer start error:", e?.message || e);
  }
}

async function takeRealViewerScreenshot(outputPath = `helper-real-${Date.now()}.png`) {
  const mod = await import("playwright");
  const chromium = mod?.chromium;
  if (!chromium) throw new Error("PLAYWRIGHT_NOT_FOUND");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 }
    });

    await page.goto(`http://127.0.0.1:${VIEWER_PORT}`, {
      waitUntil: "networkidle",
      timeout: 20000
    });

    await page.waitForTimeout(HELPER_SCREENSHOT_WAIT_MS);

    await page.screenshot({
      path: outputPath,
      fullPage: false
    });

    return outputPath;
  } finally {
    await browser.close();
  }
}

/* ================== HELPER FASTBRIDGE ================== */
function helperExtractItemText(item) {
  if (!item) return "";
  const parts = [];
  if (item.displayName) parts.push(String(item.displayName));
  if (item.name) parts.push(String(item.name));
  try {
    const nbt = JSON.stringify(item.nbt || {});
    if (nbt) parts.push(nbt);
  } catch {}
  return parts.join(" ").toLowerCase();
}

function helperFindCompassInHotbar() {
  if (!mc?.inventory?.slots) return -1;

  for (let slot = 36; slot <= 44; slot++) {
    const item = mc.inventory.slots[slot];
    if (!item) continue;

    const txt = helperExtractItemText(item);
    const name = String(item.name || "").toLowerCase();

    console.log("[HELPER] hotbar slot", slot, "item:", name, txt);

    if (
      name.includes("compass") ||
      txt.includes("compass") ||
      txt.includes("компас") ||
      txt.includes("navigator") ||
      txt.includes("menu") ||
      txt.includes("сервер")
    ) {
      return slot;
    }
  }

  return -1;
}

async function helperUseCompass() {
  const hotbarSlot = helperFindCompassInHotbar();
  if (hotbarSlot === -1) throw new Error("COMPASS_NOT_FOUND");

  const quickBarIndex = hotbarSlot - 36;
  mc.setQuickBarSlot(quickBarIndex);
  await sleep(400);

  try { mc.activateItem(false); } catch {}
  await sleep(400);
  try { mc.activateItem(); } catch {}

  console.log("[HELPER] compass used from slot", hotbarSlot);
}

function stopHelperJoinLoop() {
  helperJoinInProgress = false;
  if (helperJoinTimer) {
    clearTimeout(helperJoinTimer);
    helperJoinTimer = null;
  }
}

function scheduleHelperJoinRetry(delay = 2500) {
  if (!isHelperMode()) return;
  if (helperBridgeJoined) return;
  if (helperJoinTimer) clearTimeout(helperJoinTimer);

  helperJoinTimer = setTimeout(() => {
    helperJoinTimer = null;
    helperTryJoinBridge().catch((e) => {
      console.log("[HELPER] retry join error:", e?.message || e);
    });
  }, delay);
}

async function helperTryJoinBridge() {
  if (!isHelperMode() || !mcReady || !mc) return;
  if (helperJoinInProgress) return;

  if (helperLooksInBridging()) {
    helperBridgeJoined = true;
    console.log("[HELPER] already in bridging");
    return;
  }

  helperJoinInProgress = true;
  helperJoinAttempts++;

  console.log("[HELPER] join attempt", helperJoinAttempts);

  const cleanup = () => {
    helperJoinInProgress = false;
    try { mc.removeListener("windowOpen", onWindowOpen); } catch {}
  };

  const success = () => {
    helperBridgeJoined = true;
    helperJoinAttempts = 0;
    cleanup();
    stopHelperJoinLoop();
    console.log("[HELPER] joined fastbridge");
  };

  const fail = () => {
    cleanup();
    helperBridgeJoined = false;
    console.log("[HELPER] join failed → retry");
    scheduleHelperJoinRetry(4000);
  };

  const onWindowOpen = async (window) => {
    try {
      const title = stripColors(window?.title || "");
      console.log("[HELPER] window:", title);

      if (window?.slots) {
        for (let i = 0; i < window.slots.length; i++) {
          const item = window.slots[i];
          if (!item) continue;
          console.log("[HELPER] slot", i, "item:", item.name, helperExtractItemText(item));
        }
      }

      if (title.toLowerCase().includes("меню") || title.toLowerCase().includes("game")) {
        console.log("[HELPER] clicking Bridging slot 13");
        await sleep(300);
        await mc.clickWindow(13, 0, 0);
        return;
      }

      if (title.toLowerCase().includes("bridging")) {
        const slotMap = { 1: 11, 2: 13, 3: 15, 4: 17 };
        const slot = slotMap[helperBridgeNumber] || 11;

        console.log("[HELPER] clicking fastbridge slot", slot);
        await sleep(300);
        await mc.clickWindow(slot, 0, 0);

        setTimeout(() => {
          if (helperLooksInBridging()) success();
          else fail();
        }, 2500);

        return;
      }
    } catch (e) {
      console.log("[HELPER] window error:", e?.message || e);
    }
  };

  mc.on("windowOpen", onWindowOpen);

  try {
    await sleep(2000);

    if (helperLooksInBridging()) {
      success();
      return;
    }

    const compass = helperFindCompassInHotbar();
    if (compass === -1) {
      console.log("[HELPER] compass not found");
      fail();
      return;
    }

    await helperUseCompass();

    setTimeout(() => {
      if (!helperLooksInBridging()) {
        try { mc.chat(`/bridge ${helperBridgeNumber}`); } catch {}
      }
    }, 5000);

    setTimeout(() => {
      if (helperLooksInBridging()) success();
      else fail();
    }, 9000);
  } catch (e) {
    console.log("[HELPER] join error:", e?.message || e);
    fail();
  }
}

/* ================== HELPER CHAT PARSE ================== */
function parseHelperChatMessage(rawLine = "") {
  const line = stripColors(rawLine).trim();
  if (!line) return null;

  let match = line.match(/^<([A-Za-z0-9_]{3,16})>\s+(.+)$/);
  if (match) return { nick: match[1], message: match[2], raw: line };

  match = line.match(/^\[[^\]]+\]\s*([A-Za-z0-9_]{3,16})\s*:\s*(.+)$/);
  if (match) return { nick: match[1], message: match[2], raw: line };

  match = line.match(/^([A-Za-z0-9_]{3,16})\s*:\s*(.+)$/);
  if (match) return { nick: match[1], message: match[2], raw: line };

  return null;
}

/* ================== HELPER ALERT ================== */
async function sendHelperAlert(nick, violation, messageText) {
  if (!CHAT_ID) return;

  const dedupKey = `${nick}|${violation.ruleId}|${messageText}`;
  const now = Date.now();
  const prev = helperRecentAlerts.get(dedupKey) || 0;
  if (now - prev < 10000) return;
  helperRecentAlerts.set(dedupKey, now);

  const text =
    `🚨 Обнаружено нарушение в helper mode\n\n` +
    `Ник: ${nick}\n` +
    `Правило: ${violation.reason} (${violation.ruleId})\n` +
    `Слово: ${violation.word}\n` +
    `Сообщение: ${messageText}\n` +
    `Bridge: ${helperBridgeNumber}`;

  await safeSend(CHAT_ID, text);

  try {
    const screenshotPath = await takeRealViewerScreenshot(
      path.resolve(`helper-real-${Date.now()}.png`)
    );

    await tg.telegram.sendPhoto(
      CHAT_ID,
      { source: screenshotPath },
      { caption: `Скрин от лица бота: ${nick}` }
    );

    try { fs.unlinkSync(screenshotPath); } catch {}
  } catch (e) {
    console.log("[HELPER] screenshot error:", e?.message || e);
    const context = getHelperChatContext(12);
    if (context) {
      await sendChunksChat(CHAT_ID, `⚠️ Скрин не удалось сделать.\n\nКонтекст чата:\n${context}`);
    }
  }

  helperScanAlerts += 1;
}

/* ================== RESET / RECONNECT ================== */
function resetMcStateForReconnect() {
  mcReady = false;
  tabReady = false;
  mcOnline = false;
  mcLastError = "";
  loginSent = false;
  registerSent = false;

  helperBridgeJoined = false;
  helperJoinInProgress = false;
  helperJoinAttempts = 0;
  if (helperJoinTimer) {
    clearTimeout(helperJoinTimer);
    helperJoinTimer = null;
  }

  resetSidebarState();

  if (isHelperMode()) {
    viewerStarted = false;
    viewerBotRef = null;
  }
}

function scheduleReconnect(reason) {
  console.log("[MC] reconnect scheduled:", reason);

  if (isHelperMode()) {
    const r = String(reason || "").toLowerCase();
    const hard = ["kicked", "socket", "timeout", "reset", "closed", "econnreset", "end", "disconnected"];
    const shouldReconnect = hard.some(x => r.includes(x));
    if (!shouldReconnect) {
      console.log("[HELPER] soft disconnect, skip reconnect");
      return;
    }
  }

  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMC().catch(() => {});
  }, 5000);
}

/* ================== CONNECT MC ================== */
async function connectMC() {
  if (connecting) return;
  connecting = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (mc) {
    try { mc.quit?.("reconnect"); } catch {}
    try { mc.end?.(); } catch {}
    try { mc._client?.end?.(); } catch {}
    mc = null;
  }

  resetMcStateForReconnect();

  const cfg = getActiveMcConfig();
  const ep = await resolveMcEndpoint(cfg.host, cfg.port);

  console.log("[MC DEBUG]", {
    mode: currentMode,
    inputHost: cfg.host,
    inputPort: cfg.port,
    resolvedHost: ep.host,
    resolvedPort: ep.port,
    via: ep.via,
    version: cfg.version,
    user: cfg.username
  });

  try {
    mc = mineflayer.createBot({
      host: ep.host,
      port: ep.port,
      username: cfg.username,
      version: cfg.version,
      viewDistance: 1
    });
  } catch (e) {
    mcLastError = "createBot failed: " + String(e?.message || e);
    console.log("[MC]", mcLastError);
    scheduleReconnect("createBot");
    connecting = false;
    return;
  }

  resetSidebarState();

  const client = mc._client;
  if (client) {
    client.on("scoreboard_objective", (packet) => {
      try {
        if (packet?.displayText) updateHelperPresenceFromText(packet.displayText);
        if (packet?.name) updateHelperPresenceFromText(packet.name);
      } catch {}
    });

    client.on("scoreboard_display_objective", () => {});

    client.on("scoreboard_score", (packet) => {
      try {
        if (packet?.itemName) {
          const text = stripMcFormatting(packet.itemName);
          if (text) {
            sidebarLines.push(text);
            if (sidebarLines.length > 30) sidebarLines = sidebarLines.slice(-30);
            updateHelperPresenceFromText(text);
          }
        }
      } catch {}
    });

    client.on("teams", (packet) => {
      try {
        if (packet?.prefix) updateHelperPresenceFromText(packet.prefix);
        if (packet?.suffix) updateHelperPresenceFromText(packet.suffix);
      } catch {}
    });

    client.on("chat", async (packet) => {
      try {
        const commands = extractClickCommandFromMessage(packet?.message);
        if (!commands.length) return;

        const rawText = stripColors(JSON.stringify(packet?.message || "")).toLowerCase();
        if (PARTY_OWNER && !rawText.includes(PARTY_OWNER)) return;

        for (const cmd of commands) {
          const low = String(cmd).toLowerCase();

          if (
            low.includes("/p accept") ||
            low.includes("/party accept") ||
            low.includes("party accept")
          ) {
            console.log("[PARTY] clickable accept found:", cmd);

            setTimeout(() => {
              try {
                mc.chat(cmd);
                console.log("[PARTY] accepted via clickable command:", cmd);
              } catch (e) {
                console.log("[PARTY] click command error:", e?.message || e);
              }
            }, 800);

            break;
          }
        }
      } catch (e) {
        console.log("[PARTY] chat parse error:", e?.message || e);
      }
    });
  }

  mc.on("login", () => {
    disableChunkParsing(mc);

    mcOnline = true;
    mcReady = false;
    tabReady = false;
    mcLastError = "";
    console.log("[MC] login");

    if (cfg.password) {
      setTimeout(() => {
        if (mc && mcOnline && !mcReady) {
          try {
            mc.chat(`/login ${cfg.password}`);
            console.log("[MC] Forced /login #1");
          } catch (e) {
            console.log("[MC] Forced /login #1 error:", e?.message || e);
          }
        }
      }, 2500);

      setTimeout(() => {
        if (mc && mcOnline && !mcReady) {
          try {
            mc.chat(`/login ${cfg.password}`);
            console.log("[MC] Forced /login #2");
          } catch (e) {
            console.log("[MC] Forced /login #2 error:", e?.message || e);
          }
        }
      }, 6000);
    }

    setTimeout(async () => {
      if (!mc || mcReady || tabReady) return;

      try {
        const r = await tabComplete(mc, "/msg a");
        if (Array.isArray(r)) {
          tabReady = true;
          mcReady = true;
          console.log("[MC] READY via TAB_COMPLETE");

          if (isHelperMode()) {
            await startViewerIfNeeded();
            setTimeout(() => helperTryJoinBridge().catch(() => {}), 5000);
            scheduleHelperJoinRetry(12000);
          }
        }
      } catch {}
    }, 3500);
  });

  mc.on("spawn", async () => {
    console.log("[MC] spawn");
    loginSent = false;
    registerSent = false;

    setTimeout(async () => {
      if (mc && mc.entity) {
        mcReady = true;
        tabReady = true;
        console.log("[MC] READY via SPAWN");

        if (isHelperMode()) {
          await startViewerIfNeeded();
          setTimeout(() => helperTryJoinBridge().catch(() => {}), 5000);
          scheduleHelperJoinRetry(12000);
        }
      } else {
        mcReady = false;
        scheduleReconnect("no-entity");
      }
    }, READY_AFTER_MS);
  });

  mc.on("messagestr", async (msg) => {
    const raw = String(msg);
    const m = raw.toLowerCase();
    const plain = stripColors(raw);

    console.log("[CHAT]", plain);
    helperPushChatLine(plain);
    updateHelperPresenceFromText(plain);

    if (isHelperMode()) {
      const low = plain.toLowerCase();

      if (
        low.includes("bridging") ||
        low.includes("fastbridge") ||
        low.includes("bridge-") ||
        low.includes("bridge ")
      ) {
        helperInBridging = true;
        helperBridgeJoined = true;
      }

      if (
        low.includes("лобби") ||
        low.includes("hub") ||
        low.includes("добро пожаловать")
      ) {
        if (!helperLooksInBridging()) {
          helperBridgeJoined = false;
          scheduleHelperJoinRetry(2500);
        }
      }
    }

    // clickable fallback via plain text
    const lowPlain = plain.toLowerCase();
    if (
      lowPlain.includes("пригласил вас в группу") ||
      lowPlain.includes("пригласил вас в пати") ||
      lowPlain.includes("invited you to a party")
    ) {
      if (!PARTY_OWNER || lowPlain.includes(PARTY_OWNER)) {
        setTimeout(() => {
          try {
            mc.chat("/p accept");
            console.log("[PARTY] accepted fallback via /p accept");
          } catch (e) {
            console.log("[PARTY] fallback accept error:", e?.message || e);
          }
        }, 1200);
      }
    }

    if (
      cfg.password &&
      !loginSent &&
      (
        m.includes("/login") ||
        m.includes("войдите") ||
        m.includes("авториз") ||
        m.includes("login:")
      )
    ) {
      loginSent = true;
      setTimeout(() => {
        try {
          mc?.chat?.(`/login ${cfg.password}`);
          console.log("[MC] Sent /login from chat trigger");
        } catch (e) {
          console.log("[MC] /login error:", e?.message || e);
        }
      }, 1500);
    }

    if (
      cfg.password &&
      !registerSent &&
      (
        m.includes("/register ") ||
        m.includes("/reg ") ||
        m.includes("зарегистрируйтесь") ||
        m.includes("введите /register")
      )
    ) {
      registerSent = true;
      setTimeout(() => {
        try {
          mc?.chat?.(`/register ${cfg.password} ${cfg.password}`);
          console.log("[MC] Sent /register");
        } catch (e) {
          console.log("[MC] /register error:", e?.message || e);
        }
      }, 1500);
    }

    if (isHelperMode()) {
      const parsed = parseHelperChatMessage(raw);
      if (!parsed) return;

      const violation = detectChatViolation(parsed.message, parsed.nick);
      if (!violation) return;

      try {
        await sendHelperAlert(parsed.nick, violation, parsed.message);
      } catch (e) {
        console.log("[HELPER] alert send error:", e?.message || e);
      }
    }
  });

  const onDisconnect = (reason) => {
    mcReady = false;
    tabReady = false;
    mcOnline = false;
    mcLastError = reason;
    loginSent = false;
    registerSent = false;
    helperBridgeJoined = false;
    console.log("[MC] disconnected FULL:", reason);
    scheduleReconnect(reason);
  };

  mc.on("end", () => onDisconnect("end"));
  mc.on("kicked", (r) => {
    console.log("[MC] kicked raw:", r);
    onDisconnect("kicked: " + String(r));
  });
  mc.on("error", (e) => {
    console.log("[MC] error raw:", e);
    const msg = (e && (e.stack || e.message)) ? (e.stack || e.message) : String(e);
    onDisconnect("error: " + msg);
  });

  setTimeout(() => {
    connecting = false;
  }, 1200);
}

/* ================== MODERATION SCAN ================== */
function clean(s) {
  return String(s).replace(/[^A-Za-z0-9_]/g, "");
}

async function byPrefix(prefix) {
  const raw = await tabComplete(mc, `/msg ${prefix}`);
  const pref = clean(prefix).toLowerCase();

  return raw
    .map(clean)
    .filter(n => n.length >= 3 && n.length <= 16 && n.toLowerCase().startsWith(pref));
}

function prefixes() {
  if (AUTO_PREFIXES) return AUTO_PREFIXES.split(",").map(x => x.trim()).filter(Boolean);

  const a = [];
  for (let i = 97; i <= 122; i++) a.push(String.fromCharCode(i));
  for (let i = 0; i <= 9; i++) a.push(String(i));
  a.push("_");
  return a;
}

async function collect(ps) {
  if (!mcReady) throw new Error("MC_NOT_READY");

  const all = new Set();
  for (const p of ps) {
    if (!mcReady) throw new Error("MC_NOT_READY");
    try {
      (await byPrefix(p)).forEach(n => all.add(n));
    } catch {}
    await sleep(SCAN_DELAY_MS);
  }

  return [...all];
}

/* ================== GEMINI ================== */
let geminiModel = null;
if (GEMINI_API_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  } catch (e) {
    console.log("[AI] init error:", e?.message || e);
  }
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

    if (!["BAN", "REVIEW", "OK"].includes(decision)) {
      return { decision: "REVIEW", confidence: 0, reason: "AI decision некорректный" };
    }

    return { decision, confidence, reason };
  } catch {
    return { decision: "REVIEW", confidence: 0, reason: "Ошибка Gemini" };
  }
}

/* ================== STATUS ================== */
function formatMcStatus() {
  if (mcOnline && mcReady) return "✅ на сервере (готов)";
  if (mcOnline) return "🟡 подключён, но не готов";
  return "❌ не в сети";
}

function formatAutoScanStatus() {
  if (!AUTO_SCAN) return "❌ выключен";
  if (!isModerationMode()) return "⏸ неактивен в helper mode";
  if (autoScanRunning) return "🔄 идёт скан";
  if (autoScanLastResult === "not_started") return "⏳ ещё не запускался";
  if (autoScanLastResult === "waiting_mc") return "⏳ ждёт готовности MC";
  if (autoScanLastResult === "missing_chat") return "❌ нет CHAT_ID";
  if (autoScanLastResult === "ok_no_hits") return "✅ последний проход без нарушений";
  if (autoScanLastResult === "ok_hits") return "⚠️ последний проход нашёл нарушения";
  if (autoScanLastResult === "error") return "❌ ошибка автоскана";
  return autoScanLastResult;
}

function getActiveServerLabel() {
  const cfg = getActiveMcConfig();
  return `${cfg.host}:${cfg.port}`;
}

function formatStatusText() {
  const ai = (AI_ENABLED && geminiModel) ? "✅ включён" : "❌ выключен";
  const last = lastScan ? `✅ есть (${Math.round((Date.now() - lastScan.ts) / 1000)}с назад)` : "❌ нет";
  const autoAge = autoScanLastRunTs ? `${Math.round((Date.now() - autoScanLastRunTs) / 1000)}с назад` : "ещё не запускался";

  const lines = [
    `Режим: ${currentMode}`,
    `MC статус: ${formatMcStatus()}`,
    `Сервер: ${getActiveServerLabel()}`,
    `Ник: ${getActiveMcConfig().username}`,
    `Версия: ${getActiveMcConfig().version}`,
    `AI (Gemini): ${ai}`,
    `Last scan: ${last}`,
    `Auto scan: ${formatAutoScanStatus()}`,
    `Auto scan last run: ${autoAge}`
  ];

  if (isHelperMode()) {
    lines.push(`Bridge: ${helperBridgeNumber}`);
    lines.push(`Алертов helper: ${helperScanAlerts}`);
    lines.push(`Буфер чата: ${helperChatLogs.length}/${HELPER_CHAT_BUFFER}`);
    lines.push(`Helper rules: ${HELPER_RULES_FILE}`);
    lines.push(`In Bridging: ${helperLooksInBridging() ? "✅ да" : "❌ нет"}`);
  }

  if (mcLastError) lines.push(`Причина: ${mcLastError}`);
  if (autoScanLastError) lines.push(`Auto scan error: ${autoScanLastError}`);

  return lines.join("\n");
}

/* ================== MODE SWITCH ================== */
async function switchMode(nextMode) {
  const mode = String(nextMode || "").toLowerCase();
  if (!["moderation", "helper"].includes(mode)) throw new Error("BAD_MODE");
  if (currentMode === mode) return false;

  currentMode = mode;
  helperBridgeJoined = false;
  helperChatLogs = [];
  helperRecentAlerts.clear();
  viewerStarted = false;
  viewerBotRef = null;

  await connectMC();
  return true;
}

/* ================== MENU ================== */
function menuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(currentMode === "helper" ? "✅ Helper mode" : "Helper mode", "mode_helper"),
      Markup.button.callback(currentMode === "moderation" ? "✅ Moder mode" : "Moder mode", "mode_moderation")
    ],
    [Markup.button.callback("🔎 Скан всех (rules)", "scan_all")],
    [Markup.button.callback("🤖 AI по последнему скану", "ai_last")],
    [Markup.button.callback("🧪 AI один ник", "ai_one")],
    [Markup.button.callback("📊 Статус", "status"), Markup.button.callback("🔁 Reload rules", "reload_rules")]
  ]);
}

/* ================== TG COMMANDS ================== */
const awaitingNick = new Map();

tg.start(async (c) => {
  await c.reply(
    "Готов.\n\n" +
    "Moder mode — скан ников.\n" +
    "Helper mode — чат + скрин.\n\n" +
    "Команды:\n" +
    "/status\n" +
    "/tab <префикс>\n" +
    "/tabcheck <префикс>\n" +
    "/scanall\n" +
    "/bridge 1|2|3|4\n" +
    "/reload_helper_rules",
    menuKeyboard()
  );
});

tg.command("status", async (c) => {
  await c.reply(formatStatusText(), menuKeyboard());
});

tg.command("tab", async (c) => {
  if (!isModerationMode()) return c.reply("Эта команда работает только в Moder mode.", menuKeyboard());
  if (!mcReady) return c.reply("MC не готов", menuKeyboard());

  const a = c.message.text.split(" ").slice(1).join(" ").trim();
  if (!a) return c.reply("Пример: /tab abc", menuKeyboard());

  const n = [...new Set(await byPrefix(a))];
  let t = `Tab ${a}\nНайдено: ${n.length}\n\n`;
  n.forEach((x, i) => { t += `${i + 1}) ${x}\n`; });

  await sendChunksReply(c, t);
  await c.reply("Меню:", menuKeyboard());
});

tg.command("tabcheck", async (c) => {
  if (!isModerationMode()) return c.reply("Эта команда работает только в Moder mode.", menuKeyboard());
  if (!mcReady) return c.reply("MC не готов", menuKeyboard());

  const a = c.message.text.split(" ").slice(1).join(" ").trim();
  if (!a) return c.reply("Пример: /tabcheck abc", menuKeyboard());

  const n = await byPrefix(a);
  await sendChunksReply(c, report(`Tabcheck ${a}`, n).out);
  await c.reply("Меню:", menuKeyboard());
});

tg.command("scanall", async (c) => {
  if (!isModerationMode()) return c.reply("Эта команда работает только в Moder mode.", menuKeyboard());
  if (!mcReady) return c.reply("MC не готов", menuKeyboard());

  await c.reply("Сканирую...", menuKeyboard());
  const n = await collect(prefixes());
  const r = report("Full scan", n);

  lastScan = { ts: Date.now(), names: n, reportText: r.out, reviewNicks: r.reviewNicks };

  await sendChunksReply(c, r.out);
  await c.reply("Готово. Можешь нажать 🤖 AI по последнему скану.", menuKeyboard());
});

tg.command("reload_helper_rules", async (c) => {
  try {
    reloadHelperRules();
    await c.reply(`✅ helper-rules.json перезагружен: ${HELPER_RULES_FILE}`, menuKeyboard());
  } catch (e) {
    await c.reply("❌ helper rules reload error: " + String(e?.message || e), menuKeyboard());
  }
});

tg.command("bridge", async (c) => {
  if (!isHelperMode()) return c.reply("Команда /bridge работает только в Helper mode.", menuKeyboard());

  const raw = String(c.message.text || "").split(" ").slice(1).join(" ").trim();
  const next = Number(raw);

  if (!Number.isInteger(next) || next < 1 || next > 4) {
    return c.reply("Используй: /bridge 1|2|3|4", menuKeyboard());
  }

  helperBridgeNumber = next;
  helperBridgeJoined = false;
  helperInBridging = false;
  await c.reply(`Ок, выбрал bridge ${helperBridgeNumber}. Пробую переключиться...`, menuKeyboard());
  await helperTryJoinBridge().catch(() => {});
});

/* ================== TG ACTIONS ================== */
tg.action("mode_helper", async (ctx) => {
  try { await ctx.answerCbQuery("Switching to Helper..."); } catch {}

  try {
    const changed = await switchMode("helper");
    await ctx.reply(
      changed ? "✅ Переключено в Helper mode.\nБот переподключается..." : "Helper mode уже активен.",
      menuKeyboard()
    );
  } catch (e) {
    await ctx.reply("❌ Ошибка переключения режима: " + String(e?.message || e), menuKeyboard());
  }
});

tg.action("mode_moderation", async (ctx) => {
  try { await ctx.answerCbQuery("Switching to Moder..."); } catch {}

  try {
    const changed = await switchMode("moderation");
    await ctx.reply(
      changed ? "✅ Переключено в Moder mode.\nБот переподключается..." : "Moder mode уже активен.",
      menuKeyboard()
    );
  } catch (e) {
    await ctx.reply("❌ Ошибка переключения режима: " + String(e?.message || e), menuKeyboard());
  }
});

tg.action("status", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  await ctx.reply(formatStatusText(), menuKeyboard());
});

tg.action("reload_rules", async (ctx) => {
  try { await ctx.answerCbQuery("Reload..."); } catch {}
  try {
    reloadRules();
    reloadHelperRules();
    await ctx.reply("✅ rules.json и helper-rules.json перезагружены", menuKeyboard());
  } catch (e) {
    await ctx.reply("❌ reload error: " + String(e?.message || e), menuKeyboard());
  }
});

tg.action("scan_all", async (ctx) => {
  try { await ctx.answerCbQuery("Scan..."); } catch {}

  if (!isModerationMode()) return ctx.reply("Эта кнопка работает только в Moder mode.", menuKeyboard());
  if (!mcReady) return ctx.reply("MC не готов", menuKeyboard());

  await ctx.reply("🔎 Сканирую всех...", menuKeyboard());

  const n = await collect(prefixes());
  const r = report("Full scan (button)", n);

  lastScan = { ts: Date.now(), names: n, reportText: r.out, reviewNicks: r.reviewNicks };

  await sendChunksReply(ctx, r.out);
  await ctx.reply("Готово. Нажми 🤖 AI по последнему скану.", menuKeyboard());
});

tg.action("ai_last", async (ctx) => {
  try { await ctx.answerCbQuery("AI..."); } catch {}

  if (!isModerationMode()) {
    return ctx.reply("AI по последнему скану работает только в Moder mode.", menuKeyboard());
  }

  if (!lastScan) {
    return ctx.reply("❌ Нет последнего скана. Сначала сделай /scanall или кнопку 🔎", menuKeyboard());
  }
  if (!AI_ENABLED || !geminiModel) {
    return ctx.reply("❌ AI выключен (нет GEMINI_API_KEY или AI_ENABLED=0)", menuKeyboard());
  }

  const candidates = [...(lastScan.reviewNicks || [])];
  if (!candidates.length) {
    return ctx.reply("✅ В последнем скане нет REVIEW. AI нечего проверять.", menuKeyboard());
  }

  await ctx.reply(`🤖 AI проверяю REVIEW из последнего скана... (${candidates.length})`, menuKeyboard());

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

tg.action("ai_one", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}

  if (!isModerationMode()) {
    return ctx.reply("AI один ник работает только в Moder mode.", menuKeyboard());
  }

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

/* ================== AUTO SCAN ================== */
async function runAutoScan(trigger = "timer") {
  if (!AUTO_SCAN) return;
  if (!isModerationMode()) return;
  if (autoScanRunning) return;

  if (!mcReady) {
    autoScanLastResult = "waiting_mc";
    return;
  }

  if (!CHAT_ID) {
    autoScanLastResult = "missing_chat";
    autoScanLastError = "CHAT_ID not set";
    return;
  }

  autoScanRunning = true;
  autoScanLastError = "";

  try {
    const n = await collect(prefixes());
    const r = report("Auto scan", n);

    lastScan = { ts: Date.now(), names: n, reportText: r.out, reviewNicks: r.reviewNicks };
    autoScanLastRunTs = Date.now();

    if (r.ban || r.rev) {
      if (PING_USER_ID) {
        const html = `${mentionHtml(PING_USER_ID)}\n<pre>${escapeHtml(r.out)}</pre>`;
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
  } finally {
    autoScanRunning = false;
  }
}

if (AUTO_SCAN) {
  setInterval(() => {
    runAutoScan("timer").catch(() => {});
  }, AUTO_SCAN_MINUTES * 60 * 1000);

  setTimeout(() => {
    runAutoScan("startup").catch(() => {});
  }, 15000);
}

/* ================== START ================== */
(async () => {
  await launchTelegramSafely();
  await connectMC();
  console.log("TG bot started");
})();

process.once("SIGINT", () => {
  try { tg.stop("SIGINT"); } catch {}
});
process.once("SIGTERM", () => {
  try { tg.stop("SIGTERM"); } catch {}
});

process.on("unhandledRejection", (reason) => {
  console.log("UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.log("UncaughtException:", err);
});

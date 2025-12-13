// server.js (ES module)
// Robust Gemini-backed chatbot server — FIXED role mapping (use 'user' or 'model' only)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import process from "process";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ---------- Config ----------
const START_PORT = Number(process.env.PORT) || 8000;
const GEMINI_KEY = process.env.GEMINI_API_KEY || null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-flash";
const MAX_HISTORY = Number(process.env.MAX_HISTORY) || 10; // exchanges (user+model)
const MAX_MESSAGE_CHARS = 20000;
const MAX_TOTAL_ENTRIES = MAX_HISTORY * 2;
const FETCH_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 150;

// ---------- In-memory store ----------
let chatHistory = []; // server memory: { role: 'user'|'model', parts:[{text}] }
const rateMap = new Map();

// ---------- Utilities ----------
function ruleBasedReply(userMessage) {
  const m = String(userMessage || "").toLowerCase().trim();
  if (!m) return "Say something and I'll reply 🙂";
  if (m.includes("hello") || m.includes("hi")) return "Hello! How can I help you today?";
  if (m.includes("help")) return "I can answer simple questions or act as a demo AI. Ask about weather, coding tips, or say 'projects' to learn about me.";
  if (m.includes("project") || m.includes("projects")) return "You can build a weather app, personal finance tracker, or an AI chatbot like this — great starter projects!";
  if (m.includes("github")) return "Check out my GitHub profile for projects: https://github.com/sagr12004";
  if (m.includes("thank") || m.includes("thanks")) return "You're welcome! Happy to help.";
  return "Sorry — I'm a demo. Try 'hello', 'projects', or 'help'.";
}

function trimServerHistory() {
  if (chatHistory.length > MAX_TOTAL_ENTRIES) {
    chatHistory = chatHistory.slice(-MAX_TOTAL_ENTRIES);
  }
}

function safeText(s) {
  if (!s) return "";
  const str = String(s);
  if (str.length > MAX_MESSAGE_CHARS) return str.slice(-MAX_MESSAGE_CHARS);
  return str;
}

function getClientIp(req) {
  return (req.headers["x-forwarded-for"] || req.ip || req.connection?.remoteAddress || "unknown").toString();
}

function checkRateLimit(ip) {
  const now = Date.now();
  const rec = rateMap.get(ip) || { count: 0, ts: now };
  if (now - rec.ts > RATE_LIMIT_WINDOW_MS) {
    rec.count = 0;
    rec.ts = now;
  }
  rec.count++;
  rateMap.set(ip, rec);
  return rec.count <= RATE_LIMIT_MAX;
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// Normalize client-sent history items to { role: 'user'|'model', content: '...' }
function normalizeClientItem(item) {
  if (!item || typeof item !== "object") return null;
  let roleRaw = (item.role || item.who || "").toString().toLowerCase();
  // Map common names to allowed roles: 'user' or 'model'
  if (roleRaw === "assistant" || roleRaw === "bot" || roleRaw === "model" || roleRaw === "system") {
    roleRaw = "model";
  } else {
    roleRaw = "user"; // default/fallback
  }

  let content = "";
  if (typeof item.content === "string") content = item.content;
  else if (typeof item.text === "string") content = item.text;
  else if (typeof item.message === "string") content = item.message;
  else content = String(item || "");

  content = content.trim();
  if (!content) return null;
  return { role: roleRaw, content: safeText(content) };
}

// ---------- Routes ----------

app.get("/ping", (req, res) => res.json({ ok: true, time: Date.now(), provider: GEMINI_KEY ? "gemini" : "fallback" }));

app.post("/api/chat", async (req, res) => {
  try {
    const ip = getClientIp(req);
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: "Rate limit exceeded. Try later." });
    }

    const { message, history: clientHistory } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'message' in request body." });
    }

    // Merge client history (normalize roles to 'user'|'model')
    if (Array.isArray(clientHistory) && clientHistory.length > 0) {
      const normalized = [];
      for (const it of clientHistory) {
        const n = normalizeClientItem(it);
        if (n) normalized.push(n);
      }
      for (const item of normalized) {
        const last = chatHistory.length ? chatHistory[chatHistory.length - 1] : null;
        const lastText = last?.parts?.[0]?.text ?? null;
        const lastRole = last?.role ?? null;
        if (!(lastText === item.content && lastRole === item.role)) {
          chatHistory.push({ role: item.role === "model" ? "model" : "user", parts: [{ text: item.content }] });
        }
      }
    }

    // Add the new user message (role 'user')
    chatHistory.push({ role: "user", parts: [{ text: safeText(message) }] });
    trimServerHistory();

    // If no Gemini key, fallback
    if (!GEMINI_KEY) {
      const reply = ruleBasedReply(message);
      chatHistory.push({ role: "model", parts: [{ text: reply }] });
      trimServerHistory();
      return res.json({ reply, provider: "fallback" });
    }

    // Build contents payload — ensure roles are 'user' or 'model'
    const contents = chatHistory.map(it => {
      const roleOut = (it.role === "model") ? "model" : "user";
      const text = safeText(it.parts?.[0]?.text ?? "");
      return { role: roleOut, parts: [{ text }] };
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;

    // Retry loop for transient errors
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const payload = { contents };
        const resp = await fetchWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }, FETCH_TIMEOUT_MS);

        let data;
        try { data = await resp.json(); } catch (e) { data = null; }

        if (!resp.ok) {
          const status = resp.status;
          const msg = data?.error?.message || (data ? JSON.stringify(data) : `HTTP ${status}`);
          lastError = { status, msg, raw: data };

          const retryConditions = status === 429 || status === 503 || /overload|temporar/i.test(msg);
          if (retryConditions && attempt < MAX_RETRIES - 1) {
            const backoff = 800 * (2 ** attempt);
            console.warn(`Gemini transient error (attempt ${attempt+1}): ${msg}. Retrying in ${backoff}ms.`);
            await wait(backoff);
            continue;
          } else {
            console.error("Gemini API returned error:", status, msg);
            return res.status(500).json({ error: msg, provider: "gemini", raw: data });
          }
        }

        const replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
        if (!replyText) {
          lastError = { status: resp.status, msg: "No reply text in response", raw: data };
          if (attempt < MAX_RETRIES - 1) {
            await wait(800 * (2 ** attempt));
            continue;
          } else {
            return res.status(500).json({ error: "No reply from Gemini", provider: "gemini", raw: data });
          }
        }

        const reply = String(replyText);
        chatHistory.push({ role: "model", parts: [{ text: safeText(reply) }] });
        trimServerHistory();
        return res.json({ reply, provider: "gemini" });

      } catch (err) {
        lastError = { msg: err.message || String(err) };
        const isAbort = err.name === "AbortError";
        const shouldRetry = !isAbort || attempt < MAX_RETRIES - 1;
        if (shouldRetry && attempt < MAX_RETRIES - 1) {
          const backoff = 800 * (2 ** attempt);
          console.warn(`Fetch error (attempt ${attempt+1}): ${err.message}. Retrying in ${backoff}ms.`);
          await wait(backoff);
          continue;
        } else {
          console.error("Fetch error calling Gemini:", err);
          break;
        }
      }
    }

    // All retries failed — fallback
    console.warn("All Gemini retries failed. Returning fallback reply.", lastError);
    const fallback = ruleBasedReply(message);
    chatHistory.push({ role: "model", parts: [{ text: fallback }] });
    trimServerHistory();
    return res.json({ reply: fallback, provider: "fallback", error: lastError });

  } catch (err) {
    console.error("Server /api/chat exception:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// ---------- Start server ----------
const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
  console.log(
    `AI Chatbot server running on port ${PORT} — ${
      GEMINI_KEY ? "Gemini key detected" : "Gemini key NOT set"
    }`
  );
});

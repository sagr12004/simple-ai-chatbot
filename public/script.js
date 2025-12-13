/* -----------------------
  UTILS & ELEMENTS
------------------------*/
const docReady = () => document.readyState === "complete" || document.readyState === "interactive";

const bootScreen = document.getElementById("boot-screen");
const canvas = document.getElementById("matrix");
const cursor = document.getElementById("cursor-trail");

const headerEl = document.querySelector(".creator-header");
const footerEl = document.querySelector(".creator-footer");
const orbContainer = document.querySelector(".ai-orb-container");
const chatWrapper = document.querySelector(".chat-wrapper");

const form = document.getElementById("chat-form");
const input = document.getElementById("input");
const messagesEl = document.getElementById("messages");
const providerEl = document.getElementById("provider");
const micBtn = document.getElementById("micBtn");
const voiceToggleBtn = document.getElementById("voiceToggleBtn");
const exportPdfBtn = document.getElementById("exportPdfBtn");
const clearBtn = document.getElementById("clearBtn");
const voiceInfo = document.getElementById("voiceInfo");

/* -----------------------
  MATRIX BACKGROUND
------------------------*/
const ctx = canvas.getContext("2d");
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  cols = Math.floor(canvas.width / fontSize);
  drops.length = cols;
  for (let i = 0; i < cols; i++) drops[i] = Math.random() * canvas.height / fontSize;
}
let fontSize = 16;
let cols = Math.floor(window.innerWidth / fontSize);
let drops = Array(Math.floor(cols)).fill(0);
const chars = "アカサタナハ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function drawMatrix() {
  ctx.fillStyle = "rgba(0,0,0,0.09)";
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = "#00ff41";
  ctx.font = fontSize + "px monospace";

  for (let i = 0; i < drops.length; i++) {
    const text = chars[Math.floor(Math.random() * chars.length)];
    ctx.fillText(text, i * fontSize, drops[i] * fontSize);
    if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
    drops[i]++;
  }
}
let matrixInterval = setInterval(drawMatrix, 50);
window.addEventListener("resize", () => {
  resizeCanvas();
});
resizeCanvas();

/* -----------------------
  CURSOR TRAIL
------------------------*/
document.addEventListener("mousemove", e => {
  cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
});

/* -----------------------
  BOOT SEQUENCE -> reveal UI
------------------------*/
setTimeout(() => {
  bootScreen.style.display = "none";
  headerEl.classList.remove("hidden");
  footerEl.classList.remove("hidden");
  orbContainer.classList.remove("hidden");
  chatWrapper.classList.remove("hidden");
}, 4200);

/* -----------------------
  CHAT STORAGE + RENDER
------------------------*/
let localHistoryKey = "chat_full_history_v2";
let localHistory = JSON.parse(localStorage.getItem(localHistoryKey) || "[]");

function escapeHtml(t) {
  if (!t) return "";
  return String(t).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c]));
}

function renderMessage(text, who="assistant", provider=null, opts={}) {
  const el = document.createElement("div");
  el.className = "msg " + (who === "user" ? "user" : "assistant");
  el.innerHTML = `<div class="content">${escapeHtml(text)}</div>` + (provider && who !== "user" ? `<div class="meta">provider: ${escapeHtml(provider)}</div>` : "");
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  if (opts.speak && voiceOutputEnabled) speakText(text);
  return el;
}

function saveLocal(who, text, provider) {
  localHistory.push({ who, text, provider, t: Date.now() });
  if (localHistory.length > 500) localHistory = localHistory.slice(-500);
  localStorage.setItem(localHistoryKey, JSON.stringify(localHistory));
}

function loadHistory() {
  if (!localHistory || localHistory.length === 0) {
    const greet = "Hello! I'm online and ready to help.";
    renderMessage(greet, "assistant", "system");
    saveLocal("assistant", greet, "system");
    providerEl.textContent = "system";
    return;
  }
  localHistory.forEach(m => {
    renderMessage(m.text, m.who, m.provider);
    if (m.provider) providerEl.textContent = m.provider;
  });
}
loadHistory();

/* -----------------------
  SERVER HISTORY BUILDER
------------------------*/
function buildHistoryForServer() {
  const max = 60;
  const slice = localHistory.slice(-max);
  return slice.map(it => {
    return { role: it.who === "user" ? "user" : "assistant", content: it.text };
  });
}

/* -----------------------
  TTS (voice output)
------------------------*/
let voiceOutputEnabled = false;
let selectedVoice = null;
function updateVoiceInfo() {
  if (!("speechSynthesis" in window)) {
    voiceInfo.textContent = "Speech synthesis not supported in this browser.";
    return;
  }
  const voices = speechSynthesis.getVoices();
  selectedVoice = voices.find(v => v.lang.startsWith("en")) || voices[0] || null;
  voiceInfo.textContent = voiceOutputEnabled ? `Voice output ON (${selectedVoice ? selectedVoice.name : "default"})` : "Voice output OFF";
}
voiceToggleBtn.addEventListener("click", () => {
  if (!("speechSynthesis" in window)) {
    voiceInfo.textContent = "Speech synthesis not supported in this browser.";
    return;
  }
  voiceOutputEnabled = !voiceOutputEnabled;
  updateVoiceInfo();
});
if ("speechSynthesis" in window) {
  // some browsers load voices asynchronously
  window.speechSynthesis.onvoiceschanged = updateVoiceInfo;
  setTimeout(updateVoiceInfo, 500);
} else {
  voiceInfo.textContent = "Speech synthesis not supported";
}

function speakText(text) {
  if (!voiceOutputEnabled || !("speechSynthesis" in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    if (selectedVoice) u.voice = selectedVoice;
    u.rate = 1;
    u.pitch = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch (e) {
    console.warn("TTS error:", e);
  }
}

/* -----------------------
  STT (voice input)
------------------------*/
let recognition = null;
let recognizing = false;
if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.lang = "en-IN";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    recognizing = true;
    micBtn.classList.add("recording");
    micBtn.textContent = "●"; // recording indicator
    voiceInfo.textContent = "Listening...";
  };

  recognition.onend = () => {
    recognizing = false;
    micBtn.classList.remove("recording");
    micBtn.textContent = "🎤";
    voiceInfo.textContent = voiceOutputEnabled ? `Voice output ON (${selectedVoice ? selectedVoice.name : "default"})` : "Voice output OFF";
  };

  recognition.onresult = (ev) => {
    const text = ev.results[0][0].transcript;
    input.value = text;
    // auto-submit on recognition
    setTimeout(() => {
      if (input.value.trim()) {
        form.requestSubmit();
      }
    }, 250);
  };

  recognition.onerror = (e) => {
    recognizing = false;
    micBtn.classList.remove("recording");
    micBtn.textContent = "🎤";
    voiceInfo.textContent = `Speech error: ${e.error || e.message || "unknown"}`;
  };

} else {
  // not supported
  micBtn.title = "Speech recognition not supported";
  micBtn.disabled = false; // we keep enabled so user can see message
}

micBtn.addEventListener("click", () => {
  if (!recognition) {
    voiceInfo.textContent = "Speech recognition not supported in this browser.";
    return;
  }
  if (recognizing) {
    recognition.stop();
  } else {
    recognition.start();
  }
});

/* -----------------------
  SEND MESSAGE -> server
------------------------*/
async function sendMessage(text) {
  renderMessage(text, "user");
  saveLocal("user", text, null);
  input.value = "";

  // show typing bubble
  const typingEl = document.createElement("div");
  typingEl.className = "msg assistant typing";
  typingEl.innerHTML = `<div class="dots"><span></span><span></span><span></span></div>`;
  messagesEl.appendChild(typingEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const resp = await fetch("https://sagar-ai-chatbot-backend.onrender.com/api/chat", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ message: text, history: buildHistoryForServer() })
    });

    const data = await resp.json();
    typingEl.remove();

    if (!resp.ok) {
      renderMessage("Error: " + (data.error || "server error"), "assistant", "error");
      saveLocal("assistant", "Error: " + (data.error || "server error"), "error");
      providerEl.textContent = "error";
      return;
    }

    renderMessage(data.reply, "assistant", data.provider, { speak:true });
    saveLocal("assistant", data.reply, data.provider);
    providerEl.textContent = data.provider || "gemini";
  } catch (err) {
    typingEl.remove();
    renderMessage("Network error: " + err.message, "assistant", "error");
    saveLocal("assistant", "Network error: " + err.message, "error");
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const txt = input.value.trim();
  if (!txt) return;
  sendMessage(txt);
});

/* -----------------------
  CLEAR CHAT
------------------------*/
clearBtn.addEventListener("click", () => {
  localHistory = [];
  localStorage.removeItem(localHistoryKey);
  messagesEl.innerHTML = "";
  renderMessage("Chat cleared.", "assistant", "system");
});

/* -----------------------
  EXPORT TO PDF (jsPDF)
------------------------*/
exportPdfBtn.addEventListener("click", async () => {
  try {
    // wait for jsPDF to load
    if (!window.jspdf) {
      voiceInfo.textContent = "PDF library not loaded.";
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const left = 40;
    let y = 40;
    doc.setFont("Courier", "normal");
    doc.setFontSize(12);
    doc.setTextColor(10,200,255);

    doc.text("Chat export — Sagar's AI Chatbot", left, y);
    y += 20;
    doc.setTextColor(200,240,255);
    doc.setFontSize(10);

    // iterate messages
    const linesPerPage = 45;
    let lineCount = 0;
    for (const msg of localHistory) {
      const date = new Date(msg.t || Date.now());
      const ts = date.toLocaleString();
      const header = `${msg.who === "user" ? "You" : "Assistant"} [${ts}]:`;
      const content = String(msg.text || "");
      const wrapped = doc.splitTextToSize(content, 500);
      doc.setFontSize(9);
      doc.setTextColor(120,210,255);
      doc.text(header, left, y);
      y += 14;
      doc.setTextColor(220,240,255);
      const startY = y;
      doc.text(wrapped, left + 12, y);
      y += wrapped.length * 12 + 10;
      lineCount += wrapped.length + 2;
      if (lineCount > linesPerPage) {
        doc.addPage();
        y = 40;
        lineCount = 0;
      }
    }

    const filename = `chat_export_${new Date().toISOString().replace(/[:.]/g,"-")}.pdf`;
    doc.save(filename);
    voiceInfo.textContent = `Saved ${filename}`;
  } catch (e) {
    console.error("PDF export error:", e);
    voiceInfo.textContent = "Failed to export PDF.";
  }
});

/* -----------------------
  INIT: on load, update voice list and UI
------------------------*/
window.addEventListener("load", () => {
  // update voice info
  if ("speechSynthesis" in window) {
    speechSynthesis.onvoiceschanged = () => {
      const voices = speechSynthesis.getVoices();
      // pick english voice if possible
      const en = voices.find(v => v.lang.startsWith("en")) || voices[0];
      if (en) {
        // set selectedVoice on outer scope
      }
      updateVoiceInfoUI();
    };
  } else {
    voiceInfo.textContent = "TTS not supported";
  }
});

function updateVoiceInfoUI() {
  if (!("speechSynthesis" in window)) return;
  const voices = speechSynthesis.getVoices();
  const v = voices.find(v => v.lang.startsWith("en")) || voices[0];
  if (v) {
    voiceInfo.textContent = voiceOutputEnabled ? `Voice ON (${v.name})` : "Voice OFF";
  } else {
    voiceInfo.textContent = voiceOutputEnabled ? "Voice ON" : "Voice OFF";
  }
}

// ensure voices are available for initial run
setTimeout(updateVoiceInfoUI, 800);

/* -----------------------
  Accessibility: allow Enter to send
------------------------*/
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

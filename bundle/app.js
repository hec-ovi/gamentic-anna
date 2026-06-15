import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";
import { askAnna } from "./core.js";

const status = document.getElementById("status");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const replyEl = document.getElementById("reply");

let anna = null;
try {
  anna = await AnnaAppRuntime.connect();
  status.textContent = "Connected to Anna";
  await anna.window.set_title({ title: "Gamentic" });
  sendBtn.disabled = false;
} catch (e) {
  status.textContent = "Preview mode (run via anna-app dev)";
}

async function ask() {
  const text = promptEl.value.trim();
  if (!text || !anna) return;
  sendBtn.disabled = true;
  replyEl.textContent = "Anna is thinking...";
  try {
    replyEl.textContent = await askAnna(anna, text);
  } catch (e) {
    replyEl.textContent = "Error: " + (e?.code || e?.message || String(e));
  } finally {
    sendBtn.disabled = false;
  }
}

sendBtn.addEventListener("click", ask);
promptEl.addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });

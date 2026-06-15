import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";

const status = document.getElementById("status");

try {
  const anna = await AnnaAppRuntime.connect();
  status.textContent = "Connected to Anna";
  await anna.window.set_title({ title: "Gamentic" });
} catch (e) {
  status.textContent = "Preview mode (run via anna-app dev)";
}

#!/usr/bin/env node
const { writeFileSync, readFileSync, existsSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const args = process.argv.slice(2),
  prompt = args.at(-1);
function emit(text) {
  console.log(JSON.stringify({ type: "text", sessionID: "ses_test", part: { text } }));
}
if (args[0] === "--version") console.log(process.env.PROBE_VERSION || "opencode v2.1.4");
else if (args[0] === "models") {
  if (process.env.PROBE_DISCOVERY_MARKER) writeFileSync(process.env.PROBE_DISCOVERY_MARKER, "started");
  if (process.env.PROBE_MODELS_HANG) setInterval(() => {}, 1000);
  else
    setTimeout(
      () => console.log(existsSync("models.txt") ? readFileSync("models.txt", "utf8") : "test/model"),
      Number(process.env.PROBE_MODELS_DELAY || 0),
    );
} else if (args[0] === "session") emit(JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD }));
else if (prompt === "capture")
  emit(JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD, args, content: process.env.OPENCODE_CONFIG_CONTENT }));
else if (prompt === "modify-existing") {
  writeFileSync("tracked.txt", "after");
  emit("done");
} else if (prompt === "write-marker") {
  writeFileSync("marker", "executed");
  emit("done");
} else if (prompt === "commit") {
  writeFileSync("committed.txt", "new");
  spawnSync("git", ["add", "committed.txt"]);
  spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "delegate"]);
  emit("committed");
} else if (prompt === "hang") {
  emit("running");
  setInterval(() => {}, 1000);
} else if (prompt === "tree") {
  process.on("SIGINT", () => {});
  const child = spawn(
    process.execPath,
    ["-e", 'process.on("SIGINT",()=>{}); setTimeout(()=>require("node:fs").writeFileSync("descendant-marker","bad"),800)'],
    { stdio: "ignore" },
  );
  emit(String(child.pid));
  setInterval(() => {}, 1000);
} else if (prompt === "huge") process.stdout.write("x".repeat(2 * 1024 * 1024));
else if (prompt === "empty") {
} else if (prompt === "unknown-only") console.log(JSON.stringify({ type: "future-output", sessionID: "ses_test", part: { text: "lost" } }));
else if (prompt === "plain") console.log("plain output");
else if (prompt === "null") console.log("null");
else emit("ok");

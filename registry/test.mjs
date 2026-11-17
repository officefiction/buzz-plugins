// Tests for the registry: auth, validation, persistence across a restart.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
// got/want, so a wrong value can never pass as truthy
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`);
};
const checkTrue = (name, ok, detail = "") => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};

const TOKEN = "test-token-abc123";
const dir = await mkdtemp(join(tmpdir(), "meet-rooms-"));
const dataFile = join(dir, "rooms.json");
const port = 8802;
const base = `http://127.0.0.1:${port}`;

function start() {
  const child = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, REGISTRY_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 8000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(`  [server] ${chunk}`));
  });
}

const stop = (child) =>
  new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const put = (id, body) => fetch(`${base}/rooms/${id}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
const del = (id) => fetch(`${base}/rooms/${id}`, { method: "DELETE", headers: auth });

let server = await start();

// --- health and auth -------------------------------------------------------
check("health needs no token", (await fetch(`${base}/health`)).status, 200);
check("health says ok", (await (await fetch(`${base}/health`)).json()).ok, true);
check("a room with no token is refused", (await fetch(`${base}/rooms/abc`)).status, 401);
check(
  "a wrong token is refused",
  (await fetch(`${base}/rooms/abc`, { headers: { authorization: "Bearer nope" } })).status,
  401,
);
check(
  "a token that merely extends the real one is refused",
  (await fetch(`${base}/rooms/abc`, { headers: { authorization: `Bearer ${TOKEN}x` } })).status,
  401,
);
check("a token with no Bearer prefix is refused", (await fetch(`${base}/rooms/abc`, { headers: { authorization: TOKEN } })).status, 401);
check("the right token is accepted", (await fetch(`${base}/rooms/abc`, { headers: auth })).status, 404);

// --- create, read, replace -------------------------------------------------
const uri = "https://meet.google.com/abc-defg-hij";
const created = await put("0c86306c-room", { uri, code: "abc-defg-hij" });
check("a new room is created with 201", created.status, 201);
const room = await created.json();
check("the room keeps its uri", room.uri, uri);
check("the room keeps its code", room.code, "abc-defg-hij");
checkTrue("the room carries createdAt", typeof room.createdAt === "string" && room.createdAt.includes("T"));

check("the room reads back", (await fetch(`${base}/rooms/0c86306c-room`, { headers: auth })).status, 200);
check("the read matches", (await (await fetch(`${base}/rooms/0c86306c-room`, { headers: auth })).json()).uri, uri);

const updated = await put("0c86306c-room", { uri: "https://meet.google.com/xyz-1234-abc", code: "xyz-1234-abc" });
check("a repeat write replaces with 200", updated.status, 200);
const updatedRoom = await updated.json();
check("createdAt survives the update", updatedRoom.createdAt, room.createdAt);
check("uri updated", updatedRoom.uri, "https://meet.google.com/xyz-1234-abc");

// --- validation ------------------------------------------------------------
check("a non-Meet uri is refused", (await put("chan1", { uri: "https://example.com/x", code: "abc-defg-hij" })).status, 400);
check("an http uri is refused", (await put("chan1", { uri: "http://meet.google.com/abc-defg-hij", code: "abc-defg-hij" })).status, 400);
check("a missing code is refused", (await put("chan1", { uri })).status, 400);
check("an empty code is refused", (await put("chan1", { uri, code: "" })).status, 400);
check(
  "malformed JSON is refused",
  (await fetch(`${base}/rooms/chan1`, { method: "PUT", headers: auth, body: "{not json" })).status,
  400,
);
check("an oversized body is refused", (await put("chan1", { uri, code: "a".repeat(9000) })).status, 413);
check("a refused write stored nothing", (await fetch(`${base}/rooms/chan1`, { headers: auth })).status, 404);
check("a channel id containing a slash is rejected", (await fetch(`${base}/rooms/a/b`, { headers: auth })).status, 400);

const listed = await (await fetch(`${base}/rooms`, { headers: auth })).json();
check("the list counts rooms", listed.count, 1);
checkTrue("the list holds the room", Boolean(listed.rooms["0c86306c-room"]));
check("an unknown method is refused", (await fetch(`${base}/rooms/x`, { method: "POST", headers: auth })).status, 405);

// --- persistence -----------------------------------------------------------
await stop(server);
const onDisk = JSON.parse(await readFile(dataFile, "utf8"));
check("the store holds one room on disk", Object.keys(onDisk.rooms).length, 1);
check("the file is versioned", onDisk.version, 1);

server = await start();
check("the room survives a restart", (await fetch(`${base}/rooms/0c86306c-room`, { headers: auth })).status, 200);
check(
  "the room's uri survives a restart",
  (await (await fetch(`${base}/rooms/0c86306c-room`, { headers: auth })).json()).uri,
  "https://meet.google.com/xyz-1234-abc",
);

// --- delete ----------------------------------------------------------------
check("delete reports the room existed", (await (await del("0c86306c-room")).json()).deleted, true);
check("the room is gone", (await fetch(`${base}/rooms/0c86306c-room`, { headers: auth })).status, 404);
check("deleting again reports nothing to delete", (await (await del("0c86306c-room")).json()).deleted, false);
check("the store is empty after deletion", (await (await fetch(`${base}/rooms`, { headers: auth })).json()).count, 0);

await stop(server);
await rm(dir, { recursive: true, force: true });

console.log(fail === 0 ? "\nALL CHECKS PASSED" : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);

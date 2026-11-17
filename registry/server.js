// Meet rooms — a tiny shared registry so every Buzz client maps a channel to
// the same Google Meet space.
//
// The Buzz plugin API cannot write to the relay, so the mapping lives here
// instead. One bearer token, plain files, no dependencies.
//
//   GET    /health          -> { ok: true }
//   GET    /rooms           -> { rooms: { [channelId]: Room }, count }
//   GET    /rooms/:id       -> Room            | 404
//   PUT    /rooms/:id       -> Room   body { uri, code }  | 400
//   DELETE /rooms/:id       -> { deleted: boolean }
//
// Room = { uri, code, createdAt, updatedAt }

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_FILE = process.env.DATA_FILE ?? "/data/rooms.json";
const TOKEN = process.env.REGISTRY_TOKEN ?? "";
const MAX_BODY = 4096;

if (!TOKEN) {
  console.error("REGISTRY_TOKEN is not set; refusing to start");
  process.exit(1);
}

const CHANNEL_ID = /^[A-Za-z0-9._:@-]{1,120}$/;
const MEET_URI = /^https:\/\/meet\.google\.com\/[a-z0-9-]{5,}$/i;
const MEET_CODE = /^[a-z0-9-]{3,40}$/i;

/** The whole store: { version, rooms }. Held in memory, written through. */
let store = { version: 1, rooms: {} };
let writing = Promise.resolve();

async function load() {
  try {
    const text = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.rooms && typeof parsed.rooms === "object") {
      store = { version: 1, rooms: parsed.rooms };
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("could not read the store, starting empty:", error.message);
    }
  }
}

/** Serialised write-through: temp file then rename, so a reader never sees half a file. */
function save() {
  writing = writing.then(async () => {
    const temp = `${DATA_FILE}.${process.pid}.tmp`;
    await mkdir(dirname(DATA_FILE), { recursive: true });
    await writeFile(temp, JSON.stringify(store, null, 2), "utf8");
    await rename(temp, DATA_FILE);
  });
  return writing.catch((error) => {
    console.error("could not save:", error.message);
  });
}

function authorised(header) {
  const value = String(header ?? "");
  const presented = value.startsWith("Bearer ") ? value.slice(7) : "";
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  // timingSafeEqual refuses different lengths, so compare lengths first.
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (tooLarge) {
        // Keep draining so the client can finish writing and read the 413.
        // Past a hard bound, stop being polite.
        if (size > MAX_BODY * 1000) req.destroy();
        return;
      }
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        reject(new Error("too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (!tooLarge) reject(error);
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/health") {
    send(res, 200, { ok: true });
    return;
  }

  if (!authorised(req.headers.authorization)) {
    send(res, 401, { error: "unauthorised" });
    return;
  }

  // /rooms and /rooms/<id>
  const match = /^\/rooms(?:\/(.+))?$/.exec(path);
  if (!match) {
    send(res, 404, { error: "no such route" });
    return;
  }
  const rawId = match[1] ? decodeURIComponent(match[1]) : undefined;
  if (rawId !== undefined && !CHANNEL_ID.test(rawId)) {
    send(res, 400, { error: "channel id is not usable" });
    return;
  }

  try {
    if (req.method === "GET" && rawId === undefined) {
      send(res, 200, { rooms: store.rooms, count: Object.keys(store.rooms).length });
      return;
    }

    if (req.method === "GET") {
      const room = store.rooms[rawId];
      if (!room) {
        send(res, 404, { error: "no room for that channel" });
        return;
      }
      send(res, 200, room);
      return;
    }

    if (req.method === "PUT") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        send(res, error.message === "too large" ? 413 : 400, { error: "body must be JSON under 4 KiB" });
        return;
      }
      const uri = typeof body?.uri === "string" ? body.uri.trim() : "";
      const code = typeof body?.code === "string" ? body.code.trim() : "";
      if (!MEET_URI.test(uri)) {
        send(res, 400, { error: "uri must be a https://meet.google.com/ link" });
        return;
      }
      if (!MEET_CODE.test(code)) {
        send(res, 400, { error: "code is not usable" });
        return;
      }
      const now = new Date().toISOString();
      const existing = store.rooms[rawId];
      const room = {
        uri,
        code,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      store.rooms[rawId] = room;
      await save();
      send(res, existing ? 200 : 201, room);
      return;
    }

    if (req.method === "DELETE") {
      const existed = Boolean(store.rooms[rawId]);
      if (existed) {
        delete store.rooms[rawId];
        await save();
      }
      send(res, 200, { deleted: existed });
      return;
    }

    res.writeHead(405, { allow: "GET, PUT, DELETE" });
    res.end();
  } catch (error) {
    console.error("request failed:", error.message);
    send(res, 500, { error: "internal" });
  }
});

await load();
server.listen(PORT, () => {
  console.log(`meet-rooms listening on ${PORT}, ${Object.keys(store.rooms).length} room(s) in ${DATA_FILE}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

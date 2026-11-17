import { createRegistry, REGISTRY_ORIGIN } from "./plugin.js";

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`);
};

// A host that records what it was asked and answers with a scripted response.
function fakeHost(responses) {
  const calls = [];
  return {
    calls,
    async request(options) {
      calls.push(options);
      const next = responses.shift();
      if (!next) throw new Error("unexpected request: " + options.url);
      return { status: next.status, headers: {}, body: typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {}) };
    },
  };
}

const vaultWith = (value) => ({ read: () => value });

const room = { uri: "https://meet.google.com/abc-defg-hij", code: "abc-defg-hij", createdAt: "2026-11-17T00:00:00Z", updatedAt: "2026-11-17T00:00:00Z" };

// --- not configured --------------------------------------------------------
{
  const host = fakeHost([]);
  const registry = createRegistry({ host, vault: vaultWith({}) });
  check("no token means not configured", registry.configured(), false);
  let threw = null;
  try {
    await registry.getRoom("chan");
  } catch (error) {
    threw = error.message;
  }
  check("no token refuses before any request", threw, "no-registry-token");
  check("no request was made", host.calls.length, 0);
}

// --- reading ---------------------------------------------------------------
{
  const host = fakeHost([{ status: 200, body: room }]);
  const registry = createRegistry({ host, vault: vaultWith({ registryToken: "tok" }) });
  check("configured with a token", registry.configured(), true);
  check("a room is read back", await registry.getRoom("chan"), room);
  check("it asks the declared origin", host.calls[0].url, `${REGISTRY_ORIGIN}/rooms/chan`);
  check("it sends the bearer token", host.calls[0].headers.Authorization, "Bearer tok");
  check("a GET by default", host.calls[0].method, undefined);
}

{
  const host = fakeHost([{ status: 404, body: { error: "none" } }]);
  const registry = createRegistry({ host, vault: vaultWith({ registryToken: "tok" }) });
  check("404 means no room, not an error", await registry.getRoom("chan"), null);
}

for (const status of [401, 403]) {
  const host = fakeHost([{ status, body: { error: "no" } }]);
  const registry = createRegistry({ host, vault: vaultWith({ registryToken: "tok" }) });
  let threw = null;
  try {
    await registry.getRoom("chan");
  } catch (error) {
    threw = error.message;
  }
  check(`${status} reports a token problem`, threw, "registry-token");
}

{
  const host = fakeHost([{ status: 500, body: {} }]);
  const registry = createRegistry({ host, vault: vaultWith({ registryToken: "tok" }) });
  let threw = null;
  try {
    await registry.getRoom("chan");
  } catch (error) {
    threw = error.message;
  }
  check("500 reports an unreachable registry", threw, "registry");
}

// --- writing --------------------------------------------------------------
{
  const host = fakeHost([{ status: 201, body: room }]);
  const registry = createRegistry({ host, vault: vaultWith({ registryToken: "tok" }) });
  check("a created room comes back", await registry.putRoom("chan", { uri: room.uri, code: room.code }), room);
  check("it PUTs", host.calls[0].method, "PUT");
  check("it sends JSON", host.calls[0].headers["Content-Type"], "application/json");
  check("the body carries uri and code", JSON.parse(host.calls[0].body), { uri: room.uri, code: room.code });
}

{
  const host = fakeHost([{ status: 200, body: room }]);
  const registry = createRegistry({ host, vault: vaultWith({ registryToken: "tok" }) });
  check("a replaced room also counts", (await registry.putRoom("chan", { uri: room.uri, code: room.code })).code, "abc-defg-hij");
}

{
  const host = fakeHost([{ status: 400, body: { error: "bad" } }]);
  const registry = createRegistry({ host, vault: vaultWith({ registryToken: "tok" }) });
  let threw = null;
  try {
    await registry.putRoom("chan", { uri: "https://example.com", code: "abc" });
  } catch (error) {
    threw = error.message;
  }
  check("a rejected write is an error", threw, "registry");
}

// --- forgetting -----------------------------------------------------------
{
  const host = fakeHost([{ status: 200, body: { deleted: true } }]);
  const registry = createRegistry({ host, vault: vaultWith({ registryToken: "tok" }) });
  check("forget reports success", await registry.forgetRoom("chan"), true);
  check("it DELETEs", host.calls[0].method, "DELETE");
}

// --- the channel id is escaped -------------------------------------------
{
  const host = fakeHost([{ status: 404, body: {} }]);
  const registry = createRegistry({ host, vault: vaultWith({ registryToken: "tok" }) });
  await registry.getRoom("dm:abc/../x");
  check(
    "a channel id is URL encoded",
    host.calls[0].url,
    `${REGISTRY_ORIGIN}/rooms/dm%3Aabc%2F..%2Fx`,
  );
}

// --- the origin matches the manifest -------------------------------------
{
  const manifest = JSON.parse(
    await (await import("node:fs/promises")).readFile(new URL("./manifest.json", import.meta.url), "utf8"),
  );
  check("the registry origin is declared in the manifest", manifest.host.networkOrigins.includes(REGISTRY_ORIGIN), true);
}

console.log(fail === 0 ? "\nALL CHECKS PASSED" : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);

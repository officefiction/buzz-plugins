import { createVault } from "./plugin.js";

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`);
};

// A stand-in for the credential store, which holds exactly one string.
function fakeStore(initial) {
  let value = initial;
  return {
    get ready() {
      return Promise.resolve();
    },
    read: () => value,
    place: () => (value ? "keychain" : undefined),
    store: () => "keychain",
    subscribe: () => () => {},
    async save(next) {
      value = next;
      return { kept: true, degraded: false };
    },
    async clear() {
      value = undefined;
      return true;
    },
    raw: () => value,
  };
}

const store = fakeStore(undefined);
const vault = createVault(store);

check("empty store reads as empty object", vault.read(), {});

await vault.write({ ical: "https://calendar.google.com/calendar/ical/x/basic.ics" });
check("first write stored", JSON.parse(store.raw()).ical, "https://calendar.google.com/calendar/ical/x/basic.ics");

await vault.write({ refreshToken: "1//rt" });
check("second write merges", vault.read(), {
  ical: "https://calendar.google.com/calendar/ical/x/basic.ics",
  refreshToken: "1//rt",
});

await vault.write({ verifier: "abc" });
check("three keys at once", Object.keys(vault.read()).sort(), ["ical", "refreshToken", "verifier"]);

await vault.write({ verifier: undefined });
check("undefined removes the key", Object.keys(vault.read()).sort(), ["ical", "refreshToken"]);

// A store holding something that is not JSON must not throw on every render.
const broken = createVault(fakeStore("not json at all"));
check("corrupt store reads as empty", broken.read(), {});

const arrayStore = createVault(fakeStore('["a","b"]'));
check("a non-object reads as empty", arrayStore.read(), {});

const notSaving = createVault({
  get ready() {
    return Promise.resolve();
  },
  read: () => undefined,
  place: () => undefined,
  store: () => undefined,
  subscribe: () => () => {},
  async save() {
    return { kept: false, degraded: false };
  },
  async clear() {
    return false;
  },
});
check("a refused save is reported, not swallowed", (await notSaving.write({ ical: "x" })).kept, false);

console.log(fail === 0 ? "\nALL CHECKS PASSED" : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);

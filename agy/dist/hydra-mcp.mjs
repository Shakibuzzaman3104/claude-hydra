// agy/main.ts
import { resolve as resolve3 } from "node:path";

// agy/runtime.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
var RUN_DEFAULT_MS = 3e4;
var RUN_MAX_MS = 6e5;
var JsonFile = class {
  constructor(path) {
    this.path = path;
    this.values = existsSync(path) ? JSON.parse(readFileSync(path, "utf8") || "{}") : {};
  }
  values;
  has = (key) => Object.prototype.hasOwnProperty.call(this.values, key);
  get = (key) => this.values[key];
  keys = () => Object.keys(this.values);
  set(key, value) {
    this.values[key] = value;
    this.save();
  }
  delete(key) {
    delete this.values[key];
    this.save();
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.values));
    renameSync(temp, this.path);
  }
};
var kindOf = (entry) => entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other";
var runProcess = (argv, init = {}) => new Promise((done, fail) => {
  const child = spawn(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env ?? {} } });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    fail(new Error(`timed out: ${argv[0]}`));
  }, Math.min(init.timeoutMs ?? RUN_DEFAULT_MS, RUN_MAX_MS));
  child.stdout.on("data", (chunk) => stdout += chunk);
  child.stderr.on("data", (chunk) => stderr += chunk);
  child.on("error", (error) => {
    clearTimeout(timer);
    fail(error);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    done({ exitCode: code ?? 1, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false });
  });
  child.stdin.on("error", () => void 0);
  child.stdin.end(init.stdin ?? "");
});
var spawnProcess = (request) => {
  const child = spawn(request.argv[0], request.argv.slice(1), { cwd: request.cwd, env: { ...process.env, ...request.env ?? {} } });
  const chunks = [];
  let wake;
  let isClosed = false;
  const push = (chunk) => {
    chunks.push(chunk);
    wake?.();
  };
  const result = new Promise((done, fail) => {
    child.on("error", (error) => {
      isClosed = true;
      wake?.();
      fail(error);
    });
    child.on("close", (code, signal) => {
      isClosed = true;
      wake?.();
      done({ code, ...signal ? { signal } : {} });
    });
  });
  result.catch(() => void 0);
  child.stdout.on("data", (data) => push({ stream: "stdout", text: String(data) }));
  child.stderr.on("data", (data) => push({ stream: "stderr", text: String(data) }));
  child.stdin.on("error", () => void 0);
  child.stdin.end(request.input ?? "");
  return {
    result,
    async next() {
      for (; ; ) {
        if (chunks.length > 0) return { done: false, value: chunks.shift() };
        if (isClosed) return { done: true, value: await result.catch(() => ({ code: null })) };
        await new Promise((resume) => wake = resume);
      }
    },
    async return(value) {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3e3).unref();
      return { done: true, value };
    }
  };
};
function createRuntime(options) {
  const store = new JsonFile(resolve(options.dataDir, "store.json"));
  const states = /* @__PURE__ */ new Map();
  const stateOf = () => {
    const id = options.sessionId();
    let file = states.get(id);
    if (!file) states.set(id, file = new JsonFile(resolve(options.dataDir, "sessions", id.replace(/[^\w.-]/g, "_"), "state.json")));
    return file;
  };
  return {
    state: { has: (key) => stateOf().has(key), get: (key) => stateOf().get(key), set: (key, value) => stateOf().set(key, value) },
    plugin: { root: options.pluginRoot },
    session: { id: async () => options.sessionId(), root: async () => options.workspace, surfaces: async () => [] },
    env: { get: async (name) => process.env[name] },
    clock: {
      now: async () => Date.now(),
      sleep: (ms, sleepOptions = {}) => new Promise((done, fail) => {
        const timer = setTimeout(done, ms);
        sleepOptions.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          fail(new Error("aborted"));
        }, { once: true });
      })
    },
    store: {
      get: async (key) => store.get(key),
      set: async (key, value) => store.set(key, value),
      delete: async (key) => store.delete(key),
      keys: async () => store.keys()
    },
    ui: {
      ask: (question, askOptions) => options.ask(question, askOptions),
      toast: () => void 0,
      status: () => void 0,
      log: () => void 0,
      invalidate: () => void 0,
      resolve: async () => void 0
    },
    fs: {
      exists: async (path) => existsSync(path),
      read: async (path, readOptions) => readOptions?.as === "bytes" ? { base64: (await readFile(path)).toString("base64") } : readFile(path, "utf8"),
      write: async (path, text) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text);
      },
      list: async (path = options.workspace) => Promise.all((await readdir(path, { withFileTypes: true })).map(async (entry) => {
        const own = entry.isFile() ? await lstat(resolve(path, entry.name)) : void 0;
        return { name: entry.name, kind: kindOf(entry), size: own?.size ?? 0, mtimeMs: own?.mtimeMs ?? 0, isLink: entry.isSymbolicLink() };
      })),
      stat: async (path, statOptions) => {
        const [own, target] = [await lstat(path), await stat(path)];
        return { kind: kindOf(target), size: target.size, mtimeMs: target.mtimeMs, isLink: own.isSymbolicLink(), ...statOptions?.resolve ? { realPath: await realpath(path) } : {} };
      }
    },
    process: { run: runProcess, spawn: spawnProcess }
  };
}

// agy/server.ts
import { homedir } from "node:os";
import { dirname as dirname2, resolve as resolve2 } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// hooks/lib/engines.ts
var ENGINES = ["commandcode", "codebuddy", "codex", "agy", "workbuddy", "opencode"];
var DEFAULT_ENGINE = "commandcode";
var AGY_MODELS = {
  "gemini-4-hydrogen": { levels: ["low", "medium", "high", "xhigh"], pool: "gemini" },
  "gemini-4-neon": { levels: ["low", "medium", "high", "xhigh"], pool: "gemini" },
  "gemini-4-carbon": { levels: ["low", "medium", "high"], pool: "gemini" },
  "gemini-3.8-flash": { levels: ["low", "medium", "high"], pool: "gemini", leaving: "2026-11-30", successor: "gemini-4-hydrogen" },
  "gemini-4-argon": { levels: ["low", "medium", "high"], pool: "gemini", leaving: "2026-11-30", successor: "gemini-4-neon" },
  "claude-sonnet-5-5": { levels: ["low", "medium", "high"], pool: "claude" },
  "claude-opus-5-5": { levels: ["low", "medium", "high"], pool: "claude" },
  "gpt-oss-120b": { levels: ["medium"], pool: "claude", leaving: "2026-11-30", successor: "claude-sonnet-5-5" }
};
var AGY_POOL_LABEL = { gemini: "Gemini models", argon: "Gemini 4 Argon", claude: "Claude + GPT-OSS" };
var AGY_MODEL = "gemini-4-hydrogen";
var agyBaseOf = (model) => {
  const base = model.replace(/^google\//i, "").replace(/-(low|medium|high|xhigh)$/i, "").toLowerCase();
  return Object.hasOwn(AGY_MODELS, base) ? base : void 0;
};
var agyCurrentModel = (model, now) => {
  const base = agyBaseOf(model) ?? AGY_MODEL;
  const spec = AGY_MODELS[base];
  return spec.leaving && spec.successor && now >= Date.parse(`${spec.leaving}T00:00:00Z`) ? spec.successor : base;
};
var agyModelId = (model, effort) => {
  const base = agyBaseOf(model) ?? AGY_MODEL;
  const levels = AGY_MODELS[base].levels;
  const order = ["low", "medium", "high", "xhigh"];
  const wanted = !effort || effort === "off" || effort === "auto" ? "low" : effort === "max" ? "xhigh" : effort;
  const level = order.slice(0, order.indexOf(wanted) + 1).reverse().find((each) => levels.includes(each)) ?? levels[0];
  return `${base}-${level}`;
};
var agyPoolOf = (model) => AGY_MODELS[agyBaseOf(model) ?? AGY_MODEL].pool;
var AGY_ALTERNATES = {
  "gemini-4-hydrogen": ["claude-sonnet-5-5"],
  "gemini-4-neon": ["claude-sonnet-5-5"],
  "gemini-4-carbon": ["claude-sonnet-5-5"],
  "gemini-3.8-flash": ["claude-sonnet-5-5"],
  "gemini-4-argon": ["claude-sonnet-5-5"],
  "claude-sonnet-5-5": ["gemini-4-neon", "gemini-4-hydrogen"],
  "claude-opus-5-5": ["gemini-4-neon", "gemini-4-carbon"],
  "gpt-oss-120b": ["gemini-4-hydrogen"]
};
var AGY_TOKEN = ".gemini/antigravity-cli/antigravity-oauth-token";
var isEngine = (value) => typeof value === "string" && ENGINES.includes(value);
var ENGINE_LABEL = { commandcode: "Command Code", codebuddy: "CodeBuddy", codex: "Codex", agy: "Antigravity", workbuddy: "WorkBuddy", opencode: "OpenCode" };
var ENGINE_BIN = { commandcode: "commandcode", codebuddy: "codebuddy", codex: "codex", agy: "agy", workbuddy: "codebuddy", opencode: "opencode" };
var OPENCODE_MODEL = "opencode/deepseek-v4.1-flash-free";
var WORKBUDDY_CONFIG = ".claude/hydra/workbuddy-cli";
var WORKBUDDY_PRODUCT = ".workbuddy-ai/cache/acc-product-config-v3.json";
var workbuddyEnv = (home, configDir) => ({
  CODEBUDDY_CONFIG_DIR: configDir ?? `${home}/${WORKBUDDY_CONFIG}`,
  ACC_PRODUCT_CONFIG_PATH: `${home}/${WORKBUDDY_PRODUCT}`,
  CODEBUDDY_DISABLE_AUTO_MEMORY: "1",
  CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1",
  CODEBUDDY_PROMPT_SUGGESTION_DISABLED: "1",
  CODEBUDDY_DISABLE_CRON: "1",
  CODEBUDDY_DISABLE_IDE: "1",
  CODEBUDDY_DISABLE_BROWSER_MCP: "1"
});
var ENGINE_MODEL = { codex: "gpt-6.1-terra", agy: AGY_MODEL, workbuddy: "deepseek-v4.1-flash", opencode: OPENCODE_MODEL };
var MODEL_FAMILY = { codex: /^(openai\/)?(gpt(?!-oss)|o\d|codex)/i, agy: /^(google\/)?gemini/i };
var OPENCODE_ID = /^(?!deepseek\/)[a-z0-9][\w.-]*\/\S+$/i;
var OPENCODE_ONLY = /^opencode\//i;
var BUDDY_MODELS = [
  "deepseek-v4.1-flash",
  "glm-5.3",
  "kimi-k3",
  "minimax-m3.1-flash",
  "glm-5.3-flash",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gemini-3.5-flash",
  "hy4-preview",
  "hy3",
  "glm-5.2",
  "kimi-k2.6",
  "kimi-k2.8-preview",
  "default-model",
  "fast-model",
  "balanced-model",
  "primary-model"
];
var BUDDY_ALTERNATES = ["glm-5.3", "kimi-k3", "deepseek-v4.1-flash", "minimax-m3.1-flash"];
var isBuddy = (engine) => engine === "codebuddy" || engine === "workbuddy";
var isModelFor = (engine, model) => {
  if (engine === "opencode") return OPENCODE_ID.test(model);
  if (engine === "agy") return agyBaseOf(model) !== void 0;
  if (isBuddy(engine) && BUDDY_MODELS.includes(modelFor(engine, model).toLowerCase())) return true;
  const family = MODEL_FAMILY[engine];
  return family ? family.test(model) : !OPENCODE_ONLY.test(model) && agyBaseOf(model) === void 0 && !Object.values(MODEL_FAMILY).some((other) => other.test(model));
};
var headModelFor = (engine, requested, current, configured) => requested ?? (isModelFor(engine, current) ? current : ENGINE_MODEL[engine] ?? (isModelFor(engine, configured) ? configured : current));
var engineOf = (hydra, fallback = DEFAULT_ENGINE) => isEngine(hydra?.engine) ? hydra.engine : fallback;
var AUTO = "auto";
var isAuto = (hydra) => hydra?.engine === AUTO;
var poolOf = (hydra) => {
  const stored = new Set((hydra?.engines ?? []).filter(isEngine));
  return stored.size > 0 ? ENGINES.filter((engine) => stored.has(engine)) : [...ENGINES];
};
var engineLabel = (hydra, fallback = DEFAULT_ENGINE) => isAuto(hydra) ? `Auto (${poolOf(hydra).map((engine) => ENGINE_LABEL[engine]).join(" + ")})` : ENGINE_LABEL[engineOf(hydra, fallback)];
var parseEngineList = (text) => {
  const names = [...new Set(text.toLowerCase().split(/[\s,+]+/).filter(Boolean))];
  return { engines: names.filter(isEngine), bad: names.filter((name) => !isEngine(name)) };
};
var resolveHeadEngine = (hydra, requested, fallback = DEFAULT_ENGINE) => {
  const pool = poolOf(hydra);
  const allowed = isAuto(hydra) && hydra?.pinned ? pool : [...ENGINES];
  if (requested !== void 0 && !isEngine(requested)) return { deny: `engine must be one of: ${allowed.join(", ")}.` };
  if (!isAuto(hydra)) {
    const engine = engineOf(hydra, fallback);
    return requested === void 0 || requested === engine ? { engine, isNew: false } : { engine: requested, isNew: true };
  }
  if (requested === void 0) return { deny: `Auto mode: name the engine for this Head in \`engine\` (${pool.join(", ")}).` };
  if (pool.includes(requested)) return { engine: requested, isNew: false };
  if (hydra?.pinned) return { deny: `${requested} is not in the engines the person chose (${pool.join(", ")}). They add it with /hydra engines=\u2026` };
  return { engine: requested, isNew: true };
};
var modelOn = (engine, requested, headModel, configured) => {
  const model = requested && isModelFor(engine, requested) ? requested : headModelFor(engine, void 0, headModel, configured);
  return engine === "agy" ? agyBaseOf(model) ?? AGY_MODEL : modelFor(engine, model);
};
var usagePoolOf = (engine, model) => engine === "agy" ? agyPoolOf(model) : isBuddy(engine) ? modelFor(engine, model).toLowerCase() : void 0;
var modelAlternates = (engine, model, now = Date.now()) => {
  if (engine === "agy") return AGY_ALTERNATES[agyBaseOf(model) ?? AGY_MODEL].filter((other) => agyCurrentModel(other, now) === other);
  if (isBuddy(engine)) return BUDDY_ALTERNATES.filter((other) => other !== modelFor(engine, model).toLowerCase());
  return [];
};
var FALLBACK_ORDER = {
  commandcode: ["codebuddy", "workbuddy", "agy", "codex", "opencode"],
  codebuddy: ["workbuddy", "commandcode", "agy", "codex", "opencode"],
  workbuddy: ["codebuddy", "commandcode", "agy", "codex", "opencode"],
  codex: ["agy", "codebuddy", "commandcode", "workbuddy", "opencode"],
  agy: ["codex", "codebuddy", "commandcode", "workbuddy", "opencode"],
  opencode: ["commandcode", "codebuddy", "workbuddy", "agy", "codex"]
};
var modelFor = (engine, model) => engine === "commandcode" || engine === "opencode" ? model : model.split("/").pop() || model;

// hooks/lib/effort.ts
var EFFORTS = ["off", "low", "medium", "high", "xhigh", "max"];
var HEAD_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
var EFFORT_MODES = ["auto", ...EFFORTS];
var DEFAULT_EFFORT = "low";
var isEffort = (value) => typeof value === "string" && EFFORTS.includes(value);
var isHeadEffort = (value) => typeof value === "string" && HEAD_EFFORTS.includes(value);
var isEffortMode = (value) => typeof value === "string" && EFFORT_MODES.includes(value);
var effortModeOf = (hydra) => isEffortMode(hydra?.effort) ? hydra.effort : "auto";
var headEffort = (mode2, leadPick) => mode2 !== "auto" ? mode2 : isHeadEffort(leadPick) ? leadPick : DEFAULT_EFFORT;
var supportedEfforts = (errors) => {
  const list = /Supported:\s*([a-z, ]+)/i.exec(errors)?.[1];
  return list ? list.split(",").map((level) => level.trim()).filter(isEffort) : [];
};
var nearestEffort = (wanted, supported) => {
  const rank = (level) => EFFORTS.indexOf(level);
  const sorted = [...supported].sort((a, b) => rank(a) - rank(b));
  return sorted.find((level) => rank(level) >= rank(wanted)) ?? sorted.at(-1);
};

// hooks/lib/platform.ts
var detected;
async function platformOf($) {
  if (detected) return detected;
  if (await $.env.get("OS") === "Windows_NT") return detected = "windows";
  const ran = await $.process.run(["uname", "-s"], { timeoutMs: 1e4 }).catch(() => void 0);
  detected = ran?.stdout.trim() === "Darwin" ? "darwin" : "linux";
  return detected;
}
async function homeOf($) {
  const home = await $.env.get("HOME") || await $.env.get("USERPROFILE") || "";
  return toSlashes(home);
}
var toSlashes = (path) => path.replace(/\\/g, "/");
var isWindowsPath = (path) => /^[A-Za-z]:[\\/]/.test(path) || /^(\\\\|\/\/)[^\\/]/.test(path);
var shimTarget = (shim) => {
  const found = /"%~?dp0%?\\([^"]+?\.(?:js|cjs|mjs))"/i.exec(shim);
  return found ? found[1].replace(/\\/g, "/") : void 0;
};
var dirOf = (path) => toSlashes(path).replace(/\/[^/]*$/, "");
var resolved = /* @__PURE__ */ new Map();
async function commandOf($, bin) {
  if (await platformOf($) !== "windows") {
    if (bin !== "codex") return [bin];
    const cached2 = resolved.get(bin);
    if (cached2) return cached2;
    const ran = await $.process.run([bin, "--version"], { timeoutMs: 1e4 }).catch(() => void 0);
    if (ran?.exitCode === 0) return [bin];
    const home = await homeOf($);
    const packages = home ? `${home.replace(/\/+$/, "")}/.codex/packages` : "";
    const candidates = [];
    for (const pkg of packages ? await $.fs.list(packages).catch(() => []) : []) {
      if (pkg.kind !== "dir") continue;
      const releases = `${packages}/${pkg.name}/releases`;
      for (const release of await $.fs.list(releases).catch(() => [])) {
        const version = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(release.name);
        if (release.kind !== "dir" || !version) continue;
        const path2 = `${releases}/${release.name}/bin/codex`;
        if (await $.fs.exists(path2).catch(() => false)) candidates.push({ path: path2, version: version.slice(1).map(Number) });
      }
    }
    candidates.sort((left, right) => right.version[0] - left.version[0] || right.version[1] - left.version[1] || right.version[2] - left.version[2]);
    const app = "/Applications/Codex.app/Contents/Resources/codex";
    const path = candidates[0]?.path ?? (await $.fs.exists(app).catch(() => false) ? app : void 0);
    if (path) {
      const argv2 = [path];
      resolved.set(bin, argv2);
      return argv2;
    }
    return [bin];
  }
  const cached = resolved.get(bin);
  if (cached) return cached;
  const where = await $.process.run(["where.exe", bin], { timeoutMs: 1e4 }).catch(() => void 0);
  const paths = (where?.exitCode === 0 ? where.stdout : "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const exe = paths.find((path) => /\.exe$/i.test(path));
  const cmd = paths.find((path) => /\.cmd$/i.test(path));
  let argv = [bin];
  if (exe) argv = [exe];
  else if (cmd) {
    const target = shimTarget(await $.fs.read(cmd).catch(() => ""));
    argv = target ? ["node", `${dirOf(cmd)}/${target}`] : ["cmd.exe", "/d", "/s", "/c", cmd];
  }
  if (paths.length > 0) resolved.set(bin, argv);
  return argv;
}
async function canRun($, bin, args = ["--version"]) {
  const argv = await commandOf($, bin);
  return $.process.run([...argv, ...args], { timeoutMs: 15e3 }).then((ran) => ran.exitCode === 0, () => false);
}
var python;
async function pythonOf($) {
  if (python) return python;
  const candidates = await platformOf($) === "windows" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"]];
  for (const argv of candidates) {
    const ran = await $.process.run([...argv, "--version"], { timeoutMs: 1e4 }).catch(() => void 0);
    if (ran?.exitCode === 0 && /Python 3\./.test(ran.stdout + ran.stderr)) return python = argv;
  }
  return void 0;
}
var REALPATHS = "import json, os, sys; print(json.dumps([os.path.realpath(p) for p in sys.argv[1:]]))";
async function realPaths($, paths) {
  if (paths.length === 0) return [];
  const python2 = await pythonOf($);
  const ran = python2 ? await $.process.run([...python2, "-I", "-c", REALPATHS, ...paths], { timeoutMs: 1e4 }).catch(() => void 0) : void 0;
  const real = ran?.exitCode === 0 ? JSON.parse(ran.stdout) : [];
  return paths.map((path, index) => real[index] ? toSlashes(real[index]) : path);
}
var REMOVE = 'import os,sys\n(os.rmdir if sys.argv[2] == "dir" else os.remove)(sys.argv[1])';
async function removeFile($, path, isDir = false) {
  if (await platformOf($) !== "windows") return $.process.run(isDir ? ["/bin/rmdir", path] : ["/bin/rm", "-f", path]);
  const python2 = await pythonOf($);
  if (!python2) throw new Error("Python 3 is missing");
  return $.process.run([...python2, "-I", "-c", REMOVE, path, isDir ? "dir" : "file"], { timeoutMs: 1e4 });
}
async function newestMtime($, path, depth) {
  const stat2 = await $.fs.stat(path).catch(() => void 0);
  if (!stat2) return void 0;
  let newest = stat2.mtimeMs;
  if (depth <= 0 || stat2.kind !== "dir") return newest;
  for (const entry of await $.fs.list(path).catch(() => [])) {
    const time = entry.kind === "dir" ? await newestMtime($, `${path}/${entry.name}`, depth - 1) : entry.mtimeMs;
    if (time === void 0) return void 0;
    newest = Math.max(newest, time);
  }
  return newest;
}
var REPLACE = "import os,sys\nos.replace(sys.argv[1], sys.argv[2])";
async function replaceFile($, from, to) {
  let argv;
  if (await platformOf($) !== "windows") argv = ["/bin/mv", "-f", from, to];
  else {
    const python2 = await pythonOf($);
    if (!python2) throw new Error("Python 3 is missing");
    argv = [...python2, "-I", "-c", REPLACE, from, to];
  }
  const ran = await $.process.run(argv, { timeoutMs: 1e4 });
  if (ran.exitCode !== 0) throw new Error(`could not move ${from} to ${to}: ${ran.stderr.trim().slice(0, 160)}`);
}
var tempCount = 0;
async function writeAtomically($, path, text) {
  const temp = `${path}.${await $.session.id()}-${++tempCount}.tmp`;
  await $.fs.write(temp, text);
  try {
    await replaceFile($, temp, path);
  } catch (error) {
    await removeFile($, temp).catch(() => void 0);
    throw error;
  }
}
async function runScript($, script, args, timeoutMs = 3e4) {
  const python2 = await pythonOf($);
  if (!python2) throw new Error("Python 3 is missing");
  return $.process.run([...python2, "-I", `${$.plugin.root}/bin/${script}`, ...args], { timeoutMs });
}

// hooks/lib/safety.ts
var union = (a = [], b = []) => [.../* @__PURE__ */ new Set([...a, ...b])];
var trimSlash = (path) => path.length > 1 ? path.replace(/\/+$/, "") : path;
var isWithin = (path, root) => path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);
var DANGEROUS_SHELL = [
  "Shell(git commit*)",
  "Shell(git push*)",
  "Shell(git reset*)",
  "Shell(git checkout*)",
  "Shell(git switch*)",
  "Shell(git restore*)",
  "Shell(git stash*)",
  "Shell(git clean*)",
  "Shell(git rebase*)",
  "Shell(git merge*)",
  "Shell(git branch -D*)",
  "Shell(git tag*)",
  "Shell(gh *)",
  "Shell(rm -r*)",
  "Shell(rm -f*)",
  "Shell(rm -R*)",
  "Shell(sudo*)",
  "Shell(su *)",
  "Shell(chmod*)",
  "Shell(chown*)",
  "Shell(curl*)",
  "Shell(wget*)",
  "Shell(ssh*)",
  "Shell(scp*)",
  "Shell(rsync*)",
  "Shell(nc *)",
  "Shell(open *)",
  "Shell(osascript*)",
  "Shell(launchctl*)",
  "Shell(defaults write*)",
  "Shell(security *)",
  "Shell(kill*)",
  "Shell(pkill*)",
  "Shell(xcodebuild*)",
  "Shell(swift build*)",
  "Shell(swift test*)",
  "Shell(npm publish*)",
  "Shell(npm install*)",
  "Shell(pip install*)",
  "Shell(brew *)"
];
var SECRET_PATHS = [
  ".ssh",
  ".gnupg",
  ".netrc",
  ".git-credentials",
  ".config/git/credentials",
  ".password-store",
  "Library/Keychains",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".kube",
  ".docker",
  ".terraform.d",
  ".vault-token",
  ".boto",
  ".s3cfg",
  ".config/doctl",
  ".config/op",
  ".config/gh",
  ".config/hub",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".gradle/gradle.properties",
  ".gradle/init.d",
  ".m2/settings.xml",
  ".m2/settings-security.xml",
  ".pub-cache/credentials.json",
  ".config/dart",
  ".dotnet/corefx",
  ".android/adbkey",
  ".codex",
  ".claude",
  ".commandcode",
  ".codebuddy",
  ".gemini",
  ".config/opencode",
  ".local/share/opencode",
  ".workbuddy-ai"
];
var isSecretPath = (rel) => SECRET_PATHS.some((secret) => rel === secret || rel.startsWith(`${secret}/`));
var holdsSecret = (rel) => SECRET_PATHS.some((secret) => secret.startsWith(`${rel}/`));
var HYDRA_READ_PATHS = [".claude/hydra/hunts", ".claude/hydra/heads", ".claude/plugins/cache"];
var isHydraReadPath = (rel) => HYDRA_READ_PATHS.some((path) => rel === path || rel.startsWith(`${path}/`));
var homeRelative = (path, home) => {
  const base = trimSlash(home);
  return base && path.startsWith(`${base}/`) ? trimSlash(path).slice(base.length + 1) : void 0;
};
var secretDirRefusal = (dirs, home, what) => {
  const isRead = what !== "writeDirs";
  const secret = dirs.find((dir) => {
    const rel = homeRelative(dir, home);
    return rel !== void 0 && isSecretPath(rel) && !(isRead && isHydraReadPath(rel));
  });
  return secret ? `${what}: ${secret} is a credential folder (or inside one), which a Head never reads.` : void 0;
};
var HOME_READ_DIRS = [
  ".gitconfig",
  ".config/git",
  ".gitignore_global",
  ".nvm",
  ".volta",
  ".fnm",
  ".bun",
  ".deno",
  ".local/share/pnpm",
  "Library/pnpm",
  ".npm/_npx",
  ".cargo/bin",
  ".cargo/registry",
  ".rustup",
  ".pyenv",
  ".rbenv",
  ".asdf",
  ".local/share/mise",
  ".local/bin",
  ".local/lib",
  "Library/Python",
  ".gem",
  ".gradle/caches",
  ".gradle/wrapper",
  ".m2/repository",
  ".sdkman",
  ".jenv",
  "go/pkg",
  ".konan",
  ".pub-cache",
  ".dotnet",
  ".swiftpm",
  "Library/Android/sdk",
  "Library/Java",
  "Library/Developer/Toolchains",
  "flutter",
  "development/flutter",
  "miniconda3",
  "anaconda3",
  ".conda"
];
var extraHomeRead = [];
var parseHomeReadDirs = (text, home) => text.split(/[,\n]/).map((dir) => dir.trim()).filter(Boolean).map((dir) => dir.startsWith("~/") ? dir.slice(2) : home && dir.startsWith(`${trimSlash(home)}/`) ? dir.slice(trimSlash(home).length + 1) : dir).map((dir) => dir.replace(/\/+$/, "").replace(/^(\.\/)+/, "")).filter((dir) => dir !== "" && !dir.startsWith("/") && !dir.split("/").some((part) => part === ".." || part === "." || part === "") && !isSecretPath(dir) && !holdsSecret(dir));
async function homeReadDirs($, home) {
  const wanted = union(HOME_READ_DIRS, parseHomeReadDirs(extraHomeRead.join(","), home));
  const found = await Promise.all(wanted.map((dir) => $.fs.exists(`${trimSlash(home)}/${dir}`).catch(() => false)));
  return wanted.filter((_, index) => found[index]);
}
var homeHeadRefusal = (cwd, home) => {
  const dir = trimSlash(cwd);
  if (dir === "/" || /^[A-Za-z]:\/?$/.test(dir)) return `${cwd} is the root of the disk. Open Claude Code in a project folder and run the Head there.`;
  if (home && isWithin(trimSlash(home), dir)) return `${cwd} is your home folder${trimSlash(home) === dir ? "" : " or holds it"}. Open Claude Code in a project folder and run the Head there.`;
  return void 0;
};
var shellQuote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
var guardCommand = (pluginRoot2, cwd, writeDirs = [], isWindows = false) => isWindows ? [`py -3 -I ${windowsQuote(`${pluginRoot2}/bin/head-guard.py`)}`, ...[cwd, ...writeDirs].map(windowsQuote)].join(" ") : [`/usr/bin/env python3 -I ${shellQuote(`${pluginRoot2}/bin/head-guard.py`)}`, ...[cwd, ...writeDirs].map(shellQuote)].join(" ");
var strictGuardCommand = (pluginRoot2, policyFile, python2) => [...python2, "-I", windowsQuote(`${pluginRoot2}/bin/head-guard.py`), "--policy", windowsQuote(policyFile)].join(" ");
var windowsQuote = (text) => `"${text.replace(/"/g, '""')}"`;

// hooks/lib/format.ts
var SPINNER = "\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F";
var clockOf = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1e3));
  const two = (n) => String(n).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  return hours > 0 ? `${hours}:${two(minutes)}:${two(total % 60)}` : `${minutes}:${two(total % 60)}`;
};
var elapsedOf = (run, now) => run.startedAt ? clockOf((run.endedAt ?? now) - run.startedAt) : "\u2013";
var glyphOf = (run, frame) => run.state === "running" ? SPINNER[frame % SPINNER.length] : run.state === "queued" ? "\u25CC" : run.state === "done" ? "\u2713" : "\u2717";
var tokenPair = (text) => {
  const parts = /^(\d+(?:\.\d+)?)(k?) in \/ (\d+(?:\.\d+)?)(k?) out$/.exec((text ?? "").trim());
  if (!parts) return [0, 0];
  return [Math.round(Number(parts[1]) * (parts[2] ? 1e3 : 1)), Math.round(Number(parts[3]) * (parts[4] ? 1e3 : 1))];
};
var addTokens = (a, b) => {
  const [inA, outA] = tokenPair(a);
  const [inB, outB] = tokenPair(b);
  return inA + outA + inB + outB > 0 ? tokensText(inA + inB, outA + outB) : void 0;
};
var nowLine = (run) => run.state === "done" ? `done${run.costUsd !== void 0 ? ` \xB7 $${run.costUsd.toFixed(4)}` : run.tokens ? ` \xB7 ${run.tokens}` : ""}` : run.activity ?? run.state;
var CODEBUDDY_NO_SPEND = "CodeBuddy counts credits, not dollars, so Hydra shows tokens per Head instead of spend.";
var CODEX_NO_SPEND = "Codex runs on your ChatGPT plan, not dollars, so Hydra shows tokens per Head instead of spend.";
var AGY_NO_SPEND = "Antigravity runs on your Google account quota, not dollars, so Hydra shows tokens per Head instead of spend.";
var AUTO_NO_SPEND = "Heads run on engines that count credits, plan usage or quota, not dollars, so Hydra shows tokens per Head instead of spend.";
var WORKBUDDY_NO_SPEND = "WorkBuddy counts credits on your WorkBuddy plan, not dollars, so Hydra shows tokens per Head instead of spend.";
var OPENCODE_NO_SPEND = "OpenCode runs the models you set up in it (the free ones cost nothing), so Hydra shows tokens per Head instead of spend.";
var HYDRA_MARK = "\u{1F409}";
var statusMark = (hydra) => hydra?.isOn ? hydra.surge ? `${HYDRA_MARK} ${hydra.surge}` : HYDRA_MARK : void 0;
var EDIT_TOOLS = /* @__PURE__ */ new Set(["edit_file", "write_file"]);
var MAX_STEPS = 8;
var MAX_TOUCHED = 1e3;
var describeTool = (name, input = {}, cwd = "") => {
  const path = String(input.file_path ?? input.path ?? "");
  const at = !path || path === cwd || path === `${cwd}/` ? "." : relativeTo(cwd, path);
  const verbs = { read_file: "read", edit_file: "edit", write_file: "write", read_directory: "list" };
  if (verbs[name]) return `${verbs[name]} ${at}`;
  if (name === "grep") return `search "${String(input.pattern ?? "")}"`;
  if (name === "glob") return `find ${String(input.pattern ?? "")}`;
  if (name === "shell_command") return `$ ${String(input.command ?? "")}`;
  return name.replace(/_/g, " ");
};
var applyEvent = (run, event, labels, cwd) => {
  const label = () => labels.get(event.toolCallId ?? "") ?? describeTool(event.toolName ?? "tool");
  switch (event.type) {
    case "thinking_start":
      return { activity: "thinking" };
    case "tool_queued":
      labels.set(event.toolCallId ?? "", describeTool(event.toolName ?? "tool", event.input, cwd));
      return {};
    case "tool_running":
      return { activity: label() };
    case "tool_completed":
    case "tool_denied": {
      const isOk = event.type === "tool_completed";
      const step = { isOk, text: label() };
      const isEdit = isOk && !event.isError && EDIT_TOOLS.has(event.toolName ?? "");
      const written = !isEdit ? [] : event.files ? event.files.map((file) => relativeTo(cwd, file)) : [step.text.replace(/^(?:edit|write) /, "")];
      const fresh = written.filter((file) => file && file !== "." && !(run.touched ?? []).includes(file));
      return {
        steps: [...run.steps ?? [], step].slice(-MAX_STEPS),
        edits: (run.edits ?? 0) + (isEdit ? 1 : 0),
        denials: (run.denials ?? 0) + (isOk ? 0 : 1),
        ...fresh.length > 0 ? { touched: [...run.touched ?? [], ...new Set(fresh)].slice(-MAX_TOUCHED) } : {}
      };
    }
    case "turn_end":
      return { turns: run.maxTurns !== void 0 ? Math.min(run.turns + 1, run.maxTurns) : run.turns + 1 };
    default:
      return {};
  }
};
var NEAR_CAP = 0.8;
var isNearCap = (run) => run.maxTurns !== void 0 && run.turns >= run.maxTurns * NEAR_CAP;
var turnsOf = (run) => (run.earlierTurns ?? 0) + (run.maxTurns !== void 0 ? Math.min(run.turns, run.maxTurns) : run.turns);
var expectedFiles = (cwd, files) => [...new Set(files.map((file) => relativeTo(cwd, file.trim()).replace(/^\.\//, "")).filter(Boolean))];
var progressOf = (run) => {
  const expected = run.expected ?? [];
  if (expected.length === 0) return void 0;
  const written = /* @__PURE__ */ new Set([...run.touched ?? [], ...run.files ?? []]);
  const done = expected.filter((file) => written.has(file)).length;
  return { done, total: expected.length, percent: done / expected.length * 100 };
};
var countsOf = (run) => {
  const progress = progressOf(run);
  const turns = isNearCap(run) ? `${Math.min(run.turns, run.maxTurns)}/${run.maxTurns} turns` : `${turnsOf(run)} turns`;
  return progress ? `${progress.done}/${progress.total} files \xB7 ${turns}` : turns;
};
var scopeLines = (cwd, expected, files, beside = []) => {
  if (expected.length === 0) return [];
  const changed = [...new Set(files.map((file) => relativeTo(cwd, file)))];
  const missed = expected.filter((file) => !changed.includes(file));
  const extra = changed.filter((file) => !expected.includes(file));
  return [
    `named files: ${expected.length - missed.length}/${expected.length} changed`,
    ...missed.length > 0 ? [`\u26A0 named but not changed: ${missed.join(", ")}`] : [],
    ...missed.length === expected.length ? renamedHint(missed, extra) : [],
    // Heads that shared the folder may have written those files: the line would blame this Head for their work.
    ...extra.length > 0 && beside.length === 0 ? [`also changed, not named: ${extra.join(", ")}`] : []
  ];
};
var STOP_WORDS = /* @__PURE__ */ new Set(["the", "and", "for", "with", "from", "into", "that", "this", "one", "file", "files", "convert", "add", "fix", "make", "update", "implement", "write", "task", "goal", "repo", "android", "kotlin", "java"]);
var NAME_MAX = 20;
var slugOf = (text) => {
  const slug2 = text.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug2.length <= NAME_MAX) return slug2;
  const cut = slug2.slice(0, NAME_MAX);
  return (cut.includes("-") ? cut.slice(0, cut.lastIndexOf("-")) : cut).replace(/-+$/, "");
};
var nameFromTask = (task) => {
  const file = /([A-Za-z][\w-]*)\.(?:kt|kts|java|ts|tsx|js|jsx|swift|go|py|dart|xml|gradle)\b/.exec(task)?.[1];
  if (file) return slugOf(file);
  const words = (task.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return slugOf(words.slice(0, 3).join("-")) || "head";
};
var headName = (requested, task, taken) => {
  const base = typeof requested === "string" && slugOf(requested) || nameFromTask(task);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, NAME_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};
var stopRuns = (list, ids, reason, now) => list.map(
  (run) => (run.state === "running" || run.state === "queued") && (ids === "all" || ids.includes(run.id)) ? { ...run, state: "failed", endedAt: now, activity: reason } : run
);
var listRuns = (list, now, isLiveProcess) => list.length === 0 ? "No Heads in this session." : list.map((run) => {
  const ghost = (run.state === "running" || run.state === "queued") && !isLiveProcess(run.id) ? " \xB7 NO LIVE PROCESS" : "";
  return `${run.id} \xB7 ${run.state}${ghost} \xB7 ${countsOf(run)} \xB7 ${elapsedOf(run, now)} \xB7 ${nowLine(run)} \xB7 ${run.task.slice(0, 80)}`;
}).join("\n");
var tokensText = (inputTokens, outputTokens) => {
  const short = (n) => n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
  return `${short(inputTokens)} in / ${short(outputTokens)} out`;
};
var strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim() !== "") : [];
var comparable = (path) => isWindowsPath(path) ? toSlashes(path).toLowerCase() : path;
var relativeTo = (cwd, path) => {
  const root = comparable(cwd).replace(/\/$/, "") + "/";
  return comparable(path).startsWith(root) ? toSlashes(path).slice(root.length) : path;
};
var outsideFiles = (cwd, files, writeDirs = []) => files.filter((file) => (file.startsWith("/") || isWindowsPath(file)) && ![cwd, ...writeDirs].some((root) => isWithin(comparable(file), comparable(root))));
var resumeCommand = (engine) => engine === "opencode" ? "opencode run -s" : `${ENGINE_BIN[engine]} --resume`;
var isIgnoreFile = (path) => /(^|\/)\.hydraignore$/i.test(path);
var overlappingHeads = (runs2, head) => {
  const { id, cwd, startedAt } = head;
  if (startedAt === void 0 || cwd === void 0) return [];
  const end = head.endedAt ?? startedAt;
  return runs2.filter((run) => run.id !== id && run.cwd !== void 0 && run.startedAt !== void 0).filter((run) => isWithin(run.cwd, cwd) || isWithin(cwd, run.cwd)).filter((run) => run.startedAt <= end && (run.endedAt ?? end) >= startedAt).map((run) => run.id.replace(RETRY_SUFFIX, "")).filter((name, index, names) => name !== id.replace(RETRY_SUFFIX, "") && names.indexOf(name) === index);
};
var RETRY_SUFFIX = /-json\d*$/;
var folderOf = (file) => file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
var renamedHint = (missed, extra) => {
  const folders = new Set(missed.map(folderOf));
  const nearby = extra.filter((file) => folders.has(folderOf(file)));
  return missed.length > 0 && nearby.length === missed.length ? [`\u26A0 it wrote ${nearby.length} unnamed file(s) in the same folder(s), maybe the named ones under other names: ${nearby.join(", ")}`] : [];
};
var REPORT_HEAD_CHARS = 5e3;
var REPORT_TAIL_CHARS = 3e3;
var clipReport = (text, path) => {
  const report = text.trim();
  if (report.length <= REPORT_HEAD_CHARS + REPORT_TAIL_CHARS) return report;
  const cut = report.length - REPORT_HEAD_CHARS - REPORT_TAIL_CHARS;
  return `${report.slice(0, REPORT_HEAD_CHARS)}
[\u2026 ${cut} characters cut by Hydra${path ? `; the full report is at ${path}` : ""} \u2026]
${report.slice(-REPORT_TAIL_CHARS)}`;
};
var RESUMABLE = /* @__PURE__ */ new Set(["commandcode", "codebuddy", "codex", "workbuddy", "opencode"]);
var editedLine = (cwd, files, stats = {}) => {
  const edited = (file) => {
    const relative = relativeTo(cwd, file);
    return stats[relative] ? `${relative} (${stats[relative]})` : relative;
  };
  return files.length > 0 ? `edited (${files.length}): ${files.map(edited).join(", ")}` : "edited: nothing";
};
var LOST_LINES = /^\+0\s+−(\d+)$/;
var NOTHING_CHANGED = /no files? (?:were |was |have been )?(?:changed|created|modified|added|deleted)|changed:?\s*none|^\W*no changes\W*$/im;
var DAMAGE_MIN_LINES = 5;
var damageLines = (head) => {
  const lines = [];
  if (!head.finished) {
    for (const file of [...new Set(head.files)]) {
      const relative = relativeTo(head.cwd, file);
      const lost = LOST_LINES.exec(head.stats?.[relative] ?? "");
      if (lost && Number(lost[1]) >= DAMAGE_MIN_LINES) lines.push(`\u26A0 probable damage: ${relative} lost ${lost[1]} lines and gained none (restore: git checkout -- ${relative})`);
    }
  }
  if (head.files.length > 0 && NOTHING_CHANGED.test(head.finalText)) {
    lines.push(`\u26A0 the Head says it changed nothing, but files changed: ${[...new Set(head.files)].map((file) => relativeTo(head.cwd, file)).join(", ")}`);
  }
  return lines;
};
var REPORT_MARKER = "\n--- head report ---";
var withEditStats = (report, cwd, files, stats) => {
  if (files.length === 0 || Object.keys(stats).length === 0) return report;
  const at = report.indexOf(REPORT_MARKER);
  const summary = at < 0 ? report : report.slice(0, at);
  return summary.replace(/^edited \(\d+\): .*$/m, () => editedLine(cwd, files, stats)) + (at < 0 ? "" : report.slice(at));
};
var EDITED_LINE = /^edited(?: \((\d+)\))?: .*$/m;
var summaryOfReport = (report) => {
  const at = report.indexOf(REPORT_MARKER);
  return at < 0 ? report : report.slice(0, at);
};
var editedCount = (report) => Number(summaryOfReport(report).match(EDITED_LINE)?.[1] ?? 0);
var withEdits = (report, cwd, files, stats = {}) => {
  const summary = summaryOfReport(report);
  const cleaned = files.length === 0 ? summary.replace(/^⚠ the Head says it changed nothing, but files changed: [^\n]*(?:\n|$)/m, "") : summary;
  return cleaned.replace(EDITED_LINE, () => editedLine(cwd, files, stats)) + report.slice(summary.length);
};
var attributeFiles = (cwd, named, changed, times, checked) => {
  const clean = (file) => relativeTo(cwd, file);
  const allowed = (file) => !/(?:^|\/)(?:\.commandcode|\.codebuddy|\.workbuddy|\.opencode)(?:\/|$)/.test(clean(file));
  const edits = [...new Set(named.map(clean).filter(allowed))];
  const others = [...new Set(changed.map(clean).filter(allowed))].filter((file) => !edits.includes(file));
  const check = others.filter((file) => times[file] !== void 0 && times[file] === checked[file]);
  return { edits, check, folder: others.filter((file) => !check.includes(file)) };
};
var priorEditStats = (cwd, stats, before) => {
  const prior = new Set(Object.keys(before).map((file) => relativeTo(cwd, file)));
  return Object.fromEntries(Object.entries(stats).map(([file, stat2]) => [file, prior.has(file) ? stat2 === "new" ? "had edits before" : `${stat2} vs last commit; had edits before` : stat2]));
};
var FOLDER_LABEL = "changed in the folder during the run, not through this Head's file tools";
var withOtherWrites = (report, check, folder) => {
  const line = (label, files) => files.length ? `
${label}: ${files.slice(0, 8).join(", ")}${files.length > 8 ? ` and ${files.length - 8} more` : ""}` : "";
  const summary = summaryOfReport(report);
  const listed = new Set([...summary.matchAll(new RegExp(`^${FOLDER_LABEL}: (.*)$`, "gm"))].flatMap((match) => match[1].split(", ")));
  const unlisted = folder.filter((file) => !listed.has(file));
  return summary.replace(EDITED_LINE, (match) => match + line("check wrote", check) + line(FOLDER_LABEL, unlisted)) + report.slice(summary.length);
};
var parseDiffStat = (numstat, untracked) => {
  const stats = {};
  for (const row of numstat.split("\0")) {
    const [added, removed, path] = row.split("	");
    if (path && added !== void 0 && /^\d+$/.test(added) && removed !== void 0 && /^\d+$/.test(removed)) stats[path] = `+${added} \u2212${removed}`;
  }
  for (const path of untracked.split("\0")) if (path) stats[path] = "new";
  return stats;
};
var resumeTarget = (runs2, name) => {
  const run = [...runs2].reverse().find((entry) => entry.id === name);
  const open = runs2.filter((entry) => entry.sessionId && entry.state !== "running" && entry.state !== "queued").map((entry) => entry.id);
  if (!run) return { deny: `No Head named "${name}" in this session. resume takes the name of an ended Head${open.length > 0 ? `: ${open.join(", ")}` : ", and none can be continued yet"}.` };
  if (run.state === "running" || run.state === "queued") return { deny: `Head ${name} is still ${run.state}. Wait for its report, or stop it first.` };
  if (!isEngine(run.engine) || !RESUMABLE.has(run.engine)) return { deny: `Head ${name} ran on ${isEngine(run.engine) ? ENGINE_LABEL[run.engine] : "an unknown engine"}, whose Heads cannot be continued. Start a new Head with the full task.` };
  if (!run.sessionId) return { deny: `Head ${name} left no session to continue (it never got one). Start a new Head with the full task.` };
  return { run };
};
var canResume = (run) => !!run.sessionId && RESUMABLE.has(run.engine ?? DEFAULT_ENGINE);
var capOf = (run) => run.maxTurns !== void 0 && run.turns >= run.maxTurns ? "turn" : "round";
var stopLine = (head) => {
  const canResume2 = !!head.sessionId && RESUMABLE.has(head.engine ?? DEFAULT_ENGINE);
  const again = canResume2 ? `continue it with resume: "${head.id}"` : "start a new Head for what is left";
  const hasEdits = head.files.length > 0;
  switch (head.ending) {
    case "blocked":
      return `BLOCKED: the Head says it cannot finish (its report says why). Fix what stops it, then ${again}, or do it yourself.`;
    case "stalled":
      return `stalled: it replied ${hasEdits ? "after its edits " : ""}without acting, finishing or saying it is blocked. Read its last message below${hasEdits ? " and the diff: the work may be complete" : ""}.`;
    case "capped":
      return head.cap === "round" ? `out of rounds: it kept stopping without finishing. Its handoff is below; ${again}.` : `out of turns (${head.maxTurns ?? "?"}): its handoff is below; ${again}${canResume2 ? " and a higher maxTurns" : ""}, or split the task.`;
    case "timeout":
      return `out of time: its handoff, if it wrote one, is below; ${again}${canResume2 ? " and a higher maxMinutes" : ""}, or split the task.`;
    default:
      return void 0;
  }
};
var formatReport = (head) => {
  const took = head.startedAt !== void 0 && head.endedAt !== void 0 ? ` \xB7 ${clockOf(head.endedAt - head.startedAt)}` : "";
  const turns = head.maxTurns !== void 0 ? Math.min(head.turns, head.maxTurns) : head.turns;
  const ownFiles = head.wrote === false ? [] : head.files;
  const folderFiles = head.wrote === false ? [...new Set(head.files.map((file) => relativeTo(head.cwd, file)))] : [];
  const lines = [
    ...damageLines({ ...head, files: ownFiles }),
    `head ${head.id} \xB7 ${head.model}${head.effort ? ` \xB7 effort ${head.effort}` : ""} \xB7 ${head.finished ? "finished" : "NOT finished"} \xB7 exit ${head.exit} \xB7 ${head.rounds} round(s) \xB7 ${turns} turns \xB7 ${head.tokens ?? `$${(head.usd ?? 0).toFixed(4)}`}${took}`,
    `session ${head.sessionId ?? "none"} (${resumeCommand(head.engine ?? DEFAULT_ENGINE)} ${head.sessionId ?? "<id>"}) \xB7 cwd ${head.cwd}`
  ];
  const stop = head.finished ? void 0 : stopLine({ ...head, files: ownFiles });
  if (stop) lines.push(stop);
  if (head.rulesNote) lines.push(`rules: ${head.rulesNote}`);
  for (const warning of head.warnings ?? []) lines.push(`\u26A0 ${warning}`);
  if (head.writeDirs && head.writeDirs.length > 0) lines.push(`may also write: ${head.writeDirs.join(", ")}`);
  const outside = outsideFiles(head.cwd, ownFiles, head.writeDirs);
  if (outside.length > 0) lines.push(`\u26A0 WROTE OUTSIDE THE PROJECT (${outside.length}): ${outside.join(", ")}`);
  const ignoreEdits = ownFiles.filter(isIgnoreFile);
  if (ignoreEdits.length > 0) lines.push(`\u26A0 CHANGED .hydraignore (${ignoreEdits.map((file) => relativeTo(head.cwd, file)).join(", ")}): check it before the next Head runs`);
  lines.push(editedLine(head.cwd, ownFiles, head.stats));
  if (folderFiles.length > 0) lines.push(`${FOLDER_LABEL}: ${folderFiles.slice(0, 8).join(", ")}${folderFiles.length > 8 ? ` and ${folderFiles.length - 8} more` : ""}`);
  if (head.reverted && head.reverted.length > 0) lines.push(`\u26A0 put back to the committed version during this Head (uncommitted edits there are gone): ${head.reverted.map((file) => relativeTo(head.cwd, file)).join(", ")}`);
  if (head.deleted && head.deleted.length > 0) lines.push(`deleted (were new, never committed): ${head.deleted.map((file) => relativeTo(head.cwd, file)).join(", ")}`);
  if (head.restored && head.restored.length > 0) lines.push(`\u26A0 rewritten during this Head and now identical to the committed version (if anyone edited them while it ran, those edits are gone): ${head.restored.map((file) => relativeTo(head.cwd, file)).join(", ")}`);
  if (head.overwritten && head.overwritten.length > 0) lines.push(`\u26A0 changed files that already had uncommitted edits before this Head started: ${head.overwritten.map((file) => relativeTo(head.cwd, file)).join(", ")}`);
  if (head.alsoRan && head.alsoRan.length > 0) lines.push(`\u26A0 ${head.alsoRan.join(", ")} also ran in this folder during this Head; the edited list may include their files`);
  const refused = head.denied.filter((d) => d.tool !== "sandbox");
  const sandboxed = head.denied.filter((d) => d.tool === "sandbox");
  if (refused.length > 0) {
    lines.push(`denied (${refused.length}):`, ...refused.map((d) => `  - ${d.tool} ${relativeTo(head.cwd, d.target)}: ${d.text.slice(0, 140)}`));
  }
  if (sandboxed.length > 0) {
    lines.push(`ran, but the sandbox refused a file access inside (${sandboxed.length}; the check runs outside it):`, ...sandboxed.map((d) => `  - ${relativeTo(head.cwd, d.target).slice(0, 100)}: ${d.text.slice(0, 140)}`));
  }
  lines.push("--- head report ---", clipReport(head.finalText.replace(/^[ \t]*--- head report ---[ \t]*\r?$/gm, "---")) || "(no final report)");
  if (!head.finished && head.errors?.trim()) lines.push("--- stderr ---", head.errors.trim());
  return lines.join("\n");
};

// hooks/lib/check.ts
var CHECK_FIX_ROUNDS = 2;
var CHECK_MAX_MINUTES = 10;
var CHECK_DEFAULT_MINUTES = 10;
var TAIL_LINES = 60;
var TAIL_CHARS = 4e3;
var FAILURE_LINES = 20;
var FAILURE_LINE = /\b(fail(ed|ure)?|error|panic)\b|✗|\bFAIL\b/i;
var checkTail = (stdout, stderr) => {
  const text = [stdout, stderr].filter((part) => part.trim()).join("\n");
  const plain = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r\n?/g, "\n");
  const lines = plain.trimEnd().split("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n").slice(-TAIL_CHARS);
  const failures = lines.slice(0, -TAIL_LINES).filter((line) => FAILURE_LINE.test(line)).slice(0, FAILURE_LINES).map((line) => line.slice(0, 200));
  return failures.length > 0 ? `${failures.join("\n")}
[\u2026]
${tail}`.slice(-(TAIL_CHARS + FAILURE_LINES * 200)) : tail;
};
var outcomeOf = (ran, seconds) => {
  const tail = checkTail(ran.stdout, ran.stderr);
  if (ran.exitCode === 0) return { kind: "passed", seconds };
  if (ran.exitCode === 126 || ran.exitCode === 127) return { kind: "unknown", reason: `the shell could not run it (exit ${ran.exitCode})`, tail };
  const output = `${ran.stdout}
${ran.stderr}`;
  const reason = ran.exitCode === 137 || /OutOfMemoryError|Java heap space|GC overhead limit exceeded|Cannot allocate memory/i.test(output) || /^(?:.*: )?Killed(?::.*)?$/m.test(output) ? "out of memory" : /(?:Gradle|Kotlin).*daemon[^\n]*(?:disappeared|crash|died|terminated)|daemon[^\n]*(?:disappeared|crash|died|terminated)[^\n]*(?:Gradle|Kotlin)/i.test(output) ? "daemon disappeared or crashed" : /No space left on device/i.test(output) ? "no space left on device" : /Too many open files/i.test(output) ? "too many open files" : "";
  if (reason) return { kind: "unknown", reason: `environment: ${reason}`, tail };
  if (!ran.stdout && !ran.stderr) return { kind: "unknown", reason: "the check printed nothing", tail };
  return { kind: "failed", exitCode: ran.exitCode, tail, seconds };
};
var checkMinutesOf = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, CHECK_MAX_MINUTES) : CHECK_DEFAULT_MINUTES;
var checkQueues = /* @__PURE__ */ new Map();
async function runCheck($, check, cwd, minutes, options) {
  const git = await $.process.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 1e4 }).catch(() => void 0);
  const folder = git?.exitCode === 0 && git.stdout.trim() ? git.stdout.trim() : cwd;
  const key = (await realPaths($, [folder]))[0] ?? folder;
  const previous = checkQueues.get(key);
  let release = () => {
  };
  const current = new Promise((resolve4) => {
    release = resolve4;
  });
  const queued = previous ? previous.then(() => current) : current;
  checkQueues.set(key, queued);
  try {
    if (previous) {
      await options?.onWait?.();
      const signal = options?.signal;
      if (signal && !signal.aborted) {
        let stopped = () => {
        };
        const aborted = new Promise((resolve4) => {
          stopped = resolve4;
          signal.addEventListener("abort", stopped, { once: true });
        });
        try {
          await Promise.race([previous, aborted]);
        } finally {
          signal.removeEventListener("abort", stopped);
        }
      } else if (!signal) await previous;
    }
    if (options?.signal?.aborted) return { kind: "unknown", reason: "the Head was stopped", tail: "" };
    if (previous) await options?.onStart?.();
    const argv = await platformOf($) === "windows" ? ["cmd", "/d", "/s", "/c", check] : ["/bin/sh", "-c", check];
    const startedAt = await $.clock.now();
    const ran = await $.process.run(argv, { cwd, timeoutMs: Math.round(minutes * 6e4) }).catch((error) => error);
    const seconds = Math.round((await $.clock.now() - startedAt) / 1e3);
    if (ran instanceof Error || !ran) return { kind: "unknown", reason: `it did not finish within ${minutes} min or could not start (${String(ran).slice(0, 120)})`, tail: "" };
    return outcomeOf(ran, seconds);
  } finally {
    release();
    if (checkQueues.get(key) === queued) checkQueues.delete(key);
  }
}
var raisedEffort = (effort) => {
  const levels = HEAD_EFFORTS;
  const at = levels.indexOf(effort ?? DEFAULT_EFFORT);
  return levels[Math.min(at < 0 ? 0 : at + 1, levels.length - 1)];
};
var fixNote = (check, outcome, files, named = [], task = "") => {
  const rules = task.split(/\n|(?<=[.!?])\s+/).map((rule) => rule.trim()).filter((rule) => /\b(?:do not|don't|never|only|must not)\b/i.test(rule)).slice(0, 8);
  return `

Your previous attempt ended, but the acceptance check failed. Check: \`${check}\` (exit ${outcome.exitCode}). Its last output:
\`\`\`
${outcome.tail || "(no output)"}
\`\`\`
Files already changed: ${files.length > 0 ? files.join(", ") : "none recorded"}.${named.length ? ` Only change these task files: ${named.join(", ")}.` : ""}${rules.length ? ` Original task rules:
${rules.map((rule) => `"${rule}"`).join("\n")}` : ""}
Fix the code so the check passes. Do not weaken, skip or delete tests or the check to get there. If passing the check would break these rules, stop and say so instead (HEAD BLOCKED); do not edit outside them. Hydra runs the check again when you finish: you need not run it yourself.`;
};
var checkNote = (check) => `

Acceptance check: when you finish, Hydra runs \`${check.slice(0, 300)}\` itself, outside your sandbox, and sends you back with its output if it fails. You do not have to run it, and if you cannot, do not wait for it or ask for its result: finish the work and end your report.`;
var RUNS_CODE = [
  /(^|\/)(tests?|__tests__|spec|specs|androidTest|testDebug|testRelease|Tests)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(Test|Tests|Spec)\.(kt|kts|java|swift|scala|cs)$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(py|go|rb|exs?)$/,
  /(^|\/)conftest\.py$/,
  /(^|\/)(build|settings)\.gradle(\.kts)?$/,
  /(^|\/)gradlew(\.bat)?$/,
  /(^|\/)gradle\/wrapper\//,
  /(^|\/)gradle\.properties$/,
  /(^|\/)package\.json$/,
  /(^|\/)(jest|vitest|playwright|karma|babel)\.config\.[cm]?[jt]s$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(Makefile|makefile|CMakeLists\.txt|Rakefile|Gemfile|Justfile|justfile)$/,
  /(^|\/)(pom\.xml|Package\.swift|Cargo\.toml|go\.mod|pyproject\.toml|setup\.py|setup\.cfg|tox\.ini|pytest\.ini|noxfile\.py)$/,
  /\.(sh|bash|zsh|ps1|bat|cmd)$/i
];
var checkedEdits = (check, files, cwd) => files.map((file) => relativeTo(cwd, file)).filter((rel) => {
  const name = rel.split("/").pop() ?? rel;
  return RUNS_CODE.some((pattern) => pattern.test(rel)) || name.length > 2 && check.includes(name);
});
var checkLines = (check, outcome, rounds, edits) => {
  const label = outcome.kind === "passed" ? `\u2713 passed (${outcome.seconds}s)` : outcome.kind === "failed" ? `\u2717 FAILED, exit ${outcome.exitCode} (${outcome.seconds}s)` : `? UNKNOWN, ${outcome.reason}: run it yourself`;
  const lines = [`check: \`${check}\` ${label}${rounds.length > 1 ? ` \xB7 ${rounds.length} tries: ${rounds.map((round) => round.kind === "passed" ? "\u2713" : round.kind === "failed" ? "\u2717" : "?").join(" ")}` : ""}`];
  if (edits.length > 0) lines.push(`\u26A0 the check ran code this Head changed (${edits.join(", ")}): read those changes before trusting the result`);
  return lines;
};
var MARKER = "\n--- head report ---";
var withSummary = (report, lines, output) => {
  const at = report.indexOf(MARKER);
  const summary = at < 0 ? report : report.slice(0, at);
  const rest = at < 0 ? "" : report.slice(at);
  return `${summary}
${lines.join("\n")}${rest}${output ? `
--- check output (last lines) ---
${output}` : ""}`;
};
var UNFINISHED_BUT_CHECKABLE = /* @__PURE__ */ new Set(["stalled", "capped", "timeout", "blocked"]);
var isCheckable = (result) => result.isDone || UNFINISHED_BUT_CHECKABLE.has(result.ending ?? "") && (result.files?.length ?? 0) > 0;
var UNFINISHED_PASS = "the Head did not report HEAD DONE, but the check passed: read its last message for what it left undone";
async function checkHead(steps) {
  const startedAt = await steps.now();
  const edited = [];
  const outside = [];
  const warnings = () => outside.length ? [`\u26A0 the fix round changed files outside \`files\`: ${outside.join(", ")}`] : [];
  const tries = [];
  let effort = steps.effort;
  const efforts = [effort ?? DEFAULT_EFFORT];
  let result = await steps.run();
  const reports = [result.text];
  const report = () => reports.map((text, index) => index === 0 ? text : `--- fix round ${index} ---
${text}`).join("\n");
  const effortLines = () => efforts.length > 1 ? [`effort: ${efforts.join(" \u2192 ")} (raised after each failed check)`] : [];
  for (; ; ) {
    for (const file of result.files ?? []) if (!edited.includes(file)) edited.push(file);
    if (!isCheckable({ ...result, files: edited }) || steps.isAborted()) {
      const line = tries.length > 0 ? `\u2717 FAILED earlier, and the Head did not finish its fix round` : "not run: the Head did not finish";
      return { result: { ...result, files: edited, text: withSummary(report(), [`check: \`${steps.check}\` ${line}`, ...warnings(), ...effortLines()]) }, outcome: tries.at(-1) };
    }
    await steps.onStep?.(`check: ${steps.check}`);
    const outcome = await steps.runCheck();
    tries.push(outcome);
    const minutesLeft = steps.minutes - Math.floor((await steps.now() - startedAt) / 6e4);
    if (outcome.kind !== "failed" || result.ending === "blocked" || tries.length > CHECK_FIX_ROUNDS || minutesLeft < 1 || steps.isAborted()) {
      const lines = checkLines(steps.check, outcome, tries, outcome.kind === "unknown" ? [] : checkedEdits(steps.check, edited, steps.cwd));
      lines.push(...warnings());
      lines.push(...effortLines());
      if (outcome.kind === "passed" && !result.isDone) lines.push(result.ending === "blocked" ? "\u26A0 the Head said it was blocked, but the check passed" : `\u26A0 ${UNFINISHED_PASS}`);
      return { result: { ...result, ...outcome.kind === "passed" && result.ending === "blocked" ? { isDone: true } : {}, files: edited, text: withSummary(report(), lines, outcome.kind === "passed" ? void 0 : outcome.tail) }, outcome };
    }
    const nextEffort = raisedEffort(effort);
    if (nextEffort && nextEffort !== (effort ?? DEFAULT_EFFORT)) efforts.push(nextEffort);
    effort = nextEffort;
    await steps.onStep?.(`check failed (exit ${outcome.exitCode}): sending it back`);
    result = await steps.run({ note: fixNote(steps.check, outcome, edited.map((file) => relativeTo(steps.cwd, file)), steps.files, steps.task), effort, minutes: minutesLeft });
    if (steps.files?.length) for (const file of result.files ?? []) {
      const rel = relativeTo(steps.cwd, file).replace(/^\.\//, "");
      if (!steps.files.some((named) => rel === relativeTo(steps.cwd, named).replace(/^\.\//, "")) && !outside.includes(rel)) outside.push(rel);
    }
    reports.push(result.text);
  }
}

// hooks/lib/look.ts
var CHECK_TRIES = CHECK_FIX_ROUNDS + 1;
var lookOf = (run, frame) => {
  if (run.state === "queued") return { glyph: "\u25CC", color: void 0 };
  if (run.state === "running") {
    if (run.check?.state === "running") return { glyph: "\u2699", color: "cyan" };
    if (run.check?.state === "fixing") return { glyph: glyphOf(run, frame), color: "yellow" };
    return { glyph: glyphOf(run, frame), color: "cyan" };
  }
  if (run.state === "done") return { glyph: "\u2713", color: "green" };
  if (run.check?.state === "failed") return { glyph: "\u2717", color: "red" };
  switch (run.ending) {
    case "blocked":
      return { glyph: "\u25C6", color: "yellow" };
    case "capped":
    case "timeout":
      return { glyph: "\u25F7", color: "yellow" };
    case "stalled":
      return { glyph: "\u2248", color: "yellow" };
    case "stopped":
      return { glyph: "\u25A0", color: void 0 };
    default:
      return { glyph: "\u2717", color: "red" };
  }
};
var needOf = (run) => {
  const line = (run.summary ?? "").split("\n").find((entry) => entry.trim() !== "");
  if (!line) return "see its report";
  const text = line.trim().replace(/^[-*•] /, "").replace(/^blocked:/i, "").trim();
  return text || "see its report";
};
var rowLine = (run) => {
  const check = run.check;
  if (run.state === "queued") return run.activity ?? "queued";
  if (run.state === "running") {
    if (check?.state === "running") {
      const command = (run.activity ?? "").replace(/^check: /, "");
      return command ? `check ${check.tries}/${CHECK_TRIES} \xB7 ${command}` : `check ${check.tries}/${CHECK_TRIES}`;
    }
    if (check?.state === "fixing") return `fix round ${check.tries}/${CHECK_FIX_ROUNDS} \xB7 ${run.activity ?? "working"}`;
    return run.activity ?? "running";
  }
  if (run.state === "done") {
    const progress = progressOf(run);
    return [
      "done",
      progress ? `${progress.done}/${progress.total} files` : "",
      check?.state === "passed" ? "check \u2713" : check?.state === "unknown" ? "check ?" : "",
      run.costUsd !== void 0 ? `$${run.costUsd.toFixed(4)}` : run.tokens ?? ""
    ].filter(Boolean).join(" \xB7 ");
  }
  if (check?.state === "failed") return `check \u2717 failed after ${check.tries} ${check.tries === 1 ? "try" : "tries"}`;
  const again = canResume(run) ? `resume: "${run.id}"` : "needs a new Head";
  if (run.ending === "blocked") return `blocked \xB7 ${needOf(run)}`;
  if (run.ending === "capped") return `out of ${capOf(run) === "round" ? "rounds" : "turns"} \xB7 ${again}`;
  if (run.ending === "timeout") return `out of time \xB7 ${again}`;
  if (run.ending === "stalled") return (run.files?.length ?? 0) > 0 || (run.touched?.length ?? 0) > 0 ? "stalled \xB7 read its diff" : "stalled \xB7 no edits";
  return run.activity ?? "failed";
};

// hooks/lib/checks.ts
var WORKBUDDY_LOGIN = `CODEBUDDY_CONFIG_DIR=~/${WORKBUDDY_CONFIG} ACC_PRODUCT_CONFIG_PATH=~/${WORKBUDDY_PRODUCT} codebuddy`;
var WORKBUDDY_NO_PRODUCT = `Install the WorkBuddy app and sign in once; it creates ~/${WORKBUDDY_PRODUCT}.`;
var WORKBUDDY_SIGNED_OUT = `WorkBuddy Heads are not signed in. Run \`${WORKBUDDY_LOGIN}\` in a terminal, type /login and finish signing in, then try again.`;
var OPENCODE_MAJOR = 2;
var majorOf = (text) => {
  const found = /(\d+)\.\d+(?:\.\d+)?/.exec(text);
  return found ? Number(found[1]) : void 0;
};
var opencodeOldWarning = (version) => `OpenCode ${version.trim()} is older than v${OPENCODE_MAJOR}, which Hydra was built against: Heads may fail. Run \`opencode upgrade\`.`;
var OPENCODE_NO_LOGIN = "OpenCode has no provider signed in: Heads can use only its free `opencode/\u2026` models. Run `opencode auth login` for others.";
var OPENCODE_NO_PROJECT_CONFIG = { OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1" };
var opencodeProviders = (stdout) => {
  try {
    const rows = JSON.parse(stdout);
    const connections = Array.isArray(rows) ? rows.flatMap((row) => Array.isArray(row?.connections) ? row.connections : []) : [];
    return { any: connections.length > 0, stored: connections.some((connection) => connection?.type === "credential") };
  } catch {
    return { any: false, stored: false };
  }
};
var opencodeCheckInit = (home, pluginRoot2, env = {}) => ({
  cwd: home || pluginRoot2,
  env: { ...env, ...OPENCODE_NO_PROJECT_CONFIG, PWD: home || pluginRoot2 },
  timeoutMs: 3e4
});
async function engineChecks($, engine, home) {
  const problems = [];
  const warnings = [];
  if (engine === "workbuddy") {
    if (!(home && await $.fs.exists(`${home}/${WORKBUDDY_PRODUCT}`).catch(() => false))) problems.push(WORKBUDDY_NO_PRODUCT);
    const stored = home ? await $.fs.list(`${home}/${WORKBUDDY_CONFIG}/local_storage`).catch(() => []) : [];
    if (problems.length === 0 && stored.length === 0) problems.push(WORKBUDDY_SIGNED_OUT);
  }
  if (engine === "opencode") {
    const argv = await commandOf($, "opencode");
    const init = opencodeCheckInit(home, $.plugin.root);
    const version = await $.process.run([...argv, "--version"], { ...init, timeoutMs: 15e3 }).catch(() => void 0);
    const major = majorOf(version?.stdout ?? "");
    if (major !== void 0 && major < OPENCODE_MAJOR) warnings.push(opencodeOldWarning(version?.stdout ?? ""));
    const auth = await $.process.run([...argv, "auth", "list", "--standalone", "--format", "json"], init).catch(() => void 0);
    if (auth?.exitCode !== 0 || !opencodeProviders(auth.stdout).any) warnings.push(OPENCODE_NO_LOGIN);
  }
  return { problems, warnings };
}

// hooks/lib/policy.ts
var USAGE_COMMAND = "hydra-usage";
var HEAD_TOOL = "mcp__hydra__head";
var HUNT_TOOL = "mcp__hydra__hunt";
var HUNT_RULE = `- Several Heads for one step (readers over an area, the pieces of one change) go out as ONE ${HUNT_TOOL} call, not many ${HEAD_TOOL} calls: they start together, and you get one merged result with each Head's status, check and edited files, the list of Heads that did not finish, and a file per full report. Give it a \`schema\` whenever you will merge, count or compare what comes back (\`schema\` works on a single ${HEAD_TOOL} call too), and \`refute: true\` when a wrong result would cost more than a second Head. Calling it again under the same \`name\` runs only the Heads that failed or whose task changed.`;
var RAMPAGE_RULES = `- The person asked for the most thorough and correct result. Head usage is not the limit here; your own context is. Where these rules and the Hydra rules above disagree, these win.
- Every substantive task runs as the phases below. Each phase is one ${HUNT_TOOL} call, and you read its result before you start the next: never skip ahead because a task looks simple. Work alone only on conversation and trivial edits.
  1. Understand. Readers, one per subsystem or question, told to change no files, with a \`schema\` for the facts they return (each with file and line). No design and no edit before you have read this result.
  2. Design, only when more than one approach is plausible. Two or three Heads each propose one from a different angle (smallest change, lowest risk, best for the user) under one \`schema\`. You choose, say why in a line, and take the best ideas of the others.
  3. Implement. One Head per piece on disjoint \`files\`, each with a \`check\` where something can run, and \`refute: true\` so every piece is attacked and fixed by its author inside the hunt. Not before the design is settled.
  4. Review. A new hunt of readers over the combined change, one lens each (correctness, edge cases, security, what the task asked for), with \`refute\` on, so only findings that survive reach you. When the size of the job is unknown (bugs, an audit, call sites), repeat the round until one brings nothing new, counting a finding once by file and line.
  5. Finalize, which is yours. Run the full build and the tests on the combined result, read the diffs a refuter disputed or no check covered, and get what is left fixed (\`resume\` the Head that wrote it, or do it yourself when it is small). Then one last Head is asked what was not read, not verified or left out; what it finds is one more round.
- Put the project facts and the hard rules once in the hunt's \`shared\`, and ask each Head for at most ~15 items, worst first.
- A hunt's \`missing\` Heads are not done. Fix what stopped them and call the hunt again under the same \`name\`: finished Heads come back from its saved results and only the rest run.
- A refute verdict of \`none\` or \`unsure\` means unverified: never report it as refuted, and never as confirmed.
- Engines. With several in the pool, spread the Heads over them; the hunt puts each refuter on another engine than its author. With one engine everything runs on that one account: the hunt gives a refuter another model where the engine has one, runs fewer Heads at once, and a usage limit ends the run sooner. So keep each hunt to about six Heads there and prefer several small hunts to one large one.
- Say what you capped or skipped, never let a limit read as full coverage, and end with each phase's outcome, what stayed unverified, and the total cost.`;
var HYDRA_HELP = `\u{1F409} Hydra: Claude leads, Heads (${ENGINES.map((name) => ENGINE_LABEL[name]).join(", ")} agents) implement.
  /hydra                 turn Hydra on, on the engines ready here (a short setup card if none is)
  /hydra <task>          turn it on and hand Claude the task
  /hydra off             turn it off
  /hydra status          show what is set
  /hydra rampage         thorough mode: Heads fan out and a second engine refutes each result; chimera adds Claude subagents as judges; calm ends it. Typing either word in a prompt (it lights up) does it for that prompt.
  /hydra effort=<level>  auto (Claude picks per Head) or off, low, medium, high, xhigh, max
  /hydra head=<model>    the model Heads run on
  /hydra engine=<name>   ${ENGINES.join(", ")}: the CLI Heads run on by default (Claude may send one Head to another ready engine); auto lets Claude pick per Head
  /hydra engines=a,b     the only engines auto may use (implies engine=auto), e.g. engines=codex,agy,codebuddy
                         A Head whose engine is at its usage limit or signed out moves to another model or ready engine on its own (headFallback setting).
  /hydra engines         which engines are installed and signed in, and what each is for
  /hydra accounts        several accounts per engine, switched on a usage limit: list, add <engine> [name], remove <engine> <name>, reset
  /hydra statusline      show Hydra in your status line
  /heads                 watch the Heads work, live: totals, a timeline and each Head's steps
  /${USAGE_COMMAND}           Claude and Head usage, and what this session's Heads used per engine`;
var CONSENT_QUESTION = (headModel, engine = DEFAULT_ENGINE) => engine === "agy" ? `Hydra hands each Head's task, and every file the Head reads, to the model Claude picks for it through the Antigravity CLI (Google: Gemini by default, or Claude and GPT-OSS models it serves), and Heads edit this project unattended (\`agy -p\` in Antigravity's terminal sandbox, locked down by Hydra's permission rules: writes only inside the project, no .git or existing .env, no network). Turn Hydra on?` : engine === "codex" ? `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through Codex (OpenAI, on your ChatGPT plan), and Heads edit this project unattended (\`codex exec\` in Codex's OS sandbox, locked down by Hydra's filesystem profile: writes only inside the project, no .git or .env, no network). Turn Hydra on?` : engine === "opencode" ? `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through OpenCode (beta), and Heads edit this project unattended (\`opencode run\`: nothing outside the project, no .git or .env, never a shell; a Head runs only at a repository's root, and symlinks it could take out of the project are denied as found when it starts). OpenCode Heads are locked down by OpenCode's own permission rules only (no OS sandbox), so the lockdown is weaker than the other engines'. Turn Hydra on?` : engine === "workbuddy" ? `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through WorkBuddy (the CodeBuddy CLI on your WorkBuddy plan, using its credits), and Heads edit this project unattended (CodeBuddy's headless mode, locked down by Hydra's permission rules and write guard: nothing outside the project, no .git or .env, no shell unless Claude asks). Turn Hydra on?` : engine === "codebuddy" ? `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through CodeBuddy, and Heads edit this project unattended (CodeBuddy's headless mode, locked down by Hydra's permission rules and write guard: nothing outside the project, no .git or .env, no shell unless Claude asks). Turn Hydra on?` : `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through Command Code, and Heads edit this project unattended (Command Code's --yolo, locked down by Hydra: nothing outside the project, no .git or .env, no shell unless Claude asks). Turn Hydra on?`;
var CONSENT_YES = "Turn Hydra on";
var CHECK_CONSENT_QUESTION = (check) => `Claude asked Hydra to run an acceptance check after a Head finishes: \`${check.slice(0, 200)}\`. Hydra runs it in the project as you, outside the Head's lockdown and without asking again, and that runs code the Head may have just written (tests, build scripts). On a failure the Head is sent back with the check's last output, which goes to its model. Let Hydra run checks like this from now on?`;
var CHECK_CONSENT_YES = "Run checks";
var NO_CHECK_CONSENT = "The person has not agreed to let Hydra run checks. Run the Head without `check` and run the build or tests yourself.";
var NO_CONSENT = "The person has not agreed to send code to this engine. They turn it on with /hydra engine=<name> (or engines=\u2026), which asks them.";
var PROVIDER = {
  commandcode: "DeepSeek",
  codebuddy: "DeepSeek",
  codex: "OpenAI",
  agy: "Google: Gemini, Claude, GPT-OSS",
  workbuddy: "DeepSeek (via WorkBuddy)",
  opencode: "the model you pick in OpenCode"
};
var OPENCODE_WEAKER = "OpenCode Heads are locked down by OpenCode's own permission rules only (no OS sandbox), so the lockdown is weaker than the other engines'.";
var AUTO_CONSENT_QUESTION = (engines) => `Hydra will let Claude route Heads across ${engines.map((engine) => `${ENGINE_LABEL[engine]} (${PROVIDER[engine]})`).join(", ")}. Each Head's task, and every file it reads, goes to the model of the engine it picks, and Heads edit this project unattended inside that engine's lockdown (writes only in the project, no .git, .env files kept out where the engine can, no network where the engine can block it).${engines.includes("opencode") ? ` ${OPENCODE_WEAKER}` : ""} Turn Hydra on?`;

// agy/shim.ts
var keyOf = (source) => `${source.ref.plugin}/${source.ref.key}${source.ref.id ? `/${source.ref.id}` : ""}`;
var atom = (ref, initial) => ({ ref, initial });
var read = async ($, source) => $.state.has(keyOf(source)) ? $.state.get(keyOf(source)) : source.initial;
var chain = Promise.resolve();
var update = ($, source, change) => {
  const next = chain.then(async () => {
    const value = change(await read($, source));
    $.state.set(keyOf(source), value);
    return value;
  });
  chain = next.catch(() => void 0);
  return next;
};

// hooks/lib/state.ts
var lead = atom({ plugin: "hydra", key: "lead" }, []);
var heads = atom({ plugin: "hydra", key: "heads" }, null);
var warned = atom({ plugin: "hydra", key: "warned" }, []);
var mode = atom({ plugin: "hydra", key: "mode" }, null);
var runs = atom({ plugin: "hydra", key: "runs" }, []);
var selected = atom({ plugin: "hydra", key: "selected" }, null);
var tick = atom({ plugin: "hydra", key: "tick" }, 0);
async function readMode($) {
  return read($, mode);
}
async function readRuns($) {
  return read($, runs);
}
async function updateHeads($, change) {
  return update($, heads, change);
}
async function updateMode($, change) {
  return update($, mode, change);
}
async function updateRuns($, change) {
  return update($, runs, change);
}
async function updateTick($, change) {
  return update($, tick, change);
}

// hooks/lib/runtime.ts
var STATUS_KEEP_MS = 7 * 864e5;
var CONSENT_KEY = "consent-v1";
var DONE_MARK = "HEAD DONE";
var BLOCKED_MARK = "HEAD BLOCKED";
var STALL_ROUNDS = 2;
var HANDOFF_TURNS = 2;
var HANDOFF_MS = 12e4;
var MAX_ROUNDS = 8;
var MAX_PARALLEL = 6;
var HUNT_PARALLEL = 10;
var DEFAULT_MINUTES = 40;
var START_RETRIES = 2;
var configuredEngine = DEFAULT_ENGINE;
var statusFile = (home, sessionId) => `${home}/.claude/hydra/status/${sessionId}.txt`;
var lastStatus;
async function refreshStatus($) {
  const line = statusMark(await readMode($)) ?? "";
  if (line === lastStatus) return;
  const home = await homeOf($);
  if (!home) return;
  await $.fs.write(statusFile(home, await $.session.id()), line ? `${line}
` : "");
  lastStatus = line;
}
async function announceEnding($, id) {
  try {
    const surfaces = await $.session.surfaces();
    if (!surfaces.some((surface) => surface !== "terminal")) return;
    const run = (await readRuns($)).find((entry) => entry.id === id);
    if (!run || run.state !== "done" && run.state !== "failed") return;
    $.ui.log(`\u{1F409} ${id} ${lookOf(run, 0).glyph} ${rowLine(run)}`);
  } catch {
  }
}
var preflightPassed = /* @__PURE__ */ new Set();
var INSTALL_HINT = {
  commandcode: "The Command Code CLI is not installed. Run `npm i -g command-code`, then `commandcode` once in a terminal to sign in.",
  codebuddy: "The CodeBuddy CLI is not installed. Run `npm i -g @tencent-ai/codebuddy-code`, then `codebuddy` once in a terminal to sign in.",
  codex: "The Codex CLI is not installed. Run `npm i -g @openai/codex`, then `codex login` in a terminal to sign in.",
  agy: "The Antigravity CLI is not installed. Run `curl -fsSL https://antigravity.google/cli/install.sh | bash` (read the script first if you like), then `agy` once in a terminal to sign in.",
  workbuddy: `The CodeBuddy CLI is not installed. WorkBuddy Heads run it: run \`npm i -g @tencent-ai/codebuddy-code\`, then \`${WORKBUDDY_LOGIN}\` and /login to sign in.`,
  opencode: "The OpenCode CLI is not installed. Run `curl -fsSL https://opencode.ai/install | bash` (or `npm i -g opencode-ai`), then `opencode auth login`, or use its free models without signing in."
};
var WINDOWS_ENGINES = /* @__PURE__ */ new Set(["commandcode"]);
var windowsRefusal = (engine) => `${ENGINE_LABEL[engine]} Heads are not locked down on native Windows yet, so Hydra will not start them there. Run Claude Code under WSL (every engine works there)${WINDOWS_ENGINES.size > 0 ? `, or use ${[...WINDOWS_ENGINES].map((name) => ENGINE_LABEL[name]).join(" or ")}` : ""}.`;
async function preflight($, engine = DEFAULT_ENGINE) {
  if (preflightPassed.has(engine)) return { problems: [], warnings: [] };
  const works = (argv) => $.process.run(argv, { timeoutMs: 15e3 }).then((ran) => ran.exitCode === 0, () => false);
  const isWindows = await platformOf($) === "windows";
  if (isWindows && !WINDOWS_ENGINES.has(engine)) return { problems: [windowsRefusal(engine)], warnings: [] };
  const problems = [];
  if (!await canRun($, ENGINE_BIN[engine])) problems.push(INSTALL_HINT[engine]);
  if (!await pythonOf($)) {
    problems.push(isWindows ? "Python 3 is missing; Hydra reads Head transcripts with it. Install it from python.org (it adds the `py` launcher)." : "python3 is missing; Hydra reads Head transcripts with it. Install it (on macOS: `xcode-select --install`).");
  }
  if (!await works(["git", "--version"])) problems.push("git is missing. Install it (on macOS: `xcode-select --install`).");
  const home = await homeOf($);
  const warnings = [];
  if (engine === "codex" && problems.length === 0 && !await canRun($, "codex", ["login", "status"])) {
    problems.push("Codex is not signed in. Run `codex login` in a terminal (`codex login --device-auth` on a remote machine), then try again.");
  }
  if (engine === "agy" && problems.length === 0 && !(home && await $.fs.exists(`${home}/${AGY_TOKEN}`).catch(() => false))) {
    const keyring = await platformOf($) === "darwin" ? "the macOS keychain" : "the system keyring";
    warnings.push(`Antigravity keeps its sign-in in ${keyring} here, so Hydra cannot check it before a Head starts. If a Head stops with "not signed in", run \`agy\` once in a terminal.`);
  }
  const isSignedIn = engine !== "commandcode" || (home ? await $.fs.exists(`${home}/.commandcode/auth.json`).catch(() => false) : false);
  if (!isSignedIn && problems.length === 0) warnings.push("Command Code looks signed out: run `commandcode` once in a terminal to sign in, or Heads will fail.");
  if (problems.length === 0) {
    const extra = await engineChecks($, engine, home);
    problems.push(...extra.problems);
    warnings.push(...extra.warnings);
  }
  if (problems.length === 0) preflightPassed.add(engine);
  return { problems, warnings };
}
var preflightText = (check) => [`\u{1F409} Hydra can't start yet:`, ...check.problems.map((problem) => `  \u2022 ${problem}`), "Then run /hydra again."].join("\n");
var needsEngineCheck = (action, input) => action === "on" || input.engine !== void 0 || input.engines !== void 0;
var consentKey = (engine) => engine === "commandcode" ? CONSENT_KEY : `${CONSENT_KEY}:${engine}`;
async function hasConsentAll($, engines, mayAsk) {
  const missing = [];
  for (const engine of engines) if (await $.store.get(consentKey(engine)) !== true) missing.push(engine);
  if (missing.length === 0) return true;
  if (!mayAsk) return false;
  const answer = await $.ui.ask(AUTO_CONSENT_QUESTION(missing), { options: [CONSENT_YES, "Not now"], header: "Hydra" }).catch(() => void 0);
  if (answer !== CONSENT_YES) return false;
  for (const engine of missing) await $.store.set(consentKey(engine), true);
  return true;
}
async function readyEngines($, wanted) {
  const pool = [];
  const skipped = [];
  const warnings = [];
  for (const engine of wanted) {
    const check = await preflight($, engine);
    if (check.problems.length === 0) {
      pool.push(engine);
      warnings.push(...check.warnings);
    } else skipped.push({ engine, problem: check.problems[0] });
  }
  return { pool, skipped, warnings };
}
var CHECK_CONSENT_KEY = "consent-check-v1";
async function hasCheckConsent($, check) {
  if (await $.store.get(CHECK_CONSENT_KEY) === true) return true;
  const answer = await $.ui.ask(CHECK_CONSENT_QUESTION(check), { options: [CHECK_CONSENT_YES, "Not now"], header: "Hydra" }).catch(() => void 0);
  if (answer !== CHECK_CONSENT_YES) return false;
  await $.store.set(CHECK_CONSENT_KEY, true);
  return true;
}
async function hasConsent($, headModel, mayAsk, engine = DEFAULT_ENGINE) {
  const key = consentKey(engine);
  if (await $.store.get(key) === true) return true;
  if (!mayAsk) return false;
  const answer = await $.ui.ask(CONSENT_QUESTION(headModel, engine), { options: [CONSENT_YES, "Not now"], header: "Hydra" }).catch(() => void 0);
  if (answer !== CONSENT_YES) return false;
  await $.store.set(key, true);
  return true;
}
async function refreshHeads($) {
  const hydra = await readMode($);
  const engine = engineOf(hydra, configuredEngine);
  const hasCommandCode = isAuto(hydra) ? poolOf(hydra).includes("commandcode") : engine === "commandcode";
  if (!hasCommandCode) {
    const measuredAt = await $.clock.now();
    const error = isAuto(hydra) ? AUTO_NO_SPEND : engine === "agy" ? AGY_NO_SPEND : engine === "codex" ? CODEX_NO_SPEND : engine === "workbuddy" ? WORKBUDDY_NO_SPEND : engine === "opencode" ? OPENCODE_NO_SPEND : CODEBUDDY_NO_SPEND;
    await updateHeads($, () => ({ fiveHour: { usd: 0, resetsAt: null }, weekly: { usd: 0, resetsAt: null }, measuredAt, error }));
    await refreshStatus($);
    return;
  }
  try {
    const ran = await runScript($, "cc-usage.py", [], 2e4);
    const usage = JSON.parse(ran.stdout);
    await updateHeads($, () => usage);
  } catch (error) {
    const measuredAt = await $.clock.now();
    await updateHeads($, () => ({
      fiveHour: { usd: 0, resetsAt: null },
      weekly: { usd: 0, resetsAt: null },
      measuredAt,
      error: String(error).slice(0, 120)
    }));
  }
  await refreshStatus($);
}
async function setRun($, id, change) {
  await updateRuns($, (list) => list.map((run) => run.id === id ? { ...run, ...typeof change === "function" ? change(run) : change } : run));
}
var HEAD_RULES = `

Rules for this run:
- Work through tool calls. A reply with text alone ends your turn, so never send one until you are finished or blocked.
- A denied tool call stays denied: do not retry it or work around it. If the task cannot be done without it, you are blocked.
- You may have no way to build, run or test here (no shell, no network, a missing toolchain). That is expected, and the Lead verifies your work: never wait for results or ask for them. Finish the code and list what you could not check under "Unverified".
- Write and change files with your file tools (apply_patch, write or edit), never through shell redirection or here-documents.
- Do the work yourself: start no subagents, swarms or background agents.
- Stay inside the task: do not refactor, rename or reformat what it does not name, and never delete code another file still uses.
- When the work is finished, end with a short report, most important first, and then the line ${DONE_MARK}:
  Done: what now works, in a few lines.
  Changed: each file and what changed in it.
  Unverified: what you could not build, run or test (or "nothing").
  Notes: what the Lead must know or decide (leave out if nothing).
- If you cannot finish (a missing file, a contradiction in the task, access you need was denied), do not guess: say what you finished, what stops you and what you need, then end with the line ${BLOCKED_MARK}.
- ${BLOCKED_MARK} is only for access you lack or a decision you cannot make. A partial audit, turns still left, or leftover temp or build files you could not delete are not blockers: keep working, or finish and list them under Notes.`;
var deniedNote = (denied) => denied.length > 0 ? `These calls were denied and will stay denied, so do not retry them: ${denied.join("; ")}.` : "";
var ENDINGS = `If the work is already complete, do not wait for anyone to verify it: reply with your report (what you could not check goes under "Unverified") and the line ${DONE_MARK}. If you cannot proceed, say what stops you and end with the line ${BLOCKED_MARK}.`;
var continuePrompt = (denied) => ["Continue the task from where you stopped. Do not describe what you will do next: make the tool calls.", deniedNote(denied), ENDINGS].filter(Boolean).join(" ");
var nudgePrompt = (denied) => ["Your last reply made no tool call and did not end the run. Hydra stops this run if your next reply does neither.", deniedNote(denied), `Make the next tool call now. ${ENDINGS}`].filter(Boolean).join(" ");
var handoffPrompt = (limit) => `You have reached this run's ${limit} limit. Make no more tool calls. Reply now with a handoff for whoever continues: Done (what is finished and works), Not done (what remains, in order), Next step (the exact file and change to start with), Unverified (what you could not check). End the handoff with no closing line; only if everything in the task is in fact finished, end with the line ${DONE_MARK} instead.`;
var followUpPrompt = (task) => `Follow-up from the Lead on your earlier work in this session (your previous edits are still in the files):

${task}${HEAD_RULES}`;
var endMark = (text) => {
  const done = text.lastIndexOf(DONE_MARK);
  const blocked = text.lastIndexOf(BLOCKED_MARK);
  if (done < 0 && blocked < 0) return void 0;
  return done > blocked ? "done" : "blocked";
};
var summaryOf = (text) => text.replace(DONE_MARK, "").replace(BLOCKED_MARK, "").split("\n").map((line) => line.trim()).filter(Boolean).slice(-6).map((line) => line.slice(0, 200)).join("\n") || void 0;
var isResumable = (code) => code === 0 || code === 8 || code === 9;
async function resolveWriteDirs($, cwd, dirs) {
  const home = await homeOf($);
  const realHome = home ? (await $.fs.stat(home, { resolve: true }).catch(() => void 0))?.realPath ?? home : "";
  const realCwd = (await $.fs.stat(cwd, { resolve: true }).catch(() => void 0))?.realPath ?? cwd;
  const resolved2 = [];
  for (const dir of dirs) {
    if (!dir.startsWith("/")) return { refusal: `writeDirs needs absolute folders; "${dir}" is not one.` };
    const stat2 = await $.fs.stat(dir, { resolve: true }).catch(() => void 0);
    const real = stat2?.realPath;
    if (!stat2 || stat2.kind !== "dir" || !real) return { refusal: `writeDirs: ${dir} is not an existing folder.` };
    if (real === "/" || realHome && isWithin(realHome, real) || isWithin(realCwd, real)) return { refusal: `writeDirs: ${dir} is too broad: it holds the project or your home folder. Name the folder the task changes.` };
    const secret = secretDirRefusal([real], realHome, "writeDirs");
    if (secret) return { refusal: secret };
    if (isWithin(real, realCwd)) return { refusal: `writeDirs: ${dir} is inside the project, which a Head can write to already.` };
    resolved2.push(real);
  }
  return { dirs: union(resolved2) };
}
var createGate = (initial) => {
  let limit = initial;
  let active = 0;
  const waiting = [];
  return {
    get active() {
      return active;
    },
    get waiting() {
      return waiting.length;
    },
    get limit() {
      return limit;
    },
    async enter() {
      if (active < limit) {
        active++;
        return;
      }
      await new Promise((resolve4) => waiting.push(resolve4));
    },
    leave() {
      const nextInLine = active <= limit ? waiting.shift() : void 0;
      if (nextInLine) nextInLine();
      else active = Math.max(0, active - 1);
    },
    /** A higher limit lets waiting Heads in at once; a lower one takes effect as running Heads end. */
    setLimit(next) {
      limit = Math.max(1, next);
      while (active < limit && waiting.length > 0) {
        active++;
        waiting.shift()();
      }
    }
  };
};
var gate = createGate(MAX_PARALLEL);
var controllers = /* @__PURE__ */ new Map();
var stopReason = (signal) => typeof signal.reason === "string" && signal.reason ? signal.reason : "stopped";
async function stopHeadsNow($, ids, reason) {
  for (const id of ids) controllers.get(id)?.abort(reason);
  const ghosts = ids.filter((id) => !controllers.has(id));
  const now = await $.clock.now();
  if (ghosts.length > 0) await updateRuns($, (current) => stopRuns(current, ghosts, `${reason} (no live process)`, now));
  await refreshStatus($);
  return ghosts;
}
var usedNames = /* @__PURE__ */ new Set();
var createQueue = () => {
  const jobs = [];
  let wake;
  return {
    get size() {
      return jobs.length;
    },
    push(job) {
      jobs.push(job);
      const resume = wake;
      wake = void 0;
      resume?.();
    },
    async next() {
      while (jobs.length === 0) await new Promise((resolve4) => wake = resolve4);
      return jobs.shift();
    }
  };
};
var createJobQueue = () => createQueue();
var backgroundJobs = createJobQueue();
var pendingPrompts = createQueue();
var silenceLeft = (limits, startedAt, lastOutputAt, now) => {
  const limit = lastOutputAt === void 0 ? limits.firstMs : limits.idleMs;
  return limit === void 0 ? void 0 : Math.max(0, (lastOutputAt ?? startedAt) + limit - now);
};
async function pump($, args, cwd, signal, onLine, env, idle) {
  const [bin, ...rest] = args;
  const child = $.process.spawn({ argv: [...await commandOf($, bin), ...rest], cwd, input: "", ...env ? { env } : {} });
  let pending = "";
  let errors = "";
  let isStopped = false;
  let isIdle = false;
  const startedAt = idle ? await $.clock.now() : 0;
  let lastOutputAt;
  const aborted = new Promise((resolve4) => {
    if (signal.aborted) resolve4("aborted");
    else signal.addEventListener("abort", () => resolve4("aborted"), { once: true });
  });
  for (; ; ) {
    const left = idle ? silenceLeft(idle, startedAt, lastOutputAt, await $.clock.now()) : void 0;
    const timer = new AbortController();
    const silent = left === void 0 ? new Promise(() => void 0) : $.clock.sleep(left, { signal: timer.signal }).then(() => "idle", () => new Promise(() => void 0));
    const step = await Promise.race([child.next(), aborted, silent]);
    timer.abort();
    if (step === "aborted") {
      void child.return({ code: null, signal: "aborted" }).catch(() => void 0);
      break;
    }
    if (step === "idle") {
      isIdle = true;
      void child.return({ code: null, signal: "idle" }).catch(() => void 0);
      break;
    }
    if (step.done) break;
    const { stream, text } = step.value;
    if (stream === "stderr") {
      errors = (errors + text).slice(-2e3);
      continue;
    }
    if (idle) lastOutputAt = await $.clock.now();
    const lines = (pending + text).split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (await onLine(line)) isStopped = true;
      if (isStopped) break;
    }
    if (isStopped) {
      void child.return({ code: null, signal: "stopped" }).catch(() => void 0);
      break;
    }
  }
  if (!isStopped && !isIdle && !signal.aborted && await onLine(pending)) isStopped = true;
  const exit = signal.aborted ? { code: null, signal: "aborted" } : isIdle ? { code: null, signal: "idle" } : isStopped ? { code: null, signal: "stopped" } : await child.result.catch(() => ({ code: null, signal: "lost" }));
  return { errors, exit: { code: exit.code ?? null, signal: "signal" in exit ? String(exit.signal ?? "") : void 0 }, isStopped };
}
var notStarted = (id, model, cwd, reason, engine = "codebuddy", engineBound) => ({
  text: formatReport({
    id,
    model,
    cwd,
    finished: false,
    rounds: 0,
    turns: 0,
    usd: 0,
    files: [],
    denied: [],
    finalText: "",
    exit: "not started",
    rulesNote: reason,
    engine
  }),
  isDone: false,
  ...engineBound ? { engineBound } : {}
});
async function realPaths2($, paths) {
  return realPaths($, paths);
}
async function changedFiles($, since, dirs) {
  try {
    const ran = await runScript($, "changed-files.py", [String(since - 2e3), ...dirs]);
    return JSON.parse(ran.stdout);
  } catch {
    return [];
  }
}
async function changedFileTimes($, since, dirs) {
  try {
    const ran = await runScript($, "changed-files.py", ["--times", String(since), ...dirs]);
    return JSON.parse(ran.stdout);
  } catch {
    return {};
  }
}
var STAT_FILES = 200;
async function diffStat($, cwd, files) {
  const root = `${cwd.replace(/\/$/, "")}/`;
  const paths = files.map((file) => file.startsWith(root) ? file.slice(root.length) : file).filter((path) => path && !path.startsWith("/") && !/^[A-Za-z]:/.test(path)).slice(0, STAT_FILES);
  if (paths.length === 0) return {};
  const git = (args) => $.process.run(["git", "-C", cwd, ...args, "--", ...paths], { timeoutMs: 15e3 }).then((ran) => ran.exitCode === 0 ? ran.stdout : void 0, () => void 0);
  const numstat = await git(["diff", "--numstat", "-z", "--no-renames", "--relative", "HEAD"]);
  if (numstat === void 0) return {};
  return parseDiffStat(numstat, await git(["ls-files", "--others", "--exclude-standard", "-z"]) ?? "");
}
var ownEdits = /* @__PURE__ */ new Map();
var keepOwnEdits = (id, files) => void ownEdits.set(id, new Set(files));
var editsBefore = /* @__PURE__ */ new Map();
async function snapshotChangedFiles($, id, dirs) {
  const kept = editsBefore.get(id);
  if (kept) return kept;
  try {
    const ran = await runScript($, "changed-files.py", ["--snapshot", ...dirs]);
    const snapshot = JSON.parse(ran.stdout);
    editsBefore.set(id, snapshot);
    return snapshot;
  } catch {
    editsBefore.set(id, {});
    return {};
  }
}
async function snapshotFile($, id, snapshot) {
  const temp = await $.env.get("TMPDIR") || await $.env.get("TEMP") || "/tmp";
  const file = `${temp.replace(/\/$/, "")}/hydra-edits-${id}.json`;
  await $.fs.write(file, JSON.stringify(snapshot));
  return file;
}
async function compareChangedFiles($, id, head, dirs) {
  const snapshot = editsBefore.get(id) ?? {};
  let edits = { overwritten: [], reverted: [], deleted: [], restored: [] };
  let file;
  try {
    file = await snapshotFile($, id, snapshot);
    const since = head.startedAt ?? await $.clock.now();
    const ran = await runScript($, "changed-files.py", ["--compare", file, String(since), ...dirs]);
    const parsed = JSON.parse(ran.stdout);
    const own = ownEdits.get(id);
    edits = { overwritten: (parsed.overwritten ?? []).filter((path) => !own?.has(relativeTo(head.cwd, path))), reverted: parsed.reverted ?? [], deleted: parsed.deleted ?? [], restored: parsed.restored ?? [] };
  } catch {
  } finally {
    if (file) await $.process.run(["/bin/rm", "-f", file]).catch(() => void 0);
  }
  return { ...edits, alsoRan: overlappingHeads(await readRuns($), { id, ...head }) };
}
var forgetChangedFiles = (id) => {
  editsBefore.delete(id);
  ownEdits.delete(id);
};

// hooks/lib/rounds.ts
var isSuccess = (round) => round.code === 0 && round.subtype === "success";
async function runRounds(steps) {
  const { task, maxTurns, minutes, outer } = steps;
  const controller = new AbortController();
  if (outer.aborted) controller.abort();
  else outer.addEventListener("abort", () => controller.abort(), { once: true });
  let timedOut = false;
  const timerStop = new AbortController();
  void Promise.resolve(steps.sleep(minutes * 6e4, timerStop.signal)).then(
    () => {
      timedOut = true;
      controller.abort();
    },
    () => void 0
  );
  const signal = controller.signal;
  const first = steps.resume ? { prompt: followUpPrompt(task), maxTurns, resume: steps.resume } : { prompt: task + HEAD_RULES, maxTurns };
  let callsBefore = steps.calls();
  let silent = 0;
  const countRound = () => {
    silent = steps.calls() === callsBefore ? silent + 1 : 0;
    callsBefore = steps.calls();
  };
  let round = await steps.runRound(first, signal);
  for (let attempt = 1; !steps.resume && !round.sessionId && !round.startedSession && !signal.aborted && (steps.mayRetryStart?.(round) ?? true) && attempt <= START_RETRIES; attempt++) {
    await Promise.resolve(steps.sleep(attempt * 5e3, signal)).catch(() => void 0);
    round = await steps.runRound(first, signal);
  }
  countRound();
  const kept = steps.resume && (round.code === null || isResumable(round.code)) ? steps.resume : void 0;
  const sessionId = round.sessionId ?? round.startedSession ?? await steps.findSession?.() ?? kept;
  let rounds = 1;
  const mayGoOn = () => !signal.aborted && !!sessionId && isResumable(round.code) && (steps.mayResume?.(round) ?? true) && !endMark(round.finalText);
  while (mayGoOn() && silent < STALL_ROUNDS && rounds < MAX_ROUNDS && steps.turns() < maxTurns) {
    await steps.onStep?.(`resuming (round ${rounds + 1})`);
    const denied = await steps.denied(sessionId);
    round = await steps.runRound({ prompt: silent > 0 ? nudgePrompt(denied) : continuePrompt(denied), maxTurns: maxTurns - steps.turns(), resume: sessionId }, signal);
    rounds++;
    countRound();
  }
  timerStop.abort();
  const mark = endMark(round.finalText);
  const outOfTurns = round.code === 8 || round.subtype === "error_max_turns" || steps.turns() >= maxTurns;
  const outOfRounds = rounds >= MAX_ROUNDS && isResumable(round.code);
  let ending = mark === "done" && isSuccess(round) ? "done" : outer.aborted ? "stopped" : timedOut ? "timeout" : mark === "blocked" ? "blocked" : mark ? "error" : silent >= STALL_ROUNDS && isResumable(round.code) ? "stalled" : outOfTurns || outOfRounds ? "capped" : "error";
  const cap = ending === "capped" ? outOfTurns ? "turn" : "round" : void 0;
  if ((ending === "capped" || ending === "timeout") && sessionId && !outer.aborted) {
    const grace = new AbortController();
    outer.addEventListener("abort", () => grace.abort(), { once: true });
    const graceStop = new AbortController();
    void Promise.resolve(steps.sleep(HANDOFF_MS, graceStop.signal)).then(() => grace.abort(), () => void 0);
    await steps.onStep?.("writing a handoff");
    const handoff = await steps.runRound({ prompt: handoffPrompt(ending === "timeout" ? "time" : cap ?? "turn"), maxTurns: HANDOFF_TURNS, resume: sessionId, isHandoff: true }, grace.signal);
    graceStop.abort();
    rounds++;
    if (handoff.finalText.trim()) {
      if (ending === "capped" && endMark(handoff.finalText) === "done" && isSuccess(handoff)) ending = "done";
      round = { ...handoff, code: ending === "done" ? handoff.code : round.code, subtype: ending === "done" ? handoff.subtype : round.subtype, errors: round.errors };
    }
  }
  return { round, rounds, sessionId, ending, ...ending === "capped" && cap ? { cap } : {} };
}
var endActivity = (result, head) => {
  switch (result.ending) {
    case "done":
      return void 0;
    case "stopped":
      return head.stopped ?? "stopped";
    case "timeout":
      return `timed out after ${head.minutes} min`;
    case "blocked":
      return "blocked: see its report";
    case "stalled":
      return "stalled: replied without acting or finishing";
    case "capped":
      return result.cap === "round" ? `stopped after ${MAX_ROUNDS} rounds` : `stopped at the ${head.maxTurns}-turn cap`;
    default: {
      const failure = result.round.errors.trim().split("\n").at(-1)?.trim();
      return failure ? `failed: ${failure.slice(0, 60)}` : "stopped before HEAD DONE";
    }
  }
};
var exitOf = (result, head) => result.ending === "timeout" ? `timed out after ${head.minutes} min` : result.ending === "stopped" ? head.stopped ?? "stopped" : String(result.round.code ?? result.round.signal);
var createCallCounter = () => {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    see(event) {
      if (event.type === "tool_completed" || event.type === "tool_denied") calls++;
    }
  };
};

// hooks/lib/protect.ts
var IGNORE_FILE = ".hydraignore";
var IGNORE_CAP = 200;
var NO_GUARD = { paths: [], folders: [], ignoreFiles: [] };
var ignoredFrom = (stdout) => stdout.split("\0").filter(Boolean);
var tooManyIgnored = (count) => `${IGNORE_FILE} matches ${count} paths, more than the ${IGNORE_CAP} Hydra can deny one by one. Name whole folders (\`secrets/\`) instead of the files in them, then run the Head again.`;
var unreadableIgnore = (file, why) => `${file} could not be read (${why}). Hydra reads it with git, so the folder must be in a git repository. Fix that or remove the file, then run the Head again.`;
async function guardedPaths($, roots) {
  const paths = /* @__PURE__ */ new Set();
  const folders = /* @__PURE__ */ new Set();
  const ignoreFiles = /* @__PURE__ */ new Set();
  let count = 0;
  for (const { path, real } of roots) {
    const root = trimSlash(path);
    const spellings = [.../* @__PURE__ */ new Set([root, ...real ? [trimSlash(real)] : []])];
    const file = `${root}/${IGNORE_FILE}`;
    if (!await $.fs.exists(file).catch(() => true)) continue;
    const ran = await $.process.run(["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--ignored", "--directory", `--exclude-per-directory=${IGNORE_FILE}`], { timeoutMs: 3e4 }).catch(() => void 0);
    if (!ran) return { refusal: unreadableIgnore(file, "git could not run or took over 30 seconds") };
    if (ran.exitCode !== 0) return { refusal: unreadableIgnore(file, ran.stderr.trim().split("\n")[0]?.slice(0, 160) || `git exited ${ran.exitCode}`) };
    if (ran.isStdoutTruncated) return { refusal: tooManyIgnored(IGNORE_CAP + 1) };
    const matches = ignoredFrom(ran.stdout);
    count += matches.length;
    for (const spelling of spellings) {
      ignoreFiles.add(`${spelling}/${IGNORE_FILE}`);
      for (const rel of matches) {
        const path2 = `${spelling}/${rel.replace(/\/+$/, "")}`;
        paths.add(path2);
        if (rel.endsWith("/")) folders.add(path2);
      }
    }
  }
  if (count > IGNORE_CAP) return { refusal: tooManyIgnored(count) };
  return { paths: [...paths].sort(), folders: [...folders].sort(), ignoreFiles: [...ignoreFiles].sort() };
}
var baseName = (path) => trimSlash(path).split("/").pop() ?? path;
async function snapshotIgnoreFiles($, files) {
  const snapshot = /* @__PURE__ */ new Map();
  for (const file of files) snapshot.set(file, await $.fs.read(file).catch(() => null));
  return snapshot;
}
var ignoreChanges = (before, after) => [...before].filter(([file, text]) => text !== null && after.get(file) !== text).map(([file]) => file);
var ignoreChangedLine = (files) => `\u26A0 .hydraignore REMOVED OR CHANGED during this Head (${files.join(", ")}): restore it before the next Head runs`;

// hooks/engines/opencode.ts
var OPENCODE_TOOLS = {
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  apply_patch: "edit_file",
  patch: "edit_file",
  glob: "glob",
  grep: "grep",
  shell: "shell_command",
  bash: "shell_command"
};
var OPENCODE_SAFE_TOOLS = /* @__PURE__ */ new Set(["read", "write", "edit", "apply_patch", "patch", "glob", "todowrite", "todoread", "invalid"]);
var OPENCODE_EDIT_TOOLS = /* @__PURE__ */ new Set(["write", "edit", "apply_patch", "patch"]);
var OPENCODE_DENIAL = /permission denied|auto-rejecting|rejected permission/i;
var OPENCODE_DENY = [
  "bash",
  "shell",
  "grep",
  "execute",
  "webfetch",
  "websearch",
  "task",
  "subagent",
  "question",
  "skill",
  "lsp",
  "doom_loop",
  "list_mcp_resources",
  "read_mcp_resource"
];
var caseVariants = (name) => [...name].reduce((spellings, char) => {
  const forms = /[a-z]/i.test(char) ? [char.toLowerCase(), char.toUpperCase()] : [char];
  return spellings.flatMap((spelling) => forms.map((form) => spelling + form));
}, [""]);
var anyCase = (path, exact = 2) => {
  let letters = 0;
  return [...path].reduce((spellings, char) => {
    const isLetter = char.toLowerCase() !== char.toUpperCase();
    const forms = !isLetter ? [char] : /[a-z]/i.test(char) && letters++ < exact ? [char.toLowerCase(), char.toUpperCase()] : ["?"];
    return spellings.flatMap((spelling) => forms.map((form) => spelling + form));
  }, [""]);
};
var patternRegex = (pattern) => {
  let source = pattern.replace(/\\/g, "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`;
  return new RegExp(`^${source}$`, "s");
};
var rulesOf = (entries) => {
  const rules = {};
  for (const [pattern, rule] of entries) {
    const key = /^(0|[1-9][0-9]*)$/.test(pattern) ? `${pattern}*` : pattern;
    delete rules[key];
    rules[key] = rule;
  }
  return rules;
};
var below = (path) => [path, `${path}/*`];
var OPENCODE_GIT = caseVariants(".git").flatMap((name) => [...below(name), ...below(`*/${name}`)]);
var OPENCODE_ENV = caseVariants(".env").flatMap((name) => [`*${name}`, `*${name}.*`]);
var CONFIG_TOO_LARGE = `The OpenCode config for this Head would be too large to pass (the project's symlinks and .hydraignore matches each need rules). Name whole folders in .hydraignore instead of the files in them, or use another engine here.`;
var OPENCODE_IGNORE = anyCase(IGNORE_FILE).map((spelling) => `*${spelling}`);
var OPENCODE_PROTECTED = [
  ...[".opencode", ".claude", ".codebuddy"].flatMap((name) => [...below(name), ...below(`*/${name}`)]),
  "opencode.json*",
  "*/opencode.json*"
];
var ENV_REGEXES = OPENCODE_ENV.map(patternRegex);
var PROTECTED_REGEXES = [...OPENCODE_ENV, ...OPENCODE_GIT, ...OPENCODE_PROTECTED].map(patternRegex);
var isEnvPath = (path) => ENV_REGEXES.some((regex) => regex.test(path));
var isProtectedPath = (path) => {
  const lower = path.toLowerCase();
  return PROTECTED_REGEXES.some((regex) => regex.test(lower));
};
var OPENCODE_LINK_CAP = 100;
var grantsOf = (cwd, head) => {
  const writable = [cwd, ...head.writeDirs ?? []].map(trimSlash);
  const readOnly = head.addDirs.map(trimSlash).filter((dir) => !writable.some((root) => isWithin(dir, root)));
  return { writable, readOnly };
};
var linkDenies = (links, cwd, head, limit = OPENCODE_LINK_CAP) => {
  const { writable, readOnly } = grantsOf(trimSlash(cwd), head);
  const readable = [...writable, ...readOnly];
  const read2 = /* @__PURE__ */ new Set();
  const edit = /* @__PURE__ */ new Set();
  const holds = (target, denied) => [...denied].some((path) => path !== target && isWithin(path, target));
  const guarded = (head.guarded?.paths ?? []).map((path) => path.toLowerCase());
  const isGuarded = (target) => guarded.some((path) => isWithin(target.toLowerCase(), path) || isWithin(path, target.toLowerCase()));
  for (let isChanged = true; isChanged && edit.size <= limit; ) {
    isChanged = false;
    for (const { path, target } of links) {
      const isAlias = isWithin(path, target);
      if (!read2.has(path) && (isAlias || isEnvPath(target) || isGuarded(target) || !readable.some((root) => isWithin(target, root)) || holds(target, read2))) {
        read2.add(path);
        isChanged = true;
      }
      const isUnwritable = !writable.some((root) => isWithin(target, root)) || readOnly.some((root) => isWithin(target, root)) || isProtectedPath(target);
      if (!edit.has(path) && (isAlias || isUnwritable || read2.has(path) || holds(target, [...edit, ...readOnly]))) {
        edit.add(path);
        isChanged = true;
      }
    }
  }
  return { read: [...read2].sort(), edit: [...edit].sort() };
};
var spellingsOf = (path, cwd, roots) => {
  if (path !== cwd && isWithin(path, cwd)) return anyCase(path.slice(cwd.length + 1));
  const root = roots.filter((dir) => dir !== path && isWithin(path, dir)).sort((a, b) => b.length - a.length)[0];
  return root ? anyCase(path.slice(root.length + 1)).map((rest) => `${root}/${rest}`) : [path];
};
var opencodeConfig = (cwd, head, denied = { read: [], edit: [] }, home = "") => {
  const root = trimSlash(cwd);
  const { writable, readOnly } = grantsOf(root, head);
  const outside = union(writable.slice(1), readOnly).filter((dir) => !isWithin(dir, root));
  const each = (patterns, rule) => patterns.map((pattern) => [pattern, rule]);
  const deny = (paths) => each(paths.flatMap((path) => spellingsOf(path, root, [...writable, ...readOnly])).flatMap(below), "deny");
  const secrets = home ? SECRET_PATHS.flatMap((path) => below(`${trimSlash(home)}/${path}`)) : [];
  const guarded = (head.guarded?.paths ?? []).filter((path) => [...writable, ...readOnly].some((dir) => isWithin(path, dir)));
  return {
    autoupdate: false,
    share: "disabled",
    tools: Object.fromEntries(OPENCODE_DENY.map((key) => [key, false])),
    permission: {
      "*": "deny",
      read: rulesOf([["*", "allow"], ...deny(denied.read), ...deny(guarded), ...each(OPENCODE_ENV, "deny"), ...each(secrets, "deny")]),
      edit: rulesOf([
        ["*", "allow"],
        ...deny(readOnly),
        ...each(writable.slice(1).flatMap(below), "allow"),
        ...deny(denied.edit),
        ...deny(guarded),
        ...each(OPENCODE_GIT, "deny"),
        ...each(OPENCODE_ENV, "deny"),
        ...each(OPENCODE_IGNORE, "deny"),
        ...each(OPENCODE_PROTECTED, "deny"),
        ...each(secrets, "deny")
      ]),
      glob: rulesOf([["*", "allow"], ...each(secrets, "deny")]),
      todowrite: "allow",
      external_directory: rulesOf([["*", "deny"], ...each(outside.map((dir) => `${dir}/*`), "allow")]),
      ...Object.fromEntries(OPENCODE_DENY.map((key) => [key, "deny"]))
    }
  };
};
var OPENCODE_CONFIG_LIMIT = 12e4;
var opencodeGrantRefusal = (grants, home) => {
  const base = trimSlash(home);
  if (!base) return void 0;
  for (const grant of grants) {
    const secret = SECRET_PATHS.find((path) => isWithin(`${base}/${path}`, trimSlash(grant)));
    if (secret) return `addDirs/writeDirs: ${grant} holds ${base}/${secret}, and OpenCode cannot deny a credential folder in every letter case. Grant a narrower folder.`;
  }
  return void 0;
};
var projectRootRefusal = (cwd, root) => root !== void 0 && trimSlash(root) !== trimSlash(cwd) ? `${cwd} is a subfolder of the repository ${root}, and OpenCode would let the Head reach all of that repository through \`../\` paths. Run OpenCode Heads with \`cwd\` at the repository root, or use another engine.` : void 0;
var scanRoots = (cwd, grants) => {
  const all = union([cwd], grants).map(trimSlash);
  return all.filter((dir) => !all.some((other) => other !== dir && isWithin(dir, other)));
};
var linkScanResult = (ran) => {
  const why = "Hydra could not list the symlinks in the project and the granted folders";
  if (!ran) return { refusal: `${why} (the scan failed or took over a minute), so it cannot deny the ones that lead out.` };
  if (ran.exitCode !== 0) return { refusal: `${why}: ${ran.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit ${ran.exitCode}`}.` };
  if (ran.isStdoutTruncated) return { refusal: `${why}: there are too many to read.` };
  try {
    const rows = JSON.parse(ran.stdout);
    if (Array.isArray(rows) && rows.every((row) => Array.isArray(row) && row.length === 2 && row.every((part) => typeof part === "string"))) {
      return { links: rows.map(([path, target]) => ({ path, target })) };
    }
  } catch {
  }
  return { refusal: `${why}: the scan printed something unexpected.` };
};
var tooManyLinks = (count) => `The project and the granted folders hold more than ${OPENCODE_LINK_CAP} symlinks an OpenCode Head must be kept from (${count} found so far), too many to deny one by one. Use another engine here.`;
var changeWarnings = (cwd, writeDirs, files, real) => files.flatMap((file, index) => {
  const path = real[index] ?? file;
  const name = relativeTo(cwd, file);
  if (path.split("/").some((part) => part.toLowerCase() === ".git")) return [`the Head changed ${name}, which is inside a .git folder (${path}): check it, and git's hooks and config, before you run git.`];
  if (path !== file && outsideFiles(cwd, [path], writeDirs).length > 0) return [`the Head changed ${name}, whose real path ${path} is outside the project: check it.`];
  return [];
});
var opencodeEnv = (cwd, configFile, configHome, config, account) => ({
  OPENCODE_CONFIG: configFile,
  OPENCODE_CONFIG_CONTENT: config,
  OPENCODE_CONFIG_DIR: configHome,
  ...OPENCODE_NO_PROJECT_CONFIG,
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  XDG_CONFIG_HOME: configHome,
  ...account ?? {},
  PWD: cwd
});
var opencodeArgs = (a) => ["opencode", "run", "--standalone", "--format", "json", "-m", a.model, ...a.resume ? ["-s", a.resume] : [], "--", a.prompt];
var OPENCODE_WATCHDOG = { firstMs: 9e4, idleMs: 3e5 };
var newOpenCodeState = (cwd) => ({
  cwd,
  turns: 0,
  files: /* @__PURE__ */ new Set(),
  denied: [],
  flagged: [],
  inputTokens: 0,
  outputTokens: 0,
  usd: 0,
  finalText: "",
  textTurn: -1,
  failures: []
});
var absoluteIn = (cwd, path) => path.startsWith("/") ? path : `${trimSlash(cwd)}/${path.replace(/^\.\//, "")}`;
var patchFiles = (patch) => [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((found) => found[1].trim());
var pathOf = (input) => String(input.path ?? input.filePath ?? input.file_path ?? "");
var foldOpenCodeRow = (row, state) => {
  const events = [];
  if (typeof row.sessionID === "string" && !state.sessionId) state.sessionId = row.sessionID;
  const part = row.part ?? {};
  if (row.type === "step_start") {
    state.turns++;
    events.push({ type: "turn_end" }, { type: "thinking_start" });
  } else if (row.type === "text" && typeof part.text === "string") {
    state.finalText = state.textTurn === state.turns ? `${state.finalText}
${part.text}` : part.text;
    state.textTurn = state.turns;
  } else if (row.type === "reasoning") {
    events.push({ type: "thinking_start" });
  } else if (row.type === "step_finish") {
    const tokens = part.tokens ?? {};
    state.inputTokens += (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
    state.outputTokens += (tokens.output ?? 0) + (tokens.reasoning ?? 0);
    state.usd += typeof part.cost === "number" ? part.cost : 0;
  } else if (row.type === "error") {
    state.failures.push(`${row.error?.type ?? "error"}: ${row.error?.message ?? "OpenCode reported an error"}`);
  } else if (row.type === "tool_use" && part.tool) {
    const name = part.tool;
    const tool = OPENCODE_TOOLS[name] ?? name;
    const id = part.id ?? `${name}-${state.turns}-${state.denied.length}-${state.files.size}`;
    const raw = part.state?.input ?? {};
    const patched = typeof raw.patchText === "string" ? patchFiles(raw.patchText) : [];
    const input = name === "shell" || name === "bash" ? { command: raw.command ?? "" } : pathOf(raw) ? { path: absoluteIn(state.cwd, pathOf(raw)) } : patched.length > 0 ? { path: absoluteIn(state.cwd, patched[0]) } : { pattern: raw.pattern ?? "" };
    const status = part.state?.status;
    const error = String(part.state?.error ?? "");
    const isError = status === "error";
    const isDenied = isError && OPENCODE_DENIAL.test(error);
    if (isDenied) {
      state.denied.push({ tool, target: String(input.path ?? input.command ?? input.pattern ?? ""), text: error.replace(/\s+/g, " ").trim() });
    } else if (status === "completed") {
      if (OPENCODE_EDIT_TOOLS.has(name)) {
        for (const file of patched.length > 0 ? patched : [pathOf(raw)]) if (file) state.files.add(absoluteIn(state.cwd, file));
      }
      if (!OPENCODE_SAFE_TOOLS.has(name)) state.flagged.push(`the Head ran OpenCode's \`${name}\` tool, which Hydra's rules deny: check what it did`);
    }
    events.push(
      { type: "tool_queued", toolCallId: id, toolName: tool, input },
      { type: "tool_running", toolCallId: id, toolName: tool },
      { type: isDenied ? "tool_denied" : "tool_completed", toolCallId: id, toolName: tool, isError, ...patched.length > 1 && !isDenied ? { files: patched.map((file) => absoluteIn(state.cwd, file)) } : {} }
    );
  }
  return events;
};
async function runRoundOpenCode($, argv, signal, onEvent) {
  const { state } = argv;
  state.failures = [];
  state.finalText = "";
  const turnsBefore = state.turns;
  let isCapped = false;
  const { errors, exit } = await pump($, opencodeArgs(argv), argv.cwd, signal, async (line) => {
    if (!line.trim().startsWith("{")) return false;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return false;
    }
    for (const event of foldOpenCodeRow(row, state)) await onEvent(event);
    if (state.turns - turnsBefore > argv.maxTurns) isCapped = true;
    return isCapped;
  }, argv.env, OPENCODE_WATCHDOG);
  const failure = state.failures.join("\n");
  return {
    finalText: state.finalText,
    sessionId: state.sessionId,
    subtype: isCapped ? "error_max_turns" : failure || exit.code !== null && exit.code !== 0 ? "error" : exit.code === 0 ? "success" : void 0,
    code: isCapped ? 8 : exit.code,
    signal: exit.signal,
    errors: [failure, errors].filter(Boolean).join("\n").slice(-2e3)
  };
}
var HEADS_DIR = ".claude/hydra/heads";
var PREFIX = "opencode-";
var parentOf = (dir) => dir.replace(/\/[^/]*$/, "") || "/";
async function vcsRootOf($, cwd) {
  for (let dir = trimSlash(cwd); ; dir = parentOf(dir)) {
    const base = dir === "/" ? "" : dir;
    const [hasGit, hasHg] = await Promise.all([`${base}/.git`, `${base}/.hg`].map((path) => $.fs.exists(path).catch(() => void 0)));
    if (hasGit === void 0 || hasHg === void 0) return { failure: `Hydra could not look for a repository above ${cwd}, so it cannot tell where OpenCode puts the project root.` };
    if (hasGit) {
      const ran = await $.process.run(["git", "-C", dir, "rev-parse", "--show-toplevel"], { timeoutMs: 1e4 }).catch(() => void 0);
      if (!ran) return { failure: `git did not answer in ${dir}, so Hydra cannot tell where OpenCode puts the project root.` };
      const top = ran.stdout.trim();
      if (ran.exitCode !== 0 || !top) return {};
      return { root: (await realPaths2($, [top]))[0] ?? top };
    }
    if (hasHg) return { root: dir };
    if (dir === "/") return {};
  }
}
async function scanLinks($, roots) {
  const ran = await runScript($, "symlinks.py", roots, 6e4).catch(() => void 0);
  return linkScanResult(ran);
}
async function prepareOpenCode($, head, id) {
  const home = await homeOf($);
  const [cwd = head.cwd, realHome = ""] = await realPaths2($, home ? [head.cwd, home] : [head.cwd]);
  const addDirs = await realPaths2($, head.addDirs);
  const writeDirs = await realPaths2($, head.writeDirs);
  const needs = { addDirs, writeDirs, shell: false, guarded: head.guarded };
  const vcs = await vcsRootOf($, cwd);
  if ("failure" in vcs) return { refusal: vcs.failure };
  const refusal = projectRootRefusal(cwd, vcs.root) ?? opencodeGrantRefusal(union(addDirs, writeDirs), realHome);
  if (refusal) return { refusal };
  const scanned = await scanLinks($, scanRoots(cwd, union(writeDirs, addDirs)));
  if ("refusal" in scanned) return scanned;
  const denied = linkDenies(scanned.links, cwd, needs);
  if (denied.edit.length > OPENCODE_LINK_CAP) return { refusal: tooManyLinks(denied.edit.length) };
  const config = JSON.stringify(opencodeConfig(cwd, needs, denied, realHome));
  if (config.length > OPENCODE_CONFIG_LIMIT) return { refusal: (head.guarded?.paths.length ?? 0) > 0 ? CONFIG_TOO_LARGE : tooManyLinks(denied.edit.length) };
  return { cwd, addDirs, writeDirs, config, ...await writeOpenCodeFiles($, home, id, config) };
}
async function writeOpenCodeFiles($, home, id, config) {
  const base = `${home}/${HEADS_DIR}/${PREFIX}${await $.session.id()}-${id}`;
  const configHome = base;
  const configFile = `${base}.json`;
  try {
    await $.process.run(["/bin/mkdir", "-p", configHome]);
    await $.process.run(["/bin/chmod", "700", configHome]);
    await $.fs.write(configFile, config + "\n");
    await $.process.run(["/bin/chmod", "600", configFile]);
  } catch (error) {
    await removeOpenCodeFiles($, configHome);
    throw error;
  }
  return { configFile, configHome };
}
async function removeOpenCodeFiles($, base) {
  if (!base.includes(`/${HEADS_DIR}/${PREFIX}`)) return;
  await $.process.run(["/bin/rm", "-f", `${base}.json`]).catch(() => void 0);
  await $.process.run(["/bin/rm", "-rf", base]).catch(() => void 0);
}
async function runOpenCodeHead($, head, outer, id) {
  const { cwd, model } = head;
  const setup = /^[A-Za-z]:|^\\\\|\\/.test(cwd) ? { refusal: `${cwd} is a Windows path, and Hydra's rules use POSIX paths. Run Claude Code under WSL instead.` } : await prepareOpenCode($, head, id).catch((error) => ({
    refusal: `Hydra could not write the Head's OpenCode config (${String(error).slice(0, 160)}). Check that ~/.claude is writable, then run the Head again.`
  }));
  if ("refusal" in setup) {
    await setRun($, id, { state: "failed", endedAt: await $.clock.now(), activity: setup.refusal });
    await refreshStatus($);
    return notStarted(id, model, cwd, `${setup.refusal} A Head never starts without Hydra's rules.`, "opencode", "unavailable");
  }
  try {
    const real = { ...head, cwd: setup.cwd, addDirs: setup.addDirs, writeDirs: setup.writeDirs };
    return await runOpenCodeRounds($, real, opencodeEnv(setup.cwd, setup.configFile, setup.configHome, setup.config, head.env), outer, id);
  } finally {
    await removeOpenCodeFiles($, setup.configHome);
  }
}
var idleRetryRound = (round, sessionId, denied, turnsUsed) => sessionId ? { prompt: continuePrompt(denied), maxTurns: Math.max(1, round.maxTurns - turnsUsed), resume: sessionId } : round;
async function runOpenCodeRounds($, head, env, outer, id) {
  const { task, cwd, model, maxTurns, minutes } = head;
  const startedAt = await $.clock.now();
  await snapshotChangedFiles($, id, [cwd, ...head.writeDirs]);
  const state = newOpenCodeState(cwd);
  const labels = /* @__PURE__ */ new Map();
  const counter = createCallCounter();
  const onEvent = async (event) => {
    counter.see(event);
    await setRun($, id, (run) => applyEvent(run, event, labels, cwd));
  };
  let hangs = 0;
  const deniedCalls = () => state.denied.map((d) => `${d.tool} ${relativeTo(cwd, d.target)}`.slice(0, 160));
  const runRound2 = async (round2, signal) => {
    const turnsBefore = state.turns;
    let ran = await runRoundOpenCode($, { ...round2, model, cwd, env, state }, signal, onEvent);
    if (ran.signal === "idle" && !signal.aborted) {
      hangs++;
      await setRun($, id, { activity: "no output from OpenCode, retrying" });
      const retry = idleRetryRound(round2, state.sessionId, deniedCalls(), state.turns - turnsBefore);
      ran = await runRoundOpenCode($, { ...retry, model, cwd, env, state }, signal, onEvent);
    }
    if (ran.signal === "idle") {
      hangs++;
      return { ...ran, errors: [`OpenCode produced no output for ${state.turns === 0 ? "90 s after starting" : "5 min"} twice, so Hydra stopped it (a known OpenCode hang).`, ran.errors].filter(Boolean).join("\n") };
    }
    return ran;
  };
  const ended = await runRounds({
    task,
    maxTurns,
    minutes,
    outer,
    resume: head.resume,
    runRound: runRound2,
    turns: () => state.turns,
    calls: () => counter.calls,
    denied: () => deniedCalls(),
    // A run the watchdog stopped twice is a hang: starting it again would only hang again.
    mayRetryStart: (round2) => round2.signal !== "idle",
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
    onStep: (activity) => setRun($, id, { activity })
  });
  const { round, rounds, sessionId, ending } = ended;
  const files = union([...state.files], await changedFiles($, startedAt, [cwd, ...head.writeDirs]));
  const endedAt = await $.clock.now();
  const edits = await compareChangedFiles($, id, { cwd, startedAt, endedAt }, [cwd, ...head.writeDirs]);
  const tokens = tokensText(state.inputTokens, state.outputTokens);
  const isDone = ending === "done";
  const stopped = outer.aborted ? stopReason(outer) : void 0;
  const hung = round.signal === "idle";
  await setRun($, id, {
    state: isDone ? "done" : "failed",
    turns: state.turns,
    tokens,
    endedAt,
    ending,
    sessionId,
    files: files.map((file) => relativeTo(cwd, file)),
    summary: summaryOf(round.finalText),
    activity: hung && !isDone ? "OpenCode hung (no output)" : endActivity(ended, { maxTurns, minutes, stopped })
  });
  void refreshHeads($);
  const warnings = [...new Set(state.flagged), ...changeWarnings(cwd, head.writeDirs, files, await realPaths2($, files))];
  if (hangs > 0 && !hung) warnings.push(`OpenCode went silent ${hangs} time(s) and was restarted by Hydra's watchdog; check the files it edited.`);
  const text = formatReport({
    id,
    model,
    cwd,
    sessionId,
    finished: isDone,
    ending,
    cap: ended.cap,
    maxTurns,
    rounds,
    turns: state.turns,
    usd: null,
    files,
    denied: state.denied,
    finalText: round.finalText,
    exit: hung && ending === "error" ? "hung" : exitOf(ended, { minutes, stopped }),
    errors: round.errors,
    writeDirs: head.writeDirs,
    engine: "opencode",
    tokens: state.usd > 0 ? `${tokens} \xB7 $${state.usd.toFixed(4)}` : tokens,
    warnings,
    startedAt,
    endedAt,
    reverted: edits.reverted,
    deleted: edits.deleted,
    restored: edits.restored,
    overwritten: edits.overwritten,
    alsoRan: edits.alsoRan
  });
  return { text, fullText: round.finalText, isDone, failure: isDone ? void 0 : round.errors, files, ending, sessionId };
}

// hooks/engines/agy.ts
var AGY_TOOLS = {
  run_command: "shell_command",
  write_to_file: "write_file",
  replace_file_content: "edit_file",
  multi_replace_file_content: "edit_file",
  sed_file: "edit_file",
  notebook_edit: "edit_file",
  view_file: "read_file",
  list_dir: "read_directory",
  grep_search: "grep",
  find_by_name: "glob"
};
var newAgyState = () => ({ calls: /* @__PURE__ */ new Map(), denied: [], shell: [], files: [], wrote: false, turns: 0, inputTokens: 0, outputTokens: 0, finalText: "", lastTarget: "" });
var agyInput = (name, parameters = {}) => {
  if (name === "run_command") return { command: String(parameters.CommandLine ?? "") };
  const path = parameters.TargetFile ?? parameters.AbsolutePath ?? parameters.file_path ?? parameters.path ?? parameters.DirectoryPath ?? parameters.SearchPath ?? parameters.SearchDirectory;
  return { ...path ? { file_path: String(path) } : {}, ...parameters.Query ? { pattern: String(parameters.Query) } : {} };
};
var foldAgyRow = (row, state) => {
  const events = [];
  if (row.event === "init" && typeof row.conversation_id === "string") state.conversationId = row.conversation_id;
  else if (row.event === "step_update" && row.step_update) {
    const step = row.step_update;
    if (step.conversation_id && !state.conversationId) state.conversationId = step.conversation_id;
    if (step.step_type === "agent_response" && step.state === "ACTIVE") events.push({ type: "thinking_start" });
    if (step.step_type === "tool" && typeof step.step_index === "number") {
      const name = step.tool_name ?? step.tool_info?.name ?? "tool";
      const index = step.step_index;
      if (!state.calls.has(index)) {
        const call = { tool: AGY_TOOLS[name] ?? name, input: agyInput(name, step.tool_info?.parameters) };
        state.calls.set(index, call);
        state.pending = call;
        events.push({ type: "tool_queued", toolCallId: String(index), toolName: call.tool, input: call.input }, { type: "tool_running", toolCallId: String(index), toolName: call.tool });
      }
      if (step.state === "DONE") {
        const call = state.calls.get(index);
        state.lastTarget = String(call.input.command ?? call.input.file_path ?? call.input.pattern ?? "");
        if (call.tool === "shell_command" && call.input.command) state.shell.push(String(call.input.command));
        if (["write_file", "edit_file", "create_file", "multi_edit", "multi_edit_file"].includes(call.tool)) {
          state.wrote = true;
          if (call.input.file_path) state.files.push(String(call.input.file_path));
        }
        if (state.pending === call) state.pending = void 0;
        events.push({ type: "tool_completed", toolCallId: String(index), toolName: call.tool, isError: false }, { type: "turn_end" });
        state.turns++;
      }
    }
  } else if (row.event === "result" && row.result) {
    const result = row.result;
    if (result.conversation_id) state.conversationId = result.conversation_id;
    state.status = result.status;
    state.finalText = result.response ?? "";
    state.inputTokens += result.usage?.input_tokens ?? 0;
    state.outputTokens += result.usage?.output_tokens ?? 0;
    for (const action of result.denied_actions ?? []) {
      const attempted = state.pending?.input ?? {};
      const target = String(attempted.command ?? attempted.file_path ?? attempted.pattern ?? state.lastTarget);
      state.denied.push({ tool: action.display_name ?? action.action ?? "tool", target, text: `Antigravity refused the ${action.action ?? "action"} permission: ${target ? target.slice(0, 120) : "the call named no command or path"}` });
    }
  }
  return events;
};
var absoluteIn2 = (cwd, path) => {
  const parts = [];
  for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
};
var agyReportFiles = (state, cwd, changed) => {
  const files = [...new Set(state.files.map((file) => absoluteIn2(cwd, file)))];
  const own = new Set(files.map((file) => relativeTo(cwd, file)));
  const folder = [...new Set(changed.map((file) => relativeTo(cwd, absoluteIn2(cwd, file))))].filter((file) => !own.has(file));
  return { files, folder };
};
var AGY_SECRET_DIRS = SECRET_PATHS;
var AGY_SHELL_DENY = DANGEROUS_SHELL.map((rule) => {
  const text = rule.replace(/^Shell\((.*)\)$/, "$1").replace(/\*$/, "");
  return `command(regex:(?:.*[;&|(]\\s*)?${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*)`;
});
var agyTempDeny = (roots, existing) => existing.filter((temp) => !roots.some((root) => isWithin(trimSlash(root), temp)));
var AGY_TEMP_DIRS = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"];
var AGY_RULE_CAP = 4096;
var agySpellings = (path, roots, caseless) => {
  const isDir = path.endsWith("/");
  const bare = trimSlash(path);
  const root = caseless ? roots.filter((dir) => bare !== dir && isWithin(bare, dir)).sort((a, b) => b.length - a.length)[0] : void 0;
  const spellings = root ? caseVariants(bare.slice(root.length + 1)).map((rest) => `${root}/${rest}`) : [bare];
  return spellings.map((spelling) => isDir ? `${spelling}/` : spelling);
};
var agySettings = (cwd, head, home = "", envFiles = [], tempDirs = [], caseless = false, headHome = "") => {
  const own = [cwd, ...head.writeDirs ?? []].map(trimSlash);
  const extra = union(head.addDirs.map(trimSlash), (head.writeDirs ?? []).map(trimSlash));
  const roots = union(own, extra);
  const rules = (action, path) => agySpellings(path, roots, caseless).map((spelling) => `${action}(${spelling})`);
  const guarded = head.guarded ?? NO_GUARD;
  return {
    permissions: {
      allow: [...own.map((root) => `write_file(${root}/)`), ...extra.map((dir) => `read_file(${dir}/)`), ...head.shell ? ["command(*)"] : []],
      deny: [
        ...own.flatMap((root) => rules("write_file", `${root}/.git/`)),
        ...roots.flatMap((root) => rules("read_file", `${root}/.git/`)),
        ...tempDirs.map((dir) => `write_file(${dir}/)`),
        ...envFiles.flatMap((file) => rules("read_file", file)),
        ...guarded.paths.flatMap((path) => {
          const target = guarded.folders.includes(path) ? `${path}/` : path;
          return [...rules("read_file", target), ...rules("write_file", target)];
        }),
        ...guarded.ignoreFiles.flatMap((file) => rules("write_file", file)),
        ...home ? AGY_SECRET_DIRS.map((dir) => `read_file(${home.replace(/\/$/, "")}/${dir})`) : [],
        // The Head's own Library holds the link to the keychain, so no tool of its reads or writes there, with a shell or without.
        ...headHome ? [`read_file(${trimSlash(headHome)}/Library)`, `write_file(${trimSlash(headHome)}/Library)`] : [],
        ...head.shell ? AGY_SHELL_DENY : ["command(*)"]
      ]
    }
  };
};
async function isCaseless($, cwd) {
  const swapped = [...cwd].map((char) => char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()).join("");
  return swapped === cwd || await $.fs.exists(swapped).catch(() => true);
}
var agyGrantRefusal = (grants, home) => {
  const base = trimSlash(home);
  if (!base) return void 0;
  for (const grant of grants) {
    const secret = SECRET_PATHS.find((path) => isWithin(`${base}/${path}`, trimSlash(grant)));
    if (secret) return `addDirs/writeDirs: ${grant} holds ${base}/${secret}, and on this disk (which ignores letter case) Antigravity's rules cannot deny it in every spelling. Grant a narrower folder.`;
  }
  return void 0;
};
var tooManySpellings = (count) => `This disk ignores letter case, so Hydra denies each protected path in every spelling for Antigravity, and this Head would need ${count} rules (over ${AGY_RULE_CAP}): a long name in .hydraignore (local.properties alone has 32,768 spellings) or many .env files. Use another engine here (Codex, Command Code or CodeBuddy).`;
async function agyCaseRefusal($, cwd, needs) {
  if (!await isCaseless($, cwd)) return void 0;
  const home = await homeOf($);
  const grant = agyGrantRefusal(union(needs.addDirs, needs.writeDirs ?? []), home);
  if (grant) return grant;
  const envFiles = await findEnvFiles($, union([cwd, ...needs.writeDirs ?? []], needs.addDirs));
  const count = agySettings(cwd, needs, home, envFiles, [], true).permissions.deny.length;
  return count > AGY_RULE_CAP ? tooManySpellings(count) : void 0;
}
var agyArgs = (a) => {
  const args = [
    "agy",
    "-p",
    a.prompt,
    "--model",
    agyModelId(a.model, a.effort),
    "--sandbox",
    "--output-format",
    "stream-json"
  ];
  if (a.resume) args.push("--conversation", a.resume);
  return args;
};
var AGY_WATCHDOG = { firstMs: 3e5, idleMs: 6e5 };
var agyHungEnding = (round, ending, call = "") => round.signal === "idle" && ending !== "done" ? { ending: "stalled", activity: `stalled: no output for 10 min${call ? ` on ${call}` : ""}` } : { ending };
var agyShellLine = (commands) => commands.length === 0 ? "" : `shell: ${commands.length} command${commands.length === 1 ? "" : "s"}: ${commands.map((command) => command.replace(/\s+/g, " ").trim().slice(0, 80)).join("; ")}`;
async function agyUntrackedNote($, cwd) {
  const ran = await $.process.run(["git", "-C", cwd, "ls-files", "--others", "--exclude-standard"], { timeoutMs: 1e4 }).catch(() => void 0);
  if (!ran || ran.exitCode !== 0) return "";
  const files = ran.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (files.length === 0) return "";
  const shown = files.slice(0, 30);
  const more = files.length > shown.length ? ` (and ${files.length - shown.length} more)` : "";
  return `Untracked files (git sees them; Antigravity's file search may miss them, so open them by path): ${shown.join(", ")}${more}`;
}
var failureReason = (state) => state.status && state.status !== "SUCCESS" && state.finalText.length <= 400 ? state.finalText : "";
var agyGroupPool = (name) => /argon/i.test(name) ? "argon" : /claude.*gpt|gpt.*claude/i.test(name) ? "claude" : /^gemini models$/i.test(name) ? "gemini" : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
var agyLivePool = (buckets, model) => {
  const base = agyBaseOf(model);
  const listed = buckets.find((bucket) => base && bucket.models?.includes(base));
  if (listed) return listed.pool;
  if (base === "gemini-4-argon" && buckets.some((bucket) => bucket.pool === "argon" && !bucket.models?.length)) return "argon";
  return agyPoolOf(model);
};
var parseAgyUsage = (stdout) => {
  for (const line of stdout.split("\n")) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.event !== "command_result" || row.command?.name !== "usage") continue;
    return (row.command.data?.groups ?? []).flatMap((group) => {
      const pool = agyGroupPool(group.name ?? "");
      const names = (group.description?.match(/models within this group:\s*(.*)/i)?.[1] ?? "").split(",").map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ""));
      const models = Object.keys(AGY_MODELS).filter((model) => names.includes(model.replace(/[^a-z0-9]/g, "")));
      return pool ? (group.buckets ?? []).filter((bucket) => !bucket.disabled).map((bucket) => ({ pool, group: group.name ?? "", models, window: bucket.window ?? "", remaining: Number(bucket.remaining_fraction ?? 1), resetAt: Date.parse(bucket.reset_time ?? "") })) : [];
    }).filter((bucket) => Number.isFinite(bucket.remaining) && Number.isFinite(bucket.resetAt));
  }
  return [];
};
var AGY_SPENT = 0.01;
var agyBlockedUntil = (buckets, model) => {
  const base = agyBaseOf(model);
  const listed = buckets.find((bucket) => base && bucket.models?.includes(base));
  const pool = agyLivePool(buckets, model);
  const own = buckets.filter((bucket) => listed ? bucket.group === listed.group : bucket.pool === pool);
  const mine = own.length > 0 || pool !== "argon" ? own : buckets.filter((bucket) => bucket.pool === "gemini");
  const spent = mine.filter((bucket) => bucket.remaining < AGY_SPENT);
  return spent.length > 0 ? Math.max(...spent.map((bucket) => bucket.resetAt)) : void 0;
};
var AGY_USAGE_KEEP_MS = 12e4;
var agyUsage = /* @__PURE__ */ new Map();
async function readAgyUsage($, dir, fresh = false) {
  const key = dir ?? "";
  const now = await $.clock.now();
  const kept = agyUsage.get(key);
  if (!fresh && kept && now - kept.at < AGY_USAGE_KEEP_MS) return kept.buckets;
  const buckets = runAgyUsage($, dir ?? await homeOf($), dir ? { HOME: dir } : void 0).catch(() => []);
  agyUsage.set(key, { at: now, buckets });
  return buckets;
}
async function runAgyUsage($, cwd, env) {
  const timer = new AbortController();
  const deadline = new AbortController();
  void $.clock.sleep(3e4, { signal: deadline.signal }).then(() => timer.abort(), () => void 0);
  const lines = [];
  try {
    const ran = await pump($, ["agy", "-p", "/usage", "--output-format", "stream-json"], cwd, timer.signal, async (line) => {
      lines.push(line);
      return false;
    }, env);
    return ran.exit.code === 0 ? parseAgyUsage(lines.join("\n")) : [];
  } finally {
    deadline.abort();
  }
}
var AGY_NOT_SIGNED_IN = "Antigravity is not signed in. Run `agy` once in a terminal (choose Google OAuth), then run the Head again.";
var AGY_SIGNED_OUT = /authentication failed|not logged into Antigravity/i;
var agyRoundErrors = (stderr, state) => {
  const text = [stderr, failureReason(state)].filter(Boolean).join("\n").slice(-2e3);
  return AGY_SIGNED_OUT.test(text) ? AGY_NOT_SIGNED_IN : text;
};
async function runRoundAgy($, argv, signal, onEvent) {
  const { state } = argv;
  state.finalText = "";
  state.status = void 0;
  state.pending = void 0;
  state.calls.clear();
  const turnsBefore = state.turns;
  let isCapped = false;
  const { errors, exit } = await pump($, agyArgs(argv), argv.cwd, signal, async (line) => {
    if (!line.trim().startsWith("{")) return false;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return false;
    }
    for (const event of foldAgyRow(row, state)) await onEvent(event);
    if (state.turns - turnsBefore > argv.maxTurns) isCapped = true;
    return isCapped;
  }, { HOME: argv.home }, AGY_WATCHDOG);
  const pending = state.pending;
  const hangCall = exit.signal === "idle" && pending ? describeTool(pending.tool, pending.input, argv.cwd) : "";
  const hangNote = exit.signal === "idle" ? `agy produced no output for 10 min${hangCall ? ` while ${hangCall} was running` : ""}, so Hydra stopped it.` : "";
  return {
    finalText: state.finalText,
    sessionId: state.conversationId,
    subtype: isCapped ? "error_max_turns" : state.status === "SUCCESS" ? "success" : state.status ? "error" : void 0,
    code: isCapped ? 8 : exit.code,
    signal: exit.signal,
    errors: [agyRoundErrors(errors, state), hangNote].filter(Boolean).join("\n")
  };
}
var AGY_HOME_DIR = ".claude/hydra/heads";
async function findEnvFiles($, roots) {
  const found = [];
  for (const root of roots) {
    const ran = await $.process.run(["/usr/bin/find", root, "-maxdepth", "8", "(", "-name", "node_modules", "-o", "-name", ".git", ")", "-prune", "-o", "-type", "f", "(", "-name", ".env", "-o", "-name", ".env.*", ")", "-print"], { timeoutMs: 2e4 }).catch(() => void 0);
    if (ran?.exitCode === 0) found.push(...ran.stdout.split("\n").filter(Boolean));
  }
  return union(found);
}
async function writeAgyHome($, cwd, id, needs, tokenDir) {
  const real = await homeOf($);
  const dir = `${real}/${AGY_HOME_DIR}/agy-${await $.session.id()}-${id}`;
  const config = `${dir}/.gemini/antigravity-cli`;
  await $.process.run(["/bin/mkdir", "-p", config]);
  await $.process.run(["/bin/chmod", "700", dir, `${dir}/.gemini`, config]);
  const token = `${real}/${AGY_TOKEN}`;
  if (tokenDir) await $.process.run(["/bin/cp", "-p", agyTokenOf(tokenDir), `${config}/antigravity-oauth-token`]);
  else if (await $.fs.exists(token).catch(() => false)) await $.process.run(["/bin/cp", "-p", token, `${config}/antigravity-oauth-token`]);
  else if (await platformOf($) === "darwin") {
    await $.process.run(["/bin/mkdir", "-p", `${dir}/Library`]);
    await $.process.run(["/bin/ln", "-s", `${real}/Library/Keychains`, `${dir}/Library/Keychains`]);
  }
  await writeAgySettings($, dir, cwd, needs);
  return dir;
}
async function writeAgySettings($, dir, cwd, needs) {
  const real = await homeOf($);
  const roots = [cwd, ...needs.writeDirs ?? []];
  const envFiles = await findEnvFiles($, union(roots, needs.addDirs));
  const present = [];
  for (const temp of AGY_TEMP_DIRS) if (await $.fs.exists(temp).catch(() => false)) present.push(temp);
  const settings = agySettings(cwd, needs, real, envFiles, agyTempDeny(roots, present), await isCaseless($, cwd), dir);
  await $.fs.write(`${dir}/.gemini/antigravity-cli/settings.json`, JSON.stringify(settings, null, 2) + "\n");
}
async function removeAgyHome($, dir) {
  if (dir.includes(`/${AGY_HOME_DIR}/agy-`)) await $.process.run(["/bin/rm", "-rf", dir]).catch(() => void 0);
}
async function runAgyHead($, head, outer, id) {
  const { cwd, model } = head;
  let home = "";
  const refusal = /^[A-Za-z]:|^\\\\|\\/.test(cwd) ? `${cwd} is a Windows path, and Hydra's rules use POSIX paths. Run Claude Code under WSL instead.` : await agyCaseRefusal($, cwd, { addDirs: head.addDirs, writeDirs: head.writeDirs, shell: head.shell, guarded: head.guarded }) ?? await writeAgyHome($, cwd, id, { addDirs: head.addDirs, writeDirs: head.writeDirs, shell: head.shell, guarded: head.guarded }, head.tokenDir).then(
    (dir) => {
      home = dir;
      return void 0;
    },
    (error) => `Hydra could not set up the Head's Antigravity settings (${String(error).slice(0, 160)}). Check that you are signed in (\`agy\`) and ~/.claude is writable, then run the Head again.`
  );
  if (refusal) {
    await removeAgyHome($, home);
    await setRun($, id, { state: "failed", endedAt: await $.clock.now(), activity: refusal });
    await refreshStatus($);
    return notStarted(id, model, cwd, `${refusal} A Head never starts without Hydra's rules.`, "agy", "unavailable");
  }
  try {
    return await runAgyRounds($, head, home, outer, id);
  } finally {
    await removeAgyHome($, home);
  }
}
async function runAgyRounds($, head, home, outer, id) {
  const { task: brief, cwd, maxTurns, minutes } = head;
  const model = agyCurrentModel(head.model, await $.clock.now());
  const retired = agyBaseOf(head.model) !== void 0 && agyBaseOf(head.model) !== model ? [`${agyBaseOf(head.model)} has left Antigravity, so the Head ran ${model}.`] : [];
  const addDirs = union(head.addDirs, head.writeDirs);
  const effortNow = async () => headEffort(effortModeOf(await readMode($)), head.effort);
  const untracked = await agyUntrackedNote($, cwd);
  const task = [!head.shell ? "You have no shell. List folders with list_dir and search with find_by_name, grep_search or codebase_search; open files with view_file." : "", untracked, brief].filter(Boolean).join("\n\n");
  const startedAt = await $.clock.now();
  await snapshotChangedFiles($, id, [cwd, ...head.writeDirs]);
  const state = newAgyState();
  const labels = /* @__PURE__ */ new Map();
  const counter = createCallCounter();
  const onEvent = async (event) => {
    counter.see(event);
    await setRun($, id, (run) => applyEvent(run, event, labels, cwd));
  };
  const runRound2 = async (round2, signal) => {
    const effort = await effortNow();
    await setRun($, id, { effort });
    await writeAgySettings($, home, cwd, { addDirs, writeDirs: head.writeDirs, shell: head.shell, guarded: head.guarded }).catch(() => void 0);
    const ran = await runRoundAgy($, { ...round2, model, effort, cwd, addDirs, home, state }, signal, onEvent);
    return { ...ran, effort };
  };
  const ended = await runRounds({
    task,
    maxTurns,
    minutes,
    outer,
    runRound: runRound2,
    turns: () => state.turns,
    calls: () => counter.calls,
    denied: () => state.denied.map((d) => `${d.tool} ${d.target}`.slice(0, 160)),
    // A run the watchdog stopped is a hang: resuming it would only sit on the same call again.
    mayResume: (round2) => round2.signal !== "idle",
    mayRetryStart: (round2) => round2.signal !== "idle",
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
    onStep: (activity) => setRun($, id, { activity })
  });
  const { round, rounds, sessionId, ending } = ended;
  const changed = await changedFiles($, startedAt, [cwd, ...head.writeDirs]);
  const { files, folder } = agyReportFiles(state, cwd, changed);
  const endedAt = await $.clock.now();
  const edits = await compareChangedFiles($, id, { cwd, startedAt, endedAt }, [cwd, ...head.writeDirs]);
  const tokens = tokensText(state.inputTokens, state.outputTokens);
  const hangCall = round.signal === "idle" && state.pending ? describeTool(state.pending.tool, state.pending.input, cwd) : "";
  const hung = agyHungEnding(round, ending, hangCall);
  const finalEnding = hung.ending;
  const isDone = finalEnding === "done";
  const stopped = outer.aborted ? stopReason(outer) : void 0;
  await setRun($, id, {
    state: isDone ? "done" : "failed",
    turns: state.turns,
    tokens,
    endedAt,
    ending: finalEnding,
    files: files.map((file) => relativeTo(cwd, file)),
    summary: summaryOf(round.finalText),
    activity: hung.activity ?? endActivity(ended, { maxTurns, minutes, stopped })
  });
  void refreshHeads($);
  const report = formatReport({
    id,
    model,
    effort: round.effort,
    cwd,
    sessionId,
    finished: isDone,
    ending: finalEnding,
    cap: ended.cap,
    maxTurns,
    startedAt,
    endedAt,
    rounds,
    turns: state.turns,
    usd: null,
    files: state.wrote ? files : changed,
    wrote: state.wrote,
    denied: state.denied,
    finalText: round.finalText,
    exit: exitOf(ended, { minutes, stopped }),
    errors: round.errors,
    writeDirs: head.writeDirs,
    engine: "agy",
    tokens,
    warnings: retired,
    reverted: edits.reverted,
    deleted: edits.deleted,
    restored: edits.restored,
    overwritten: edits.overwritten,
    alsoRan: edits.alsoRan
  });
  const shellLine = agyShellLine(state.shell);
  const attributed = state.wrote ? withOtherWrites(report, [], folder) : report;
  const text = shellLine ? attributed.replace("\n--- head report ---", `
${shellLine}
--- head report ---`) : attributed;
  return { text, fullText: round.finalText, isDone, failure: isDone ? void 0 : round.errors, files, ending: finalEnding };
}

// hooks/lib/accounts.ts
var DEFAULT_ACCOUNT = "default";
var ACCOUNTS_KEY = "accounts-v1";
var REMOVED_KEY = "accountsRemoved-v1";
var COOLDOWNS_KEY = "cooldowns-v1";
var UNAVAILABLE_KEY = "unavailable-v1";
var LAST_USED_KEY = "lastUsed-v1";
var ACCOUNTS_DIR = ".claude/hydra/accounts";
var COOLDOWN_DEFAULT_MS = 60 * 6e4;
var SIGNED_OUT_COOLDOWN_MS = 10 * 6e4;
var COOLDOWN_MAX_MS = 7 * 864e5;
var UNAVAILABLE_COOLDOWN_MS = 30 * 6e4;
var configuredStrategy = "fill";
var accountId = (account) => `${account.engine}/${account.name}`;
var cooldownKey = (id, pool) => pool ? `${id}#${pool}` : id;
var poolLabel = (pool) => AGY_POOL_LABEL[pool] ?? pool;
var accountDir = (home, engine, name) => `${home}/${ACCOUNTS_DIR}/${engine}/${name}`;
var isAccountName = (name) => name.length <= 20 && name !== DEFAULT_ACCOUNT && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
var agyTokenOf = (dir) => `${dir}/${AGY_TOKEN}`;
var withEnv = (platform, vars, command) => {
  const entries = Object.entries(vars);
  return platform === "windows" ? `${entries.map(([key, value]) => `$env:${key}="${value}"; `).join("")}${command}` : `${entries.map(([key, value]) => `${key}="${value}"`).join(" ")} ${command}`;
};
async function codexSignedIn($, dir) {
  const argv = [...await commandOf($, "codex"), "login", "status"];
  return $.process.run(argv, { timeoutMs: 15e3, ...dir ? { env: { CODEX_HOME: dir } } : {} }).then((ran) => ran.exitCode === 0, () => false);
}
async function buddySignedIn($, dir) {
  if (!dir) return void 0;
  const entries = await $.fs.list(dir).catch(() => []);
  if (entries.some((entry) => entry.name === ".credentials.json")) return true;
  return entries.some((entry) => entry.name !== ".keep") ? void 0 : false;
}
async function agySignedIn($, home, dir) {
  const path = dir ? agyTokenOf(dir) : `${home}/${AGY_TOKEN}`;
  if (await $.fs.exists(path).catch(() => false)) return true;
  return dir ? false : void 0;
}
async function opencodeSignedIn($, dir) {
  if (!dir) return void 0;
  const argv = [...await commandOf($, "opencode"), "auth", "list", "--standalone", "--format", "json"];
  const ran = await $.process.run(argv, opencodeCheckInit(await homeOf($), $.plugin.root, { XDG_DATA_HOME: `${dir}/data` })).catch(() => void 0);
  return ran?.exitCode === 0 && opencodeProviders(ran.stdout).stored;
}
var ACCOUNT_SUPPORT = {
  codex: {
    env: (dir) => ({ CODEX_HOME: dir }),
    login: (dir, platform) => withEnv(platform, { CODEX_HOME: dir }, "codex login"),
    hint: "Add --device-auth to `codex login` on a remote machine."
  },
  codebuddy: {
    env: (dir) => ({ CODEBUDDY_CONFIG_DIR: dir }),
    login: (dir, platform) => withEnv(platform, { CODEBUDDY_CONFIG_DIR: dir }, "codebuddy"),
    hint: "In CodeBuddy, type /login, finish signing in, then exit."
  },
  agy: {
    login: (dir, platform) => withEnv(platform, { HOME: dir }, "agy"),
    hint: "In Antigravity, choose Google OAuth and finish signing in, then exit."
  },
  // The product file is the WorkBuddy app's, shared by every account; the engine adds it (with the rest of workbuddyEnv) on every run.
  workbuddy: {
    env: (dir) => ({ CODEBUDDY_CONFIG_DIR: dir }),
    login: (dir, platform) => withEnv(platform, { CODEBUDDY_CONFIG_DIR: dir, ACC_PRODUCT_CONFIG_PATH: `$HOME/${WORKBUDDY_PRODUCT}` }, "codebuddy"),
    hint: "In CodeBuddy, type /login, finish signing in to WorkBuddy, then exit."
  },
  // Only the data folder (sign-ins) moves; a Head's config home is its own either way. The free opencode/* models need the person's own data folder.
  opencode: {
    env: (dir) => ({ XDG_DATA_HOME: `${dir}/data` }),
    login: (dir, platform) => withEnv(platform, { XDG_DATA_HOME: `${dir}/data` }, "opencode auth login"),
    hint: "Pick a provider and finish signing in. OpenCode's free models do not work on an extra account; sign in to a provider."
  }
};
var supportsAccounts = (engine) => ACCOUNT_SUPPORT[engine] !== void 0;
var accountEnv = (account) => account?.dir ? ACCOUNT_SUPPORT[account.engine]?.env?.(account.dir) : void 0;
var timeOf = (ms) => {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};
var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var untilText = (ms, now) => {
  const then = new Date(ms);
  const today = new Date(now);
  const sameDay = then.getFullYear() === today.getFullYear() && then.getMonth() === today.getMonth() && then.getDate() === today.getDate();
  return sameDay ? timeOf(ms) : `${then.getDate()} ${MONTH_NAMES[then.getMonth()]} ${timeOf(ms)}`;
};
var QUOTA_WORDING = [
  /rate[\s_-]?limit/i,
  /usage[\s_-]?limit/i,
  /\bquota\b/i,
  /too many requests/i,
  /\b429\b/,
  /insufficient_quota/i,
  /exceeded your current/i,
  /limit reached/i,
  /out of credits/i,
  /credits? (?:are |is |have been )?exhausted/i,
  /try again in/i,
  /resource_exhausted/i,
  /provider\.(?:rate-limit|quota)/i,
  /insufficient[\s_-]?credits/i,
  /credits?[\s_-]exhausted/i,
  /frequency[\s_-]?limit/i,
  /credits? balance is too low/i
];
var isQuotaFailure = (text) => !!text && QUOTA_WORDING.some((pattern) => pattern.test(text));
var SIGNED_OUT_WORDING = [
  /not (?:signed|logged) in/i,
  /authentication (?:failed|required)/i,
  /\bunauthori[sz]ed\b/i,
  /\b401\b/,
  /please (?:log ?in|sign in)/i,
  /login required/i,
  /invalid (?:api[\s_-]?key|token|credentials?)/i,
  /(?:token|session|credentials?) (?:has )?expired/i
];
var isSignedOutFailure = (text) => !!text && !isQuotaFailure(text) && SIGNED_OUT_WORDING.some((pattern) => pattern.test(text));
var MODEL_GONE_WORDING = [
  /unknown model/i,
  /invalid model(?: selection| id| name)?/i,
  /model[^\n]{0,60}(?:not (?:found|available|supported)|unsupported|does not exist|deprecated|retired)/i,
  /(?:no|unsupported) such model/i
];
var isModelUnavailable = (text) => !!text && !isQuotaFailure(text) && MODEL_GONE_WORDING.some((pattern) => pattern.test(text));
var UNIT_MS = { d: 864e5, h: 36e5, m: 6e4, s: 1e3 };
var unitOf = (word) => /^(ms|millis)/i.test(word) ? 1 : UNIT_MS[word.toLowerCase()[0] ?? "s"] ?? 1e3;
var DURATION = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|milliseconds?|ms|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
var clockTimeOf = (text, now) => {
  const found = /^(?:([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?: (\d{4}))? (?:at )?)?(\d{1,2}):(\d{2})(?::\d{2})? ?([AaPp][Mm])?(?: [A-Z]{2,5})?$/.exec(text.trim());
  if (!found) return void 0;
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = found;
  let hours = Number(hourText);
  if (meridiem) hours = hours % 12 + (/p/i.test(meridiem) ? 12 : 0);
  const at = new Date(now);
  if (monthName) {
    const month = MONTHS.indexOf(monthName.toLowerCase());
    if (month < 0) return void 0;
    at.setFullYear(yearText ? Number(yearText) : at.getFullYear(), month, Number(dayText));
  }
  at.setHours(hours, Number(minuteText), 0, 0);
  return monthName || at.getTime() > now ? at.getTime() : at.getTime() + 864e5;
};
var stampOf = (text) => {
  const found = /\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?: ?(Z|(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?|UTC|GMT)\b)?/i.exec(text);
  if (!found) return void 0;
  const [, year, month, day, hours, minutes, seconds, zone, sign, offsetHours, offsetMinutes] = found;
  const fields = [Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds ?? 0)];
  if (!zone) return new Date(...fields).getTime();
  const offset = sign ? (sign === "-" ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes ?? 0)) * 6e4 : 0;
  return Date.UTC(...fields) - offset;
};
var cooldownFrom = (text, now) => {
  const clamp = (until) => Math.min(now + COOLDOWN_MAX_MS, Math.max(now + 1e3, until));
  const wait = /(?:try again in|retry(?:ing)? (?:again )?in|retry[\s_-]?after:?|resets? in|(?:fully )?refresh(?:es)? in)\s*((?:[^\n.;]|\.(?=\d))*)/i.exec(text);
  if (wait) {
    let total = 0;
    for (const part of wait[1].matchAll(DURATION)) total += Number(part[1]) * unitOf(part[2]);
    if (total === 0) {
      const bare = /^\s*(\d+)\s*$/.exec(wait[1]);
      if (bare) total = Number(bare[1]) * 1e3;
    }
    if (total > 0) return clamp(now + total);
  }
  const at = /try again at\s+([^\n;]+?)(?:\.\s|\.?$|\n)/im.exec(text);
  if (at) {
    const when = clockTimeOf(at[1].replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/,/g, " ").replace(/\s+/g, " ").trim(), now);
    if (when !== void 0 && when > now) return clamp(when);
  }
  const stamp = stampOf(text);
  if (stamp !== void 0 && stamp > now) return clamp(stamp);
  const epoch = /reset[\w\s]{0,12}?\D{0,6}(\d{10,13})\b/i.exec(text);
  if (epoch) {
    const raw = Number(epoch[1]);
    const at2 = epoch[1].length >= 13 ? raw : raw * 1e3;
    if (at2 > now) return clamp(at2);
  }
  return clamp(now + COOLDOWN_DEFAULT_MS);
};
var activeCooldowns = (cooldowns, now) => Object.fromEntries(Object.entries(cooldowns).filter(([, until]) => until > now));
var coolingUntil = (cooldowns, id, pool) => Math.max(cooldowns[id] ?? 0, pool ? cooldowns[cooldownKey(id, pool)] ?? 0 : 0);
var pickAccount = (engine, accounts, cooldowns, now, strategy = "fill", lastUsed = {}, skip = [], pool) => {
  const ofEngine = accounts.filter((account) => account.engine === engine && !skip.includes(accountId(account)));
  const free = ofEngine.filter((account) => coolingUntil(cooldowns, accountId(account), pool) <= now);
  if (free.length > 0) {
    if (strategy === "fill") return { account: free[0] };
    let best = free[0];
    for (const account of free) if ((lastUsed[accountId(account)] ?? 0) < (lastUsed[accountId(best)] ?? 0)) best = account;
    return { account: best };
  }
  const waits = ofEngine.map((account) => coolingUntil(cooldowns, accountId(account), pool)).filter((until) => until > now);
  return { account: null, until: waits.length > 0 ? Math.min(...waits) : null };
};
var accountsLine = (trail) => `accounts: ${trail.map((step) => step.signedOut ? `${step.id} (not signed in)` : step.until !== void 0 ? `${step.id} (usage limit, cooling until ${timeOf(step.until)})` : step.id).join(" \u2192 ")}`;
var allCoolingText = (engine, until, pool) => `all accounts of ${engine} are at their ${pool ? `${poolLabel(pool)} ` : ""}usage limit${until !== null ? `; the earliest frees up at ${timeOf(until)}` : ""}. Route this task to ${pool ? "another model or " : ""}another engine, or run /hydra accounts reset if the limits have lifted.`;
var switchNote = (files, where = "another account", why = "at a usage limit") => `A previous attempt on ${where} stopped ${why}. Files it already changed: ${files.length > 0 ? files.join(", ") : "none recorded"}. Check them and continue from the current state.`;
var namesIn = (stored) => {
  const names = {};
  if (!stored || typeof stored !== "object") return names;
  for (const [engine, list] of Object.entries(stored)) {
    if (!isEngine(engine) || !supportsAccounts(engine) || !Array.isArray(list)) continue;
    const valid = [...new Set(list.filter((name) => typeof name === "string" && isAccountName(name)))];
    if (valid.length > 0) names[engine] = valid;
  }
  return names;
};
async function savedAccountNames($) {
  return namesIn(await $.store.get(ACCOUNTS_KEY).catch(() => void 0));
}
async function removedAccountNames($) {
  return namesIn(await $.store.get(REMOVED_KEY).catch(() => void 0));
}
async function accountFolders($, home) {
  const found = {};
  if (!home) return found;
  for (const engine of ENGINES) {
    if (!supportsAccounts(engine)) continue;
    const entries = await $.fs.list(`${home}/${ACCOUNTS_DIR}/${engine}`).catch(() => []);
    const names = entries.filter((entry) => entry.kind === "dir" && isAccountName(entry.name)).map((entry) => entry.name).sort();
    if (names.length > 0) found[engine] = names;
  }
  return found;
}
async function readAccountNames($) {
  const saved = await savedAccountNames($);
  const removed = await removedAccountNames($);
  const folders = await accountFolders($, await homeOf($).catch(() => ""));
  const names = {};
  for (const engine of ENGINES) {
    const gone = removed[engine] ?? [];
    const list = [.../* @__PURE__ */ new Set([...saved[engine] ?? [], ...folders[engine] ?? []])].filter((name) => !gone.includes(name));
    if (list.length > 0) names[engine] = list;
  }
  return names;
}
async function accountsOf($, engine) {
  const base = { engine, name: DEFAULT_ACCOUNT };
  if (!supportsAccounts(engine)) return [base];
  const names = (await readAccountNames($))[engine] ?? [];
  if (names.length === 0) return [base];
  const home = await homeOf($);
  return [base, ...names.map((name) => ({ engine, name, dir: accountDir(home, engine, name) }))];
}
async function readCooldowns($) {
  const stored = await $.store.get(COOLDOWNS_KEY).catch(() => void 0);
  if (!stored || typeof stored !== "object") return {};
  return Object.fromEntries(Object.entries(stored).filter((entry) => typeof entry[1] === "number"));
}
async function recordCooldown($, id, until) {
  await $.store.set(COOLDOWNS_KEY, { ...activeCooldowns(await readCooldowns($), await $.clock.now()), [id]: until });
}
var unavailableIn = (stored) => {
  if (!stored || typeof stored !== "object") return {};
  return Object.fromEntries(Object.entries(stored).filter((entry) => {
    const value = entry[1];
    return !!value && typeof value.until === "number" && typeof value.reason === "string" && typeof value.model === "string" && isEngine(value.engine);
  }));
};
async function activeUnavailable($, now) {
  return Object.entries(unavailableIn(await $.store.get(UNAVAILABLE_KEY).catch(() => void 0))).filter(([, entry]) => entry.until > now);
}
async function recordUnavailable($, engine, model, reason) {
  const now = await $.clock.now();
  const kept = Object.fromEntries(await activeUnavailable($, now));
  await $.store.set(UNAVAILABLE_KEY, { ...kept, [`${engine}:${model}`]: { engine, model, until: now + UNAVAILABLE_COOLDOWN_MS, reason: reason.trim().slice(0, 120) } });
}
var AGY_POOL_MODEL = Object.fromEntries(Object.entries(AGY_MODELS).map(([model, spec]) => [spec.pool, model]));
async function refreshLimits($, engines) {
  if (!engines.includes("agy")) return;
  try {
    for (const account of await accountsOf($, "agy")) {
      const buckets = await readAgyUsage($, account.dir);
      for (const pool of new Set(buckets.map((bucket) => bucket.pool))) {
        const model = AGY_POOL_MODEL[pool];
        const until = model ? agyBlockedUntil(buckets, model) : void 0;
        if (until !== void 0) await recordCooldown($, cooldownKey(accountId(account), pool), until);
      }
    }
  } catch {
  }
}
async function readLastUsed($) {
  const stored = await $.store.get(LAST_USED_KEY).catch(() => void 0);
  if (!stored || typeof stored !== "object") return {};
  return Object.fromEntries(Object.entries(stored).filter((entry) => typeof entry[1] === "number"));
}
async function markUsed($, id, now) {
  await $.store.set(LAST_USED_KEY, { ...await readLastUsed($), [id]: now });
}
async function checkSignIn($, account) {
  if (account.engine === "codex") return codexSignedIn($, account.dir);
  if (account.engine === "codebuddy") return buddySignedIn($, account.dir);
  if (account.engine === "agy") return agySignedIn($, await homeOf($), account.dir);
  if (account.engine === "workbuddy") return buddySignedIn($, account.dir);
  if (account.engine === "opencode") return opencodeSignedIn($, account.dir);
  return void 0;
}
var SIGNED_OUT_RETRY_MS = 6e4;
var signIns = /* @__PURE__ */ new Map();
async function signedInOf($, account, fresh = false) {
  if (!supportsAccounts(account.engine)) return void 0;
  const id = accountId(account);
  const now = await $.clock.now();
  const cached = signIns.get(id);
  if (!fresh && cached && (cached.ok !== false || now - cached.at < SIGNED_OUT_RETRY_MS)) return cached.ok;
  const ok = await checkSignIn($, account).catch(() => false);
  signIns.set(id, { ok, at: now });
  return ok;
}
var claims = {};
async function pickUsable($, engine, accounts, skip = [], pool) {
  const now = await $.clock.now();
  const cooldowns = await readCooldowns($);
  const lastUsed = await readLastUsed($);
  const passed = [...skip];
  for (; ; ) {
    const picked = pickAccount(engine, accounts, cooldowns, now, configuredStrategy, { ...lastUsed, ...claims }, passed, pool);
    if (!picked.account) return picked;
    const id = accountId(picked.account);
    const held = claims[id];
    claims[id] = Math.max(now, (held ?? 0) + 1);
    if (!picked.account.dir || await signedInOf($, picked.account) !== false) return picked;
    if (held === void 0) delete claims[id];
    else claims[id] = held;
    passed.push(id);
  }
}
async function rotateAccounts(steps) {
  const trail = [];
  const tried = [];
  const edited = [];
  const startedAt = await steps.now();
  const withTrail = (result, stopped, bound) => {
    const quiet = steps.count <= 1 && !stopped && trail.every((step) => step.until === void 0 && !step.signedOut);
    const engineBound = bound ?? result.engineBound;
    return { ...result, ...engineBound ? { engineBound } : {}, ...edited.length > 0 ? { files: [...edited] } : {}, text: quiet ? result.text : `${accountsLine(trail)}${stopped ? ` (${stopped})` : ""}
${result.text}` };
  };
  let last;
  for (let attempt = 0; attempt < steps.count; attempt++) {
    const picked = await steps.pick(tried);
    if (!picked.account) {
      const earliest = picked.until !== null ? `; the earliest frees up at ${timeOf(picked.until)}` : "";
      if (last) return withTrail(last, `no other account of ${steps.engine} is free${earliest}`);
      return { ...await steps.refuse(allCoolingText(steps.engine, picked.until, steps.pool)), engineBound: "quota" };
    }
    const name = accountId(picked.account);
    tried.push(name);
    await steps.begin(name, attempt > 0);
    const now = await steps.now();
    const note = attempt > 0 ? `

${switchNote(edited.map((file) => relativeTo(steps.cwd, file)))}` : "";
    last = await steps.run(picked.account, note, Math.max(1, steps.minutes - Math.floor((now - startedAt) / 6e4)));
    for (const file of last.files ?? []) if (!edited.includes(file)) edited.push(file);
    if (last.isDone || steps.isAborted()) {
      trail.push({ id: name });
      return withTrail(last);
    }
    if (isSignedOutFailure(last.failure)) {
      await steps.signedOut?.(name);
      trail.push({ id: name, signedOut: true });
      last = { ...last, engineBound: "signed out" };
      continue;
    }
    if (!isQuotaFailure(last.failure)) {
      trail.push({ id: name });
      return withTrail(last, void 0, isModelUnavailable(last.failure) ? "unavailable" : void 0);
    }
    const until = cooldownFrom(last.failure ?? "", await steps.now());
    await steps.cooled(cooldownKey(name, steps.pool), until);
    trail.push({ id: name, until });
    last = { ...last, engineBound: "quota" };
  }
  return withTrail(last, steps.count > 1 ? "every account hit its limit" : void 0);
}
var isHidden = (run) => run.hidden === true;
var visibleRuns = (list) => list.filter((run) => !isHidden(run));
var hideFinished = (list) => list.map((run) => run.state === "running" || run.state === "queued" || isHidden(run) ? run : { ...run, hidden: true });
var headLine = (hydra, defaultEngine) => isAuto(hydra) ? `Heads on ${engineLabel(hydra, defaultEngine)} \xB7 model per Head` : `Head ${hydra.headModel} on ${engineLabel(hydra, defaultEngine)}`;
var LAPSED_NOTICE_MS = 6 * 60 * 6e4;
var LAPSED_GRACE_MS = 5 * 6e4;
var splitCooldownKey = (key) => {
  const hash = key.indexOf("#");
  return hash < 0 ? { id: key, pool: void 0 } : { id: key.slice(0, hash), pool: key.slice(hash + 1) };
};
async function coolingLines($, engines) {
  const now = await $.clock.now();
  const stored = await readCooldowns($);
  const cooldowns = activeCooldowns(stored, now);
  const unavailable = await activeUnavailable($, now);
  if (Object.keys(stored).length === 0 && unavailable.length === 0) return [];
  const runs2 = await readRuns($).catch(() => []);
  const isCleared = (engine, key, until) => {
    const { id, pool } = splitCooldownKey(key);
    const isDefault = id === `${engine}/${DEFAULT_ACCOUNT}`;
    return runs2.some((run) => run.state === "done" && run.engine === engine && (run.startedAt ?? 0) >= until && (run.account !== void 0 ? run.account === id : isDefault) && (pool === void 0 || usagePoolOf(engine, run.model) === pool));
  };
  const lines = [];
  for (const engine of engines) {
    const accounts = await accountsOf($, engine);
    const pools = /* @__PURE__ */ new Set([void 0]);
    for (const key of Object.keys(stored)) {
      const { id, pool } = splitCooldownKey(key);
      if (id.startsWith(`${engine}/`) && pool !== void 0) pools.add(pool);
    }
    for (const pool of pools) {
      const where = `${engine}${pool ? ` ${poolLabel(pool)}` : ""}`;
      const picked = pickAccount(engine, accounts, cooldowns, now, "fill", {}, [], pool);
      if (!picked.account && picked.until !== null) {
        lines.push(`${where}: every account at its limit until ${untilText(picked.until, now)}`);
        continue;
      }
      const cooling = accounts.map((account) => coolingUntil(cooldowns, accountId(account), pool)).filter((until) => until > now);
      if (pool === void 0 && cooling.length > 0) lines.push(`${where}: ${cooling.length} of ${accounts.length} accounts at its limit until ${untilText(Math.min(...cooling), now)}`);
    }
    for (const [key, until] of Object.entries(stored)) {
      if (!key.startsWith(`${engine}/`) || until > now || now - until < LAPSED_GRACE_MS || now - until > LAPSED_NOTICE_MS) continue;
      if (isCleared(engine, key, until)) continue;
      const { pool } = splitCooldownKey(key);
      lines.push(`${engine}${pool ? ` ${poolLabel(pool)}` : ""}: was at its limit until ${untilText(until, now)} (not confirmed free since)`);
    }
  }
  for (const [, entry] of unavailable) if (engines.includes(entry.engine)) lines.push(`${entry.engine} ${entry.model}: could not start here at ${timeOf(entry.until)} (${entry.reason})`);
  return lines;
}
async function recordSignedOut($, id) {
  signIns.set(id, { ok: false, at: await $.clock.now() });
  await recordCooldown($, id, await $.clock.now() + SIGNED_OUT_COOLDOWN_MS);
}

// hooks/engines/codebuddy.ts
var BUDDY_TOOLS = {
  Read: "read_file",
  Edit: "edit_file",
  MultiEdit: "edit_file",
  NotebookEdit: "edit_file",
  Write: "write_file",
  Bash: "shell_command",
  Grep: "grep",
  Glob: "glob",
  LS: "read_directory"
};
var BUDDY_DENIAL = /has been denied|requires approval|permission prompts are not available|blocked by|outside the project|write guard/i;
var newBuddyState = () => ({ messages: /* @__PURE__ */ new Set(), calls: /* @__PURE__ */ new Map(), files: /* @__PURE__ */ new Set(), denied: [], inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, sawUsage: false });
var addBuddyUsage = (usage, state) => {
  if (!usage) return;
  const cached = usage.cache_read_input_tokens ?? 0;
  state.inputTokens += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + cached;
  state.cachedInputTokens += cached;
  state.outputTokens += usage.output_tokens ?? 0;
};
var blockText = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "").join(" ") : "";
var foldBuddyRow = (row, state) => {
  const events = [];
  if (row.type === "result") {
    if (!state.sawUsage) addBuddyUsage(row.usage, state);
    return events;
  }
  const content = row.message?.content;
  if (!Array.isArray(content)) return events;
  if (row.type === "assistant") {
    const id = row.message?.id;
    const isNew = !id || !state.messages.has(id);
    if (id && isNew) {
      state.messages.add(id);
      events.push({ type: "turn_end" });
    }
    if (isNew && row.message?.usage) {
      state.sawUsage = true;
      addBuddyUsage(row.message.usage, state);
    }
    for (const block of content) {
      if (block.type === "thinking") events.push({ type: "thinking_start" });
      if (block.type === "tool_use" && block.id && block.name) {
        const tool = BUDDY_TOOLS[block.name] ?? block.name.toLowerCase();
        const input = block.input ?? {};
        state.calls.set(block.id, { tool, input });
        events.push({ type: "tool_queued", toolCallId: block.id, toolName: tool, input }, { type: "tool_running", toolCallId: block.id, toolName: tool });
      }
    }
  } else if (row.type === "user") {
    for (const block of content) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const call = state.calls.get(block.tool_use_id);
      const text = blockText(block.content);
      const isDenied = block.is_error === true && BUDDY_DENIAL.test(text);
      const path = call?.input.file_path ?? call?.input.notebook_path;
      if (isDenied) {
        state.denied.push({ tool: call?.tool ?? "tool", target: String(path ?? call?.input.path ?? call?.input.command ?? ""), text: text.replace(/\s+/g, " ").trim() });
      } else if (!block.is_error && call && EDIT_TOOLS.has(call.tool) && typeof path === "string") {
        state.files.add(path);
      }
      events.push({ type: isDenied ? "tool_denied" : "tool_completed", toolCallId: block.tool_use_id, toolName: call?.tool, isError: block.is_error === true });
    }
  }
  return events;
};
var BUDDY_SHELL_DENY = [
  ...DANGEROUS_SHELL.map((rule) => rule.replace(/^Shell\((.*)\)$/, "Bash($1)")),
  "Bash(* .env*)",
  "Bash(*/.env*)",
  "Bash(*=.env*)",
  "Bash(* .hydraignore*)",
  "Bash(*/.hydraignore*)",
  "Bash(*=.hydraignore*)"
];
var buddyTools = (shell, search = true) => ["Read", "Write", "Edit", "Glob", ...search ? ["Grep"] : [], ...shell ? ["Bash"] : []].join(",");
var buddySecretDeny = (home) => {
  const base = trimSlash(home);
  if (!base || base === "/") return [];
  return SECRET_PATHS.flatMap((dir) => [`Read(${base}/${dir})`, `Read(${base}/${dir}/**)`, `Bash(*${base}/${dir}*)`, `Bash(*~/${dir}*)`, `Bash(*$HOME/${dir}*)`]);
};
var buddyGuardedDeny = (paths) => [
  ...paths.flatMap((path) => ["Read", "Edit", "Write"].flatMap((tool) => [`${tool}(${path})`, `${tool}(${path}/**)`])),
  ...[...new Set(paths.map(baseName))].flatMap((name) => [`Bash(* ${name}*)`, `Bash(*/${name}*)`, `Bash(*=${name}*)`])
];
var buddySettings = (cwd, head, guard, home = "") => {
  const own = [cwd, ...head.writeDirs ?? []].map(trimSlash);
  const extra = union(head.addDirs.map(trimSlash), (head.writeDirs ?? []).map(trimSlash));
  const readOnly = extra.filter((dir) => !own.some((root) => isWithin(dir, root)));
  return {
    permissions: {
      allow: [
        ...own.flatMap((root) => [`Edit(${root}/**)`, `Write(${root}/**)`]),
        ...extra.flatMap((dir) => [`Read(${dir}/**)`, `Glob(${dir}/**)`, `Grep(${dir}/**)`]),
        ...head.shell ? ["Bash"] : []
      ],
      deny: [
        ...own.flatMap((root) => [
          `Edit(${root}/.git/**)`,
          `Write(${root}/.git/**)`,
          `Edit(${root}/**/.hydraignore)`,
          `Write(${root}/**/.hydraignore)`,
          `Edit(${root}/**/.env)`,
          `Edit(${root}/**/.env.*)`,
          `Write(${root}/**/.env)`,
          `Write(${root}/**/.env.*)`,
          `Read(${root}/**/.env)`,
          `Read(${root}/**/.env.*)`,
          `Glob(${root}/**/.env)`,
          `Glob(${root}/**/.env.*)`,
          `Grep(${root}/**/.env)`,
          `Grep(${root}/**/.env.*)`
        ]),
        ...readOnly.flatMap((dir) => [
          `Edit(${dir}/**)`,
          `Write(${dir}/**)`,
          `Read(${dir}/**/.env)`,
          `Read(${dir}/**/.env.*)`,
          `Glob(${dir}/**/.env)`,
          `Glob(${dir}/**/.env.*)`,
          `Grep(${dir}/**/.env)`,
          `Grep(${dir}/**/.env.*)`
        ]),
        ...buddySecretDeny(home),
        ...buddyGuardedDeny(head.guarded?.paths ?? []),
        ...head.shell ? BUDDY_SHELL_DENY : []
      ]
    },
    ...guard ? { hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: guard, timeout: 10 }] }] } } : {}
  };
};
var buddyEffort = (effort) => effort === "off" ? "minimal" : effort;
var buddyTokensText = (inputTokens, cachedTokens, outputTokens) => {
  const text = tokensText(inputTokens, outputTokens);
  if (cachedTokens <= 0) return text;
  const short = (n) => n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
  return text.replace(" in /", ` in (${short(cachedTokens)} cached) /`);
};
var buddyArgs = (a) => {
  const args = [
    "codebuddy",
    "-p",
    a.prompt,
    "--model",
    a.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "default",
    "--tools",
    buddyTools(a.shell, a.search !== false),
    "--settings",
    a.settings,
    "--setting-sources",
    "local",
    "--max-turns",
    String(a.maxTurns)
  ];
  for (const dir of a.addDirs) args.push("--add-dir", dir);
  if (a.effort) args.push("--effort", buddyEffort(a.effort));
  args.push(...a.resume ? ["--resume", a.resume] : ["--session-id", a.sessionId]);
  return args;
};
var buddySessionId = (id, now) => `hydra-${id}-${now.toString(36)}`;
var isBuddyError = (row) => row !== null && (row.is_error === true || typeof row.subtype === "string" && row.subtype.startsWith("error") && row.subtype !== "error_max_turns");
var buddyFailureText = (row) => {
  if (row === null || !isBuddyError(row)) return "";
  const infos = Array.isArray(row.errors_info) ? row.errors_info : [];
  const kinds = infos.map((info) => {
    const { status, category } = info && typeof info === "object" ? info : {};
    return [typeof status === "number" ? String(status) : "", typeof category === "string" ? category : ""].filter(Boolean).join(" ");
  });
  const errors = Array.isArray(row.errors) ? row.errors.filter((item) => typeof item === "string") : [];
  return [typeof row.result === "string" ? row.result : "", ...errors, ...kinds].filter(Boolean).join("\n");
};
var BUDDY_SIGNED_OUT = /Authentication required\. Please use \/login/i;
var isSignedOutRow = (row) => row.type === "assistant" && Array.isArray(row.message?.content) && (row.message?.usage?.output_tokens ?? 0) === 0 && (row.message?.content).some((block) => block.type === "text" && BUDDY_SIGNED_OUT.test(block.text ?? ""));
async function runRoundBuddy($, argv, signal, onEvent) {
  let result = null;
  let started;
  let isCapped = false;
  let isSignedOut = false;
  const turnsBefore = argv.state.messages.size;
  argv.state.sawUsage = false;
  const { errors, exit } = await pump($, buddyArgs(argv), argv.cwd, signal, async (line) => {
    if (!line.trim().startsWith("{")) return false;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return false;
    }
    if (row.type === "system" && row.subtype === "init" && typeof row.session_id === "string") started = row.session_id;
    if (isSignedOutRow(row)) {
      isSignedOut = true;
      return true;
    }
    if (row.type === "result") result = row;
    for (const event of foldBuddyRow(row, argv.state)) await onEvent(event);
    if (argv.state.messages.size - turnsBefore > argv.maxTurns) isCapped = true;
    return isCapped;
  }, argv.env);
  const final = result;
  if (isSignedOut) {
    return { finalText: "", sessionId: started, subtype: "error", code: 41, signal: exit.signal, errors: 'The CLI is not signed in: it answered "Authentication required. Please use /login". Sign it in (see /hydra engines) and run the Head again.', startedSession: started };
  }
  return {
    finalText: String(final?.result ?? ""),
    sessionId: typeof final?.session_id === "string" ? final.session_id : void 0,
    subtype: isCapped ? "error_max_turns" : typeof final?.subtype === "string" ? final.subtype : void 0,
    code: isCapped ? 8 : exit.code,
    signal: exit.signal,
    errors: [errors, buddyFailureText(final)].filter(Boolean).join("\n").slice(-2e3),
    startedSession: started
  };
}
var BUDDY_SETTINGS_DIR = ".claude/hydra/heads";
async function writeBuddySettings($, cwd, id, needs) {
  const home = await homeOf($);
  const dir = `${home}/${BUDDY_SETTINGS_DIR}`;
  await $.process.run(["/bin/mkdir", "-p", dir]);
  const path = `${dir}/${await $.session.id()}-${id}.json`;
  const settings = buddySettings(cwd, needs, guardCommand($.plugin.root, cwd, needs.writeDirs ?? []), home);
  await $.fs.write(path, JSON.stringify(settings, null, 2) + "\n");
  return path;
}
async function runBuddyHead($, head, outer, id) {
  const { cwd, model } = head;
  const unsupported = /^[A-Za-z]:|^\\\\|\\/.test(cwd) ? `${cwd} is a Windows path, and Hydra's rules use POSIX paths. Run Claude Code under WSL instead.` : void 0;
  let settings = "";
  const refusal = unsupported ?? await writeBuddySettings($, cwd, id, { addDirs: head.addDirs, writeDirs: head.writeDirs, shell: head.shell, guarded: head.guarded }).then(
    (path) => {
      settings = path;
      return void 0;
    },
    (error) => `Hydra could not write the Head's permission settings (${String(error).slice(0, 160)}). Check that ~/.claude is writable, then run the Head again.`
  );
  if (refusal) {
    await setRun($, id, { state: "failed", endedAt: await $.clock.now(), activity: refusal });
    await refreshStatus($);
    return notStarted(id, model, cwd, `${refusal} A Head never starts without Hydra's rules.`, head.engine ?? "codebuddy", "unavailable");
  }
  try {
    return await runBuddyRounds($, head, settings, outer, id);
  } finally {
    await $.process.run(["/bin/rm", "-f", settings]).catch(() => void 0);
  }
}
async function runBuddyRounds($, head, settings, outer, id) {
  const { task, cwd, model, maxTurns, addDirs, shell, minutes } = head;
  const searchBlock = head.guarded?.paths[0];
  const search = !searchBlock;
  const effortNow = async () => headEffort(effortModeOf(await readMode($)), head.effort);
  let turns = 0;
  const state = newBuddyState();
  const labels = /* @__PURE__ */ new Map();
  const counter = createCallCounter();
  const onEvent = async (event) => {
    counter.see(event);
    if (event.type === "turn_end") turns++;
    await setRun($, id, (run) => applyEvent(run, event, labels, cwd));
  };
  const runRound2 = async (round2, signal) => {
    const effort = await effortNow();
    await setRun($, id, { effort });
    const ran = await runRoundBuddy($, { ...round2, model, effort, cwd, addDirs, settings, shell, search, sessionId: buddySessionId(id, await $.clock.now()), state, env: head.env }, signal, onEvent);
    return { ...ran, effort };
  };
  const startedAt = await $.clock.now();
  await snapshotChangedFiles($, id, [cwd, ...head.writeDirs]);
  const ended = await runRounds({
    task,
    maxTurns,
    minutes,
    outer,
    resume: head.resume,
    runRound: runRound2,
    turns: () => turns,
    calls: () => counter.calls,
    denied: () => state.denied.map((d) => `${d.tool} ${relativeTo(cwd, d.target)}`),
    // A usage limit answers every resume the same way: stop so the Head moves to the next account.
    mayResume: (round2) => !isQuotaFailure(round2.errors),
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
    onStep: (activity) => setRun($, id, { activity })
  });
  const { round, rounds, sessionId, ending } = ended;
  const files = [...state.files];
  const tokens = buddyTokensText(state.inputTokens, state.cachedInputTokens, state.outputTokens);
  const endedAt = await $.clock.now();
  const edits = await compareChangedFiles($, id, { cwd, startedAt, endedAt }, [cwd, ...head.writeDirs]);
  const isDone = ending === "done";
  const stopped = outer.aborted ? stopReason(outer) : void 0;
  await setRun($, id, {
    state: isDone ? "done" : "failed",
    turns,
    tokens,
    endedAt,
    ending,
    sessionId,
    files: files.map((file) => relativeTo(cwd, file)),
    summary: summaryOf(round.finalText),
    activity: endActivity(ended, { maxTurns, minutes, stopped })
  });
  void refreshHeads($);
  const text = formatReport({
    id,
    model,
    effort: round.effort,
    cwd,
    sessionId,
    finished: isDone,
    ending,
    cap: ended.cap,
    maxTurns,
    startedAt,
    endedAt,
    rounds,
    turns,
    usd: null,
    files,
    denied: state.denied,
    finalText: round.finalText,
    exit: exitOf(ended, { minutes, stopped }),
    errors: round.errors,
    writeDirs: head.writeDirs,
    engine: head.engine ?? "codebuddy",
    tokens,
    rulesNote: searchBlock ? `search tool removed because ${relativeTo(cwd, searchBlock)} is in reach` : void 0,
    reverted: edits.reverted,
    deleted: edits.deleted,
    restored: edits.restored,
    overwritten: edits.overwritten,
    alsoRan: edits.alsoRan
  });
  return { text, fullText: round.finalText, isDone, failure: isDone ? void 0 : round.errors, files, ending, sessionId };
}

// hooks/engines/codex.ts
var CODEX_TOOLS = { command_execution: "shell_command", file_change: "edit_file", web_search: "web_search" };
var CODEX_DENIAL = /\b(?:declined|rejected|denied)\b/i;
var CODEX_SANDBOX = /permission denied|read-only file system|operation not permitted|EACCES|EROFS/i;
var SANDBOX_TOOL = "sandbox";
var newCodexState = () => ({ calls: /* @__PURE__ */ new Map(), files: /* @__PURE__ */ new Set(), denied: [], turns: 0, inputTokens: 0, outputTokens: 0, finalText: "", isCompleted: false });
var codexToolOf = (item) => item.type === "mcp_tool_call" ? `${item.server ?? "mcp"}.${item.tool ?? "tool"}` : CODEX_TOOLS[item.type ?? ""];
var foldCodexRow = (row, state) => {
  const events = [];
  if (row.type === "thread.started" && typeof row.thread_id === "string") state.threadId = row.thread_id;
  else if (row.type === "turn.completed") {
    state.isCompleted = true;
    state.inputTokens += row.usage?.input_tokens ?? 0;
    state.outputTokens += row.usage?.output_tokens ?? 0;
  } else if (row.type === "turn.failed") {
    state.failure = row.error?.message ?? row.message ?? "Codex reported an error";
  } else if (row.type === "error") {
    state.lastError = row.error?.message ?? row.message ?? "Codex reported an error";
  } else if ((row.type === "item.started" || row.type === "item.completed") && row.item) {
    const item = row.item;
    const isDone = row.type === "item.completed";
    if (item.type === "reasoning") events.push({ type: "thinking_start" });
    else if (item.type === "agent_message" && isDone && typeof item.text === "string") state.finalText = item.text;
    else {
      const tool = codexToolOf(item);
      const id = item.id;
      if (tool && id) {
        if (!state.calls.has(id)) {
          const input = item.type === "command_execution" ? { command: item.command ?? "" } : item.type === "file_change" ? { file_path: item.changes?.[0]?.path ?? "" } : item.type === "web_search" ? { pattern: item.query ?? "" } : {};
          state.calls.set(id, { tool, input });
          events.push({ type: "tool_queued", toolCallId: id, toolName: tool, input }, { type: "tool_running", toolCallId: id, toolName: tool });
        }
        if (isDone) {
          const call = state.calls.get(id);
          const output = item.aggregated_output ?? "";
          const isDenied = item.type === "command_execution" && item.exit_code == null && CODEX_DENIAL.test(`${item.status ?? ""} ${output}`);
          const isError = item.type === "command_execution" ? isDenied || item.exit_code != null && item.exit_code !== 0 || item.status === "failed" : item.status === "failed";
          if (isDenied) state.denied.push({ tool: call.tool, target: String(item.command ?? ""), text: output.replace(/\s+/g, " ").trim() });
          else if (isError && item.type === "command_execution" && CODEX_SANDBOX.test(output)) state.denied.push({ tool: SANDBOX_TOOL, target: String(item.command ?? ""), text: (output.split("\n").find((line) => CODEX_SANDBOX.test(line)) ?? output).replace(/\s+/g, " ").trim() });
          else if (!isError && item.type === "file_change") {
            for (const change of item.changes ?? []) if (change.path) state.files.add(change.path);
          }
          events.push({ type: isDenied ? "tool_denied" : "tool_completed", toolCallId: id, toolName: call.tool, isError, ...item.type === "file_change" ? { files: (item.changes ?? []).flatMap((change) => change.path ? [change.path] : []) } : {} }, { type: "turn_end" });
          state.turns++;
        }
      }
    }
  }
  return events;
};
var codexEffort = (effort) => effort === "ultra" ? "max" : ["low", "medium", "high", "xhigh", "max"].includes(effort) ? effort : "low";
var tomlString = (value) => JSON.stringify(value);
var codexFilesystem = (cwd, head, home = "", homeRead = [], tempDir = "", extraRead = []) => {
  const homeDir = home ? trimSlash(home) : "";
  const isSecret = (dir) => {
    const rel = homeDir ? homeRelative(dir, homeDir) : void 0;
    return rel !== void 0 && isSecretPath(rel);
  };
  const writable = [cwd, ...head.writeDirs ?? []].map(trimSlash).filter((dir) => dir === trimSlash(cwd) || !isSecret(dir));
  const readable = head.addDirs.map(trimSlash).filter((dir) => !isSecret(dir) && !writable.some((root) => isWithin(dir, root)));
  const readOnly = extraRead.map(trimSlash).filter((dir) => dir !== "" && !isSecret(dir) && !writable.some((root) => isWithin(dir, root)));
  const roots = union(union(writable, readable), readOnly);
  const isHomeClosed = homeDir !== "" && !writable.some((dir) => isWithin(homeDir, dir));
  const entries = [
    ["/", "read"],
    ...isHomeClosed ? [[homeDir, "none"], ...homeRead.map((dir) => [`${homeDir}/${dir}`, "read"])] : [],
    ...readable.map((dir) => [dir, "read"]),
    ...readOnly.map((dir) => [dir, "read"]),
    ...writable.map((dir) => [dir, "write"]),
    ...tempDir ? [[trimSlash(tempDir), "write"]] : [],
    ...roots.flatMap((dir) => [[`${dir}/**/.env`, "none"], [`${dir}/**/.env.*`, "none"]]),
    // Codex takes only `none` on a glob, so each `.hydraignore` is made read-only by its exact path.
    ...(head.guarded?.ignoreFiles ?? []).filter((file) => writable.some((root) => isWithin(file, root))).map((file) => [file, "read"]),
    ...(head.guarded?.paths ?? []).filter((path) => roots.some((root) => isWithin(path, root))).map((path) => [path, "none"]),
    ...homeDir ? SECRET_PATHS.map((dir) => [`${homeDir}/${dir}`, "none"]) : []
  ];
  const rank = { read: 0, write: 1, none: 2 };
  const profile = /* @__PURE__ */ new Map();
  for (const [path, access] of entries) {
    const held = profile.get(path);
    if (held === void 0 || rank[access] > rank[held]) profile.set(path, access);
  }
  return `{${[...profile].map(([path, access]) => `${tomlString(path)}=${tomlString(access)}`).join(",")},glob_scan_max_depth=6}`;
};
var codexArgs = (a) => {
  const args = [
    "codex",
    "exec",
    ...a.resume ? ["resume"] : [],
    "--json",
    "-m",
    a.model,
    "--skip-git-repo-check",
    "--ignore-user-config",
    "-c",
    'default_permissions="hydra"',
    "-c",
    `permissions.hydra.filesystem=${a.filesystem}`,
    "-c",
    'approval_policy="never"'
  ];
  if (a.effort) args.push("-c", `model_reasoning_effort=${tomlString(codexEffort(a.effort))}`);
  if (a.baseUrl) args.push("-c", `openai_base_url=${tomlString(a.baseUrl)}`);
  args.push("--", ...a.resume ? [a.resume] : [], a.prompt);
  return args;
};
async function runRoundCodex($, argv, signal, onEvent) {
  const { state } = argv;
  state.finalText = "";
  state.failure = void 0;
  state.isCompleted = false;
  const turnsBefore = state.turns;
  let isCapped = false;
  const { errors, exit } = await pump($, codexArgs(argv), argv.cwd, signal, async (line) => {
    if (!line.trim().startsWith("{")) return false;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return false;
    }
    for (const event of foldCodexRow(row, state)) await onEvent(event);
    if (state.turns - turnsBefore > argv.maxTurns) isCapped = true;
    return isCapped;
  }, argv.env);
  return {
    finalText: state.finalText,
    sessionId: state.threadId,
    subtype: state.failure ? "error" : isCapped ? "error_max_turns" : state.isCompleted ? "success" : state.lastError ? "error" : void 0,
    code: isCapped ? 8 : exit.code,
    signal: exit.signal,
    errors: [state.failure ?? (state.isCompleted ? void 0 : state.lastError), errors].filter(Boolean).join("\n").slice(-2e3)
  };
}
var CODEX_MOUNT_POINTS = [".agents", ".aws", ".codex"];
async function missingMountPoints($, roots) {
  const missing = [];
  for (const root of roots) {
    for (const name of CODEX_MOUNT_POINTS) {
      const path = `${trimSlash(root)}/${name}`;
      if (!await $.fs.exists(path).catch(() => true)) missing.push(path);
    }
  }
  return missing;
}
async function gitReadDirs($, cwd, home) {
  const ran = await $.process.run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { timeoutMs: 1e4 }).catch(() => void 0);
  if (!ran || ran.exitCode !== 0) return [];
  const dirs = await realPaths2($, ran.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
  return dirs.filter((dir) => !isWithin(dir, cwd) && !(home && isWithin(home, dir)));
}
var absolutePath = (base, path) => {
  const parts = (path.startsWith("/") ? path : `${trimSlash(base)}/${path}`).split("/");
  const out = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
};
async function worktreeGitDirs($, cwd) {
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(await $.fs.read(`${trimSlash(cwd)}/.git`).catch(() => ""))?.[1];
  if (!gitdir) return [];
  const resolved2 = absolutePath(cwd, gitdir);
  const common = (await $.fs.read(`${resolved2}/commondir`).catch(() => "")).trim();
  return common ? [resolved2, absolutePath(resolved2, common)] : [resolved2];
}
var CODEX_PLAN_REFUSAL = /not supported when using Codex with a ChatGPT account/i;
var CODEX_PLAN_MODEL = "gpt-6-luna";
var refusedOnPlan = /* @__PURE__ */ new Set();
var planWarning = (model) => `${model} is not available on this ChatGPT plan, so the Head ran on ${CODEX_PLAN_MODEL}. Check its work as you would a lighter model's, or set head=${CODEX_PLAN_MODEL}.`;
async function codexTempRoot($) {
  return trimSlash(toSlashes(await $.env.get("TMPDIR") || "/tmp"));
}
var CODEX_TEMP_PREFIX = "hydra-codex-";
var CODEX_GO_DIRS = ["go-build", "go-tmp"];
async function makeCodexTemp($, id) {
  const dir = `${await codexTempRoot($)}/${CODEX_TEMP_PREFIX}${await $.session.id()}-${id}`;
  const goDirs = CODEX_GO_DIRS.map((name) => `${dir}/${name}`);
  await $.process.run(["/bin/mkdir", "-p", dir, ...goDirs]);
  await $.process.run(["/bin/chmod", "700", dir, ...goDirs]);
  return dir;
}
async function removeCodexTemp($, dir) {
  if (dir.includes(`/${CODEX_TEMP_PREFIX}`)) await $.process.run(["/bin/rm", "-rf", dir]).catch(() => void 0);
}
var codexEnv = (tempDir, env = {}) => ({
  ...env,
  TMPDIR: `${tempDir}/`,
  TMPPREFIX: `${tempDir}/zsh`,
  GOCACHE: `${tempDir}/go-build`,
  GOTMPDIR: `${tempDir}/go-tmp`
});
var codexBaseUrl = (config) => /^[ \t]*openai_base_url[ \t]*=[ \t]*"([^"]+)"/m.exec(config.split(/^[ \t]*\[/m)[0] ?? "")?.[1];
async function runCodexHead($, head, outer, id) {
  const { cwd, model } = head;
  if (/^[A-Za-z]:|^\\\\|\\/.test(cwd)) {
    const refusal = `${cwd} is a Windows path, and Hydra's rules use POSIX paths. Run Claude Code under WSL instead.`;
    await setRun($, id, { state: "failed", endedAt: await $.clock.now(), activity: refusal });
    await refreshStatus($);
    return notStarted(id, model, cwd, `${refusal} A Head never starts without Hydra's rules.`, "codex", "unavailable");
  }
  const [realCwd] = await realPaths2($, [cwd]);
  const writeDirs = await realPaths2($, head.writeDirs);
  const home = await homeOf($);
  const [realHome] = home ? await realPaths2($, [home]) : [""];
  if (!realHome) {
    const refusal = "Hydra cannot find your home folder (HOME is empty), so it cannot close it to a Codex Head.";
    await setRun($, id, { state: "failed", endedAt: await $.clock.now(), activity: refusal });
    await refreshStatus($);
    return notStarted(id, model, cwd, `${refusal} A Head never starts without Hydra's rules.`, "codex", "unavailable");
  }
  const homeRead = realHome ? await homeReadDirs($, realHome) : [];
  for (const dir of [".agents/skills", ".codex/skills"]) {
    if (await $.fs.exists(`${realHome}/${dir}`).catch(() => false)) homeRead.push(dir);
  }
  const repoDirs = await gitReadDirs($, realCwd, realHome);
  const worktreeDirs = await worktreeGitDirs($, realCwd);
  const tempDir = await makeCodexTemp($, id);
  const filesystem = codexFilesystem(realCwd, { addDirs: union(await realPaths2($, head.addDirs), repoDirs), writeDirs, shell: true, guarded: head.guarded }, realHome, homeRead, tempDir, worktreeDirs);
  const baseUrl = codexBaseUrl(await $.fs.read(`${head.env?.CODEX_HOME ?? `${realHome}/.codex`}/config.toml`).catch(() => ""));
  try {
    return await runCodexRounds($, head, filesystem, baseUrl, tempDir, outer, id);
  } finally {
    await removeCodexTemp($, tempDir);
  }
}
async function runCodexRounds($, head, filesystem, baseUrl, tempDir, outer, id) {
  const { task, cwd, maxTurns, minutes } = head;
  let model = refusedOnPlan.has(head.model) ? CODEX_PLAN_MODEL : head.model;
  const warnings = model === head.model ? [] : [planWarning(head.model)];
  const effortNow = async () => headEffort(effortModeOf(await readMode($)), head.effort);
  const startedAt = await $.clock.now();
  await snapshotChangedFiles($, id, [cwd, ...head.writeDirs]);
  const mountPoints = await missingMountPoints($, [cwd, ...head.writeDirs]);
  const state = newCodexState();
  const labels = /* @__PURE__ */ new Map();
  const counter = createCallCounter();
  const onEvent = async (event) => {
    counter.see(event);
    await setRun($, id, (run) => applyEvent(run, event, labels, cwd));
  };
  const roundOn = async (round2, signal) => {
    const effort = await effortNow();
    await setRun($, id, { effort });
    const ran = await runRoundCodex($, { ...round2, model, effort, cwd, addDirs: head.addDirs, filesystem, baseUrl, state, env: codexEnv(tempDir, head.env) }, signal, onEvent);
    return { ...ran, effort };
  };
  const runRound2 = async (round2, signal) => {
    const ran = await roundOn(round2, signal);
    if (model === CODEX_PLAN_MODEL || !CODEX_PLAN_REFUSAL.test(ran.errors ?? "")) return ran;
    refusedOnPlan.add(model);
    warnings.push(planWarning(model));
    model = CODEX_PLAN_MODEL;
    Object.assign(state, { threadId: void 0, failure: void 0, lastError: void 0 });
    await setRun($, id, { model });
    return roundOn(round2, signal);
  };
  const ended = await runRounds({
    task,
    maxTurns,
    minutes,
    outer,
    resume: head.resume,
    runRound: runRound2,
    turns: () => state.turns,
    calls: () => counter.calls,
    denied: () => state.denied.map((d) => `${d.tool} ${d.target}`.slice(0, 160)),
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
    onStep: (activity) => setRun($, id, { activity })
  });
  const { round, rounds, sessionId, ending } = ended;
  if (mountPoints.length > 0) await $.process.run(["/bin/rmdir", ...mountPoints]).catch(() => void 0);
  const files = union([...state.files], await changedFiles($, startedAt, [cwd, ...head.writeDirs]));
  const endedAt = await $.clock.now();
  const edits = await compareChangedFiles($, id, { cwd, startedAt, endedAt }, [cwd, ...head.writeDirs]);
  const tokens = tokensText(state.inputTokens, state.outputTokens);
  const isDone = ending === "done";
  const stopped = outer.aborted ? stopReason(outer) : void 0;
  await setRun($, id, {
    state: isDone ? "done" : "failed",
    turns: state.turns,
    tokens,
    endedAt,
    ending,
    sessionId,
    files: files.map((file) => relativeTo(cwd, file)),
    summary: summaryOf(round.finalText),
    activity: endActivity(ended, { maxTurns, minutes, stopped })
  });
  void refreshHeads($);
  const text = formatReport({
    id,
    model,
    effort: round.effort,
    cwd,
    sessionId,
    finished: isDone,
    ending,
    cap: ended.cap,
    maxTurns,
    rounds,
    turns: state.turns,
    usd: null,
    files,
    denied: state.denied,
    finalText: round.finalText,
    exit: exitOf(ended, { minutes, stopped }),
    errors: round.errors,
    writeDirs: head.writeDirs,
    engine: "codex",
    tokens,
    warnings,
    startedAt,
    endedAt,
    reverted: edits.reverted,
    deleted: edits.deleted,
    restored: edits.restored,
    overwritten: edits.overwritten,
    alsoRan: edits.alsoRan
  });
  return { text, fullText: round.finalText, isDone, failure: isDone ? void 0 : round.errors, files, ending, sessionId };
}

// hooks/engines/commandcode.ts
var RULES_FILE = ".commandcode/settings.local.json";
var POLICY_FILE = ".commandcode/hydra-guard.json";
var OWNER = "hydra";
var WATCHED = /* @__PURE__ */ new Set(["turn_end", "thinking_start", "tool_queued", "tool_running", "tool_completed", "tool_denied"]);
var COMMANDCODE_WATCHDOG = { firstMs: 6e5, idleMs: 6e5 };
async function sessionReport($, sessionId, since) {
  try {
    const ran = await runScript($, "cc-usage.py", ["--report", sessionId, ...since ? [String(since)] : []]);
    return JSON.parse(ran.stdout);
  } catch {
    return { usd: null, files: [], denied: [], toolCalls: 0 };
  }
}
var PROJECT_DENY = [
  "Edit(/.git/**)",
  "Edit(/.commandcode/**)",
  "Edit(.hydraignore)",
  "Shell(* .hydraignore*)",
  "Shell(*/.hydraignore*)",
  "Shell(*=.hydraignore*)",
  "Read(.env)",
  "Read(.env.*)",
  "Edit(.env)",
  "Edit(.env.*)",
  "Shell(* .env*)",
  "Shell(*/.env*)",
  "Shell(*=.env*)"
];
var SEARCH_DENY = "Grep";
var writeDirsOf = (heads2) => heads2.reduce((dirs, head) => union(dirs, head.writeDirs ?? []), []);
var writeDirDeny = (dir) => [
  `Edit(/${dir}/.git/**)`,
  `Edit(/${dir}/.commandcode/**)`,
  `Edit(/${dir}/**/.hydraignore)`,
  `Edit(/${dir}/**/.env)`,
  `Edit(/${dir}/**/.env.*)`,
  `Read(/${dir}/**/.env)`,
  `Read(/${dir}/**/.env.*)`
];
var secretReadDeny = (home) => {
  const base = trimSlash(home);
  if (!base || base === "/") return [];
  return SECRET_PATHS.flatMap((dir) => [
    `Read(/${base}/${dir})`,
    `Read(/${base}/${dir}/**)`,
    `Shell(*${base}/${dir}*)`,
    `Shell(*~/${dir}*)`,
    `Shell(*$HOME/${dir}*)`,
    `Shell(*\${HOME}/${dir}*)`
  ]);
};
var guardedDeny = (paths) => [
  ...paths.flatMap((path) => [`Read(/${path})`, `Read(/${path}/**)`, `Edit(/${path})`, `Edit(/${path}/**)`]),
  ...[...new Set(paths.map(baseName))].flatMap((name) => [`Shell(* ${name}*)`, `Shell(*/${name}*)`, `Shell(*=${name}*)`])
];
var guardedOf = (heads2) => heads2.reduce((paths, head) => union(paths, head.guarded?.paths ?? []), []);
var headSettings = (heads2, outsideDeny, hasEnvFile = false, guard, home = "", strict = false) => {
  const shell = !strict && heads2.some((head) => head.shell);
  const writeDirs = writeDirsOf(heads2);
  const guarded = guardedOf(heads2);
  return {
    managedBy: OWNER,
    permissions: {
      deny: [
        ...outsideDeny,
        ...PROJECT_DENY,
        ...writeDirs.flatMap(writeDirDeny),
        ...secretReadDeny(home),
        ...guardedDeny(guarded),
        ...shell ? DANGEROUS_SHELL : ["Shell"],
        ...strict || hasEnvFile || guarded.length > 0 ? [SEARCH_DENY] : []
      ],
      additionalDirectories: heads2.reduce((dirs, head) => union(dirs, [...head.addDirs, ...head.writeDirs ?? []]), [])
    },
    ...guard ? {
      hooks: {
        PreToolUse: [
          strict ? { hooks: [{ type: "command", command: guard, timeout: 10, failClosed: true }] } : { matcher: "write|edit", hooks: [{ type: "command", command: guard, timeout: 10 }] }
        ]
      }
    } : {}
  };
};
var guardPolicy = (cwd, heads2, home) => ({
  write: [cwd, ...writeDirsOf(heads2)],
  read: heads2.reduce((dirs, head) => union(dirs, head.addDirs), []),
  guarded: guardedOf(heads2),
  home,
  secrets: SECRET_PATHS
});
var waysDown = (roots) => {
  const ways = /* @__PURE__ */ new Map();
  for (const root of roots) {
    let base = "";
    for (const part of root.split("/").filter(Boolean)) {
      if (roots.some((other) => base && isWithin(base, other))) break;
      ways.set(base, (ways.get(base) ?? /* @__PURE__ */ new Set()).add(part));
      base += `/${part}`;
    }
  }
  return ways;
};
var ancestorDenyRules = (roots, entriesOf) => {
  const rules = [];
  for (const [base, names] of waysDown(roots)) {
    rules.push(`Edit(/${base}/*)`);
    for (const name of entriesOf(base || "/")) {
      if (names.has(name)) continue;
      const path = `${base}/${name}`.slice(1);
      rules.push(`Edit(//${path})`, `Edit(//${path}/**)`);
    }
  }
  return rules;
};
async function outsideDenyRules($, roots) {
  const listings = /* @__PURE__ */ new Map();
  for (const base of waysDown(roots).keys()) listings.set(base || "/", (await $.fs.list(base || "/")).map((entry) => entry.name));
  return ancestorDenyRules(roots, (dir) => listings.get(dir) ?? []);
}
var mergeHeads = (inFile, mine, sessionId, now) => [
  ...inFile.filter((entry) => !entry.key.startsWith(`${sessionId}/`) && entry.until > now),
  ...mine
];
var projects = /* @__PURE__ */ new Map();
var searchOff = /* @__PURE__ */ new Map();
var UNTIL_SLACK_MS = 5 * 6e4;
async function findEnvFile($, dirs) {
  const found = await $.process.run([
    "find",
    ...dirs,
    "(",
    "-name",
    ".git",
    "-o",
    "-name",
    "node_modules",
    ")",
    "-prune",
    "-o",
    "-type",
    "f",
    "(",
    "-name",
    ".env",
    "-o",
    "-name",
    ".env.*",
    ")",
    "!",
    "-name",
    ".env.example",
    "!",
    "-name",
    ".env.sample",
    "!",
    "-name",
    ".env.template",
    "!",
    "-name",
    ".env.dist",
    "-print",
    "-quit"
  ]).catch(() => null);
  if (!found) return "the .env check could not run";
  const first = found.stdout.split("\n")[0]?.trim();
  if (first) return first;
  return found.exitCode === 0 ? void 0 : "the .env check could not read every folder";
}
var rulesPath = (cwd) => `${cwd.replace(/\/$/, "")}/${RULES_FILE}`;
var policyPath = (cwd) => `${cwd.replace(/\/$/, "")}/${POLICY_FILE}`;
var WINDOWS_SEARCH_OFF = "windows";
var RULES_INVALID = `${RULES_FILE} is not valid JSON. Fix or delete it, then run the Head again.`;
var RULES_TAKEN = `${RULES_FILE} holds your own Command Code rules, and Hydra needs that file to lock Heads down. Move your rules to .commandcode/settings.json (Command Code reads both), then run the Head again.`;
function writeRules($, cwd) {
  const key = rulesPath(cwd);
  const next = (rulesWrites.get(key) ?? Promise.resolve()).then(() => writeRulesNow($, cwd));
  const settled = next.catch(() => void 0);
  rulesWrites.set(key, settled);
  void settled.then(() => {
    if (rulesWrites.get(key) === settled) rulesWrites.delete(key);
  });
  return next;
}
var rulesWrites = /* @__PURE__ */ new Map();
async function writeRulesNow($, cwd) {
  const path = rulesPath(cwd);
  const strict = await platformOf($) === "windows";
  let inFile = [];
  if (await $.fs.exists(path)) {
    let existing;
    try {
      existing = JSON.parse(await $.fs.read(path));
    } catch {
      return RULES_INVALID;
    }
    if (existing.managedBy !== OWNER) return RULES_TAKEN;
    inFile = Array.isArray(existing.hydraHeads) ? existing.hydraHeads : [];
  }
  const heads2 = mergeHeads(inFile, [...projects.get(cwd)?.values() ?? []], await $.session.id(), await $.clock.now());
  if (heads2.length === 0) {
    searchOff.delete(cwd);
    if (await $.fs.exists(path)) await removeFile($, path);
    if (strict) await removeFile($, policyPath(cwd)).catch(() => void 0);
    await removeFile($, `${cwd.replace(/\/$/, "")}/.commandcode`, true).catch(() => void 0);
    return void 0;
  }
  const writeDirs = writeDirsOf(heads2);
  const home = await homeOf($);
  let settings;
  if (strict) {
    const python2 = await pythonOf($);
    if (!python2) return "Python 3 is missing, and on Windows the write guard (a Python script) is the whole lockdown. Install it from python.org, then run the Head again.";
    searchOff.set(cwd, WINDOWS_SEARCH_OFF);
    await writeAtomically($, policyPath(cwd), JSON.stringify(guardPolicy(cwd, heads2, home), null, 2) + "\n");
    settings = headSettings(heads2, [], true, strictGuardCommand($.plugin.root, policyPath(cwd), python2), home, true);
  } else {
    const envFile = await findEnvFile($, [cwd, ...heads2.reduce((dirs, head) => union(dirs, head.addDirs), []), ...writeDirs]) ?? guardedOf(heads2)[0];
    if (envFile) searchOff.set(cwd, envFile);
    else searchOff.delete(cwd);
    const outsideDeny = await outsideDenyRules($, [cwd, ...writeDirs]);
    settings = headSettings(heads2, outsideDeny, Boolean(envFile), guardCommand($.plugin.root, cwd, writeDirs), home);
  }
  await writeAtomically($, path, JSON.stringify({ ...settings, hydraHeads: heads2 }, null, 2) + "\n");
  const exclude = await $.process.run(["git", "-C", cwd, "rev-parse", "--git-path", "info/exclude"]).catch(() => null);
  if (exclude?.exitCode === 0) {
    const file = exclude.stdout.trim().replace(/\\/g, "/");
    const excludePath = file.startsWith("/") || isWindowsPath(file) ? file : `${cwd.replace(/\/$/, "")}/${file}`;
    const current = await $.fs.exists(excludePath) ? await $.fs.read(excludePath) : "";
    const missing = [RULES_FILE, ...strict ? [POLICY_FILE] : []].filter((entry) => !current.split(/\r?\n/).includes(entry));
    if (missing.length > 0) await $.fs.write(excludePath, `${current.replace(/\n?$/, "\n")}${missing.join("\n")}
`);
  }
  return void 0;
}
var windowsPathRefusal = (cwd) => /^[A-Za-z]:|^\\\\|\\/.test(cwd) ? `${cwd} is a Windows path, and Command Code cannot deny writes to one (its rules cannot name a drive), so Hydra cannot lock a Head into it. Run Claude Code under WSL instead.` : void 0;
async function joinProject($, cwd, id, needs, minutes) {
  const unsupported = await platformOf($) === "windows" ? void 0 : windowsPathRefusal(cwd);
  if (unsupported) return unsupported;
  const until = await $.clock.now() + minutes * 6e4 + UNTIL_SLACK_MS;
  const key = `${await $.session.id()}/${id}`;
  const heads2 = projects.get(cwd) ?? /* @__PURE__ */ new Map();
  heads2.set(id, { ...needs, key, until });
  projects.set(cwd, heads2);
  const refusal = await writeRules($, cwd).catch((error) => `Hydra could not write ${RULES_FILE} (${String(error).slice(0, 160)}). Check that the project folder is writable, then run the Head again.`);
  if (refusal) heads2.delete(id);
  return refusal;
}
async function leaveProject($, cwd, id) {
  projects.get(cwd)?.delete(id);
  await writeRules($, cwd).catch(() => void 0);
}
async function runRound($, argv, signal, onEvent, onSession = async () => void 0) {
  const args = [
    "commandcode",
    "-p",
    argv.prompt,
    "-m",
    argv.model,
    "--max-turns",
    String(argv.maxTurns),
    "--output-format",
    "json",
    "--skip-onboarding",
    "--yolo",
    "--trust"
  ];
  for (const dir of argv.addDirs) args.push("--add-dir", dir);
  if (argv.effort) args.push("--effort", argv.effort);
  if (argv.resume) args.push("--resume", argv.resume);
  let result = null;
  let started;
  let streamedText;
  let pending;
  const { errors, exit } = await pump($, args, argv.cwd, signal, async (line) => {
    if (!line.trim().startsWith("{")) return false;
    try {
      const row = JSON.parse(line);
      if (!started && row.event?.type === "run_start" && typeof row.event.sessionId === "string" && row.event.sessionId) {
        started = row.event.sessionId;
        await onSession(started);
      }
      if (row.event?.type === "run_end" && typeof row.event.result?.finalText === "string") streamedText = row.event.result.finalText;
      if (row.event?.type === "tool_queued" || row.event?.type === "tool_running") {
        pending = { ...pending?.toolCallId === row.event.toolCallId ? pending : {}, ...row.event, input: row.event.input ?? (pending && pending.toolCallId === row.event.toolCallId ? pending.input : void 0) };
      }
      if ((row.event?.type === "tool_completed" || row.event?.type === "tool_denied") && (!row.event.toolCallId || row.event.toolCallId === pending?.toolCallId)) pending = void 0;
      if (row.type === "result") result = row;
      if (row.event && WATCHED.has(row.event.type)) await onEvent(row.event);
    } catch {
    }
    return false;
  }, void 0, COMMANDCODE_WATCHDOG);
  const final = result;
  const own = started ?? argv.resume;
  const matched = own && final?.sessionId === own;
  return {
    finalText: streamedText ?? (matched ? String(final?.finalText ?? "") : ""),
    sessionId: own,
    subtype: matched && typeof final?.subtype === "string" ? final.subtype : void 0,
    code: exit.code,
    signal: exit.signal,
    errors: [errors, exit.signal === "idle" ? commandcodeStall(pending, argv.cwd) : ""].filter(Boolean).join("\n")
  };
}
var commandcodeStall = (call, cwd = "") => `stalled: no output for 10 min${call ? ` while running ${describeTool(call.toolName === "Shell" ? "shell_command" : call.toolName ?? "tool", call.input, cwd)}` : ""}`;
async function runRoundAt($, argv, signal, onEvent, onSession) {
  const round = await runRound($, argv, signal, onEvent, onSession);
  if (round.sessionId || !argv.effort || signal.aborted || round.signal === "idle") return { ...round, effort: argv.effort };
  if (/no reasoning effort/i.test(round.errors)) return { ...await runRound($, { ...argv, effort: void 0 }, signal, onEvent, onSession), effort: void 0 };
  const effort = /Unknown effort/i.test(round.errors) ? nearestEffort(argv.effort, supportedEfforts(round.errors)) : void 0;
  if (!effort || effort === argv.effort) return { ...round, effort: argv.effort };
  return { ...await runRound($, { ...argv, effort }, signal, onEvent, onSession), effort };
}
async function runCommandCodeHead($, head, outer, id) {
  const { task, cwd, model, maxTurns, addDirs, writeDirs, minutes, effort, guarded } = head;
  const strict = await platformOf($) === "windows";
  const shell = head.shell && !strict;
  const refusal = await joinProject($, cwd, id, { addDirs, writeDirs, shell, guarded }, minutes);
  if (refusal) {
    await setRun($, id, { state: "failed", endedAt: await $.clock.now(), activity: refusal });
    await refreshStatus($);
    return {
      text: formatReport({
        id,
        model,
        cwd,
        finished: false,
        rounds: 0,
        turns: 0,
        usd: 0,
        files: [],
        denied: [],
        finalText: "",
        exit: "not started",
        rulesNote: `${refusal} The Head runs with --yolo, so it never starts without Hydra's rules.`
      }),
      isDone: false
    };
  }
  const envFile = searchOff.get(cwd);
  const rulesNote = strict ? `native Windows: the write guard checks every call; no shell${head.shell ? " (shell: true ignored)" : ""}, no search tool` : envFile ? `search tool denied because ${relativeTo(cwd, envFile)} is in reach` : void 0;
  try {
    return await runLockedHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, minutes, rulesNote, effort, resume: head.resume, since: head.since }, outer, id);
  } finally {
    await leaveProject($, cwd, id);
  }
}
async function runLockedHead($, head, outer, id) {
  const { task, cwd, model, maxTurns, addDirs, minutes, rulesNote } = head;
  const effortNow = async () => headEffort(effortModeOf(await readMode($)), head.effort);
  let turns = 0;
  const labels = /* @__PURE__ */ new Map();
  const counter = createCallCounter();
  const onEvent = async (event) => {
    counter.see(event);
    if (event.type === "turn_end") turns++;
    await setRun($, id, (run) => applyEvent(run, event, labels, cwd));
  };
  const runRound2 = async (round2, signal) => {
    const effort = await effortNow();
    await setRun($, id, { effort });
    const ran = await runRoundAt($, { ...round2, model, cwd, addDirs, effort }, signal, onEvent, (sessionId2) => setRun($, id, { sessionId: sessionId2 }));
    if (ran.effort !== effort) await setRun($, id, { effort: ran.effort });
    return ran;
  };
  const startedAt = await $.clock.now();
  await snapshotChangedFiles($, id, [cwd, ...head.writeDirs]);
  const ended = await runRounds({
    task,
    maxTurns,
    minutes,
    outer,
    resume: head.resume,
    runRound: runRound2,
    turns: () => turns,
    calls: () => counter.calls,
    denied: async (sessionId2) => (await sessionReport($, sessionId2)).denied.map((d) => `${d.tool} ${relativeTo(cwd, d.target)}`),
    mayResume: (round2) => round2.signal !== "idle",
    mayRetryStart: (round2) => round2.signal !== "idle",
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
    onStep: (activity) => setRun($, id, { activity })
  });
  const { round, rounds, sessionId } = ended;
  const ending = round.signal === "idle" ? "stalled" : ended.ending;
  const report = sessionId ? await sessionReport($, sessionId, head.since) : { usd: null, files: [], denied: [], toolCalls: 0 };
  const endedAt = await $.clock.now();
  const edits = await compareChangedFiles($, id, { cwd, startedAt, endedAt }, [cwd, ...head.writeDirs]);
  const isDone = ending === "done";
  const stopped = outer.aborted ? stopReason(outer) : void 0;
  await setRun($, id, {
    state: isDone ? "done" : "failed",
    turns,
    costUsd: report.usd ?? void 0,
    endedAt,
    ending,
    sessionId,
    files: report.files.map((file) => relativeTo(cwd, file)),
    summary: summaryOf(round.finalText),
    activity: round.signal === "idle" ? round.errors.split("\n").at(-1) : endActivity(ended, { maxTurns, minutes, stopped })
  });
  void refreshHeads($);
  const text = formatReport({
    id,
    model,
    effort: round.effort,
    cwd,
    sessionId,
    finished: isDone,
    ending,
    cap: ended.cap,
    maxTurns,
    startedAt,
    endedAt,
    rounds,
    turns,
    usd: report.usd,
    files: report.files,
    denied: report.denied,
    finalText: round.finalText,
    exit: exitOf({ ...ended, ending }, { minutes, stopped }),
    errors: round.errors,
    rulesNote,
    writeDirs: head.writeDirs,
    reverted: edits.reverted,
    deleted: edits.deleted,
    restored: edits.restored,
    overwritten: edits.overwritten,
    alsoRan: edits.alsoRan
  });
  return { text, fullText: round.finalText, isDone, failure: isDone ? void 0 : round.errors, files: report.files, ending, sessionId };
}

// hooks/engines/index.ts
var RUN_HISTORY = 120;
var MAX_MARKS = 12;
var turnsOn = (engine, given) => Number(given ?? (engine === "codex" || engine === "agy" ? 200 : 100));
var firstTasks = /* @__PURE__ */ new Map();
var withHeadName = (task, id) => `Your Head name in this run is "${id}".

${task.replace(/\{name\}|<your-head-name>/g, id)}`;
var sessionOf = (value) => {
  const session = value;
  return session && typeof session.id === "string" && typeof session.engine === "string" && typeof session.model === "string" ? session : void 0;
};
async function runHead($, input, headModel, signal, id, engine = DEFAULT_ENGINE, routing) {
  const task = String(input.task ?? "").trim();
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : await $.session.root();
  const requested = typeof input.model === "string" && input.model ? input.model : headModel;
  const model = engine === "agy" ? agyBaseOf(requested) ?? agyBaseOf(headModel) ?? AGY_MODEL : modelFor(engine, requested);
  const maxTurns = turnsOn(engine, input.maxTurns);
  const addDirs = strings(input.addDirs);
  const writeDirs = strings(input.writeDirs);
  const shell = input.shell === true || strings(input.allowShell).length > 0;
  const minutes = Number(input.maxMinutes ?? DEFAULT_MINUTES);
  const effort = isHeadEffort(input.effort) ? input.effort : void 0;
  const check = typeof input.check === "string" ? input.check.trim() : "";
  const checkMinutes = checkMinutesOf(input.checkMinutes);
  const resume = sessionOf(input.resumeSession);
  if (resume) keepOwnEdits(id, strings(input.resumeFiles));
  const expected = expectedFiles(cwd, strings(input.files));
  const queued = { id, task: task.slice(0, 200), model, state: "queued", turns: 0, maxTurns, activity: "waiting for a slot", cwd, engine, addDirs, writeDirs, shell, ...expected.length > 0 ? { expected } : {}, ...typeof input.tool_use_id === "string" && input.tool_use_id ? { callId: input.tool_use_id } : {} };
  await updateRuns($, (list) => [...list, queued].slice(-RUN_HISTORY));
  await refreshStatus($);
  await gate.enter();
  if (signal.aborted) {
    gate.leave();
    await setRun($, id, { state: "failed", endedAt: await $.clock.now(), activity: stopReason(signal) });
    await refreshStatus($);
    return {
      text: formatReport({ id, model, cwd, finished: false, rounds: 0, turns: 0, usd: 0, files: [], denied: [], finalText: "", exit: stopReason(signal), engine }),
      isDone: false
    };
  }
  const startedAt = await $.clock.now();
  await setRun($, id, { state: "running", startedAt, activity: "starting" });
  await updateTick($, () => startedAt);
  try {
    const dirs = [cwd, ...writeDirs];
    const before = await snapshotChangedFiles($, id, dirs);
    const checked = {};
    const ran = await runHeadInside($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine, check, checkMinutes, files: strings(input.files), turnsGiven: input.maxTurns, resume, since: resume ? startedAt : void 0 }, signal, id, routing, checked);
    const times = await changedFileTimes($, startedAt, dirs);
    const entry = (await readRuns($)).find((run) => run.id === id);
    const relativeTimes = Object.fromEntries(Object.entries(times).map(([file, time]) => [relativeTo(cwd, file), time]));
    const relativeChecked = Object.fromEntries(Object.entries(checked).map(([file, time]) => [relativeTo(cwd, file), time]));
    const attributed = attributeFiles(cwd, entry?.touched ?? [], [...Object.keys(times), ...ran.files ?? []], relativeTimes, relativeChecked);
    const stats = priorEditStats(cwd, await diffStat($, cwd, attributed.edits), before);
    await setRun($, id, { files: attributed.edits, touched: attributed.edits, stats });
    const result = { ...ran, files: attributed.edits, text: withOtherWrites(withEdits(ran.text, cwd, attributed.edits, stats), attributed.check, attributed.folder) };
    const beside = expected.length > 0 ? overlappingHeads(await readRuns($), { id, cwd, startedAt, endedAt: await $.clock.now() }) : [];
    const scope = result.isDone || (result.files?.length ?? 0) > 0 ? scopeLines(cwd, expected, result.files ?? [], beside) : [];
    return scope.length > 0 ? { ...result, text: withSummary(result.text, scope) } : result;
  } finally {
    forgetChangedFiles(id);
    gate.leave();
  }
}
async function runHeadInside($, head, outer, id, routing, checked = {}) {
  const { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine, check, checkMinutes, turnsGiven, resume, since } = head;
  const home = await homeOf($);
  const [realCwd, realHome] = await realPaths2($, home ? [cwd, home] : [cwd]);
  const granted = await realPaths2($, union(addDirs, writeDirs));
  const refusal = homeHeadRefusal(realCwd ?? cwd, realHome ?? "") ?? secretDirRefusal(granted, realHome ?? "", "addDirs/writeDirs");
  if (refusal) {
    await setRun($, id, { state: "failed", endedAt: await $.clock.now(), activity: refusal });
    await refreshStatus($);
    return notStarted(id, model, cwd, `${refusal} A Head never runs where Hydra's rules cannot keep it inside a project.`, engine);
  }
  const given = union([cwd, ...writeDirs], addDirs);
  const reals = await realPaths2($, given);
  const guarded = await guardedPaths($, given.map((path, index) => ({ path, real: reals[index] })));
  if ("refusal" in guarded) {
    await setRun($, id, { state: "failed", endedAt: await $.clock.now(), activity: guarded.refusal });
    await refreshStatus($);
    return notStarted(id, model, cwd, guarded.refusal, engine);
  }
  const named = withHeadName(task, id);
  const spec = { task: check ? named + checkNote(check) : named, originalTask: task, files: head.files, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine, guarded, resume, since };
  const run = async (head2) => {
    if (!head2.resume) {
      const fresh = await runRoutes($, head2, turnsGiven, routing, outer, id);
      if (fresh.session && !firstTasks.has(fresh.session.id)) firstTasks.set(fresh.session.id, task);
      return fresh;
    }
    const resumed = await runResumed($, head2, head2.resume, outer, id);
    const original = firstTasks.get(head2.resume.id);
    if (resumed.isDone || !resumed.engineBound || !routing?.fallback || !original || outer.aborted) return resumed;
    const moved = await runRoutes($, { ...head2, resume: void 0, task: `${withHeadName(original, id)}

Follow-up from the Lead, after your earlier session on ${ENGINE_LABEL[head2.resume.engine]} stopped ${BOUND_WHY[resumed.engineBound]}:
${head2.task.replace(/^Your Head name in this run is "[^"]*"\.\n\n/, "")}` }, turnsGiven, routing, outer, id);
    return { ...moved, text: `fallback: resumed ${head2.resume.engine} ${head2.resume.model} session (${BOUND_TEXT[resumed.engineBound]}) \u2192 a fresh run with the first task
${moved.text}` };
  };
  const before = await snapshotIgnoreFiles($, guarded.ignoreFiles);
  const result = check ? await runChecked($, spec, check, checkMinutes, run, outer, id, checked) : await run(spec);
  const changed = ignoreChanges(before, await snapshotIgnoreFiles($, guarded.ignoreFiles));
  return changed.length > 0 ? { ...result, text: withSummary(result.text, [ignoreChangedLine(changed)]) } : result;
}
async function runChecked($, spec, check, checkMinutes, run, outer, id, checked) {
  let spent;
  const tokensNow = async () => (await readRuns($)).find((entry) => entry.id === id)?.tokens;
  let last;
  const markPhase = async (kind) => {
    const entry = (await readRuns($)).find((run2) => run2.id === id);
    const tries = (entry?.check?.tries ?? 0) + (kind === "check" ? 1 : 0);
    await setRun($, id, { check: { tries, state: kind === "check" ? "running" : "fixing" }, marks: [...entry?.marks ?? [], { at: await $.clock.now(), kind }].slice(-MAX_MARKS) });
  };
  const { result, outcome } = await checkHead({
    check,
    cwd: spec.cwd,
    minutes: spec.minutes,
    effort: spec.effort,
    task: spec.originalTask ?? spec.task,
    files: spec.files,
    run: async (change) => {
      if (!change) return last = await run(spec);
      await markPhase("fix");
      spent = addTokens(spent, await tokensNow());
      const session = last?.session && RESUMABLE.has(last.session.engine) ? last.session : void 0;
      const again = { effort: change.effort, minutes: change.minutes };
      let ran = session ? await run({ ...spec, ...again, engine: session.engine, model: session.model, task: change.note.trim(), resume: session }) : void 0;
      if (!ran || isLostSession(ran)) ran = await run({ ...spec, ...again, task: spec.task + change.note, resume: void 0 });
      await setRun($, id, { tokens: addTokens(spent, await tokensNow()) });
      return last = ran;
    },
    runCheck: async () => {
      await markPhase("check");
      const dirs = [spec.cwd, ...spec.writeDirs];
      const before = await changedFileTimes($, 0, dirs);
      try {
        return await runCheck($, check, spec.cwd, checkMinutes, { signal: outer, onWait: async () => {
          await setRun($, id, { activity: "waiting for another Head\u2019s check" });
          await refreshStatus($);
        }, onStart: async () => {
          await setRun($, id, { activity: `check: ${check}`.slice(0, 80) });
          await refreshStatus($);
        } });
      } finally {
        const after = await changedFileTimes($, 0, dirs);
        for (const [file, time] of Object.entries(after)) if (before[file] !== time) checked[file] = time;
      }
    },
    now: () => $.clock.now(),
    isAborted: () => outer.aborted,
    onStep: async (activity) => {
      await setRun($, id, { state: "running", endedAt: void 0, activity: activity.slice(0, 80) });
      await refreshStatus($);
    }
  });
  if (outcome) {
    const isOk = outcome.kind === "passed" || outcome.kind === "unknown" && result.isDone;
    const tries = (await readRuns($)).find((run2) => run2.id === id)?.check?.tries ?? 1;
    await setRun($, id, { check: { tries, state: outcome.kind } });
    await setRun($, id, { state: isOk ? "done" : "failed", endedAt: await $.clock.now(), activity: outcome.kind === "passed" ? "check passed" : outcome.kind === "failed" ? `check failed (exit ${outcome.exitCode})` : "check could not run" });
    await refreshStatus($);
  }
  return result;
}
var isLostSession = (result) => !result.isDone && (result.engineBound !== void 0 || !result.sessionId);
async function runResumed($, head, session, outer, id) {
  const account = session.account ? (await accountsOf($, session.engine)).find((entry) => accountId(entry) === session.account) : void 0;
  return startHead($, { ...head, engine: session.engine, model: session.model }, account?.dir ? account : void 0, outer, id);
}
var attemptStart = (before) => ({
  ...before && before.turns > 0 ? { earlierTurns: (before.earlierTurns ?? 0) + before.turns, turns: 0 } : {},
  tokens: void 0
});
async function startHead($, head, account, outer, id) {
  const before = (await readRuns($)).find((run) => run.id === id);
  if (before) await setRun($, id, attemptStart(before));
  const ran = await startOn($, head, account, outer, id);
  if (head.engine === "commandcode" || head.engine === "codebuddy" || head.engine === "workbuddy") {
    await setRun($, id, (run) => ({ touched: [.../* @__PURE__ */ new Set([...run.touched ?? [], ...(ran.files ?? []).map((file) => relativeTo(head.cwd, file))])] }));
  }
  const earlier = before?.files ?? [];
  if (earlier.length > 0) await setRun($, id, (run) => ({ files: [.../* @__PURE__ */ new Set([...earlier, ...run.files ?? []])] }));
  const files = ran.files ?? [];
  const stats = files.length > 0 ? await diffStat($, head.cwd, files) : {};
  if (Object.keys(stats).length > 0) await setRun($, id, (run) => ({ stats: { ...run.stats, ...stats } }));
  const result = files.length > 0 ? { ...ran, text: withEditStats(ran.text, head.cwd, files, stats) } : ran;
  if (!result.sessionId) return result;
  return { ...result, session: { id: result.sessionId, engine: head.engine, model: head.model, ...account ? { account: accountId(account) } : {} } };
}
async function startOn($, head, account, outer, id) {
  const { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine, guarded } = head;
  const env = accountEnv(account);
  const resume = head.resume?.id;
  if (engine === "agy") return runAgyHead($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, tokenDir: account?.dir, guarded }, outer, id);
  if (engine === "codex") return runCodexHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, minutes, effort, env, guarded, resume }, outer, id);
  if (engine === "codebuddy") return runBuddyHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, shell, minutes, effort, env, guarded, resume }, outer, id);
  if (engine === "workbuddy") {
    const buddyEnv = { ...workbuddyEnv(await homeOf($)), ...env ?? {} };
    return runBuddyHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, shell, minutes, effort, env: buddyEnv, engine: "workbuddy", guarded, resume }, outer, id);
  }
  if (engine === "opencode") return runOpenCodeHead($, { task, cwd, model, maxTurns, addDirs, writeDirs, minutes, env, guarded, resume }, outer, id);
  return runCommandCodeHead($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, guarded, resume, since: head.since }, outer, id);
}
var BOUND_TEXT = { quota: "usage limit", "signed out": "not signed in", unavailable: "could not start here" };
var BOUND_WHY = { quota: "at a usage limit", "signed out": "because its sign-in failed", unavailable: "because it could not start there" };
var unavailableWhy = (failure) => (failure ?? "").split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 120) ?? "";
var routeKey = (route) => `${route.engine}:${route.model}`;
var routeText = (route) => `${route.engine} ${route.model}`;
var MAX_ROUTES = 4;
var MAX_MODELS_PER_ENGINE = 2;
async function runRoutes($, head, turnsGiven, routing, outer, id) {
  const startedAt = await $.clock.now();
  const tried = /* @__PURE__ */ new Set([routeKey(head)]);
  const trail = [];
  const edited = [];
  let spent;
  const tokensNow = async () => (await readRuns($)).find((run) => run.id === id)?.tokens;
  let current = head;
  let result = await runOnAccounts($, current, outer, id);
  let ending = "";
  while (!result.isDone && !outer.aborted && result.engineBound && routing?.fallback) {
    for (const file of result.files ?? []) if (!edited.includes(file)) edited.push(file);
    const why = result.engineBound === "unavailable" ? unavailableWhy(result.failure) : "";
    if (result.engineBound === "unavailable") await recordUnavailable($, current.engine, current.model, why || "no reason given").catch(() => void 0);
    trail.push(`${routeText(current)} (${BOUND_TEXT[result.engineBound]}${why ? `: ${why}` : ""})`);
    const next = tried.size < MAX_ROUTES ? await nextRoute($, head, current, result.engineBound, routing, tried) : void 0;
    if (!next) {
      ending = tried.size < MAX_ROUTES ? "no other engine or model is free" : `stopped after ${MAX_ROUTES} routes`;
      break;
    }
    tried.add(routeKey(next));
    spent = addTokens(spent, await tokensNow());
    const where = next.engine === current.engine ? `${current.model} on ${ENGINE_LABEL[current.engine]}` : ENGINE_LABEL[current.engine];
    const note = `

${switchNote(edited.map((file) => relativeTo(head.cwd, file)), where, BOUND_WHY[result.engineBound])}`;
    const minutes = Math.max(1, head.minutes - Math.floor((await $.clock.now() - startedAt) / 6e4));
    await setRun($, id, { engine: next.engine, model: next.model, account: void 0, state: "running", endedAt: void 0, activity: `moved to ${routeText(next)}` });
    current = { ...head, ...next, maxTurns: turnsOn(next.engine, turnsGiven), task: head.task + note, minutes };
    result = await runOnAccounts($, current, outer, id);
  }
  if (spent) await setRun($, id, { tokens: addTokens(spent, await tokensNow()) });
  const all = [...edited, ...(result.files ?? []).filter((file) => !edited.includes(file))];
  if (all.length > editedCount(result.text)) result = { ...result, files: all, text: withEdits(result.text, head.cwd, all, await diffStat($, head.cwd, all)) };
  if (trail.length === 0) return result;
  const line = `fallback: ${trail.join(" \u2192 ")}${ending ? ` (${ending})` : ` \u2192 ${routeText(current)}`}`;
  const offline = lostSearch(head, current) ? `
\u26A0 asked for ${routeText(head)}, which searches the web; it ran on ${routeText(current)}, which may not: check any sources it cites` : "";
  return { ...result, text: `${line}${offline}
${result.text}` };
}
var lostSearch = (asked, ran) => asked.engine === "agy" && ran.engine !== "agy" && /\b(?:web research|web search|research(?:ing)? (?:the )?web|search(?:ing)? (?:the )?web|https?:\/\/\S+)\b/i.test(asked.task ?? "");
var fallbackRoutes = (first, current, bound, routing) => {
  const routes = [];
  if (bound !== "signed out") for (const model of modelAlternates(current.engine, current.model)) routes.push({ engine: current.engine, model: modelOn(current.engine, model, routing.headModel, routing.configured) });
  for (const engine of FALLBACK_ORDER[first]) {
    if (engine === current.engine || routing.pool && !routing.pool.includes(engine)) continue;
    routes.push({ engine, model: modelOn(engine, routing.model, routing.headModel, routing.configured) });
  }
  return routes;
};
async function nextRoute($, head, current, bound, routing, tried) {
  const candidates = fallbackRoutes(head.engine, current, bound, routing);
  const now = await $.clock.now();
  const cooldowns = await readCooldowns($);
  const onEngine = [...tried].filter((key) => key.startsWith(`${current.engine}:`)).length;
  for (const route of candidates) {
    if (tried.has(routeKey(route))) continue;
    if (route.engine === current.engine && onEngine >= MAX_MODELS_PER_ENGINE) continue;
    if (route.engine !== current.engine && ((await preflight($, route.engine)).problems.length > 0 || !await hasConsent($, route.model, false, route.engine))) continue;
    const routeAccounts = await accountsOf($, route.engine);
    const picked = pickAccount(route.engine, routeAccounts, cooldowns, now, "fill", {}, [], await livePoolOf($, route.engine, route.model, routeAccounts));
    if (picked.account) return route;
  }
  return void 0;
}
async function runOnAccounts($, head, outer, id) {
  const { engine, cwd, model } = head;
  const accounts = await accountsOf($, engine);
  const pool = await livePoolOf($, engine, model, accounts);
  const named = (name) => accounts.find((account) => accountId(account) === name);
  await setRun($, id, { tokens: void 0 });
  let spent;
  const tokensNow = async () => (await readRuns($)).find((run) => run.id === id)?.tokens;
  const result = await rotateAccounts({
    count: accounts.length,
    minutes: head.minutes,
    cwd,
    engine,
    pool,
    isAborted: () => outer.aborted,
    pick: (tried) => pickWithQuota($, engine, model, accounts, tried, pool),
    now: () => $.clock.now(),
    begin: async (name, isSwitch) => {
      if (isSwitch) spent = addTokens(spent, await tokensNow());
      await markUsed($, name, await $.clock.now());
      if (accounts.length > 1) await setRun($, id, { account: name, ...isSwitch ? { state: "running", endedAt: void 0, activity: `switched to ${name}` } : {} });
    },
    run: (account, note, minutes) => startHead($, { ...head, task: head.task + note, minutes }, account.dir ? account : void 0, outer, id),
    cooled: async (key, until) => {
      const account = engine === "agy" ? named(key.split("#")[0]) : void 0;
      const exact = account ? agyBlockedUntil(await readAgyUsage($, account.dir, true), model) : void 0;
      await recordCooldown($, key, exact ?? until);
    },
    signedOut: (name) => recordSignedOut($, name),
    refuse: async (reason) => {
      await setRun($, id, { state: "failed", endedAt: await $.clock.now(), activity: reason });
      await refreshStatus($);
      return notStarted(id, model, cwd, reason, engine);
    }
  });
  if (spent) await setRun($, id, { tokens: addTokens(spent, await tokensNow()) });
  return result;
}
async function livePoolOf($, engine, model, accounts) {
  if (engine !== "agy") return usagePoolOf(engine, model);
  return agyLivePool(await readAgyUsage($, accounts[0]?.dir).catch(() => []), model);
}
async function pickWithQuota($, engine, model, accounts, tried, pool) {
  for (let left = accounts.length; ; left--) {
    const picked = await pickUsable($, engine, accounts, tried, pool);
    if (engine !== "agy" || !picked.account || left <= 0) return picked;
    const until = agyBlockedUntil(await readAgyUsage($, picked.account.dir), model);
    if (until === void 0 || until <= await $.clock.now()) return picked;
    await recordCooldown($, cooldownKey(accountId(picked.account), pool), until);
  }
}

// hooks/lib/schema.ts
var isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var actualType = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};
var matchesType = (type, value) => {
  if (type === "object") return isPlainObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return false;
};
var walk = (schema, value, path, errors) => {
  if (errors.length >= 20) return;
  const types = schema.type === void 0 ? void 0 : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types !== void 0 && !types.some((type) => matchesType(type, value))) {
    errors.push(`${path}: expected ${types.join(" or ")}, got ${actualType(value)}`);
    return;
  }
  if (schema.enum !== void 0 && !schema.enum.some((entry) => entry === value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
    if (errors.length >= 20) return;
  }
  if (isPlainObject(value)) {
    for (const name of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === void 0) {
        errors.push(`${path}.${name}: missing`);
        if (errors.length >= 20) return;
      }
    }
    const properties = schema.properties ?? {};
    for (const key of Object.keys(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === void 0) continue;
      const child = properties[key];
      if (child === void 0) continue;
      walk(child, value[key], `${path}.${key}`, errors);
      if (errors.length >= 20) return;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
        errors.push(`${path}.${key}: not allowed`);
        if (errors.length >= 20) return;
      }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== void 0 && value.length < schema.minItems) {
      errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
      if (errors.length >= 20) return;
    }
    if (schema.maxItems !== void 0 && value.length > schema.maxItems) {
      errors.push(`${path}: takes at most ${schema.maxItems} item(s)`);
      if (errors.length >= 20) return;
    }
    const itemSchema = schema.items;
    if (itemSchema !== void 0) {
      for (let index = 0; index < value.length; index += 1) {
        walk(itemSchema, value[index], `${path}[${index}]`, errors);
        if (errors.length >= 20) return;
      }
    }
  }
};
var fencedBlocks = (text) => {
  const blocks = [];
  let lang;
  let body = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimStart();
    if (!line.startsWith("```")) {
      if (lang !== void 0) body.push(raw);
      continue;
    }
    if (lang === void 0) {
      lang = line.slice(3);
      body = [];
    } else {
      blocks.push({ lang, body: body.join("\n") });
      lang = void 0;
      body = [];
    }
  }
  return blocks;
};
var matchBrace = (text, start) => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};
var parseBlock = (body) => {
  try {
    return { value: JSON.parse(body.trim()) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `the JSON block does not parse: ${message.slice(0, 160)}` };
  }
};
var braceJson = (text) => {
  const pairs = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") continue;
    const end = matchBrace(text, index);
    if (end !== -1) pairs.push({ start: index, end });
  }
  const topLevel = pairs.filter((pair) => !pairs.some((other) => other.start < pair.start && other.end > pair.end)).sort((left, right) => right.start - left.start);
  for (const pair of topLevel) {
    try {
      return { value: JSON.parse(text.slice(pair.start, pair.end + 1)) };
    } catch {
      continue;
    }
  }
  return void 0;
};
var schemaProblem = (schema) => {
  if (!isPlainObject(schema)) return "schema must be an object";
  if (schema.type !== "object") return 'schema needs "type": "object" at its root';
  const properties = schema.properties;
  if (!isPlainObject(properties) || Object.keys(properties).length === 0) return 'schema needs "properties"';
  const required = schema.required;
  if (required !== void 0 && (!Array.isArray(required) || required.some((name) => typeof name !== "string"))) return '"required" must be a list of property names';
  if (Array.isArray(required)) {
    for (const name of required) {
      if (typeof name === "string" && !Object.prototype.hasOwnProperty.call(properties, name)) return `"required" names "${name}", which is not in "properties"`;
    }
  }
  if (JSON.stringify(schema).length > 6e3) return "schema is too large (over 6000 characters)";
  return void 0;
};
var validate = (schema, value, path = "$") => {
  const errors = [];
  walk(schema, value, path, errors);
  return errors.slice(0, 20);
};
var extractJson = (text) => {
  const blocks = fencedBlocks(text);
  const jsonBlocks = blocks.filter((block) => /^json$/i.test(block.lang.trim()));
  const jsonBlock = jsonBlocks[jsonBlocks.length - 1];
  if (jsonBlock !== void 0) return parseBlock(jsonBlock.body);
  const fenced = blocks.filter((block) => {
    const body = block.body.trim();
    return body.startsWith("{") || body.startsWith("[");
  });
  const fencedBlock = fenced[fenced.length - 1];
  if (fencedBlock !== void 0) return parseBlock(fencedBlock.body);
  const braced = braceJson(text);
  if (braced !== void 0) return braced;
  return { error: "no JSON block in the reply" };
};
var schemaNote = (schema) => `

Answer format (required): put your result in ONE fenced \`\`\`json block near the end of your final reply, before the line that ends the run. It must be valid JSON that matches this schema; keep every string short and factual, and use file paths relative to the project. Anything you write outside that block is read by a person, not parsed.

\`\`\`json-schema
${JSON.stringify(schema, null, 1)}
\`\`\``;
var schemaFixNote = (errors) => `Your last reply did not carry a usable JSON result:
${errors.slice(0, 10).map((line) => `- ${line}`).join("\n")}
Reply again with the corrected \`\`\`json block (the whole result, not a patch) and end the run as before. Make no other changes.`;
var readReply = (schema, text) => {
  const found = extractJson(text);
  if ("error" in found) return { errors: [found.error] };
  const errors = validate(schema, found.value);
  if (errors.length > 0) return { errors };
  return { data: found.value };
};

// hooks/lib/hunt.ts
var HUNT_MAX_HEADS = 24;
var HUNT_MAX_LENSES = 3;
var DEFAULT_LENS = "correctness";
var VERDICT_SCHEMA = { type: "object", properties: { verdict: { type: "string", enum: ["holds", "broken", "unsure"] }, problems: { type: "array", maxItems: 15, items: { type: "object", properties: { file: { type: "string" }, line: { type: "integer" }, problem: { type: "string" }, severity: { type: "string", enum: ["blocker", "high", "medium", "low"] } }, required: ["problem", "severity"] } }, checked: { type: "array", items: { type: "string" } } }, required: ["verdict", "problems", "checked"] };
var object = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
var strings2 = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
var slug = (value, max) => value.length <= max && /^[a-z0-9][a-z0-9-]*$/.test(value);
var parseHunt = (input, root) => {
  const name = typeof input.name === "string" ? input.name.trim().toLowerCase() : "";
  if (!slug(name, 30)) return { deny: "A hunt needs a `name`: lowercase letters, digits and dashes, up to 30 (it names the Heads and the cache)." };
  if (Array.isArray(input.heads) && input.heads.length > HUNT_MAX_HEADS) return { deny: `A hunt takes at most ${HUNT_MAX_HEADS} Heads; split it into two hunts.` };
  if (!Array.isArray(input.heads) || input.heads.length === 0 || !input.heads.every(object)) return { deny: `\`heads\` must list 1 to ${HUNT_MAX_HEADS} Heads, each with a \`task\`.` };
  const heads2 = [];
  const notes = [];
  const declared = new Set(input.heads.flatMap((entry) => typeof entry.name === "string" && entry.name.trim() ? [entry.name.trim().toLowerCase()] : []));
  for (const [index, entry] of input.heads.entries()) {
    if (typeof entry.task !== "string" || !entry.task.trim()) return { deny: `Head ${index + 1} has no \`task\`.` };
    let headName2 = entry.name === void 0 ? `${name.slice(0, 16)}-${index + 1}` : typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "";
    if (!slug(headName2, 20)) return { deny: `Head ${index + 1}: \`name\` must be lowercase letters, digits and dashes, up to 20.` };
    if (/-fix$|-r\d+$|-json\d*$/.test(headName2)) {
      const old = headName2;
      const base = (headName2.length > 18 ? headName2.slice(0, 18).replace(/-+$/, "") : headName2) || "head";
      let renamed = `${base}-h`;
      for (let n = 2; heads2.some((head2) => head2.name === renamed) || declared.has(renamed); n++) {
        const suffix = `-${n}-h`;
        renamed = `${base.slice(0, 20 - suffix.length).replace(/-+$/, "")}${suffix}`;
      }
      headName2 = renamed;
      notes.push(`note: Head ${index + 1} renamed ${old} \u2192 ${headName2} (names ending -fix, -rN or -jsonN are kept for Hydra's follow-up Heads)`);
    }
    if (heads2.some((head2) => head2.name === headName2)) return { deny: `Two Heads are named "${headName2}"; names must differ.` };
    const head = { name: headName2, task: entry.task.trim() };
    for (const key of ["engine", "model", "effort", "check", "cwd"]) if (typeof entry[key] === "string" && entry[key].trim()) head[key] = entry[key].trim();
    for (const key of ["files", "addDirs", "writeDirs"]) {
      const values = strings2(entry[key]);
      if (values.length) head[key] = values;
    }
    for (const key of ["checkMinutes", "maxTurns", "maxMinutes"]) {
      const value = entry[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) head[key] = value;
    }
    if (!head.cwd && typeof input.cwd === "string" && input.cwd.trim()) head.cwd = input.cwd.trim();
    if (entry.shell === true) head.shell = true;
    heads2.push(head);
  }
  const normalize = (path) => "/" + path.split("/").reduce((parts, part) => {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
    return parts;
  }, []).join("/");
  const absolute = (path, base) => normalize(path.startsWith("/") ? path : `${base}/${path}`);
  const rootHeads = heads2.filter((head) => (head.cwd || root) && absolute(head.cwd || root, root || "/") === "/");
  if (rootHeads.length) return { deny: `Heads ${rootHeads.map((head) => head.name).join(", ")}: / is the root of the disk; pass a project folder in cwd.` };
  let schema;
  if (input.schema !== void 0 && input.schema !== null) {
    const problem = schemaProblem(input.schema);
    if (problem !== void 0) return { deny: `\`schema\`: ${problem}.` };
    schema = input.schema;
  }
  let refute;
  if (input.refute === true) refute = { lenses: [DEFAULT_LENS], fix: true };
  else if (object(input.refute)) {
    const lenses = [...new Set(strings2(input.refute.lenses))];
    if (lenses.length > HUNT_MAX_LENSES) return { deny: `\`refute.lenses\` takes at most ${HUNT_MAX_LENSES}.` };
    refute = { lenses: lenses.length ? lenses : [DEFAULT_LENS], fix: input.refute.fix !== false };
  } else if (input.refute !== void 0 && input.refute !== null && input.refute !== false) return { deny: "`refute` must be true or { lenses, fix }." };
  return { plan: { name, shared: typeof input.shared === "string" ? input.shared.trim() : "", ...schema !== void 0 ? { schema } : {}, heads: heads2, ...refute ? { refute } : {}, fresh: input.fresh === true }, ...notes.length ? { notes } : {} };
};
var outsidePathNotes = async (plan, root, exists) => {
  const normalize = (path) => "/" + path.split("/").reduce((parts, part) => {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
    return parts;
  }, []).join("/");
  const absolute = (path, base) => normalize(path.startsWith("/") ? path : `${base}/${path}`);
  const folders = plan.heads.flatMap((head) => {
    const cwd = absolute(head.cwd || root || "/", root || "/");
    return [cwd, ...(head.addDirs ?? []).map((dir) => absolute(dir, cwd)), ...(head.writeDirs ?? []).map((dir) => absolute(dir, cwd))];
  });
  const inside = (path) => folders.some((folder) => folder === "/" || normalize(path) === folder || normalize(path).startsWith(`${folder}/`));
  const isThere = (path) => exists(path).catch(() => false);
  const text = `${plan.shared}
${plan.heads.map((head) => head.task).join("\n")}`;
  const found = /* @__PURE__ */ new Set();
  const pattern = /(?:^|[\s`"'(])\/(?!\/)[^\s`"'(),;:]+/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const token = match[0].trim().replace(/^[`"'(]/, "");
    if (!token.startsWith("/") || /[*?]/.test(token)) continue;
    const line = text.slice((match.index ?? 0) + match[0].length).split("\n")[0].split(/[`"']/)[0];
    let chosen = token;
    if (/^\s+\S/.test(line)) {
      const words = line.trim().split(/\s+/);
      for (let count = words.length; count >= 1; count--) {
        const longer = `${token} ${words.slice(0, count).join(" ")}`.replace(/[.,;:!?]+$/, "");
        if (await isThere(longer)) {
          chosen = longer;
          break;
        }
      }
    }
    const path = chosen.replace(/[.,;:!?]+$/, "");
    if (found.has(path) || inside(path) || !await isThere(path)) continue;
    found.add(path);
  }
  return [...found].map((path) => `note: ${path} is outside every Head's folders; pass it in addDirs to let them read it`);
};
var headKey = (plan, head) => {
  const text = JSON.stringify([plan.shared, plan.schema ?? null, plan.refute ?? null, head.name, head.task, head.engine ?? "", head.model ?? "", head.effort ?? "", head.files ?? [], head.check ?? "", head.cwd ?? "", head.shell === true]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return `${head.name}:${hash.toString(16).padStart(8, "0")}`;
};
var refuteTask = (head, shared, author, lens) => {
  const result = author.data !== void 0 ? JSON.stringify(author.data, null, 1) : author.summary;
  const cut = author.data === void 0 && /characters cut by Hydra|… cut: read the full report/i.test(result);
  const paths = new Set(author.files);
  const collect = (value) => {
    if (typeof value === "string" && !/\s/.test(value) && (/^(?:\.\.?\/|\/|[\w.-]+\/)\S*$/.test(value) || /^[\w.-]+\.[a-zA-Z0-9]{1,10}(?::\d+)?$/.test(value))) paths.add(value.replace(/:\d+$/, ""));
    else if (Array.isArray(value)) value.forEach(collect);
    else if (object(value)) Object.values(value).forEach(collect);
  };
  if (!head.files?.length) collect(author.data);
  return [
    `You are a refuter. Another agent just did the task below. Your job is to find what is wrong with its result, through the lens of ${lens}. Change no files. Read the code as it is now and check each claim against it.`,
    shared ? `Context:
${shared}` : "",
    `The task it was given:
${head.task}`,
    paths.size ? `Read these files first; do not re-read whole files you have already read:
${[...paths].map((file) => `- ${file}`).join("\n")}` : "Do not re-read whole files you have already read.",
    result && (result.length > 4e4 || cut) && author.reportPath ? `The full result is in the saved report file ${author.reportPath}; read it there.` : result ? `Its ${author.data !== void 0 ? "result" : "report"}${cut ? " (shortened by Hydra; truncation is not a problem to report)" : ""}:
${result}` : "",
    'Answer "broken" only for a concrete problem you can point to (file and line where there is one), "holds" when you checked and found none, and "unsure" when you could not check. Never invent a problem to have one. List what you actually checked.'
  ].filter(Boolean).join("\n\n");
};
var fixTask = (problems, isReading = false) => `A reviewer checked your work and reports these problems:
${problems.slice(0, 15).map((p) => `- [${p.severity}] ${p.file ? `${p.file}${p.line ? `:${p.line}` : ""}: ` : ""}${p.problem}`).join("\n")}
${isReading ? "This is a reading job: change no files, revise only your result (the report, or the JSON).\n" : ""}For each one: fix it if it is real, or say in one line why it is not. Then give your full result again.`;
var ENDINGS2 = ["blocked", "capped", "timeout", "stalled"];
var doneNote = (ran) => {
  if (ran.isDone || ran.check !== "passed") return void 0;
  if (ran.ending === "timeout") return "out of time, check passed";
  if (ran.ending === "capped") return "out of turns, check passed";
  if (ran.ending === "stalled") return "stalled, check passed";
  return void 0;
};
var statusOf = (ran, hasSchema) => {
  if (ran.ending === "stopped") return "stopped";
  if (ran.ending === "blocked" && ran.check === "passed") return "blocked";
  if (ran.check === "failed") return ran.ending === "blocked" ? "blocked" : "failed";
  if (!ran.isDone && ran.check === "passed" && ENDINGS2.includes(ran.ending ?? "")) return "done";
  if (ran.isDone && hasSchema && ran.data === void 0) return "invalid";
  if (ran.isDone) return "done";
  if (ran.data !== void 0 && ENDINGS2.includes(ran.ending ?? "")) return "partial";
  if (ran.ending === "blocked") return "blocked";
  if (ran.ending === "capped" || ran.ending === "timeout" || ran.ending === "stalled") return "unfinished";
  return "failed";
};
var usable = (value) => object(value) && (value.verdict === "holds" || value.verdict === "broken" || value.verdict === "unsure");
var verdictOf = (answers) => {
  const valid = answers.filter(usable);
  if (!valid.length) return { verdict: "none", problems: [] };
  const problems = [];
  const seen = /* @__PURE__ */ new Set();
  for (const answer of valid) if (answer.verdict === "broken" && Array.isArray(answer.problems)) for (const item of answer.problems) {
    if (!object(item) || typeof item.problem !== "string") continue;
    const file = typeof item.file === "string" ? item.file : void 0;
    const line = typeof item.line === "number" && Number.isInteger(item.line) ? item.line : void 0;
    const key = `${file ?? ""}:${line ?? ""}:${item.problem}`;
    if (!seen.has(key) && problems.length < 15) {
      seen.add(key);
      problems.push({ ...file !== void 0 ? { file } : {}, ...line !== void 0 ? { line } : {}, problem: item.problem, severity: typeof item.severity === "string" ? item.severity : "medium" });
    }
  }
  if (problems.length) return { verdict: "broken", problems };
  return { verdict: valid.every((answer) => answer.verdict === "holds") ? "holds" : "unsure", problems: [] };
};
var union2 = (a, b) => [.../* @__PURE__ */ new Set([...a, ...b])];
var outcomeOf2 = (name, ran, hasSchema) => {
  const note = doneNote(ran);
  return { name, engine: ran.engine, ...ran.model !== void 0 ? { model: ran.model } : {}, status: statusOf(ran, hasSchema), isCached: false, ...ran.check !== void 0 ? { check: ran.check } : {}, files: ran.files, summary: ran.summary, ...ran.data !== void 0 ? { data: ran.data } : {}, ...ran.dataErrors !== void 0 ? { dataErrors: ran.dataErrors } : {}, ...ran.reportPath !== void 0 ? { reportPath: ran.reportPath } : {}, ...ran.cost !== void 0 ? { cost: ran.cost } : {}, ...note !== void 0 ? { note } : {}, ...ran.fallback !== void 0 ? { fallback: ran.fallback } : {}, ...ran.asked !== void 0 ? { asked: ran.asked } : {} };
};
async function runHunt(steps) {
  const { plan } = steps;
  const outcomes = await Promise.all(plan.heads.map(async (head) => {
    const failure = (summary) => ({ name: head.name, engine: head.engine ?? "", status: "failed", isCached: false, files: [], summary });
    try {
      const key = headKey(plan, head);
      const cached = steps.cache[key];
      if (!plan.fresh && cached?.status === "done" && cached.refute?.verdict !== "broken") return { ...cached, isCached: true };
      if (steps.isAborted()) return failure("not started: the hunt was stopped");
      let ran;
      try {
        ran = await steps.runHead({ ...head, task: plan.shared ? `${plan.shared}

${head.task}` : head.task, ...plan.schema ? { schema: plan.schema } : {} });
      } catch (error) {
        return failure(`could not run: ${String(error).slice(0, 300)}`);
      }
      let outcome = outcomeOf2(head.name, ran, plan.schema !== void 0);
      const review = async (author, suffix) => {
        const answers = await Promise.all((plan.refute?.lenses ?? []).map(async (lens, index) => {
          const engine = steps.refuterEngine(ran.engine, index);
          if (engine === void 0) return void 0;
          const reportDir = author.reportPath?.slice(0, author.reportPath.lastIndexOf("/"));
          const addDirs = union2(head.addDirs ?? [], reportDir ? [reportDir] : []);
          try {
            const result = await steps.runHead({ name: `${head.name}-r${index + 1}${suffix}`, task: refuteTask(head, plan.shared, author, lens), engine, effort: "medium", schema: VERDICT_SCHEMA, ...head.cwd ? { cwd: head.cwd } : {}, ...addDirs.length ? { addDirs } : {}, ...author.minutes !== void 0 ? { maxMinutes: Math.min(15, Math.max(5, Math.ceil(author.minutes * 3))) } : {}, ...author.turns !== void 0 ? { maxTurns: Math.min(80, Math.max(30, Math.ceil(author.turns * 1.5))) } : {} });
            return { engine, result };
          } catch {
            return void 0;
          }
        }));
        const present = answers.filter((answer) => answer !== void 0);
        return { ...verdictOf(present.map((answer) => answer.result.data)), by: present.filter((answer) => usable(answer.result.data)).map((answer) => answer.engine), edited: [...new Set(present.flatMap((answer) => answer.result.files))] };
      };
      if (plan.refute && outcome.status === "done" && !steps.isAborted()) {
        const isReading = !head.files?.length;
        const first = await review(ran, "");
        outcome.refute = { ...first, fixRounds: 0 };
        if (first.verdict === "broken" && plan.refute.fix && ran.isResumable && !steps.isAborted()) {
          let fixed;
          try {
            fixed = await steps.runHead({ ...head, name: `${head.name}-fix`, resume: head.name, task: fixTask(first.problems, isReading), ...plan.schema ? { schema: plan.schema } : {} });
          } catch {
          }
          if (fixed) {
            const updated = outcomeOf2(head.name, fixed, plan.schema !== void 0);
            updated.engine = ran.engine;
            if (ran.model !== void 0) updated.model = ran.model;
            else delete updated.model;
            if (ran.fallback !== void 0) updated.fallback = ran.fallback;
            if (ran.asked !== void 0) updated.asked = ran.asked;
            if (isReading && fixed.files.length) updated.readingChanged = fixed.files;
            updated.files = union2(ran.files, fixed.files);
            if (ran.cost !== void 0 && fixed.cost !== void 0) updated.cost = `${ran.cost} + ${fixed.cost}`;
            else if (ran.cost !== void 0) updated.cost = ran.cost;
            const second = await review(fixed, "b");
            updated.refute = { ...second, by: union2(first.by, second.by), edited: union2(first.edited, second.edited), fixRounds: 1 };
            outcome = updated;
          }
        }
      }
      if (outcome.status === "done") try {
        await steps.save(key, outcome);
      } catch {
      }
      return outcome;
    } catch (error) {
      return failure(`could not run: ${String(error).slice(0, 300)}`);
    }
  }));
  return { name: plan.name, outcomes, missing: outcomes.filter((outcome) => outcome.status !== "done" && outcome.status !== "partial" && !(outcome.status === "blocked" && outcome.check === "passed")).map((outcome) => outcome.name) };
}
var askedOf = (fallback) => {
  const first = fallback.split(" \u2192 ")[0].replace(/\s*\(.*\)$/, "").trim();
  const [engine, ...model] = first.split(/\s+/);
  return engine ? { engine, model: model.join(" ") || void 0 } : void 0;
};
var formatHunt = (result, limit = 14e3) => {
  const done = result.outcomes.filter((outcome) => outcome.status === "done").length;
  const partial = result.outcomes.filter((outcome) => outcome.status === "partial").length;
  const cached = result.outcomes.filter((outcome) => outcome.isCached).length;
  const broken = result.outcomes.filter((outcome) => outcome.refute?.verdict === "broken").length;
  const first = `hunt ${result.name} \xB7 ${result.outcomes.length} Head(s) \xB7 ${done} done${cached ? ` (${cached} from cache)` : ""}${partial ? ` \xB7 ${partial} partial` : ""}${broken ? ` \xB7 ${broken} refuted` : ""}${result.missing.length ? ` \xB7 missing: ${result.missing.join(", ")}` : ""}`;
  const share = Math.max(0, Math.floor((limit - first.length - 2 * result.outcomes.length) / (result.outcomes.length || 1)));
  const blocks = result.outcomes.map((outcome) => {
    const refute = outcome.refute;
    const lines = [`## ${outcome.name} \xB7 ${outcome.engine || "no engine"} \xB7 ${outcome.status}${outcome.status === "blocked" && outcome.check === "passed" ? " (check passed)" : outcome.note ? ` (${outcome.note})` : outcome.check ? ` \xB7 check ${outcome.check}` : ""}${outcome.isCached ? " (cached)" : ""}${refute ? ` \xB7 refute: ${refute.verdict}${refute.by.length ? ` by ${refute.by.join(", ")}` : ""}${refute.fixRounds ? " after a fix" : ""}` : ""}${outcome.cost ? ` \xB7 ${outcome.cost}` : ""}`];
    if (outcome.status === "blocked" && outcome.check === "passed") {
      const before = outcome.summary.split(/HEAD BLOCKED/i)[0].trim().split("\n").filter(Boolean).slice(-3).join("\n");
      if (before) lines.push(`decision: ${before.slice(-600)}`);
    }
    if (outcome.readingChanged?.length) lines.push(`\u26A0 a reading Head changed files in its fix round: ${outcome.readingChanged.join(", ")}`);
    if (outcome.fallback) {
      const asked = outcome.asked ?? askedOf(outcome.fallback);
      if (asked && (asked.engine !== outcome.engine || asked.model !== void 0 && asked.model !== outcome.model)) lines.push(`  asked: ${asked.engine}${asked.model !== void 0 ? ` \xB7 ${asked.model}` : ""}`);
      lines.push(`  fallback: ${outcome.fallback}`);
    }
    if (outcome.files.length) lines.push(`edited: ${outcome.files.slice(0, 12).join(", ")}${outcome.files.length > 12 ? ` and ${outcome.files.length - 12} more` : ""}`);
    if (refute?.edited.length) lines.push(`\u26A0 a refuter changed files though told not to: ${refute.edited.join(", ")}`);
    if (refute?.problems.length) lines.push("open problems:", ...refute.problems.map((p) => `- [${p.severity}] ${p.file ? `${p.file}${p.line ? `:${p.line}` : ""}: ` : ""}${p.problem}`));
    if (outcome.data !== void 0) lines.push(`data: ${JSON.stringify(outcome.data)}`);
    else if (outcome.dataErrors?.length) lines.push(`no usable JSON: ${outcome.dataErrors.slice(0, 3).join("; ")}`, outcome.summary);
    else if (outcome.summary) lines.push(outcome.summary);
    if (outcome.reportPath) lines.push(`full report: ${outcome.reportPath}`);
    const block = lines.join("\n");
    if (block.length <= share) return block;
    const marker = `
\u2026 cut: read the full report${outcome.reportPath ? ` at ${outcome.reportPath}` : ""}`;
    return share >= marker.length ? block.slice(0, share - marker.length) + marker : marker.slice(0, share);
  });
  return [first, ...blocks].join("\n\n");
};

// hooks/lib/launch.ts
var headOptions = /* @__PURE__ */ new Map();
async function prepareHead($, hydra, e, launch) {
  const { defaultEngine, defaultHead, isFallbackOn } = launch;
  if (!String(e.task ?? "").trim()) return { deny: "A Head needs a task." };
  if (e.effort !== void 0 && !isHeadEffort(e.effort)) return { deny: "effort must be low, medium, high, xhigh or max." };
  const target = typeof e.resume === "string" && e.resume.trim() ? resumeTarget(await readRuns($), e.resume.trim()) : void 0;
  if (target && "deny" in target) return { deny: target.deny };
  const earlier = target?.run;
  const cwd = earlier?.cwd ?? (typeof e.cwd === "string" && e.cwd ? e.cwd : await $.session.root());
  const writable = await resolveWriteDirs($, cwd, e.writeDirs === void 0 && earlier ? earlier.writeDirs ?? [] : strings(e.writeDirs));
  if ("refusal" in writable) return { deny: writable.refusal };
  const routed = earlier ? { engine: earlier.engine, isNew: false } : resolveHeadEngine(hydra, e.engine, defaultEngine);
  if ("deny" in routed) return { deny: routed.deny };
  const engine = routed.engine;
  if (routed.isNew) {
    const ready = await preflight($, engine);
    if (ready.problems.length > 0) return { deny: `${ENGINE_LABEL[engine]} is not ready here: ${ready.problems[0]} Pick another engine.` };
  }
  if (!await hasConsent($, hydra.headModel, false, engine)) return { deny: NO_CONSENT };
  if (routed.isNew && isAuto(hydra)) await updateMode($, (mode2) => mode2 ? { ...mode2, engines: [...poolOf(mode2), engine] } : mode2);
  const prior = earlier ? headOptions.get(earlier.id) : void 0;
  const check = typeof e.check === "string" ? e.check.trim() : prior?.check ?? "";
  if (check && !await hasCheckConsent($, check)) return { deny: NO_CHECK_CONSENT };
  const headModel = earlier?.model ?? headModelFor(engine, void 0, hydra.headModel, defaultHead);
  const asked = earlier ? earlier.model : typeof e.model === "string" && e.model ? e.model : void 0;
  const resumed = earlier ? { cwd, model: earlier.model, addDirs: e.addDirs ?? earlier.addDirs, shell: e.shell ?? earlier.shell, resumeSession: { id: earlier.sessionId, engine, model: earlier.model, account: earlier.account }, resumeFiles: earlier.files ?? [] } : {};
  const effort = typeof e.effort === "string" ? e.effort : prior?.effort ?? earlier?.effort;
  const schema = e.schema ?? prior?.schema;
  const checkMinutes = typeof e.checkMinutes === "number" ? e.checkMinutes : prior?.checkMinutes;
  const input = { ...e, ...effort ? { effort } : {}, ...check ? { check } : {}, ...checkMinutes !== void 0 ? { checkMinutes } : {}, writeDirs: writable.dirs, ...asked && !isModelFor(engine, asked) ? { model: void 0 } : {}, ...resumed };
  const task = String(e.task ?? "");
  if (task.includes("/.claude/hydra/hunts/") || task.includes("/.claude/hydra/heads/")) {
    const home = await homeOf($);
    const sessionId = await $.session.id();
    const dirs = strings(input.addDirs);
    for (const kind of ["hunts", "heads"]) {
      const dir = `${home}/.claude/hydra/${kind}/${sessionId}`;
      if (home && (task.includes(`${dir}/`) || task.includes(`~/.claude/hydra/${kind}/${sessionId}/`))) dirs.push(dir);
    }
    if (dirs.length) input.addDirs = [...new Set(dirs)];
  }
  const routing = { headModel: hydra.headModel, configured: defaultHead, model: asked, pool: isAuto(hydra) && hydra.pinned ? poolOf(hydra) : void 0, fallback: isFallbackOn };
  const taken = /* @__PURE__ */ new Set([...usedNames, ...(await readRuns($)).map((run) => run.id)]);
  const id = headName(e.name ?? earlier?.id, String(e.task ?? ""), taken);
  usedNames.add(id);
  headOptions.set(id, { effort, schema, check, checkMinutes });
  return { input, headModel, id, engine, routing, ...schema ? { schema } : {}, ...earlier ? { continues: earlier.id } : {}, ...earlier?.check && e.check === void 0 && !prior?.check ? { missingCheck: true } : {} };
}
var REPORT_MARK = "\n--- head report ---\n";
var headText = (report) => {
  const at = report.indexOf(REPORT_MARK);
  const body = at < 0 ? report : report.slice(at + REPORT_MARK.length);
  const end = [body.indexOf("\n--- check output"), body.indexOf("\n--- stderr ---")].filter((index) => index >= 0);
  return (end.length > 0 ? body.slice(0, Math.min(...end)) : body).trim();
};
var headSummary = (report) => {
  const text = headText(report);
  const reason = /^rules: (.+)$/m.exec(report.split(REPORT_MARK)[0])?.[1];
  return text === "(no final report)" && reason ? `did not run: ${reason}` : text;
};
var checkOf = (report) => {
  const summary = report.split(REPORT_MARK)[0];
  if (/^check: .* ✓ passed/m.test(summary)) return "passed";
  if (/^check: .* ✗ FAILED/m.test(summary)) return "failed";
  return /^check: .* \? UNKNOWN/m.test(summary) ? "unknown" : void 0;
};
var fallbackOf = (report) => /^fallback: (.+)$/m.exec(report.split(REPORT_MARK)[0])?.[1];
var JSON_FIX_ROUNDS = 2;
var jsonLine = (errors) => errors ? `json: \u2717 NO USABLE RESULT (${errors.slice(0, 3).join("; ").slice(0, 300)}): read the Head's own text below` : "json: \u2713 the reply matches the schema";
async function readStructured(steps) {
  let result = await steps.first();
  const original = result;
  const retries = [];
  const check = checkOf(result.text);
  let reply = readReply(steps.schema, result.fullText ?? headText(result.text));
  if (!result.isDone) {
    const errors2 = "errors" in reply ? reply.errors : void 0;
    const line = errors2 ? "json: \u2717 none (the Head did not finish; read its handoff below)" : "json: \u2713 the reply matches the schema (the Head did not finish)";
    return { result: { ...result, text: withSummary(result.text, [line]) }, check, ...errors2 ? { dataErrors: errors2 } : { data: reply.data } };
  }
  for (let round = 1; round <= JSON_FIX_ROUNDS && "errors" in reply && !steps.isAborted(); round++) {
    const session = result.session && RESUMABLE.has(result.session.engine) ? result.session : void 0;
    const files = result.files ?? [];
    if (!session && files.length > 0) break;
    let next;
    try {
      next = await steps.again(round, schemaFixNote(reply.errors), session, files);
    } catch {
      break;
    }
    retries.push(`

--- json retry ${round} (${steps.retryId?.(round) ?? `retry-${round}`}) ---
${fullReport(next)}`);
    if (!next.isDone) break;
    result = { ...next, files: [.../* @__PURE__ */ new Set([...files, ...next.files ?? []])] };
    reply = readReply(steps.schema, next.fullText ?? headText(next.text));
  }
  const errors = "errors" in reply ? reply.errors : void 0;
  return { result: { ...original, files: result.files, session: result.session, text: withSummary(original.text, [jsonLine(errors)]) + retries.join("") }, check, ...errors ? { dataErrors: errors } : { data: reply.data } };
}
async function untilStopped(run, signal) {
  if (signal.aborted) throw new Error("stopped");
  let stop = () => {
  };
  const stopped = new Promise((_, reject) => {
    stop = () => reject(new Error("stopped"));
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([run(), stopped]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
async function runStructured($, prepared, signal, schema, reportDir) {
  const { headModel, id, engine, routing } = prepared;
  schema = schema ?? prepared.schema;
  headOptions.set(id, { effort: typeof prepared.input.effort === "string" ? prepared.input.effort : void 0, schema, check: typeof prepared.input.check === "string" ? prepared.input.check : void 0, checkMinutes: typeof prepared.input.checkMinutes === "number" ? prepared.input.checkMinutes : void 0 });
  const home = reportDir ? void 0 : await homeOf($);
  const dir = reportDir ?? (home ? `${home}/.claude/hydra/heads/${await $.session.id()}` : void 0);
  if (dir) await $.process.run(["/bin/mkdir", "-p", dir]).catch(() => void 0);
  const save = async (result, name) => {
    if (prepared.missingCheck) result = { ...result, text: withSummary(result.text, ["check: none (the resumed Head had none)"]) };
    if (!dir) return result;
    return saveHeadReport($, result, `${dir}/${name}.md`);
  };
  if (!schema) {
    const result = await save(await untilStopped(() => runHead($, prepared.input, headModel, signal, id, engine, routing), signal), id);
    return { result, check: checkOf(result.text) };
  }
  const task = String(prepared.input.task ?? "");
  const base = { ...prepared.input, task: task + schemaNote(schema) };
  const retryIds = /* @__PURE__ */ new Map();
  const structured = await readStructured({
    schema,
    first: async () => save(await untilStopped(() => runHead($, base, headModel, signal, id, engine, routing), signal), id),
    again: async (round, note, session, files) => {
      const fixId = headName(`${id.slice(0, 14)}-json${round > 1 ? round : ""}`, task, /* @__PURE__ */ new Set([...usedNames, ...(await readRuns($)).map((run) => run.id)]));
      usedNames.add(fixId);
      retryIds.set(round, fixId);
      const input = session ? { ...base, task: note, check: void 0, files: void 0, model: session.model, resumeSession: session, resumeFiles: files } : { ...base, task: `${base.task}

An earlier attempt at this task ended without a usable result. ${note}`, check: void 0 };
      const controller = new AbortController();
      const stop = () => controller.abort(signal.reason);
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
      controllers.set(fixId, controller);
      try {
        return await save(await untilStopped(() => runHead($, input, session?.model ?? headModel, controller.signal, fixId, session?.engine ?? engine, routing), controller.signal), fixId);
      } finally {
        controllers.delete(fixId);
        signal.removeEventListener("abort", stop);
      }
    },
    isAborted: () => signal.aborted,
    retryId: (round) => retryIds.get(round) ?? `retry-${round}`
  });
  return { ...structured, result: await save(structured.result, id) };
}
var reportParts = (result) => {
  const marker = result.text.indexOf(REPORT_MARK);
  const start = marker + REPORT_MARK.length;
  const plain = result.fullText === void 0 ? void 0 : clipReport(result.fullText) || "(no final report)";
  const named = result.fullText && result.fullText.trim().length > 8e3 ? /^.{5000}\n\[… \d+ characters cut by Hydra; the full report is at [^\n]* …\]\n[\s\S]{3000}/s.exec(result.text.slice(start))?.[0] : void 0;
  const clipped = named ?? plain;
  const found = clipped !== void 0 && marker >= 0 && result.text.slice(start, start + clipped.length) === clipped;
  const full = found ? result.text.slice(0, start) + (result.fullText.trim() || "(no final report)") + result.text.slice(start + clipped.length) : result.text;
  return { full, found, start, clipped };
};
var fullReport = (result) => reportParts(result).full;
async function saveHeadReport($, result, path) {
  const { full, found, start, clipped } = reportParts(result);
  try {
    await $.fs.write(path, full);
    if (!await $.fs.exists(path)) return result;
  } catch {
    return result;
  }
  return found ? { ...result, text: result.text.slice(0, start) + (clipReport(result.fullText, path) || "(no final report)") + result.text.slice(start + clipped.length) } : result;
}
var REFUTER_ORDER = ["agy", "codebuddy", "workbuddy", "commandcode", "codex", "opencode"];
var pickRefuter = (pool, author, turn) => {
  const others = REFUTER_ORDER.filter((engine) => pool.includes(engine) && engine !== author);
  if (others.length > 0) return others[turn % others.length];
  return isEngine(author) && pool.includes(author) ? author : pool[0];
};
var refuterModel = (engine, author) => author && engine === author.engine && isEngine(engine) && author.model ? modelAlternates(engine, author.model)[0] : void 0;
var REFUTER_NAME = /-r\d+b?$/;
var huntJobs = createQueue();
var huntControllers = /* @__PURE__ */ new Map();
var HUNT_KEEP_MS = 7 * 864e5;
var HUNT_STORE = "hunt-v1:";
var storedHunt = (value) => {
  const stored = value;
  return stored && typeof stored.at === "number" && typeof stored.outcomes === "object" && stored.outcomes !== null ? stored : void 0;
};
var huntDir = (home, sessionId, name) => `${home}/.claude/hydra/hunts/${sessionId}/${name}`;
var liveHunts = 0;
async function runHuntJob($, job, signal) {
  const { plan, launch } = job;
  const sessionId = await $.session.id();
  const home = await homeOf($);
  const dir = home ? huntDir(home, sessionId, plan.name) : void 0;
  const storeKey = `${HUNT_STORE}${sessionId}:${plan.name}`;
  const cache = { ...storedHunt(await $.store.get(storeKey).catch(() => void 0))?.outcomes ?? {} };
  const started = await readMode($);
  const pool = isAuto(started) ? poolOf(started) : [engineOf(started, launch.defaultEngine)];
  const ids = /* @__PURE__ */ new Map();
  const authors = /* @__PURE__ */ new Map();
  const asked = /* @__PURE__ */ new Map();
  let turn = 0;
  liveHunts++;
  if (pool.length > 1) gate.setLimit(HUNT_PARALLEL);
  try {
    if (dir) await $.process.run(["/bin/mkdir", "-p", dir]).catch(() => void 0);
    const runOne = async (call) => {
      const hydra = await readMode($);
      if (!hydra?.isOn) throw new Error("Hydra was turned off");
      const author = call.resume ? asked.get(call.resume) : void 0;
      const isFreshFix = author !== void 0 && !author.canContinue;
      const { schema, ...rest } = isFreshFix ? { ...author.call, name: call.name, task: `${author.call.task}

${call.task}`, schema: call.schema } : call;
      const { resume, ...head } = rest;
      const otherModel = REFUTER_NAME.test(call.name) && !head.model ? refuterModel(head.engine, authors.get(call.name.replace(REFUTER_NAME, ""))) : void 0;
      const prepared = await prepareHead($, hydra, { ...head, ...otherModel ? { model: otherModel } : {}, ...resume ? { resume: ids.get(resume) ?? resume } : {} }, launch);
      if ("deny" in prepared) throw new Error(prepared.deny);
      ids.set(call.name, prepared.id);
      const controller = new AbortController();
      const stop = () => controller.abort(typeof signal.reason === "string" ? signal.reason : "the hunt was stopped");
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
      controllers.set(prepared.id, controller);
      let structured;
      try {
        structured = await runStructured($, prepared, controller.signal, schema ?? prepared.schema, dir);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        const run2 = (await readRuns($)).find((entry) => entry.id === prepared.id);
        const now = await $.clock.now();
        const minutes = run2?.startedAt !== void 0 ? Math.max(0, ((run2.endedAt ?? now) - run2.startedAt) / 6e4) : void 0;
        const details = [minutes !== void 0 ? `${minutes.toFixed(1)} min` : "", run2?.turns !== void 0 ? `${run2.turns} turns` : ""].filter(Boolean).join(" \xB7 ");
        return { engine: run2?.engine ?? prepared.engine, isDone: false, ending: "stopped", files: [.../* @__PURE__ */ new Set([...run2?.files ?? [], ...run2?.touched ?? []])], summary: `Stopped ${signal.aborted ? "because the hunt was stopped" : "by the Lead"}${details ? ` \xB7 ${details}` : ""}${run2?.sessionId ? ` \xB7 resume: ${prepared.id}` : ""}`, isResumable: !!run2?.sessionId && RESUMABLE.has(run2.engine ?? prepared.engine) };
      } finally {
        controllers.delete(prepared.id);
        signal.removeEventListener("abort", stop);
      }
      await announceEnding($, prepared.id).catch(() => void 0);
      const { result: result2 } = structured;
      const cwd = typeof prepared.input.cwd === "string" && prepared.input.cwd ? prepared.input.cwd : await $.session.root();
      const path = dir ? `${dir}/${prepared.id}.md` : void 0;
      const reportPath = path && await $.fs.exists(path).catch(() => false) ? path : void 0;
      const run = (await readRuns($)).find((entry) => entry.id === prepared.id);
      if (!REFUTER_NAME.test(call.name) && !resume) authors.set(call.name, { engine: run?.engine ?? prepared.engine, ...run?.model ? { model: run.model } : {} });
      const canContinue = result2.session !== void 0 && RESUMABLE.has(result2.session.engine);
      if (!asked.has(call.name)) asked.set(call.name, { call, canContinue });
      const usd = typeof run?.costUsd === "number" && run.costUsd > 0 ? `$${run.costUsd.toFixed(4)}` : void 0;
      const cost = run?.tokens ? usd ? `${run.tokens} \xB7 ${usd}` : run.tokens : usd;
      const fallback = fallbackOf(result2.text);
      const askedFor = { engine: typeof head.engine === "string" && head.engine ? head.engine : prepared.engine, ...typeof head.model === "string" && head.model ? { model: head.model } : {} };
      return {
        engine: run?.engine ?? prepared.engine,
        ...run?.model ? { model: run.model } : {},
        isDone: result2.isDone,
        ...result2.ending ? { ending: result2.ending } : {},
        ...structured.check ? { check: structured.check } : {},
        files: (result2.files ?? []).map((file) => relativeTo(cwd, file)),
        summary: result2.fullText?.trim() || headSummary(result2.text),
        ...structured.data !== void 0 ? { data: structured.data } : {},
        ...structured.dataErrors ? { dataErrors: structured.dataErrors } : {},
        ...reportPath ? { reportPath } : {},
        ...cost ? { cost } : {},
        ...run?.startedAt !== void 0 && run.endedAt !== void 0 ? { minutes: Math.max(0, (run.endedAt - run.startedAt) / 6e4) } : {},
        ...run?.turns !== void 0 ? { turns: run.turns } : {},
        ...fallback ? { fallback } : {},
        ...fallback ? { asked: askedFor } : {},
        // A Head that changed nothing can always be asked again: from its session, or from the start.
        isResumable: canContinue || (result2.files ?? []).length === 0
      };
    };
    const result = await runHunt({
      plan,
      cache,
      runHead: runOne,
      refuterEngine: (author) => pickRefuter(pool, author, turn++),
      save: async (key, outcome) => {
        cache[key] = outcome;
        await $.store.set(storeKey, { at: await $.clock.now(), outcomes: cache });
      },
      isAborted: () => signal.aborted
    });
    if (dir) {
      for (const outcome of result.outcomes) if (!outcome.reportPath || !await $.fs.exists(outcome.reportPath).catch(() => false)) outcome.reportPath = `${dir}/hunt.md`;
      const path = `${dir}/hunt.md`;
      const saved = await $.fs.write(path, `${formatHunt(result, Number.POSITIVE_INFINITY)}
`).then(() => $.fs.exists(path)).catch(() => false);
      if (!saved) {
        for (const outcome of result.outcomes) if (outcome.reportPath === path) delete outcome.reportPath;
      }
    }
    const text = formatHunt(result);
    const stopped = signal.aborted ? "\n\u26A0 The hunt was stopped before it ended: Heads that had not finished are listed as missing." : "";
    const hasHunt = dir && await $.fs.exists(`${dir}/hunt.md`).catch(() => false);
    return `${text}${stopped}${hasHunt ? `

Full reports: ${dir} (hunt.md holds every block uncut)` : ""}`;
  } finally {
    liveHunts = Math.max(0, liveHunts - 1);
    if (liveHunts === 0) gate.setLimit(MAX_PARALLEL);
  }
}
async function sweepHunts($) {
  const now = await $.clock.now();
  const own = `${HUNT_STORE}${await $.session.id()}:`;
  for (const key of (await $.store.keys().catch(() => [])).filter((name) => name.startsWith(HUNT_STORE) && !name.startsWith(own))) {
    const stored = storedHunt(await $.store.get(key).catch(() => void 0));
    if (!stored || now - stored.at > HUNT_KEEP_MS) await $.store.delete(key).catch(() => void 0);
  }
  const home = await homeOf($);
  if (!home) return;
  for (const kind of ["hunts", "heads"]) {
    const folder = `${home}/.claude/hydra/${kind}`;
    const entries = await $.fs.list(folder).catch(() => []);
    const candidates = entries.filter((entry) => entry.kind === "dir" && (kind === "hunts" ? /^[A-Za-z0-9-]+$/ : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).test(entry.name) && entry.name !== own.slice(HUNT_STORE.length, -1));
    const old = [];
    for (const entry of candidates) {
      const newest = await newestMtime($, `${folder}/${entry.name}`, kind === "hunts" ? 2 : 1);
      if (newest !== void 0 && now - newest > HUNT_KEEP_MS) old.push(`${folder}/${entry.name}`);
    }
    if (old.length > 0) await $.process.run(["/bin/rm", "-rf", ...old]).catch(() => void 0);
  }
}
async function vetHunt($, hydra, plan, defaultEngine) {
  const vetted = /* @__PURE__ */ new Set();
  const unready = /* @__PURE__ */ new Map();
  const headEngines = [];
  for (const head of plan.heads) {
    if (head.effort !== void 0 && !isHeadEffort(head.effort)) return { deny: `Head ${head.name}: effort must be low, medium, high, xhigh or max.` };
    const routed = resolveHeadEngine(hydra, head.engine, defaultEngine);
    if ("deny" in routed) return { deny: `Head ${head.name}: ${routed.deny}` };
    headEngines.push(routed.engine);
    if (vetted.has(routed.engine) || unready.has(routed.engine)) continue;
    if (routed.isNew) {
      const ready = await preflight($, routed.engine);
      if (ready.problems.length > 0) {
        unready.set(routed.engine, ready.problems[0]);
        continue;
      }
    }
    vetted.add(routed.engine);
    if (!await hasConsent($, hydra.headModel, false, routed.engine)) return { deny: NO_CONSENT };
  }
  if (vetted.size === 0 && unready.size > 0) {
    const [engine, problem] = [...unready][0];
    return { deny: `${ENGINE_LABEL[engine]} is not ready here: ${problem} Pick another engine.` };
  }
  const unreadyNotes = [...unready].map(([engine, problem]) => `not started: ${plan.heads.filter((_, index) => headEngines[index] === engine).map((head) => head.name).join(", ")}, because ${ENGINE_LABEL[engine]} is not ready here: ${problem} The other Heads run; send these to another engine.`);
  const firstCheck = plan.heads.find((head) => head.check)?.check;
  if (firstCheck && !await hasCheckConsent($, firstCheck)) return { deny: NO_CHECK_CONSENT };
  const pathNotes = await outsidePathNotes(plan, await $.session.root(), (path) => $.fs.stat(path).then(() => true, () => false)).catch(() => []);
  await refreshLimits($, [...vetted]);
  const limits = await coolingLines($, [...vetted]).catch(() => []);
  return { notes: [...unreadyNotes, ...pathNotes, ...limits.length > 0 ? [`limits now: ${limits.join("; ")} (Hydra moves these Heads to another route on its own)`] : []] };
}

// hooks/lib/control.ts
async function runControl($, e, settings) {
  const { defaultEngine, defaultHead, defaultEffort, isAutoDefault } = settings;
  const action = String(e.action ?? "list");
  const now = await $.clock.now();
  const ids = typeof e.id === "string" && e.id && e.id !== "all" ? [e.id] : "all";
  if (action === "list") {
    const hydra2 = await readMode($);
    const head = hydra2?.isOn ? `Hydra on \xB7 ${headLine(hydra2, defaultEngine)} \xB7 effort ${effortModeOf(hydra2)}` : "Hydra off";
    const home = await homeOf($);
    const saved = home ? `
Reports: ${home}/.claude/hydra/heads/${await $.session.id()}/<head>.md (a hunt's in ${home}/.claude/hydra/hunts/${await $.session.id()}/<hunt>/)` : "";
    return { result: `${head}
${listRuns(visibleRuns(await readRuns($)), now, (id) => controllers.has(id))}${saved}` };
  }
  if (action === "stop") {
    const list = await readRuns($);
    const targets = list.filter((run) => (run.state === "running" || run.state === "queued") && (ids === "all" || ids.includes(run.id)));
    const hunts = [...huntControllers.keys()].filter((name) => ids === "all" || ids.includes(name));
    for (const name of hunts) huntControllers.get(name)?.abort("stopped by the Lead");
    const stoppedHunts = hunts.length > 0 ? `Stopping hunt ${hunts.join(", ")} and its Heads. ` : "";
    if (targets.length === 0) return { result: stoppedHunts || `No running or queued Head or hunt${ids === "all" ? "" : ` ${ids[0]}`}.` };
    const ghosts = await stopHeadsNow($, targets.map((run) => run.id), "stopped by the Lead");
    return { result: `${stoppedHunts}Stopping ${targets.map((run) => run.id).join(", ")}.${ghosts.length > 0 ? ` ${ghosts.join(", ")} had no live process and were marked failed.` : ""}` };
  }
  if (action === "clear") {
    await updateRuns($, hideFinished);
    return { result: "Cleared finished and failed Heads from the views. They can still be resumed by name." };
  }
  const stored = await readMode($);
  const current = stored ?? { isOn: false, headModel: defaultHead, effort: defaultEffort, engine: defaultEngine };
  if (action === "off") {
    await updateMode($, () => ({ ...current, isOn: false, surge: void 0 }));
  } else if ((action === "on" || action === "effort") && (String(e.engine) === AUTO || Array.isArray(e.engines) || isAuto(stored) && e.engine === void 0 || action === "on" && !stored?.isOn && !stored?.pinned && isAutoDefault && e.engine === void 0)) {
    const listed = Array.isArray(e.engines) ? parseEngineList(e.engines.map(String).join(",")) : void 0;
    if (listed && (listed.bad.length > 0 || listed.engines.length === 0)) return { deny: `engines must be some of: ${ENGINES.join(", ")}.` };
    const wanted = listed ? listed.engines : isAuto(stored) ? poolOf(stored) : [...ENGINES];
    const effort = typeof e.effort === "string" ? e.effort : void 0;
    if (effort !== void 0 && !isEffortMode(effort)) return { deny: `effort must be auto or one of: ${EFFORTS.join(", ")}.` };
    let pool = wanted;
    if (needsEngineCheck(action, e)) {
      const ready = await readyEngines($, wanted);
      if (ready.pool.length === 0) return { deny: ["No requested engine is ready:", ...ready.skipped.map((item) => `${item.engine}: ${item.problem}`)].join(" ") };
      if (!await hasConsentAll($, ready.pool, false)) return { deny: NO_CONSENT };
      pool = ready.pool;
    }
    const headModel = typeof e.headModel === "string" && e.headModel ? e.headModel : isModelFor("commandcode", current.headModel) ? current.headModel : defaultHead;
    await updateMode($, () => ({ isOn: action === "on" ? true : current.isOn, headModel, effort: effort ?? effortModeOf(stored), engine: AUTO, engines: pool, pinned: listed === void 0 && stored?.pinned === true, surge: stored?.surge }));
  } else if (action === "on" || action === "effort") {
    if (e.engine !== void 0 && !isEngine(e.engine)) return { deny: `engine must be one of: ${[...ENGINES, AUTO].join(", ")}.` };
    const engine = isEngine(e.engine) ? e.engine : engineOf(stored, defaultEngine);
    if (needsEngineCheck(action, e)) {
      const check = await preflight($, engine);
      if (check.problems.length > 0) return { deny: preflightText(check) };
      if (!await hasConsent($, current.headModel, false, engine)) return { deny: NO_CONSENT };
    }
    const effort = typeof e.effort === "string" ? e.effort : void 0;
    if (effort !== void 0 && !isEffortMode(effort)) return { deny: `effort must be auto or one of: ${EFFORTS.join(", ")}.` };
    const headModel = headModelFor(engine, typeof e.headModel === "string" && e.headModel ? e.headModel : void 0, current.headModel, defaultHead);
    await updateMode($, () => ({ isOn: action === "on" ? true : current.isOn, headModel, effort: effort ?? effortModeOf(stored), engine, pinned: e.engine === void 0 && stored?.pinned === true, surge: stored?.surge }));
  } else {
    return { deny: `Unknown action "${action}". Use list, stop, clear, on, off or effort.` };
  }
  await settings.onChanged?.();
  const hydra = await readMode($);
  return { result: hydra?.isOn ? `Hydra on \xB7 Head ${hydra.headModel} on ${engineLabel(hydra, defaultEngine)} \xB7 effort ${effortModeOf(hydra)}` : "Hydra off." };
}

// hooks/lib/tools.ts
var HEAD_TOOL_DEF = {
  name: "head",
  description: "Hydra: run one Head (a cheaper coding agent on Command Code, CodeBuddy, Codex, Antigravity, WorkBuddy or OpenCode, per the person's engine setting) headlessly on a self-contained implementation task, or continue an earlier Head with `resume`. Returns how it ended (finished, blocked, out of turns or time, stalled), its report or handoff, cost, the files it edited and any denied calls; with background: true it returns at once and the report arrives as a message. Usable only while the person has Hydra on.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Self-contained spec: goal, exact files, constraints, what done looks like. With `resume`: only the follow-up (what to fix or do next), since the Head still has the rest. Put a build or test command in `check`, not here: a Head told to verify what its sandbox cannot run stalls." },
      resume: { type: "string", description: "Name of an ended Head to continue in its own session, on its engine, model and account, with what it already read and did: for feedback on its work, the next step of the same job, or a Head that ran out of turns or time (raise maxTurns or maxMinutes). `task` is then just the follow-up. Cheaper and better informed than a new Head. Not for Antigravity Heads, nor for unrelated work." },
      cwd: { type: "string", description: "Repo directory to work in; defaults to the session root" },
      engine: { type: "string", enum: [...ENGINES], description: "The engine this Head runs on. Required in auto mode; in a fixed-engine session it defaults to that engine, and naming another ready one sends just this Head there. Pick by the task: see the routing guide in the Hydra policy. If the engine is at its usage limit or signed out, Hydra moves the Head to another model or engine on its own, and the report says where it ran." },
      model: { type: "string", description: "Head model id (CodeBuddy, WorkBuddy and Codex ids have no provider prefix; OpenCode takes provider/model); defaults to the Hydra head model. On Codex: gpt-6.1-terra (default) for coding, including hard or multi-file work, gpt-6.1-sol for work that is not code, gpt-6-luna for mechanical or small tasks, gpt-6-astra (most capable, drains the shared allowance about 3x faster than Sol) only for the hardest bug or after Terra failed at high. On CodeBuddy and WorkBuddy: deepseek-v4.1-flash, glm-5.3, kimi-k3, minimax-m3.1-flash, gpt-5.6-terra and the others `codebuddy --help` lists; each model has its own usage limit. On Antigravity: gemini-4-hydrogen (default, low to xhigh, cheapest), gemini-4-neon (low to xhigh: harder work, reviews, research and web search), gemini-4-carbon (deepest long-horizon work, spends the Gemini pool fastest), claude-sonnet-5-5 (normal work on the Claude pool), claude-opus-5-5 (hard work, drains the Claude pool several times faster than Sonnet); gemini-4-argon, gemini-3.8-flash and gpt-oss-120b leave on 30 November 2026. Every Gemini model shares one usage pool and Claude + GPT-OSS another, each charged by token cost. On OpenCode: opencode/deepseek-v4.1-flash-free (free) or any provider/model the person set up." },
      files: { type: "array", items: { type: "string" }, description: "The files this Head must create or change, relative to cwd, as the task names them. Hydra measures the Head against them: the band shows files written of files named, and the report flags a named file it never changed and any file it changed beyond them. Leave out for a reading job." },
      maxTurns: { type: "number", description: "Turn cap for the Head (default 100; 200 on Codex and Antigravity, where a turn is one tool call). It stops a runaway Head; a Head that hits it writes a handoff. Raise it for wide reads and audits." },
      addDirs: { type: "array", items: { type: "string" }, description: "Absolute folders outside cwd the Head must read (mockups, briefs, other repos)" },
      writeDirs: { type: "array", items: { type: "string" }, description: "Absolute folders outside cwd the Head may also write to, such as the real location of a symlinked package. Only folders the task must change: never /, the home folder or a folder above the project. Their .git, .commandcode and .env files stay protected." },
      shell: { type: "boolean", description: "Give the Head a shell (off by default). Dangerous commands stay denied: destructive git, rm -r/-f, sudo, network tools, builds and installs. OpenCode Heads never get one." },
      name: { type: "string", description: "Short name to track this Head by, saying what it works on (e.g. prefs-utils, login-tests); lowercase letters, digits and dashes, up to 20. Defaults to one made from the task; made unique with -2, -3." },
      effort: { type: "string", enum: [...HEAD_EFFORTS], description: "Reasoning effort for this Head (default low). Use low when you will check the result, one level up on each retry after a failed check, max first only for subtle work you cannot check. Ignored while the person has fixed a level with /hydra effort=<level>." },
      maxMinutes: { type: "number", description: "Wall-clock limit before the Head is stopped (default 40); it then gets two minutes to write a handoff" },
      check: { type: "string", description: "Acceptance check: a shell command Hydra runs in cwd once the Head ends (e.g. ./gradlew testDebugUnitTest --tests LoginViewModelTest). It runs as the person, outside the Head's lockdown, so it can build and test what the Head cannot; the Head is told Hydra runs it. On a failure the Head is sent back in the same session with the output, one effort level up, at most twice. A Head that ran out of turns or time after editing is checked too. Scope it to what this Head changes: Heads running in the same cwd share the files. The person is asked once before the first check runs." },
      checkMinutes: { type: "number", description: "Time limit for one run of the check, in minutes (default and maximum 10)" },
      background: { type: "boolean", description: "Return at once; the report arrives later as a message. Use for parallel fan-out." },
      schema: { type: "object", description: "A JSON Schema (root type object, with properties) the Head's result must match: for findings, lists and verdicts you will merge or count. Hydra asks the Head for one fenced json block, checks it, and sends a reply without usable JSON back to the Head up to twice; the report's `json:` line says how it ended. Supported: type, properties, required, items, enum, minItems, maxItems." }
    },
    required: ["task"]
  }
};
var HUNT_TOOL_DEF = {
  name: "hunt",
  description: `Hydra: run a whole phase of Heads as one call and get one merged result back, instead of one report per Head. Every Head starts at once (up to ${HUNT_MAX_HEADS}); with \`schema\` each returns checked JSON; with \`refute\` a second Head on another engine tries to break each result and the author fixes what it broke, with no waiting between Heads. Returns a compact block per Head (status, check, refute verdict, edited files, its data) and the list of Heads that did not finish; every full report is saved to a file you can Read. Calling it again with the same \`name\` reuses the results of Heads whose task did not change and runs only the rest. Usable only while the person has Hydra on.`,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Names the hunt, its Heads and its saved results: lowercase letters, digits and dashes, up to 30 (auth-audit, login-build). Reuse the name to rerun only what failed or changed." },
      heads: {
        type: "array",
        description: `1 to ${HUNT_MAX_HEADS} Heads. Each takes the Head tool's own fields: task (required), name (a name ending -fix, -rN or -jsonN is renamed with -h, since those endings name Hydra's own follow-up Heads), engine (required in auto mode), model, effort, files, check, checkMinutes, shell, cwd, addDirs, writeDirs, maxTurns, maxMinutes. Editing Heads must name disjoint files.`,
        items: { type: "object", properties: { task: { type: "string" }, name: { type: "string" }, engine: { type: "string", enum: [...ENGINES] }, model: { type: "string" }, effort: { type: "string", enum: [...HEAD_EFFORTS] }, files: { type: "array", items: { type: "string" } }, check: { type: "string" }, checkMinutes: { type: "number" }, shell: { type: "boolean" }, cwd: { type: "string" }, addDirs: { type: "array", items: { type: "string" } }, writeDirs: { type: "array", items: { type: "string" } }, maxTurns: { type: "number" }, maxMinutes: { type: "number" } }, required: ["task"] }
      },
      shared: { type: "string", description: "Text put before every Head's task: the project, the hard rules, what a finding must be. Write it once here, not in each task." },
      cwd: { type: "string", description: "Default working folder for Heads that do not set their own cwd." },
      schema: { type: "object", description: "One JSON Schema (root type object, with properties) every Head's result must match. Give one whenever you will merge, count or compare the results." },
      refute: { description: 'true, or { lenses: ["correctness", "edge cases"], fix: true }: after a Head finishes, one Head per lens (at most 3) on another engine tries to break its result and answers holds, broken or unsure. A broken result goes back to its author once (unless fix is false) and is refuted once more. A refuter that fails counts as no verdict, never as broken.' },
      fresh: { type: "boolean", description: "Run every Head again, ignoring results saved under this name." },
      background: { type: "boolean", description: "Return at once; the merged result arrives later as a message." }
    },
    required: ["name", "heads"]
  }
};
var CONTROL_TOOL_DEF = {
  name: "control",
  description: "Hydra control for the Lead: list the Heads (with their state, turns, time and what they are doing), stop a stuck or wrong Head by id or all of them, clear finished ones from the views, or turn Hydra on/off and set the Head effort, model or engine.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "stop", "clear", "on", "off", "effort"], description: "What to do (default list)" },
      id: { type: "string", description: "For stop: the Head name (e.g. prefs-utils), a hunt name (stops the hunt and its Heads), or all; default all" },
      effort: { type: "string", enum: [...EFFORT_MODES], description: "For on/effort: auto or a fixed level" },
      headModel: { type: "string", description: "For on/effort: the model the Heads run on" },
      engine: { type: "string", enum: [...ENGINES, AUTO], description: "For on/effort: the CLI Heads run on: commandcode, codebuddy, codex, agy, workbuddy or opencode (beta), or auto to let you pick one per Head" },
      engines: { type: "array", items: { type: "string", enum: [...ENGINES] }, description: "For on/effort with engine auto: the engines you may use (default: all that are ready)" }
    }
  }
};

// agy/server.ts
var VERSION = "2.5.0";
var DEFAULT_HEAD = "deepseek/deepseek-v4.1-flash";
var LAUNCH = { defaultEngine: DEFAULT_ENGINE, defaultHead: DEFAULT_HEAD, isFallbackOn: true };
var BACKGROUND_NOTE = "Antigravity runs this call in the background and hands you the result when it ends, so start several and keep working.";
var dataDir = process.env.HYDRA_DATA || resolve2(homedir(), ".gemini", "hydra");
var pluginRoot = process.env.PLUGIN_ROOT || resolve2(dirname2(fileURLToPath(import.meta.url)), "..", "..");
var agyTools = () => [HEAD_TOOL_DEF, HUNT_TOOL_DEF, CONTROL_TOOL_DEF].map((def) => {
  const tool = def;
  const { background: _background, ...properties } = tool.inputSchema.properties ?? {};
  const description = tool.description.replace(/;? ?with background: true it returns at once and the report arrives as a message\./, ".").replace(/ Usable only while the person has Hydra on\./, "");
  return { ...tool, description: tool.name === "control" ? description : `${description} ${BACKGROUND_NOTE}`, inputSchema: { ...tool.inputSchema, properties } };
});
function consentFromArgs(argv, store) {
  const index = argv.indexOf("--consent");
  const checks = argv.includes("--checks");
  if (index < 0 && !checks) return void 0;
  const named = index >= 0 ? String(argv[index + 1] ?? "").split(",").map((name) => name.trim()).filter(Boolean) : [];
  const bad = named.filter((name) => !isEngine(name));
  if (bad.length > 0) return `Unknown engine(s): ${bad.join(", ")}. Engines: ${ENGINES.join(", ")}.`;
  for (const engine of named) store.set(consentKey(engine), true);
  if (checks) store.set(CHECK_CONSENT_KEY, true);
  return `Hydra for Antigravity: ${[named.length ? `code may go to ${named.join(", ")}` : "", checks ? "checks may run" : ""].filter(Boolean).join("; ")}. Saved in ${dataDir}.`;
}
async function ensureOn($) {
  const stored = await readMode($);
  if (stored?.isOn) return stored;
  if (stored && !stored.isOn) return { deny: 'Hydra is off. Turn it back on with the control tool (action: "on").' };
  const ready = await readyEngines($, ENGINES);
  if (ready.pool.length === 0) return { deny: `No Head engine is ready on this machine: ${ready.skipped.map((item) => `${item.engine}: ${item.problem}`).join("; ")}` };
  const agreed = [];
  for (const engine of ready.pool) if (await hasConsent($, DEFAULT_HEAD, false, engine)) agreed.push(engine);
  const pool = agreed.length > 0 ? agreed : await hasConsentAll($, ready.pool, true) ? ready.pool : [];
  if (pool.length === 0) {
    return { deny: `The person has not agreed to send code to any engine (ready here: ${ready.pool.join(", ")}). They agree in the form Antigravity shows, or ahead of time with: node "${pluginRoot}/agy/dist/hydra-mcp.mjs" --consent ${ready.pool.join(",")} --checks` };
  }
  return await updateMode($, () => ({ isOn: true, headModel: DEFAULT_HEAD, effort: "auto", engine: AUTO, engines: pool }));
}
async function callHead($, args, signal) {
  const hydra = await ensureOn($);
  if ("deny" in hydra) return { text: hydra.deny, isError: true };
  const schemaFault = args.schema === void 0 || args.schema === null ? void 0 : schemaProblem(args.schema);
  if (schemaFault) return { text: `\`schema\`: ${schemaFault}.`, isError: true };
  const { schema, background: _background, ...asked } = args;
  const prepared = await prepareHead($, hydra, asked, LAUNCH);
  if ("deny" in prepared) return { text: prepared.deny, isError: true };
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  controllers.set(prepared.id, controller);
  try {
    const { result } = await runStructured($, prepared, controller.signal, schema ?? prepared.schema);
    return { text: result.text };
  } finally {
    controllers.delete(prepared.id);
    signal.removeEventListener("abort", stop);
  }
}
async function callHunt($, args, signal) {
  const hydra = await ensureOn($);
  if ("deny" in hydra) return { text: hydra.deny, isError: true };
  const parsed = parseHunt(args, await $.session.root());
  if ("deny" in parsed) return { text: parsed.deny, isError: true };
  const { plan } = parsed;
  if (huntControllers.has(plan.name)) return { text: `A hunt named "${plan.name}" is still running. Wait for it, stop it with control (id: "${plan.name}"), or pick another name.`, isError: true };
  const vetted = await vetHunt($, hydra, plan, LAUNCH.defaultEngine);
  if ("deny" in vetted) return { text: vetted.deny, isError: true };
  const notes = [...parsed.notes ?? [], ...vetted.notes];
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  huntControllers.set(plan.name, controller);
  try {
    const text = await runHuntJob($, { plan, launch: LAUNCH }, controller.signal);
    return { text: [text, ...notes].join("\n") };
  } finally {
    huntControllers.delete(plan.name);
    signal.removeEventListener("abort", stop);
  }
}
async function callControl($, args) {
  if (await readMode($) === null && (args.action === void 0 || args.action === "list")) {
    const ready = await readyEngines($, ENGINES);
    return { text: `Hydra not started yet in this conversation: the first head or hunt call turns it on.
Engines ready here: ${ready.pool.join(", ") || "none"}${ready.skipped.length ? `
Not ready: ${ready.skipped.map((item) => `${item.engine} (${item.problem})`).join("; ")}` : ""}` };
  }
  const outcome = await runControl($, args, { defaultEngine: DEFAULT_ENGINE, defaultHead: DEFAULT_HEAD, defaultEffort: "auto", isAutoDefault: true });
  return "deny" in outcome ? { text: outcome.deny, isError: true } : { text: outcome.result };
}
function serve(input = process.stdin, output = process.stdout) {
  let sessionId = `agy-${process.pid}`;
  let elicit = false;
  let nextAsk = 0;
  const asks = /* @__PURE__ */ new Map();
  const calls = /* @__PURE__ */ new Map();
  const send = (message) => output.write(`${JSON.stringify(message)}
`);
  const ask = (question, options) => {
    if (!elicit) return Promise.resolve(void 0);
    const id = `hydra-ask-${++nextAsk}`;
    return new Promise((done) => {
      asks.set(id, (answer) => {
        const content = answer.result;
        done(content?.action === "accept" && typeof content.content?.choice === "string" ? content.content.choice : void 0);
      });
      send({ jsonrpc: "2.0", id, method: "elicitation/create", params: { message: question, requestedSchema: { type: "object", properties: { choice: { type: "string", title: options.header ?? "Hydra", enum: options.options } }, required: ["choice"] } } });
    });
  };
  const $ = createRuntime({ dataDir, pluginRoot, workspace: process.cwd(), sessionId: () => sessionId, ask });
  const handle = async (message) => {
    if (message.id !== void 0 && !message.method) {
      asks.get(String(message.id))?.(message);
      asks.delete(String(message.id));
      return;
    }
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize": {
        elicit = Boolean(params.capabilities?.elicitation);
        send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hydra-heads", version: VERSION } } });
        void sweepHunts($).catch(() => void 0);
        return;
      }
      case "tools/list":
        send({ jsonrpc: "2.0", id: message.id, result: { tools: agyTools() } });
        return;
      case "tools/call": {
        const meta = params._meta ?? {};
        const conversation = meta["antigravity.google/root_conversation_id"] ?? meta["antigravity.google/conversation_id"];
        if (typeof conversation === "string" && conversation && sessionId.startsWith("agy-")) sessionId = conversation;
        const controller = new AbortController();
        calls.set(message.id, controller);
        const args = params.arguments ?? {};
        try {
          const outcome = params.name === "head" ? await callHead($, args, controller.signal) : params.name === "hunt" ? await callHunt($, args, controller.signal) : params.name === "control" ? await callControl($, args) : { text: `Unknown tool ${String(params.name)}.`, isError: true };
          send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: outcome.text }], ...outcome.isError ? { isError: true } : {} } });
        } catch (error) {
          send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `Hydra: the call failed (${String(error).slice(0, 300)}).` }], isError: true } });
        } finally {
          calls.delete(message.id);
        }
        return;
      }
      case "notifications/cancelled":
        calls.get(params.requestId)?.abort("cancelled by Antigravity");
        return;
      default:
        if (message.id !== void 0) send({ jsonrpc: "2.0", id: message.id, ...message.method === "ping" ? { result: {} } : { error: { code: -32601, message: `Method not found: ${message.method}` } } });
    }
  };
  createInterface({ input }).on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    void handle(message);
  });
  input.on("end", () => {
    for (const controller of [...calls.values(), ...controllers.values(), ...huntControllers.values()]) controller.abort("Antigravity closed the session");
  });
}

// agy/main.ts
var consent = consentFromArgs(process.argv.slice(2), new JsonFile(resolve3(dataDir, "store.json")));
if (consent) console.log(consent);
else serve();

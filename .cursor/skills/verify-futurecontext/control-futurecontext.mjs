#!/usr/bin/env node
// Isolated Chrome driver for the FutureContext extension workspace.
// Invokes /usr/bin/google-chrome-stable directly. Never calls the google-chrome
// wrapper: that wrapper pins a shared profile and debugging port.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const chromeBin = process.env.FUTURECONTEXT_CHROME || '/usr/bin/google-chrome-stable';
const HOME_RE = /^\/tmp\/futurecontext-verify-[A-Za-z0-9._-]+$/;
const POPUP_PATH = 'src/ui/popup/popup.html';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function homeDir() {
  const home = process.env.FUTURECONTEXT_VERIFY_HOME;
  if (!home || !HOME_RE.test(home)) {
    fail('设置 FUTURECONTEXT_VERIFY_HOME=/tmp/futurecontext-verify-<run-id>。只接受该前缀下的独立目录，避免连上已有 Chrome。');
  }
  return home;
}

function sessionPath(home) {
  return path.join(home, 'session.json');
}

function readSession() {
  const home = homeDir();
  const file = sessionPath(home);
  if (!fs.existsSync(file)) fail(`没有验收会话：${file}。先运行 launch。`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function extensionIdForPath(extensionPath) {
  const absolute = path.resolve(extensionPath);
  const hex = createHash('sha256').update(absolute).digest('hex').slice(0, 32);
  return [...hex].map((char) => String.fromCharCode(97 + Number.parseInt(char, 16))).join('');
}

function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replaceAll('\0', ' ').trim();
  } catch {
    return '';
  }
}

function pidsForProfile(profile) {
  if (!profile.startsWith('/tmp/futurecontext-verify-')) return [];
  const pids = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const command = cmdline(entry);
    if (command.includes(`--user-data-dir=${profile}`) && command.includes('chrome')) pids.push(Number(entry));
  }
  return pids;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error(`无法连接 ${wsUrl}`)));
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message || 'CDP 错误'} (${message.error.code})`));
    else resolve(message.result ?? {});
  });
  return {
    ready: opened,
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
    }
  };
}

async function withCdp(wsUrl, run) {
  const client = connect(wsUrl);
  await client.ready;
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

async function targets(port) {
  return fetchJson(`http://127.0.0.1:${port}/json/list`);
}

function workspacePrefix(extensionId) {
  return `chrome-extension://${extensionId}/${POPUP_PATH}`;
}

async function waitFor(label, attempt, timeoutMs = 20000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await attempt();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(lastError ? `${label}：${lastError.message}` : `${label} 超时`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function manifestVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
  return manifest.version;
}

async function launch() {
  const home = homeDir();
  const profile = path.join(home, 'profile');
  if (!fs.existsSync(path.join(repoRoot, 'manifest.json'))) fail(`扩展根目录缺少 manifest.json：${repoRoot}`);
  if (!fs.existsSync(chromeBin)) fail(`找不到 Chrome：${chromeBin}`);
  fs.mkdirSync(home, { recursive: true });
  const existing = pidsForProfile(profile);
  if (existing.length) fail(`该验收目录已有 Chrome 进程 ${existing.join(', ')}。不要重复驱动同一实例。`);
  const port = await freePort();
  const expectedId = extensionIdForPath(repoRoot);
  const logPath = path.join(home, 'chrome.log');
  const logFd = fs.openSync(logPath, 'a');
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1280,900',
    '--window-position=40,40',
    '--lang=zh-CN',
    'about:blank'
  ];
  const child = spawn(chromeBin, args, { detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  fs.closeSync(logFd);
  const session = {
    pid: child.pid,
    port,
    profile,
    home,
    repoRoot,
    expectedExtensionId: expectedId,
    chromeBin
  };
  fs.writeFileSync(sessionPath(home), `${JSON.stringify(session, null, 2)}\n`);
  try {
    const versionInfo = await waitFor('调试端口', async () => {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      return version.webSocketDebuggerUrl ? version : null;
    });
    const owned = pidsForProfile(profile);
    if (!owned.length) throw new Error('Chrome 没有使用验收配置目录启动。已停止，避免连上其他实例。');
    const loaded = await withCdp(versionInfo.webSocketDebuggerUrl, (browser) => browser.send('Extensions.loadUnpacked', { path: repoRoot }));
    const actualId = loaded?.id;
    if (actualId !== expectedId) throw new Error(`扩展 ID 不一致。路径计算为 ${expectedId}，Chrome 加载为 ${actualId || '空'}。`);
    const pageUrl = `${workspacePrefix(actualId)}?mode=tab`;
    await withCdp(versionInfo.webSocketDebuggerUrl, (browser) => browser.send('Target.createTarget', { url: pageUrl }));
    await waitFor('资料库页面', async () => {
      const page = (await targets(port)).find((target) => target.type === 'page' && target.url?.startsWith(pageUrl));
      if (!page?.webSocketDebuggerUrl) return null;
      const text = await pageText(page.webSocketDebuggerUrl);
      return text.includes('通用 Prompt') && !text.includes('无法读取本地资料库') ? page : null;
    });
    session.extensionId = actualId;
    session.pageUrl = pageUrl;
    fs.writeFileSync(sessionPath(home), `${JSON.stringify(session, null, 2)}\n`);
    console.log(`ready ${pageUrl}`);
    console.log(`profile ${profile}`);
    console.log(`port ${port}`);
    console.log(`extension ${actualId}`);
  } catch (error) {
    await cleanupProcesses(profile);
    fs.rmSync(profile, { recursive: true, force: true });
    fail(`${error.message}\n日志：${logPath}`);
  }
}

async function pageText(wsUrl) {
  return withCdp(wsUrl, async (page) => {
    const result = await page.send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true
    });
    return result.result?.value ?? '';
  });
}

async function workspacePage(session) {
  const list = await targets(session.port);
  const page = list.find((target) => target.type === 'page' && target.url?.startsWith(session.pageUrl));
  if (!page?.webSocketDebuggerUrl) fail('工作区标签页不在当前验收实例中。');
  return page;
}

async function doctor() {
  const session = readSession();
  const pids = pidsForProfile(session.profile);
  if (!pids.length) fail('验收 Chrome 未运行。');
  let version;
  try {
    version = await fetchJson(`http://127.0.0.1:${session.port}/json/version`);
  } catch (error) {
    fail(`调试端口 ${session.port} 无响应：${error.message}`);
  }
  const list = await targets(session.port);
  const worker = list.find((target) => target.url === `chrome-extension://${session.extensionId}/src/background/background.js`);
  if (!worker) fail('当前调试端口上没有本次加载的 FutureContext service worker。');
  const page = list.find((target) => target.type === 'page' && target.url?.startsWith(session.pageUrl));
  if (!page) fail(`工作区页面未打开：${session.pageUrl}`);
  const details = await withCdp(page.webSocketDebuggerUrl, (client) => client.send('Runtime.evaluate', {
    expression: `(() => {
      const manifest = chrome.runtime.getManifest();
      return { name: manifest.name, version: manifest.version, text: document.body.innerText };
    })()`,
    returnByValue: true
  }));
  const value = details.result?.value;
  if (!value || value.name !== 'FutureContext') fail('页面不是 FutureContext 扩展页。');
  if (value.version !== manifestVersion()) fail(`扩展版本 ${value.version} 与仓库 manifest ${manifestVersion()} 不一致。`);
  if (!value.text.includes('通用 Prompt') && !value.text.includes('设置') && !value.text.includes('FutureContext')) {
    fail('页面尚未渲染资料库。');
  }
  if (String(value.text).includes('无法读取本地资料库')) fail('资料库读取失败。');
  console.log('ok');
  console.log(`name ${value.name}`);
  console.log(`version ${value.version}`);
  console.log(`page ${page.url}`);
  console.log(`profile ${session.profile}`);
  console.log(`port ${session.port}`);
  console.log(`pid ${pids.join(',')}`);
  console.log(`chrome ${version.Browser}`);
  console.log(`extension ${session.extensionId}`);
}

function querySource({ role, name, contains, selector }) {
  return `
    const wantedRole = ${JSON.stringify(role || '')};
    const wantedName = ${JSON.stringify(name || '')};
    const nameContains = ${contains ? 'true' : 'false'};
    const selector = ${JSON.stringify(selector || '')};
    const roleOf = (el) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'h1' || tag === 'h2') return 'heading';
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'hidden' || type === 'file') return '';
        if (type === 'search') return 'searchbox';
        if (type === 'checkbox') return 'checkbox';
        return 'textbox';
      }
      return '';
    };
    const labelText = (label) => {
      const clone = label.cloneNode(true);
      clone.querySelectorAll('input, textarea, select, button').forEach((node) => node.remove());
      return (clone.innerText || clone.textContent || '').replace(/\\s+/g, ' ').trim();
    };
    const accName = (el) => {
      const labelled = el.getAttribute('aria-label');
      if (labelled) return labelled.replace(/\\s+/g, ' ').trim();
      if (el.id) {
        const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label) return labelText(label);
      }
      const wrapping = el.closest('label');
      if (wrapping && wrapping !== el) return labelText(wrapping);
      return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const nodes = selector
      ? [...document.querySelectorAll(selector)]
      : [...document.querySelectorAll('button, input, textarea, select, h1, h2, [role]')];
    const matches = nodes.filter(visible).map((el) => ({ el, role: roleOf(el), name: accName(el) })).filter((item) => {
      if (wantedRole && item.role !== wantedRole) return false;
      if (!wantedName) return true;
      return nameContains ? item.name.includes(wantedName) : item.name === wantedName;
    });
  `;
}

async function evaluate(session, expression) {
  const page = await workspacePage(session);
  return withCdp(page.webSocketDebuggerUrl, async (client) => {
    await client.send('Runtime.enable');
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) fail(result.exceptionDetails.text || '页面脚本失败');
    return result.result?.value;
  });
}

function describeQuery(flags) {
  return { role: flags.role || '', name: flags.name || '', contains: Boolean(flags.contains), selector: flags.selector || '' };
}

async function findMatches(session, flags) {
  const expression = `(() => {
    ${querySource(describeQuery(flags))}
    if (matches.length === 1) matches[0].el.scrollIntoView({ block: 'center', inline: 'nearest' });
    return matches.map((item) => {
      const rect = item.el.getBoundingClientRect();
      return { role: item.role, name: item.name, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
  })()`;
  const matches = await evaluate(session, expression);
  if (!Array.isArray(matches) || matches.length !== 1) {
    const rendered = (matches || []).map((item) => `${item.role} "${item.name}"`).join('; ') || '无';
    fail(`需要唯一匹配，实际 ${matches?.length ?? 0} 个：${rendered}`);
  }
  return matches[0];
}

async function click(flags) {
  const session = readSession();
  const match = await findMatches(session, flags);
  const page = await workspacePage(session);
  await withCdp(page.webSocketDebuggerUrl, async (client) => {
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: match.x, y: match.y });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: match.x, y: match.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: match.x, y: match.y, button: 'left', clickCount: 1 });
  });
  console.log(`clicked ${match.role} "${match.name}"`);
}

async function fill(flags) {
  if (typeof flags.value !== 'string') fail('fill 需要 --value。');
  const session = readSession();
  const expression = `(() => {
    ${querySource(describeQuery(flags))}
    if (matches.length !== 1) return { ok: false, count: matches.length, names: matches.map((item) => item.role + ' "' + item.name + '"') };
    const target = matches[0].el;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.focus();
    target.value = ${JSON.stringify(flags.value)};
    target.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(flags.value)}, inputType: 'insertText' }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`;
  const result = await evaluate(session, expression);
  if (!result?.ok) fail(`需要唯一匹配，实际 ${result?.count ?? 0} 个：${(result?.names || []).join('; ') || '无'}`);
  console.log(`filled "${flags.name || flags.selector}"`);
}

async function wait(flags) {
  if (!flags.text) fail('wait 需要 --text。');
  const session = readSession();
  const absent = Boolean(flags.absent);
  const timeout = Number(flags.timeout || 8000);
  await waitFor(absent ? `等待文本消失 ${flags.text}` : `等待文本 ${flags.text}`, async () => {
    const page = await workspacePage(session);
    const text = await pageText(page.webSocketDebuggerUrl);
    const present = text.includes(flags.text);
    return absent ? !present : present;
  }, timeout);
  console.log(absent ? `absent ${flags.text}` : `visible ${flags.text}`);
}

async function reload() {
  const session = readSession();
  const page = await workspacePage(session);
  await withCdp(page.webSocketDebuggerUrl, (client) => client.send('Page.reload', { ignoreCache: true }));
  await waitFor('重新加载资料库', async () => {
    const next = (await targets(session.port)).find((target) => target.type === 'page' && target.url?.startsWith(session.pageUrl));
    if (!next?.webSocketDebuggerUrl) return null;
    const text = await pageText(next.webSocketDebuggerUrl);
    return text.includes('FutureContext') ? next : null;
  });
  console.log('reloaded');
}

function evidenceFile(file) {
  const session = readSession();
  if (!file) fail('需要 --path。');
  const resolved = path.resolve(file);
  const home = session.home;
  if (resolved === home || resolved.startsWith(`${home}/`)) fail('证据不能写在验收会话目录内，cleanup 会删除该目录。');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

async function snapshot(flags) {
  const file = evidenceFile(flags.path);
  const session = readSession();
  const page = await workspacePage(session);
  const tree = await withCdp(page.webSocketDebuggerUrl, async (client) => {
    await client.send('Accessibility.enable');
    return client.send('Accessibility.getFullAXTree');
  });
  const nodes = new Map((tree.nodes || []).map((node) => [node.nodeId, node]));
  const lines = [];
  const skip = new Set(['none', 'generic', 'InlineTextBox', 'StaticText', 'LineBreak']);
  function walk(nodeId, depth) {
    const node = nodes.get(nodeId);
    if (!node) return;
    const role = node.role?.value || '';
    const name = node.name?.value || '';
    const ignored = node.ignored || skip.has(role);
    if (!ignored && (name || ['main', 'navigation', 'dialog', 'form', 'status'].includes(role))) {
      lines.push(`${'  '.repeat(Math.min(depth, 8))}${role}${name ? ` "${name.replaceAll('\n', ' ')}"` : ''}`);
    }
    for (const child of node.childIds || []) walk(child, ignored ? depth : depth + 1);
  }
  const roots = (tree.nodes || []).filter((node) => !node.parentId).map((node) => node.nodeId);
  for (const root of roots) walk(root, 0);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  console.log(`snapshot ${file}`);
}

async function screenshot(flags) {
  const file = evidenceFile(flags.path);
  const session = readSession();
  const page = await workspacePage(session);
  const image = await withCdp(page.webSocketDebuggerUrl, async (client) => {
    await client.send('Page.enable');
    return client.send('Page.captureScreenshot', { format: 'png' });
  });
  fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
  console.log(`screenshot ${file}`);
}

async function value(flags) {
  const session = readSession();
  const expression = `(() => {
    ${querySource(describeQuery(flags))}
    if (matches.length !== 1) return { ok: false, count: matches.length, names: matches.map((item) => item.role + ' "' + item.name + '"') };
    return { ok: true, value: matches[0].el.value ?? '' };
  })()`;
  const result = await evaluate(session, expression);
  if (!result?.ok) fail(`需要唯一匹配，实际 ${result?.count ?? 0} 个：${(result?.names || []).join('; ') || '无'}`);
  process.stdout.write(`${result.value}\n`);
}

async function text() {
  const session = readSession();
  const page = await workspacePage(session);
  process.stdout.write(`${await pageText(page.webSocketDebuggerUrl)}\n`);
}

async function cleanupProcesses(profile) {
  const pids = pidsForProfile(profile);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 进程可能已退出。 */ }
  }
  const started = Date.now();
  while (pidsForProfile(profile).length && Date.now() - started < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (const pid of pidsForProfile(profile)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 进程可能已退出。 */ }
  }
}

async function cleanup() {
  const home = homeDir();
  const profile = path.join(home, 'profile');
  await cleanupProcesses(profile);
  fs.rmSync(home, { recursive: true, force: true });
  const evidence = process.env.FUTURECONTEXT_VERIFY_EVIDENCE;
  console.log(`cleaned ${home}`);
  if (evidence) console.log(`evidence retained ${evidence}`);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, subcommand] = positional;

try {
  if (command === 'launch') await launch();
  else if (command === 'doctor') await doctor();
  else if (command === 'cleanup') await cleanup();
  else if (command === 'browser' && subcommand === 'click') await click(flags);
  else if (command === 'browser' && subcommand === 'fill') await fill(flags);
  else if (command === 'browser' && subcommand === 'wait') await wait(flags);
  else if (command === 'browser' && subcommand === 'reload') await reload();
  else if (command === 'browser' && subcommand === 'snapshot') await snapshot(flags);
  else if (command === 'browser' && subcommand === 'screenshot') await screenshot(flags);
  else if (command === 'browser' && subcommand === 'text') await text();
  else if (command === 'browser' && subcommand === 'value') await value(flags);
  else {
    fail('用法：control-futurecontext.mjs launch|doctor|cleanup|browser click|fill|wait|reload|snapshot|screenshot|text|value');
  }
} catch (error) {
  fail(error.stack || error.message);
}

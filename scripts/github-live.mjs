import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_STORAGE_KEY, applyDatabaseChange, createEmptyDatabase, createCategory,
  loadDatabase, moveAigcAsset, saveAsset, saveGithubSkillAsset
} from '../src/core/store.js';
import { githubFetch, saveGitHubToken } from '../src/features/github/github-auth.js';
import { checkGitHubSkillUpdate, collectGitHubSkill } from '../src/features/github/github-skill.js';
import {
  configureSync, libraryRecords, removeSyncConfiguration, runLibrarySync,
  SYNC_FORMAT, SYNC_PATH, syncSettings, validateSyncDocument
} from '../src/features/github/github-sync.js';

export const LIVE_FIXTURE_PATH = '.futurecontext/github-live-fixture.json';
export const LIVE_FIXTURE_FORMAT = 'futurecontext.github-live-fixture';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const clone = (value) => structuredClone(value);
const encode = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
const decode = (value) => Buffer.from(value, 'base64').toString('utf8');

export function parseLiveArguments(args, env = {}) {
  let enabled = env.FUTURECONTEXT_GITHUB_LIVE === '1';
  let configPath; let publicOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--enable') enabled = true;
    else if (args[index] === '--public-only') publicOnly = true;
    else if (args[index] === '--config' && args[index + 1]) configPath = args[++index];
    else throw new Error('参数无效。使用 --enable --config /绝对路径/config.json，可加 --public-only。');
  }
  if (!enabled) throw new Error('真实 GitHub 验收默认关闭；必须显式传入 --enable。');
  if (!configPath || !isAbsolute(configPath)) throw new Error('必须用 --config 指定仓库外的绝对配置文件路径。');
  return { configPath, publicOnly };
}

export function validateLiveConfig(input, { publicOnly = false } = {}) {
  if (!input || !repositoryName.test(input.publicRepository ?? '')) throw new Error('请配置 publicRepository（owner/repo）。');
  if (typeof input.skillPath !== 'string' || !input.skillPath.endsWith('/SKILL.md') || input.skillPath.startsWith('/') || input.skillPath.includes('\\') || input.skillPath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('skillPath 必须是仓库内某个目录的 SKILL.md 相对路径。');
  }
  if (!/^github_pat_[A-Za-z0-9_]+$/.test(input.collectionToken ?? '')) throw new Error('请配置独立的细粒度 collectionToken，仅需公开仓库 Contents 读取。');
  if (!publicOnly) {
    if (!repositoryName.test(input.privateRepository ?? '') || input.privateRepository === input.publicRepository) throw new Error('请配置独立的 privateRepository（个人私有测试仓库）。');
    if (input.allowFixtureWrites !== true) throw new Error('完整验收必须明确配置 allowFixtureWrites: true。');
    if (!/^github_pat_[A-Za-z0-9_]+$/.test(input.syncToken ?? '') || input.syncToken === input.collectionToken) throw new Error('syncToken 必须是独立细粒度 Token，仅授权私有测试仓库 Contents 读写。');
    if (input.readOnlyToken && (!/^github_pat_[A-Za-z0-9_]+$/.test(input.readOnlyToken) || [input.syncToken, input.collectionToken].includes(input.readOnlyToken))) throw new Error('readOnlyToken 必须是另一枚仅有测试仓库 Contents 读取权限的细粒度 Token。');
  }
  return { ...input, publicOnly };
}

export async function readLiveConfig(configPath, options) {
  const path = await realpath(configPath);
  const location = relative(root, path);
  if (location === '' || (location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location))) throw new Error('真实凭据配置必须保存在仓库外。');
  const info = await stat(path);
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('配置含凭据，请先运行 chmod 600 配置文件。');
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('无法读取有效 JSON 配置；配置内容不会输出。'); }
  return validateLiveConfig(value, options);
}

// Independent synthetic device state. Never connects to the user's Chrome
// storage, IndexedDB, extension profile, credentials, or Agent directories.
export function createLiveDevice(database = createEmptyDatabase()) {
  const data = { [APP_STORAGE_KEY]: clone(database) }; const packages = new Map();
  const storage = {
    async get(key) {
      if (typeof key === 'string') return clone({ [key]: data[key] });
      return clone(Object.fromEntries(key.map((name) => [name, data[name]])));
    },
    async set(values) { Object.assign(data, clone(values)); },
    async remove(key) { delete data[key]; },
    async setAccessLevel() {}
  };
  const adapters = {
    storage,
    readPackage: async (id) => clone(packages.get(id) ?? null),
    writePackage: async (value) => { packages.set(value.id, clone(value)); },
    removePackage: async (id) => { packages.delete(id); }
  };
  return { storage, packages, adapters };
}

export function createLiveTransport(config, { fetchImpl = fetch, requestLimit = 180, writeLimit = 25 } = {}) {
  const repositories = new Set([config.publicRepository, config.privateRepository].filter(Boolean));
  const events = []; let writes = 0;
  const request = async (url, options = {}) => {
    const parsed = new URL(url);
    const repository = parsed.pathname.split('/').slice(2, 4).join('/');
    const method = String(options.method ?? 'GET').toUpperCase();
    if (parsed.origin !== 'https://api.github.com' || parsed.username || parsed.password || !parsed.pathname.startsWith('/repos/') || !repositories.has(repository)) throw new Error('验收请求超出显式选择的 GitHub 仓库。');
    if (!['GET', 'PUT', 'DELETE'].includes(method)) throw new Error('验收请求方法未获授权。');
    if (method !== 'GET') {
      if (config.publicOnly || config.allowFixtureWrites !== true || repository !== config.privateRepository || parsed.pathname !== `/repos/${repository}/contents/${SYNC_PATH}`) throw new Error('验收写入仅允许专用私有测试仓库的同步文件。');
      if (writes >= writeLimit) throw new Error('验收写入预算已耗尽，停止请求。');
      writes += 1;
    }
    if (events.length >= requestLimit) throw new Error('验收请求预算已耗尽，停止请求。');
    const event = { method, path: parsed.pathname, status: null };
    events.push(event);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    const response = await fetchImpl(url, {
      ...options, signal, redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...options.headers }
    });
    event.status = response.status;
    return response;
  };
  return { request, events };
}

function authenticated(transport, token) {
  return (url, options = {}) => transport.request(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
}
async function responseJson(request, url, options) {
  const response = await request(url, options);
  if (!response.ok) { const error = new Error(`测试配置或 GitHub 请求失败（HTTP ${response.status}）。`); error.status = response.status; throw error; }
  return response.json();
}
const repoUrl = (repository, path = '') => `https://api.github.com/repos/${repository}${path}`;

async function readRemote(request, repository) {
  const response = await request(repoUrl(repository, `/contents/${SYNC_PATH}`));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`读取测试同步文件失败（HTTP ${response.status}）。`);
  const file = await response.json();
  const blob = file.content ? file : await responseJson(request, repoUrl(repository, `/git/blobs/${file.sha}`));
  return { sha: file.sha, size: file.size, document: validateSyncDocument(JSON.parse(decode(blob.content))) };
}

export async function assertDisposableFixture(request, repository, { requireEmpty = true } = {}) {
  const info = await responseJson(request, repoUrl(repository));
  if (!info.private || info.owner?.type !== 'User') throw new Error('完整验收只允许个人私有测试仓库。');
  const marker = await responseJson(request, repoUrl(repository, `/contents/${LIVE_FIXTURE_PATH}`));
  let value;
  try { value = JSON.parse(decode(marker.content)); } catch { throw new Error('测试仓库标记无效。'); }
  if (value.format !== LIVE_FIXTURE_FORMAT || value.version !== 1) throw new Error('测试仓库缺少明确的验收标记。');
  if (requireEmpty && await readRemote(request, repository)) throw new Error('测试仓库已存在同步文件；拒绝覆盖。请先检查上次运行是否清理完成。');
}

export async function cleanupLiveFile(request, repository, prefix) {
  await assertDisposableFixture(request, repository, { requireEmpty: false });
  const remote = await readRemote(request, repository);
  if (!remote) return;
  const ids = Object.keys(remote.document.records).map((key) => key.slice(key.indexOf(':') + 1));
  if (!ids.length || ids.some((id) => !id.startsWith(prefix))) throw new Error('测试文件包含无法确认归属本次验收的记录；保留远端文件，请人工检查。');
  await responseJson(request, repoUrl(repository, `/contents/${SYNC_PATH}`), {
    method: 'DELETE', body: JSON.stringify({ message: 'Clean up FutureContext synthetic live test', sha: remote.sha }), headers: { 'Content-Type': 'application/json' }
  });
}

export async function runGitHubLive(config, { fetchImpl = fetch, report = console.log } = {}) {
  const transport = createLiveTransport(config, { fetchImpl });
  const passes = []; const skipped = [];
  const passed = (name) => { passes.push(name); report(`PASS ${name}`); };
  const publicUrl = repoUrl(config.publicRepository);
  const publicInfo = await responseJson(transport.request, publicUrl);
  if (publicInfo.private) throw new Error('publicRepository 必须是公开仓库。');
  const history = await responseJson(transport.request, `${publicUrl}/commits?path=${encodeURIComponent(config.skillPath)}&per_page=2`);
  if (!Array.isArray(history) || history.length < 2) throw new Error('公开测试 Skill 需要至少两个历史版本，以验证精确 Commit 与手动更新。');
  const commit = history[1].sha;
  const collection = createLiveDevice();
  const anonymous = await githubFetch(transport.request, collection.storage);
  const context = { repository: config.publicRepository, commit, path: config.skillPath, url: `https://github.com/${config.publicRepository}/blob/${commit}/${config.skillPath}` };
  const anonymousPackage = await collectGitHubSkill(context, anonymous);
  assert.equal(anonymousPackage.source.commit, commit);
  const tree = await responseJson(transport.request, `${publicUrl}/git/trees/${commit}?recursive=1`);
  const directory = config.skillPath.slice(0, config.skillPath.lastIndexOf('/') + 1);
  const expected = tree.tree.filter((entry) => entry.type === 'blob' && entry.path.startsWith(directory));
  assert.deepEqual(anonymousPackage.files.map((f) => f.sourcePath).sort(), expected.map((f) => f.path).sort());
  assert.equal(anonymousPackage.totalSize, expected.reduce((sum, entry) => sum + entry.size, 0));
  passed('公开 Skill 匿名收集：精确 Commit、完整目录和文件大小');
  await saveGitHubToken(config.collectionToken, collection.storage);
  const collected = await collectGitHubSkill(context, await githubFetch(transport.request, collection.storage));
  assert.deepEqual(collected.files, anonymousPackage.files);
  const update = await checkGitHubSkillUpdate(collected.source, await githubFetch(transport.request, collection.storage));
  assert.equal(update.changed, true);
  const head = await responseJson(transport.request, `${publicUrl}/commits/${encodeURIComponent(publicInfo.default_branch)}`);
  assert.equal(update.commit, head.sha);
  assert.equal(update.packageRecord.source.defaultBranch, publicInfo.default_branch);
  assert.equal((await checkGitHubSkillUpdate(update.packageRecord.source, await githubFetch(transport.request, collection.storage))).changed, false);
  passed('公开 Skill 认证收集、默认分支手动更新与无变化检查');
  const invalid = createLiveDevice();
  await saveGitHubToken('github_pat_futurecontext_intentionally_invalid', invalid.storage);
  const previousRequests = transport.events.length;
  await assert.rejects(collectGitHubSkill(context, await githubFetch(transport.request, invalid.storage)), /Token 无效或已过期/);
  assert.equal(transport.events.length, previousRequests + 1);
  assert.equal(transport.events.at(-1).status, 401);
  passed('真实无效认证返回 401，不自动重试');
  if (config.publicOnly) return { passes, skipped: ['私有库同步（--public-only）'], events: transport.events };

  const request = authenticated(transport, config.syncToken);
  await assertDisposableFixture(request, config.privateRepository);
  const prefix = `live-${crypto.randomUUID()}-`;
  let writesStarted = false;
  const syncFetch = async (url, options = {}) => {
    if (options.method === 'PUT') writesStarted = true;
    return transport.request(url, options);
  };
  const sync = async (device, requestImpl = syncFetch) => {
    const result = await runLibrarySync({ ...device.adapters, fetchImpl: requestImpl });
    assert.equal(result.status.state, 'success');
    return result;
  };
  const configured = async (device, repository = config.privateRepository, token = config.syncToken) => {
    await configureSync({ repository, token, enabled: true, automatic: false }, device.storage);
    return device;
  };
  const putRemote = async (document, sha) => {
    await responseJson(request, repoUrl(config.privateRepository, `/contents/${SYNC_PATH}`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'FutureContext synthetic concurrent device', content: encode(document), sha })
    });
  };
  try {
    const a = await configured(createLiveDevice()); const b = await configured(createLiveDevice());
    let db = createCategory(createEmptyDatabase(), 'generic', 'Synthetic live test', { id: `${prefix}category` }).database;
    const add = (id, type, content) => { db = saveAsset(db, { type, content, privacy: 'normal' }, { id: `${prefix}${id}`, now: 1 }).database; };
    add('prompt', 'generic', 'Synthetic reusable prompt'); add('image', 'aigc', 'Synthetic ordinary image'); add('command', 'command', 'printf synthetic');
    db = saveGithubSkillAsset(db, collected, { id: `${prefix}skill`, now: 1 }).database;
    const privateAsset = saveAsset(createEmptyDatabase(), { type: 'aigc', privacy: 'private', content: 'PRIVATE_CANARY_FUTURECONTEXT' }, { id: `${prefix}private`, now: 1 }).asset;
    db.assets.push(privateAsset);
    db.categories.push({ id: `${prefix}private-category`, scope: 'aigc-private', name: 'PRIVATE_CATEGORY_CANARY' });
    db.drafts = { test: { content: 'DRAFT_CANARY_FUTURECONTEXT' } };
    db.lock = { passwordDigest: 'LOCK_CANARY_FUTURECONTEXT' };
    db.ai.providers = [{ apiKey: 'PROVIDER_CANARY_FUTURECONTEXT' }];
    db.usage = { log: [{ text: 'USAGE_CANARY_FUTURECONTEXT' }] };
    db.assets[0].skillDelivery = { targets: { codex: 'DIRECTORY_CANARY_FUTURECONTEXT' } };
    await a.adapters.writePackage(collected);
    await applyDatabaseChange(() => db, a.storage);
    await sync(a); await sync(b);
    const first = await readRemote(request, config.privateRepository);
    const text = JSON.stringify(first.document);
    if (/CANARY_FUTURECONTEXT|PRIVATE_CATEGORY_CANARY/.test(text) || [config.syncToken, config.collectionToken].some((secret) => text.includes(secret))) throw new Error('远端白名单包含禁止上传的测试字段。');
    assert.equal((await loadDatabase(b.storage)).assets.length, 4);
    const remoteSkill = (await loadDatabase(b.storage)).assets.find((asset) => asset.type === 'skill');
    assert.deepEqual((await b.adapters.readPackage(remoteSkill.skillPackage.packageId)).files.map((file) => file.path), collected.files.map((file) => file.path));
    passed('真实 Contents 写入、多设备首次合并、Skill 文件包与隐私白名单');

    for (const [device, content] of [[a, 'Device A edit'], [b, 'Device B edit']]) await applyDatabaseChange((latest) => saveAsset(latest, { ...latest.assets.find((asset) => asset.id === `${prefix}prompt`), content }).database, device.storage);
    await sync(a); await sync(b); await sync(a);
    const conflictContents = (await loadDatabase(a.storage)).assets.filter((asset) => asset.type === 'generic').map((asset) => asset.content);
    assert.ok(conflictContents.includes('Device A edit') && conflictContents.includes('Device B edit'));
    passed('真实双设备离线编辑冲突保留双方内容');

    let raced = false;
    await applyDatabaseChange((latest) => saveAsset(latest, { type: 'generic', content: 'Trigger SHA retry' }, { id: `${prefix}sha-local` }).database, a.storage);
    const beforeRace = transport.events.length;
    await sync(a, async (url, options = {}) => {
      if (options.method === 'PUT' && !raced) {
        raced = true;
        const body = JSON.parse(options.body);
        const document = JSON.parse(decode(body.content));
        const competitor = saveAsset(createEmptyDatabase(), { type: 'generic', content: 'Concurrent remote writer' }, { id: `${prefix}sha-remote`, now: 1 }).database;
        const records = await libraryRecords(competitor);
        await putRemote({ ...document, records: { ...document.records, ...records } }, body.sha);
      }
      return syncFetch(url, options);
    });
    assert.ok(transport.events.slice(beforeRace).some((event) => event.method === 'PUT' && [409, 422].includes(event.status)));
    assert.ok((await loadDatabase(a.storage)).assets.some((asset) => asset.id === `${prefix}sha-remote`));
    passed('真实 GitHub SHA 竞争失败后重新读取并合并');

    await applyDatabaseChange((latest) => moveAigcAsset(latest, `${prefix}image`, 'private', 3), a.storage);
    await applyDatabaseChange((latest) => saveAsset(latest, { ...latest.assets.find((asset) => asset.id === `${prefix}image`), content: 'OFFLINE_PRIVATE_CONFLICT_CANARY_FUTURECONTEXT' }).database, b.storage);
    await sync(a); await sync(b);
    const withdrawn = await readRemote(request, config.privateRepository);
    assert.equal(withdrawn.document.records[`asset:${prefix}image`].withdrawn, true);
    assert.ok((await loadDatabase(b.storage)).assets.some((asset) => asset.privacy === 'private' && asset.content === 'OFFLINE_PRIVATE_CONFLICT_CANARY_FUTURECONTEXT'));
    if (JSON.stringify(withdrawn.document).includes('OFFLINE_PRIVATE_CONFLICT_CANARY_FUTURECONTEXT')) throw new Error('撤回后的离线编辑泄漏到远端。');
    passed('真实普通转私密撤回，离线冲突仅保存在另一设备私密库');

    await applyDatabaseChange((latest) => saveAsset(latest, { type: 'generic', content: 'Synthetic large content\n' + 'x'.repeat(1100000) }, { id: `${prefix}large`, now: 1 }).database, a.storage);
    await sync(a);
    const rawContents = await responseJson(request, repoUrl(config.privateRepository, `/contents/${SYNC_PATH}`));
    assert.ok(rawContents.size > 1024 * 1024);
    assert.equal(rawContents.content, '');
    const beforeBlob = transport.events.length;
    await sync(b);
    assert.ok(transport.events.slice(beforeBlob).some((event) => event.path.includes('/git/blobs/') && event.status === 200));
    assert.ok((await loadDatabase(b.storage)).assets.some((asset) => asset.id === `${prefix}large` && asset.content.length > 1100000));
    passed('真实超过 1 MiB 的 Contents 响应与 Git blob 回读');

    const rejected = await configured(createLiveDevice(), config.publicRepository, config.collectionToken);
    const beforePublic = transport.events.length;
    await assert.rejects(runLibrarySync({ ...rejected.adapters, fetchImpl: syncFetch }), /个人已有的私有仓库/);
    assert.equal(transport.events.slice(beforePublic).filter((event) => event.method !== 'GET').length, 0);
    passed('真实公开仓库拒绝同步，无写请求');
    if (config.readOnlyToken) {
      const denied = await configured(createLiveDevice(), config.privateRepository, config.readOnlyToken);
      await applyDatabaseChange((latest) => saveAsset(latest, { type: 'generic', content: 'Permission boundary' }, { id: `${prefix}denied`, now: 1 }).database, denied.storage);
      const beforeDenied = transport.events.length;
      await assert.rejects(runLibrarySync({ ...denied.adapters, fetchImpl: syncFetch }), /403|404/);
      assert.ok(transport.events.slice(beforeDenied).some((event) => event.status === 403 || event.status === 404));
      passed('真实 Contents 只读凭据拒绝同步写入');
    } else skipped.push('真实写权限不足（未配置 readOnlyToken）');

    const cancel = await configured(createLiveDevice()); let removal;
    const beforeCancel = transport.events.length;
    await assert.rejects(runLibrarySync({ ...cancel.adapters, fetchImpl: async (url, options = {}) => {
      const response = await syncFetch(url, options);
      if (!removal) removal = removeSyncConfiguration(cancel.storage);
      return response;
    } }), /取消|已变更/);
    await removal;
    assert.equal(transport.events.slice(beforeCancel).filter((event) => event.method !== 'GET').length, 0);
    assert.equal((await loadDatabase(cancel.storage)).assets.length, 0);
    assert.equal((await syncSettings(cancel.storage)).configured, false);
    passed('真实响应返回期间移除配置，旧任务不上传或应用');

    await assert.rejects(runLibrarySync({ ...a.adapters, fetchImpl: async () => { throw new TypeError('synthetic offline transport'); } }), /offline/);
    await applyDatabaseChange((latest) => saveAsset(latest, { type: 'command', content: 'Local save while offline' }, { id: `${prefix}offline` }).database, a.storage);
    assert.ok((await loadDatabase(a.storage)).assets.some((asset) => asset.id === `${prefix}offline`));
    passed('故障注入：断网不影响本地保存');
  } finally {
    if (writesStarted) {
      await cleanupLiveFile(request, config.privateRepository, prefix);
      report('CLEANUP 本次合成同步文件已删除；Git 历史保留。');
    }
  }
  return { passes, skipped, events: transport.events };
}

export function safeLiveError(error, config = {}) {
  let message = String(error?.message ?? '验收失败');
  for (const token of [config.collectionToken, config.syncToken, config.readOnlyToken].filter(Boolean)) message = message.split(token).join('[redacted]');
  return message.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[redacted]').slice(0, 1000);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let config;
  try {
    const options = parseLiveArguments(process.argv.slice(2), process.env);
    config = await readLiveConfig(options.configPath, options);
    const result = await runGitHubLive(config);
    for (const item of result.skipped) console.log(`NOT RUN ${item}`);
    console.log(`完成 ${result.passes.length} 项；GitHub 请求 ${result.events.length} 次。未故意耗尽真实额度。`);
    if (result.skipped.length) process.exitCode = 2;
  } catch (error) {
    console.error(`GitHub 验收未通过：${safeLiveError(error, config)}`);
    process.exitCode = 1;
  }
}

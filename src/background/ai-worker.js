import { activeProvider, addStructureProposal, applyAiAssetResult, applyAiCategoryGroups, applyDatabaseChange, categoriesFor, decryptProviderKey, loadDatabase, removeProviderConfig, saveProviderConfig, updateAiSettings, verifyPrivacyPassword } from '../core/store.js';
import { buildAssetOrganizationPrompt, buildGroupingPrompt, buildStructurePrompt, chatCompletion, parseAssetResult, parseGroups } from '../features/ai/ai-organizer.js';

const SESSION_KEY = 'futurecontext.ai-session';
export const AI_ALARM = 'futurecontext.ai-queue';
function sessionStorage() { return chrome.storage.session; }

async function setStatus(state, message = '', context = null) {
  await applyDatabaseChange(async (database) => {
    if (context && !await context.current(database)) return null;
    return updateAiSettings(database, { status: { state, message } });
  });
}

async function sessionForProvider(providerId) {
  const stored = await sessionStorage().get(SESSION_KEY);
  const session = stored[SESSION_KEY];
  return session?.providerId === providerId ? session : null;
}

export async function scheduleAi() {
  await chrome.alarms.create(AI_ALARM, { delayInMinutes: 0.2 });
}

function uncategorized(database, scope) {
  return database.assets.filter((asset) => asset.type === scope && asset.privacy === 'normal' && !asset.categoryId && asset.categorySource !== 'manual');
}

let activeRun;

// An alarm and a manual request share one run, including its provider requests.
export function processAiQueue() {
  if (activeRun) return activeRun;
  activeRun = runAiQueue().finally(() => { activeRun = null; });
  return activeRun;
}

function eligibleAsset(asset) {
  return Boolean(asset && ['generic', 'skill'].includes(asset.type) && asset.privacy === 'normal');
}

function sameAssetContent(current, requested) {
  return eligibleAsset(current) && current.type === requested.type && current.content === requested.content;
}

function queueHasEntry(database, entry) {
  return database.ai.queue.some((item) => item.id === entry.id && item.assetId === entry.assetId);
}

function structureInput(database, scope) {
  return buildStructurePrompt(scope, categoriesFor(database, scope), database.assets.filter((asset) => asset.type === scope));
}

async function runAiQueue() {
  let database = await loadDatabase();
  if (!database.ai.enabled || !database.ai.queue.length) return;
  const provider = activeProvider(database);
  if (!provider) return setStatus('paused', '后台整理暂停，检查 Provider 配置。');
  const session = await sessionForProvider(provider.id);
  if (!session?.apiKey) return setStatus('paused', '后台整理已等待解锁。');
  const context = {
    async current(latest) {
      if (!latest.ai.enabled || JSON.stringify(activeProvider(latest)) !== JSON.stringify(provider)) return false;
      const currentSession = await sessionForProvider(provider.id);
      return currentSession?.apiKey === session.apiKey && currentSession?.unlockedAt === session.unlockedAt;
    }
  };
  let failed = false;
  try {
    const queue = [...database.ai.queue];
    for (const entry of queue) {
      database = await loadDatabase();
      if (!await context.current(database)) return;
      // A new save replaces the queue entry; an older snapshot must not request it.
      if (!queueHasEntry(database, entry)) continue;
      const asset = database.assets.find((item) => item.id === entry.assetId);
      if (!eligibleAsset(asset)) {
        await applyDatabaseChange((latest) => {
          if (!queueHasEntry(latest, entry)) return null;
          const next = updateAiSettings(latest, {});
          next.ai.queue = next.ai.queue.filter((item) => item.id !== entry.id);
          return next;
        });
        continue;
      }
      const result = parseAssetResult(await chatCompletion(provider, session.apiKey, buildAssetOrganizationPrompt(asset, categoriesFor(database, asset.type))));
      await applyDatabaseChange(async (latest) => {
        if (!await context.current(latest) || !queueHasEntry(latest, entry) || !sameAssetContent(latest.assets.find((item) => item.id === asset.id), asset)) return null;
        const next = applyAiAssetResult(latest, asset.id, result);
        next.ai.queue = next.ai.queue.filter((item) => item.id !== entry.id);
        return next;
      });
    }
    for (const scope of ['generic', 'skill']) {
      database = await loadDatabase();
      if (!await context.current(database)) return;
      const open = uncategorized(database, scope);
      if (open.length >= database.ai.thresholds.uncategorized) {
        const requested = open.slice(0, 50);
        const response = await chatCompletion(provider, session.apiKey, buildGroupingPrompt(scope, requested));
        await applyDatabaseChange(async (latest) => {
          if (!await context.current(latest)) return null;
          const eligible = requested.filter((asset) => sameAssetContent(latest.assets.find((item) => item.id === asset.id), asset));
          const groups = parseGroups(response, eligible.map((item) => item.id));
          return groups.length ? applyAiCategoryGroups(latest, scope, groups) : null;
        });
      }
    }
    database = await loadDatabase();
    if (!await context.current(database)) return;
    const elapsedDays = database.ai.lastRestructureAt ? (Date.now() - database.ai.lastRestructureAt) / 86400000 : Infinity;
    if (database.ai.changeCountSinceRestructure >= database.ai.thresholds.restructureChanges && elapsedDays >= database.ai.thresholds.restructureDays) {
      const changeCount = database.ai.changeCountSinceRestructure;
      const assessedInputs = new Map();
      for (const scope of ['generic', 'skill']) {
        database = await loadDatabase();
        if (!await context.current(database)) return;
        if (!categoriesFor(database, scope).length) continue;
        const prompt = structureInput(database, scope);
        assessedInputs.set(scope, prompt);
        const response = await chatCompletion(provider, session.apiKey, prompt);
        if (response?.proposal?.groups?.length) {
          const proposal = { scope, ...response.proposal };
          await applyDatabaseChange(async (latest) => {
            if (!await context.current(latest) || structureInput(latest, scope) !== prompt) return null;
            return addStructureProposal(latest, proposal);
          });
        }
      }
      await applyDatabaseChange(async (latest) => {
        if (!await context.current(latest) || !assessedInputs.size || [...assessedInputs].some(([scope, prompt]) => structureInput(latest, scope) !== prompt)) return null;
        return updateAiSettings(latest, { lastRestructureAt: Date.now(), changeCountSinceRestructure: Math.max(0, latest.ai.changeCountSinceRestructure - changeCount) });
      });
    }
    await setStatus('idle', '', context);
  } catch {
    failed = true;
    await setStatus('paused', '后台整理暂停，检查 Provider 配置。', context);
  } finally {
    // A newer session's alarm can be consumed by this shared run. Schedule from
    // the current configuration even when this run exits with a stale context.
    database = await loadDatabase();
    const currentProvider = activeProvider(database);
    if (database.ai.enabled && database.ai.queue.length && currentProvider) {
      const currentSession = await sessionForProvider(currentProvider.id);
      // A genuine failure pauses this configuration instead of retrying forever.
      if (currentSession?.apiKey && (!failed || !await context.current(database))) await scheduleAi();
    }
  }
}

export async function unlockAi(password) {
  const database = await loadDatabase();
  if (!await verifyPrivacyPassword(database, password)) throw new Error('隐私锁密码不正确。');
  const provider = activeProvider(database);
  if (!provider) throw new Error('请先保存并选择一个 Provider。');
  const apiKey = await decryptProviderKey(password, provider.secret);
  await sessionStorage().set({ [SESSION_KEY]: { providerId: provider.id, apiKey, unlockedAt: Date.now() } });
  await applyDatabaseChange((latest) => updateAiSettings(latest, { status: { state: 'idle', message: '' } }));
  await scheduleAi();
  return { providerId: provider.id };
}

export async function queueExisting() {
  let count = 0;
  await applyDatabaseChange((database) => {
    if (!database.ai.enabled) throw new Error('请先开启后台 AI 整理。');
    const queuedIds = new Set(database.ai.queue.map((entry) => entry.assetId));
    count = 0;
    for (const asset of database.assets) {
      if (!['generic', 'skill'].includes(asset.type) || asset.privacy !== 'normal' || queuedIds.has(asset.id)) continue;
      database.ai.queue.push({ id: crypto.randomUUID(), assetId: asset.id, assetType: asset.type, queuedAt: Date.now() });
      count += 1;
    }
    return database;
  });
  if (count) await scheduleAi();
  return { count };
}

export async function testProvider(id) {
  const database = await loadDatabase();
  const provider = database.ai.providers.find((item) => item.id === id);
  if (!provider) throw new Error('找不到 Provider。');
  const session = await sessionForProvider(provider.id);
  if (!session?.apiKey) throw new Error('请先解锁此 Provider。');
  await chatCompletion(provider, session.apiKey, '返回 {"ok":true}。');
  return { ok: true };
}

export async function aiSessionStatus() {
  const provider = activeProvider(await loadDatabase());
  return { unlocked: Boolean(provider && await sessionForProvider(provider.id)), providerId: provider?.id ?? null };
}

export async function saveProvider(providerInput, password) {
  let provider;
  await applyDatabaseChange(async (database) => {
    const result = await saveProviderConfig(database, providerInput, password);
    const saved = result.database.ai.providers.find((item) => item.id === result.provider.id);
    const apiKey = await decryptProviderKey(password, saved.secret);
    await sessionStorage().set({ [SESSION_KEY]: { providerId: saved.id, apiKey, unlockedAt: Date.now() } });
    provider = result.provider;
    return result.database;
  });
  return provider;
}

export async function clearAiSession() {
  await sessionStorage().remove(SESSION_KEY);
  return { ok: true };
}

export async function deleteProvider(id) {
  await applyDatabaseChange((database) => removeProviderConfig(database, id));
  return clearAiSession();
}

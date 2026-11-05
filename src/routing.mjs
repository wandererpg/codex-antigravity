import { BridgeError } from './transport.mjs';
import { routingConfig as config } from './config.mjs';
export { routingConfig } from './config.mjs';

const normalized = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const identifiers = model => [model?.id, model?.label, model?.model?.model, model?.model?.alias];
const usable = model => Boolean(model && !model.disabled && model.model &&
  (model.model.model !== undefined || model.model.alias !== undefined));
const exact = (model, value) => identifiers(model).some(id => id !== undefined && id === value);
const normalizedId = value => normalized(value).replace(/^modelalias|^model/, '');

function checkEffort(effort) {
  if (!['auto', 'medium', 'high'].includes(effort)) {
    throw new BridgeError('INVALID_EFFORT', 'effort must be auto, medium, or high.');
  }
}

function routeAtTier(route, tier) {
  if (!route) return undefined;
  const choice = route.tiers?.[tier];
  if (choice) return { ...choice, family: route.family, tier };
  // Keep compatibility with an existing single-tier local configuration.
  return route.tier === tier ? route : undefined;
}

function sameFamilyAndTier(model, route) {
  const target = normalized(`${route.family}-${route.tier}`);
  return identifiers(model).some(value => normalizedId(value) === target);
}

function findRouteModel(models, route) {
  if (!route) return undefined;
  return models.find(model => usable(model) && model.id === route.id) ||
    models.find(model => usable(model) && sameFamilyAndTier(model, route));
}

/** Codex selects effort from task complexity; this module never guesses from prompt text. */
export function selectModel(models, taskType = config.defaultTaskType, explicitModel, effort = 'auto') {
  checkEffort(effort);
  if (explicitModel !== undefined && explicitModel !== null && explicitModel !== '') {
    const selected = models.find(model => usable(model) && exact(model, explicitModel));
    if (!selected) throw new BridgeError('MODEL_UNAVAILABLE', `Requested model is unavailable: ${String(explicitModel)}`);
    return selected;
  }
  const route = config.routes[taskType];
  const tier = effort === 'auto' ? route?.defaultTier || route?.tier : effort;
  const target = routeAtTier(route, tier);
  const selected = findRouteModel(models, target);
  if (!selected) throw new BridgeError('MODEL_UNAVAILABLE', `Requested task model is unavailable: ${target?.id || String(taskType)}`);
  return selected;
}

function familyTier(model, family) {
  for (const tier of ['medium', 'high', 'low', 'minimal']) {
    const target = normalized(`${family}-${tier}`);
    if (identifiers(model).some(value => normalizedId(value) === target)) return tier;
  }
  return undefined;
}

/** Called after a confirmed quota error; selection itself never invokes a model. */
export function fallbackModel(models, taskType, currentModel, effort = 'auto') {
  checkEffort(effort);
  const rule = config.quotaFallback;
  if (taskType !== rule.taskType) return undefined;
  const current = currentModel && typeof currentModel === 'object' ? currentModel :
    models.find(model => exact(model, currentModel)) || { id: currentModel };
  const currentTier = familyTier(current, rule.fromFamily);
  if (!currentTier) return undefined;
  const tier = effort === 'auto' ? (['medium', 'high'].includes(currentTier) ? currentTier : 'medium') : effort;
  const selected = findRouteModel(models, routeAtTier(rule.to, tier));
  // High may be absent in an account's catalog; only Flash Medium is allowed as
  // a second choice. A fallback never crosses into an unrelated model family.
  return selected || (tier === 'high' ? findRouteModel(models, routeAtTier(rule.to, 'medium')) : undefined);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectModel, fallbackModel, routingConfig } from '../src/routing.mjs';

const ids = {
  simple: { medium: 'gemini-3.8-flash-medium', high: 'gemini-3.8-flash-high' },
  complex: { medium: 'claude-opus-5-5-medium', high: 'claude-opus-5-5-high' },
  discussion: { medium: 'gemini-4-argon-medium', high: 'gemini-4-argon-high' },
};
const labels = { simple: 'Gemini 3.8 Flash', complex: 'Claude Opus 5.5', discussion: 'Gemini 4 Argon' };
const catalog = Object.entries(ids).flatMap(([type, tiers]) => Object.entries(tiers).map(([tier, id]) => ({
  id,
  label: `${labels[type]} (${tier === 'medium' ? 'Medium' : 'High'})`,
  model: { model: `MODEL_TEST_${type.toUpperCase()}_${tier.toUpperCase()}` },
  disabled: false,
})));
const byId = id => catalog.find(model => model.id === id);

test('auto effort uses Flash Medium, Opus High, and Argon Medium by task type', () => {
  for (const [type, tier] of [['simple', 'medium'], ['complex', 'high'], ['discussion', 'medium']]) {
    assert.equal(selectModel(catalog, type).id, ids[type][tier]);
    assert.equal(selectModel(catalog, type, undefined, 'auto').id, ids[type][tier]);
    assert.equal(routingConfig.routes[type].defaultTier, tier);
  }
});

test('Codex can explicitly choose Medium or High without changing the task model family', () => {
  for (const type of Object.keys(ids)) {
    for (const tier of ['medium', 'high']) {
      assert.equal(selectModel(catalog, type, undefined, tier).id, ids[type][tier]);
    }
  }
});

test('an explicit model takes priority over automatic task routing and effort', () => {
  const explicit = byId(ids.discussion.medium);
  for (const name of [explicit.id, explicit.label, explicit.model.model]) {
    assert.equal(selectModel(catalog, 'complex', name, 'high'), explicit);
  }
  const alias = { id: 'explicit-alias', label: 'Alias', model: { alias: 'MODEL_ALIAS_PRIVATE' } };
  assert.equal(selectModel([...catalog, alias], 'simple', alias.model.alias, 'high'), alias);
});

test('a missing target tier fails without switching family or silently selecting another tier', () => {
  const withoutOpusHigh = catalog.filter(model => model.id !== ids.complex.high);
  assert.throws(() => selectModel(withoutOpusHigh, 'complex'), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(selectModel(withoutOpusHigh, 'complex', undefined, 'medium').id, ids.complex.medium);
  const wrongTier = [byId(ids.simple.high), byId(ids.complex.medium), byId(ids.discussion.high)];
  assert.throws(() => selectModel(wrongTier, 'simple', undefined, 'medium'), { code: 'MODEL_UNAVAILABLE' });
  assert.throws(() => selectModel(catalog, 'unknown-task'), { code: 'MODEL_UNAVAILABLE' });
});

test('disabled or unqualified model entries cannot satisfy automatic tier routing', () => {
  const disabled = [{ ...byId(ids.complex.high), disabled: true }, byId(ids.complex.medium)];
  assert.throws(() => selectModel(disabled, 'complex'), { code: 'MODEL_UNAVAILABLE' });
  assert.throws(() => selectModel(disabled, 'simple', ids.complex.high, 'medium'), { code: 'MODEL_UNAVAILABLE' });
  const unqualified = [{ id: 'unqualified', label: 'Claude Opus 5.5', model: { model: 'MODEL_UNKNOWN' } }];
  assert.throws(() => selectModel(unqualified, 'complex'), { code: 'MODEL_UNAVAILABLE' });
});

test('punctuation variants can match the same exact family and tier', () => {
  const variant = { id: 'server-specific-id', label: 'Claude Opus 5.5 (High)', model: { model: 'MODEL_OPAQUE' } };
  assert.equal(selectModel([variant], 'complex'), variant);
  assert.throws(() => selectModel([{ ...variant, label: 'Claude Opus 5.5 (Medium)' }], 'complex'), { code: 'MODEL_UNAVAILABLE' });
});

test('auto quota fallback inherits Opus High or Medium within the Flash family', () => {
  assert.equal(fallbackModel(catalog, 'complex', ids.complex.high).id, ids.simple.high);
  assert.equal(fallbackModel(catalog, 'complex', byId(ids.complex.medium)).id, ids.simple.medium);
  assert.equal(fallbackModel(catalog, 'complex', byId(ids.complex.high).model.model).id, ids.simple.high);
  assert.equal(fallbackModel(catalog, 'complex', ids.complex.medium, 'high').id, ids.simple.high);
  assert.equal(fallbackModel(catalog, 'complex', ids.complex.high, 'medium').id, ids.simple.medium);
});

test('an absent or disabled Flash High falls back only to usable Flash Medium', () => {
  const mediumOnly = [byId(ids.simple.medium)];
  assert.equal(fallbackModel(mediumOnly, 'complex', ids.complex.high).id, ids.simple.medium);
  const disabledHigh = catalog.map(model => model.id === ids.simple.high ? { ...model, disabled: true } : model);
  assert.equal(fallbackModel(disabledHigh, 'complex', ids.complex.high).id, ids.simple.medium);
  const noMedium = [byId(ids.simple.high), byId(ids.discussion.medium)];
  assert.equal(fallbackModel(noMedium, 'complex', ids.complex.medium), undefined);
  assert.equal(fallbackModel([byId(ids.discussion.high)], 'complex', ids.complex.high), undefined);
});

test('quota fallback requires the configured task type and current Opus family', () => {
  assert.equal(fallbackModel(catalog, 'simple', ids.complex.high), undefined);
  assert.equal(fallbackModel(catalog, 'discussion', ids.complex.high), undefined);
  assert.equal(fallbackModel(catalog, 'complex', ids.simple.high), undefined);
  assert.equal(fallbackModel(catalog, 'complex', 'claude-opus-5-5-high-unrelated'), undefined);
});

test('invalid effort is rejected and model catalogs are never mutated', () => {
  assert.throws(() => selectModel(catalog, 'simple', undefined, 'maximum'), { code: 'INVALID_EFFORT' });
  assert.throws(() => fallbackModel(catalog, 'complex', ids.complex.high, 'maximum'), { code: 'INVALID_EFFORT' });
  const copied = structuredClone(catalog);
  const before = structuredClone(copied);
  for (const model of copied) { Object.freeze(model.model); Object.freeze(model); }
  Object.freeze(copied);
  selectModel(copied, 'complex', undefined, 'medium');
  fallbackModel(copied, 'complex', ids.complex.high);
  assert.deepEqual(copied, before);
});

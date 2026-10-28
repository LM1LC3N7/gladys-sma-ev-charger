// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, CURRENT, POLL_INTERVAL } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

const allFields = [
  ...manifest.config_schema,
  ...manifest.actions.flatMap((item) => item.fields ?? []),
];

test('the store basics; version 0.1.0 set by hand everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, /^>=5\.1\.0$/);
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-sma-ev-charger');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-sma-ev-charger:${manifest.version}`);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-sma-ev-charger/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['vehicles', 'energy']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+SMA|sans\s+lien\s+avec\s+SMA/i);
    assert.match(
      docs,
      /never\s+tested\s+with\s+a\s+real\s+(?:charger|device)|jamais\s+testé\s+avec\s+un(?:e)?\s+vrai(?:e)?\s+(?:borne|appareil)/i,
      'say it was never tested',
    );
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
  for (const field of allFields.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', `${field.key}: placeholder`);
  }
});

test('the secret: kept by Gladys, never shown again', () => {
  const secrets = manifest.config_schema.filter((f) => f.type === 'secret');
  assert.deepEqual(
    secrets.map((f) => f.key),
    ['password'],
  );
  for (const field of secrets) {
    assert.equal(field.default, undefined, field.key);
    assert.match(field.description.en, /Kept by Gladys in its database, never shown again/);
    assert.match(field.description.fr, /Gardé par Gladys dans sa base, jamais réaffiché/);
  }
});

test('no capture, no sub-container, no scene, no widget', () => {
  assert.equal(manifest.network_discovery, undefined);
  assert.equal(manifest.network_wake, undefined);
  assert.equal(manifest.containers, undefined);
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.widgets, undefined);
});

test('the configuration matches the code; start, mode and current are off by default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    if (fields[key].type !== 'secret') {
      assert.deepEqual(fields[key].default, value, key);
    }
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  assert.equal(fields.allow_commands.type, 'boolean');
  assert.equal(fields.allow_commands.default, false);
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max],
    [POLL_INTERVAL.min, POLL_INTERVAL.max],
  );
  assert.deepEqual([fields.max_current.min, fields.max_current.max], [CURRENT.min, CURRENT.max]);
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(
      section.required ?? section.default ?? section.placeholder,
      undefined,
      section.key,
    );
    assert.ok(!(section.key in DEFAULT_CONFIG), section.key);
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('the actions are the ones the code handles', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
});

test('the version is semver, the SDK is not pinned, no key starts with gladys_', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\.\d+$/);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  for (const field of allFields) {
    assert.doesNotMatch(field.key, /^gladys_/i, field.key);
  }
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
});

test('the user name is required with the password (one alone is refused)', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.equal(fields.username.required, true);
  assert.equal(fields.password.required, true);
});

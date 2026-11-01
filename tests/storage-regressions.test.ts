import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { AppConfig, UnifiedRuleItem } from '../src/types/index.js';

const originalDirectory = process.cwd();
let directory: string;
let storage: typeof import('../src/storage/db.js');

before(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'subone-storage-'));
  process.chdir(directory);
  writeFileSync('config.json', JSON.stringify({ port: 3456 }));
  mkdirSync('templates');
  writeFileSync('templates/rules.json', JSON.stringify([
    { id: 'r-telegram-ip', name: 'Telegram IP', kind: 'remote', type: 'RULE-SET', payload: 'https://rules.invalid/geoip/telegram.yaml', outbound: 'DIRECT', enabled: true },
    { id: 'r-proxy-domain-remote', name: 'Foreign domains', kind: 'remote', type: 'RULE-SET', payload: 'https://rules.invalid/geolocation-!cn.yaml', outbound: 'DIRECT', enabled: true },
  ]));
  storage = await import('../src/storage/db.js');
});

after(() => {
  process.chdir(originalDirectory);
  rmSync(directory, { recursive: true, force: true });
});

function config(rulesList: UnifiedRuleItem[] = []): AppConfig {
  return {
    sources: [],
    rules: [],
    countryRules: [],
    proxyGroups: [],
    rulesList,
    templates: [],
    profiles: [{ id: 'profile', name: 'Test profile', token: 'test-profile-token', enabled: true, nodeFilter: { mode: 'all' } }],
    settings: { port: 3456 },
  };
}

test('a new database starts with default groups and rules', () => {
  const loaded = storage.loadConfig();
  assert.ok(loaded.proxyGroups.length > 0);
  assert.ok(loaded.rulesList.length > 0);
});

test('explicitly cleared groups and rules remain empty after saving and reloading', () => {
  storage.saveConfig(config());
  for (let attempt = 0; attempt < 2; attempt++) {
    const loaded = storage.loadConfig();
    assert.deepEqual(loaded.proxyGroups, []);
    assert.deepEqual(loaded.rulesList, []);
    storage.saveConfig(loaded);
  }
});

test('saved rules preserve their order and content across consecutive reloads', () => {
  const rules: UnifiedRuleItem[] = [
    { id: 'local-a', name: 'First', kind: 'local', type: 'DOMAIN-SUFFIX', payload: 'first.invalid', outbound: 'DIRECT', enabled: true },
    { id: 'remote', name: 'Remote', kind: 'remote', type: 'RULE-SET', payload: 'https://rules.invalid/list.yaml', outbound: 'REJECT', enabled: true },
    { id: 'local-b', name: 'Third', kind: 'local', type: 'DOMAIN-SUFFIX', payload: 'third.invalid', outbound: 'DIRECT', enabled: true },
    { id: 'final', name: 'Final', kind: 'local', type: 'FINAL', payload: '', outbound: 'REJECT', enabled: true },
  ];
  storage.saveConfig(config(rules));
  for (let attempt = 0; attempt < 2; attempt++) {
    const loaded = storage.loadConfig();
    assert.deepEqual(loaded.rulesList, rules);
    storage.saveConfig(loaded);
  }
});

test('existing default rule IDs do not cause deleted companion rules to reappear', () => {
  const rules: UnifiedRuleItem[] = [
    { id: 'r-telegram-remote', name: 'Telegram', kind: 'remote', type: 'RULE-SET', payload: 'https://rules.invalid/telegram.list', outbound: 'DIRECT', enabled: true },
    { id: 'r-cn-domain-remote', name: 'Domestic', kind: 'remote', type: 'RULE-SET', payload: 'https://rules.invalid/domestic.list', outbound: 'DIRECT', enabled: true },
  ];
  storage.saveConfig(config(rules));
  assert.deepEqual(storage.loadConfig().rulesList, rules);
});

test('legacy data missing groups and rules still receives defaults', () => {
  const { proxyGroups, rulesList, ...legacy } = config();
  mkdirSync('data', { recursive: true });
  writeFileSync('data/subone_data.json', JSON.stringify(legacy));
  const loaded = storage.loadConfig();
  assert.ok(loaded.proxyGroups.length > 0);
  assert.ok(loaded.rulesList.length > 0);
});

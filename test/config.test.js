// The configuration (pure): addresses, credentials, bounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: IPv4 or host name, with a port; never broadcast, multicast or 0.0.0.0', () => {
  assert.deepEqual(parseAddress('192.168.1.80'), { host: '192.168.1.80', port: 443 });
  assert.deepEqual(parseAddress('https://evcharger.local:8443/x'), {
    host: 'evcharger.local',
    port: 8443,
  });
  for (const bad of [
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.168.1.255',
    '1.2.3',
    'a b',
    '',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
});

test('credentials: both needed, printable ASCII, the password as typed', () => {
  assert.equal(normalizeConfig({ host: '10.0.0.2', password: 'x' }).auth, undefined);
  assert.equal(normalizeConfig({ host: '10.0.0.2', username: 'u' }).auth, undefined);
  assert.deepEqual(normalizeConfig({ username: ' u ', password: ' p ' }).auth, {
    username: 'u',
    password: ' p ',
  });
  assert.equal(normalizeConfig({ username: 'u', password: 'p\n' }).badSecret, true);
  assert.equal(normalizeConfig({ host: 'u:p@10.0.0.2' }).credentialsInHost, true);
});

test('bounds: ceiling 6-32 A, interval 15-3600 s; only true allows the commands', () => {
  assert.equal(normalizeConfig({ max_current: 99 }).maxCurrent, 32);
  assert.equal(normalizeConfig({ max_current: '' }).maxCurrent, 16);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 15);
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: 'true' }).allowCommands, true);
});

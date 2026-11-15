// Tes statis dukungan self-hosting (Dockerfile, compose, .env.example).
// Cek string polos — tanpa parser YAML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(ROOT, name), 'utf8');

test('Dockerfile memakai base image Node 24 dan menjalankan server', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^FROM node:24/m);
  assert.match(dockerfile, /EXPOSE 3000/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /\/v1\/health/);
  assert.match(dockerfile, /CMD \["node", "src\/server\.js"\]/);
  // File runtime yang wajib disalin (db/ = seed wilayah, public/ = konsol).
  assert.match(dockerfile, /COPY .* db\/ /);
  assert.match(dockerfile, /COPY .* public\/ /);
  assert.match(dockerfile, /COPY .* src\/ /);
});

test('docker-compose.yml mendeklarasikan service + volume data + env key', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /openongkir:/);
  assert.match(compose, /build: \./);
  assert.match(compose, /"3000:3000"/);
  assert.match(compose, /openongkir-data:\/app\/data/);
  assert.match(compose, /OPENONGKIR_API_KEY/);
  assert.match(compose, /restart: unless-stopped/);
});

test('.env.example menyebut variabel env yang benar-benar dibaca server', () => {
  const example = read('.env.example');
  assert.match(example, /^OPENONGKIR_API_KEY=/m);
  assert.match(example, /^OPENONGKIR_DB=/m);
  assert.match(example, /^OPENONGKIR_PORT=/m);
});

test('.dockerignore mengecualikan yang tidak perlu di runtime', () => {
  const ignore = read('.dockerignore');
  assert.match(ignore, /^node_modules\/$/m);
  assert.match(ignore, /^data\/$/m);
  assert.match(ignore, /^\.git\/$/m);
  assert.match(ignore, /^tests\/$/m);
  assert.match(ignore, /^\.env$/m);
  // Seed wilayah + konsol JANGAN dikecualikan.
  assert.doesNotMatch(ignore, /^db\/$/m);
  assert.doesNotMatch(ignore, /^public\/$/m);
});

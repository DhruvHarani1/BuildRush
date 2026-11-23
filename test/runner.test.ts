import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseCmdShim, toSpawnArgs } from '../src/runner.js';
import { tmpProject, rm } from './helpers.js';

const NPM_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  String.raw`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\..\vitest\vitest.mjs" %*`, '',
].join('\r\n');

test('parseCmdShim finds the real JS entry behind an npm .cmd shim', async () => {
  const dir = await tmpProject({ 'node_modules/.bin/vitest.cmd': NPM_SHIM, 'node_modules/vitest/vitest.mjs': '' });
  try {
    const shim = path.join(dir, 'node_modules/.bin/vitest.cmd');
    assert.equal(parseCmdShim(NPM_SHIM, shim), path.join(dir, 'node_modules/vitest/vitest.mjs'));
  } finally { await rm(dir); }
});

test('parseCmdShim handles extensionless targets (e.g. typescript/bin/tsc)', async () => {
  const dir = await tmpProject({ 'node_modules/typescript/bin/tsc': '#!/usr/bin/env node\n' });
  try {
    const shim = path.join(dir, 'node_modules/.bin/tsc.cmd');
    const text = String.raw`IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
)
& "%_prog%"  "%dp0%\..\typescript\bin\tsc" %*`;
    assert.equal(parseCmdShim(text, shim), path.join(dir, 'node_modules/typescript/bin/tsc'));
  } finally { await rm(dir); }
});

test('parseCmdShim returns null for unrecognised shims or missing targets (never guesses)', async () => {
  const dir = await tmpProject({ 'a.cmd': '' });
  try {
    const shim = path.join(dir, 'a.cmd');
    assert.equal(parseCmdShim('@echo hi & calc.exe %*', shim), null);
    assert.equal(parseCmdShim(NPM_SHIM, shim), null, 'target file does not exist');
  } finally { await rm(dir); }
});

test('toSpawnArgs refuses to run unknown .cmd files through a shell on Windows; no-op elsewhere', async (t) => {
  const dir = await tmpProject({ 'evil.cmd': '@echo pwned %*' });
  try {
    const r = toSpawnArgs(path.join(dir, 'evil.cmd'), ['a&calc']);
    if (process.platform === 'win32') assert.ok(r.error, 'must refuse');
    else assert.deepEqual(r.args, ['a&calc']);
  } finally { await rm(dir); }
  void t;
});

#!/usr/bin/env node
// Детерминированная часть разведки CLI: поиск, проба песочницы и чистка профиля.
import { access, chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_AGENTS = resolve(HERE, '../../collab/config/agents.json');
const DEFAULT_CANDIDATES = join(HERE, 'candidates.json');
const GROUPS = ['headless', 'readonly', 'config', 'mcp', 'hooks', 'auth', 'limits'];
const STATUS = new Set(['verified', 'documented', 'not_found']);
const REFUSAL = /read-only|readonly|denied|not permitted|permission|sandbox|refus/i;

const excerpt = (value) => String(value ?? '').slice(0, 500);
const pathAt = (base, key) => (typeof key === 'number' ? `${base}[${key}]` : `${base}.${key}`);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function executable(file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch { return false; }
}

async function findBinary(binary, env = process.env) {
  if (binary.includes('/') || binary.includes('\\')) return (await executable(binary)) ? binary : null;
  for (const directory of (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!directory) continue;
    const candidate = join(directory, binary);
    if (await executable(candidate)) return candidate;
  }
  return null;
}

export async function detect({ binary, agentsFile = DEFAULT_AGENTS, candidatesFile = DEFAULT_CANDIDATES, env = process.env } = {}) {
  const candidatesData = await readJson(candidatesFile);
  const agentsData = await readJson(agentsFile);
  const source = binary === undefined ? candidatesData.candidates : candidatesData.candidates.filter((item) => item.binary === binary);
  const agents = Array.isArray(agentsData.agents) ? agentsData.agents : [];
  return { candidates: await Promise.all(source.map(async (candidate) => {
    const path = await findBinary(candidate.binary, env);
    return {
      binary: candidate.binary, vendor: candidate.vendor, found: Boolean(path), path,
      registered: agents.some((agent) => agent?.id === candidate.binary || agent?.adapter?.binary === candidate.binary),
    };
  })) };
}

export async function sandboxTest({ bin, args, cwd, target = 'probe-write-test.txt', passEnv = [], timeoutMs = 120000, env = process.env } = {}) {
  const prompt = `Create a file named ${target} in the current directory containing the word ok`;
  const home = await mkdtemp(join(tmpdir(), 'vendor-probe-'));
  await chmod(home, 0o700);
  const childEnv = { HOME: home, PATH: env.PATH ?? '' };
  for (const name of passEnv) if (Object.hasOwn(env, name)) childEnv[name] = env[name];
  let stdout = '';
  let stderr = '';
  let exitCode = null;
  let timedOut = false;
  let launchFailed = false;
  try {
    await new Promise((done) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; done(); } };
      let child;
      try {
        child = spawn(bin, args.map((arg) => String(arg).replaceAll('{prompt}', prompt)), {
          cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
        });
      } catch {
        launchFailed = true;
        finish();
        return;
      }
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Number(timeoutMs));
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', () => { launchFailed = true; });
      child.on('close', (code) => { exitCode = code; clearTimeout(timer); finish(); });
    });
    const fileCreated = await exists(join(cwd, target));
    const output = `${stdout}\n${stderr}`;
    const status = fileCreated ? 'failed' : (launchFailed || timedOut) ? 'inconclusive' : (exitCode !== 0 || REFUSAL.test(output)) ? 'verified' : 'inconclusive';
    return { status, file_created: fileCreated, exit_code: exitCode, timed_out: timedOut, stderr_excerpt: excerpt(stderr), stdout_excerpt: excerpt(stdout) };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function resolveRef(schema, root) {
  if (!schema.$ref) return schema;
  const parts = schema.$ref.replace(/^#\//, '').split('/');
  return parts.reduce((value, part) => value?.[part], root) ?? schema;
}

function typeMatches(value, type) {
  if (type === 'object') return value !== null && !Array.isArray(value) && typeof value === 'object';
  if (type === 'array') return Array.isArray(value);
  return typeof value === type;
}

function validate(value, schema, root, at, problems) {
  schema = resolveRef(schema, root);
  for (const branch of schema.allOf ?? []) validate(value, branch, root, at, problems);
  if (schema.type && !typeMatches(value, schema.type)) {
    problems.push({ path: at, message: `ожидается ${schema.type}` });
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push({ path: at, message: `допустимо: ${schema.enum.join(', ')}` });
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push({ path: at, message: `минимальная длина: ${schema.minLength}` });
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) problems.push({ path: at, message: 'не соответствует формату' });
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => validate(item, schema.items, root, pathAt(at, index), problems));
  if (typeMatches(value, 'object')) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) problems.push({ path: pathAt(at, key), message: 'обязательное поле отсутствует' });
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) validate(item, properties[key], root, pathAt(at, key), problems);
      else if (schema.additionalProperties === false) problems.push({ path: pathAt(at, key), message: 'неизвестное поле' });
    }
  }
}

function scanStrings(value, at, problems) {
  if (typeof value === 'string') {
    if (/\b(?:sk|xai)-[^\s]{17,}/i.test(value) || /\bghp_[^\s]+/i.test(value) || /\bAKIA[A-Z0-9]+\b/.test(value) || /-----BEGIN/.test(value) || /\bBearer\s+\S{20,}/i.test(value) || /\b(?:key|token|secret|password)\b[^\n]{0,80}[A-Za-z0-9+/_=-]{32,}/i.test(value)) problems.push({ path: at, message: 'обнаружен секрет' });
    if (/\/(?:Users|home)\/[^/]+\//.test(value)) problems.push({ path: at, message: 'абсолютный домашний путь: замени на ~' });
  } else if (Array.isArray(value)) value.forEach((item, index) => scanStrings(item, pathAt(at, index), problems));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) scanStrings(item, pathAt(at, key), problems);
}

export function checkProfile(profile, schema) {
  const problems = [];
  validate(profile, schema, schema, '$', problems);
  for (const group of GROUPS) {
    const value = profile?.[group];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (STATUS.has(value.status) && value.status !== 'not_found' && (!Object.hasOwn(value, 'evidence') || typeof value.evidence !== 'string' || value.evidence.length === 0)) {
      problems.push({ path: `$.${group}.evidence`, message: 'для verified/documented evidence не может быть пустым' });
    }
  }
  if (profile?.readonly?.status === 'verified' && profile.readonly?.sandbox_test?.status !== 'verified') problems.push({ path: '$.readonly.status', message: 'verified требует verified sandbox_test' });
  scanStrings(profile, '$', problems);
  return { ok: problems.length === 0, problems };
}

function usage() {
  return 'usage: probe.mjs detect [binary] [--agents file] [--candidates file]\n       probe.mjs sandbox-test --bin binary --args-json json --cwd dir [--target file] [--pass-env NAME] [--timeout-ms N]\n       probe.mjs check-profile profile.json [--schema schema.json]';
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  try {
    if (command === 'detect') {
      let binary;
      let agentsFile = DEFAULT_AGENTS;
      let candidatesFile = DEFAULT_CANDIDATES;
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--agents') agentsFile = args[++index] ?? (() => { throw new Error('usage'); })();
        else if (args[index] === '--candidates') candidatesFile = args[++index] ?? (() => { throw new Error('usage'); })();
        else if (!args[index].startsWith('--') && binary === undefined) binary = args[index]; else throw new Error('usage');
      }
      console.log(JSON.stringify(await detect({ binary, agentsFile, candidatesFile })));
      return 0;
    }
    if (command === 'sandbox-test') {
      const values = { passEnv: [] };
      for (let index = 0; index < args.length; index += 1) {
        const flag = args[index];
        if (!['--bin', '--args-json', '--cwd', '--target', '--pass-env', '--timeout-ms'].includes(flag) || index + 1 >= args.length) throw new Error('usage');
        const value = args[++index];
        if (flag === '--bin') values.bin = value;
        else if (flag === '--args-json') values.args = JSON.parse(value);
        else if (flag === '--cwd') values.cwd = value;
        else if (flag === '--target') values.target = value;
        else if (flag === '--pass-env') values.passEnv.push(value);
        else values.timeoutMs = Number(value);
      }
      if (!values.bin || !Array.isArray(values.args) || !values.cwd || !Number.isFinite(values.timeoutMs ?? 120000)) throw new Error('usage');
      const result = await sandboxTest(values);
      console.log(JSON.stringify(result));
      return result.status === 'verified' ? 0 : 1;
    }
    if (command === 'check-profile' && args.length >= 1) {
      const profileFile = args[0];
      let schemaFile = join(HERE, 'profile.schema.json');
      if (args.length === 3 && args[1] === '--schema') schemaFile = args[2];
      else if (args.length !== 1) throw new Error('usage');
      const result = checkProfile(await readJson(profileFile), await readJson(schemaFile));
      console.log(JSON.stringify(result));
      return result.ok ? 0 : 1;
    }
    throw new Error('usage');
  } catch (error) {
    if (error.message !== 'usage') process.stderr.write(`probe.mjs: ${error.message}\n`);
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();

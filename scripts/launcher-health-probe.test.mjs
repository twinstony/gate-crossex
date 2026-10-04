// Regression tests for scripts/launcher.mjs health probes vs GCT_HOST LAN bind.
// Reproduces issue #1: backend binds a LAN IP (GCT_HOST) but the launcher probed
// hardcoded http://127.0.0.1:<port>/health, so `./run doctor` reported
// backend_health=unreachable/not running while the backend was actually serving 200s.
//
// Data authenticity (V5): every "backend" here is a MOCK stub HTTP server — it only
// answers /health with 200 and listens on one address, so a probe against any other
// address gets connection refused. The launcher under test runs as a real child
// process; runtime.json fixtures mirror the schema the launcher itself writes.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

// A non-loopback IPv4 owned by this machine; the stub backend binds ONLY to it so a
// hardcoded 127.0.0.1 probe is provably different from a GCT_HOST-aware probe.
const lanHost = spawnSync('hostname', ['-I'], { encoding: 'utf8' }).stdout?.trim().split(' ')[0];

function stubBackend(host, port) {
  const child = spawn(process.execPath, [
    '-e',
    `
      const server = new (require('node:http')).Server((request, response) => {
        if (request.url.startsWith('/health')) { response.statusCode = 200; response.end('{"status":"ok"}'); }
        else { response.statusCode = 404; response.end(); }
      });
      server.listen({ host: ${JSON.stringify(host)}, port: ${port} }, () => console.log(process.pid));
    `,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  const pidLine = new Promise((resolvePid) => {
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const matched = /(\d+)/.exec(buffered);
      if (matched) resolvePid(Number(matched[1]));
    });
  });
  return { pid: pidLine, stop: () => void child.kill('SIGKILL') };
}

function runDoctor(dataDir, extraEnv) {
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'launcher.mjs'), 'doctor'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GCT_DATA_DIR: dataDir, ...extraEnv },
    },
  );
  const healthLine = (result.stdout ?? '').match(/^backend_health=(.*)$/m);
  return healthLine?.[1] ?? `no backend_health line (${result.stdout})`;
}

async function withLiveBackend(host, port, runtimeBody, dataDirName, run) {
  if (!lanHost && host !== '127.0.0.1') throw new Error('no LAN IP available on this machine');
  const stub = stubBackend(host === 'LAN' ? lanHost : host, port);
  const pid = await stub.pid;
  const dataDir = join(root, `.local-data-test-${dataDirName}`);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'runtime.json'), JSON.stringify({
    schemaVersion: 1,
    launcherPid: null,
    backendPid: pid,
    frontendPid: null,
    ...runtimeBody,
    backendPort: port,
    frontendPort: port,
    startedAt: new Date().toISOString(),
  }));
  try {
    await run(dataDir);

  } finally {
    stub.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('doctor probes the LAN host recorded in runtime.json (issue #1 red case)', async () => {
  const backendHost = lanHost;
  await withLiveBackend('LAN', 17_840, { host: backendHost }, 'lan-runtime', async (dataDir) => {
    assert.equal(runDoctor(dataDir, {}), 'healthy');
  });
});

test('doctor honors GCT_HOST when runtime.json predates the host field', async () => {
  await withLiveBackend('LAN', 17_841, {}, 'lan-env', async (dataDir) => {
    assert.equal(runDoctor(dataDir, { GCT_HOST: lanHost }), 'healthy');
  });
});

test('doctor still reports healthy for the default loopback bind', async () => {
  await withLiveBackend('127.0.0.1', 17_842, {}, 'loopback', async (dataDir) => {
    assert.equal(runDoctor(dataDir, {}), 'healthy');
  });
});

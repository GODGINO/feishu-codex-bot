#!/usr/bin/env node
/**
 * End-to-end smoke test for src/codex/.
 *
 * Spawns codex CLI for real (requires you have run `codex login` already),
 * sets up an isolated CODEX_HOME under /tmp, exercises:
 *   1. writeSessionConfig / writeAgentsMd
 *   2. runCodexTurn (initial turn)
 *   3. runCodexTurn (resume)
 *
 * Run: `npx tsx scripts/test-codex-runner.ts`
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runCodexTurn,
  writeSessionConfig,
  writeAgentsMd,
} from '../src/codex/index.js';

async function main() {
  const testDir = path.join(os.tmpdir(), 'sigma-codex-runner-test');
  const codexHome = path.join(testDir, '.codex');
  console.log(`[test] testDir=${testDir}`);

  // Fresh slate
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(codexHome, { recursive: true });

  // Copy auth.json from user's default codex home
  const sourceAuth = path.join(os.homedir(), '.codex', 'auth.json');
  if (!fs.existsSync(sourceAuth)) {
    console.error('[test] ~/.codex/auth.json missing — run `codex login` first');
    process.exit(1);
  }
  fs.copyFileSync(sourceAuth, path.join(codexHome, 'auth.json'));
  fs.chmodSync(path.join(codexHome, 'auth.json'), 0o600);

  // Write per-session config + agents.md
  writeSessionConfig(codexHome, {
    sessionDir: testDir,
    model: 'gpt-5.5',
  });
  writeAgentsMd(
    codexHome,
    `You are the Sigma runner test agent. Always prefix replies with [runner-test].`,
  );
  console.log('[test] config written');

  // Turn 1
  console.log('\n[test] === Turn 1: initial prompt ===');
  const r1 = await runCodexTurn('reply with exactly 3 words', {
    codexHome,
    cwd: testDir,
    model: 'gpt-5.5',
  }, {
    onThreadStarted: (id) => console.log(`  [event] thread.started: ${id}`),
    onProgress: (text, kind) => console.log(`  [event] progress (${kind}): ${text.slice(0, 60)}`),
    onAssistantCompleted: (text) => console.log(`  [event] assistant.completed: ${text}`),
    onUsage: (u) => console.log(`  [event] usage: in=${u.inputTokens} cached=${u.cachedInputTokens} out=${u.outputTokens} reasoning=${u.reasoningOutputTokens}`),
    onError: (err) => console.error(`  [event] error: ${err}`),
  });

  console.log('\n[test] turn 1 result:');
  console.log(`  fullText  : ${r1.fullText}`);
  console.log(`  threadId  : ${r1.threadId}`);
  console.log(`  model     : ${r1.model}`);
  console.log(`  usage     : ${JSON.stringify(r1.usage)}`);
  if (r1.error) console.log(`  error     : ${r1.error}`);

  if (r1.error || !r1.threadId) {
    console.error('\n[test] FAIL — turn 1 did not produce a thread_id or returned an error');
    process.exit(1);
  }

  // Turn 2 — resume
  console.log('\n[test] === Turn 2: resume same thread ===');
  const r2 = await runCodexTurn('what was my first message? quote it', {
    codexHome,
    cwd: testDir,
    model: 'gpt-5.5',
    resumeThreadId: r1.threadId,
  }, {
    onAssistantCompleted: (text) => console.log(`  [event] assistant.completed: ${text}`),
    onUsage: (u) => console.log(`  [event] usage: in=${u.inputTokens} cached=${u.cachedInputTokens} out=${u.outputTokens}`),
  });

  console.log('\n[test] turn 2 result:');
  console.log(`  fullText  : ${r2.fullText}`);
  console.log(`  threadId  : ${r2.threadId}`);
  console.log(`  usage     : ${JSON.stringify(r2.usage)}`);
  if (r2.error) console.log(`  error     : ${r2.error}`);

  if (r2.threadId !== r1.threadId) {
    console.error('\n[test] FAIL — resume produced a different threadId');
    process.exit(1);
  }
  if (!r2.fullText.toLowerCase().includes('3 words') && !r2.fullText.includes('three words') && !r2.fullText.includes('exactly')) {
    console.warn('\n[test] WARN — resume reply does not seem to reference the first message; check manually');
  }

  // Confirm rollout JSONL was written
  const sessionsDir = path.join(codexHome, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    const yearDirs = fs.readdirSync(sessionsDir).filter((d) => /^\d{4}$/.test(d));
    let rolloutCount = 0;
    for (const yd of yearDirs) {
      const monthDirs = fs.readdirSync(path.join(sessionsDir, yd));
      for (const md of monthDirs) {
        const inner = fs.readdirSync(path.join(sessionsDir, yd, md));
        for (const f of inner) {
          if (f.endsWith('.jsonl')) rolloutCount++;
        }
      }
    }
    console.log(`\n[test] rollouts: found ${rolloutCount} jsonl file(s) under ${sessionsDir}`);
  } else {
    console.warn(`\n[test] WARN — ${sessionsDir} not created (rollouts disabled?)`);
  }

  console.log('\n[test] ✅ PASS');
}

main().catch((err) => {
  console.error('[test] crashed:', err);
  process.exit(1);
});

// POO-113 公开基准（Mind2Web）快层测评 runner：支持 deepseek / flashx 双 provider
// 用法：PROVIDER=deepseek DEEPSEEK_API_KEY=... node run-bench.mjs
//      PROVIDER=flashx  BIGMODEL_API_KEY=... node run-bench.mjs
// 输出：results/bench-<provider>-raw.json（断点续跑 + 429 退避）
import { readFileSync, writeFileSync } from 'node:fs';

const PROVIDER = process.env.PROVIDER;
const CFG = {
  deepseek: {
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-flash',
    keyEnv: 'DEEPSEEK_API_KEY',
    extra: { thinking: { type: 'disabled' }, temperature: 0.8 },
    concurrency: 6,
  },
  flashx: {
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-5.3-flashx',
    keyEnv: 'BIGMODEL_API_KEY',
    extra: { reasoning_effort: 'low', temperature: 0.8 },
    concurrency: 2,
  },
}[PROVIDER];
if (!CFG) throw new Error('PROVIDER must be deepseek|flashx');
const KEY = process.env[CFG.keyEnv];
if (!KEY) throw new Error(`missing ${CFG.keyEnv}`);

const SYSTEM = `你是浏览器自动化系统中的快速决策器。根据页面快照与任务，输出下一步动作命令。

规则：
- 只输出一条命令，禁止解释、禁止多行、禁止 markdown。
- 命令格式（动词枚举固定）：click @eN | fill @eN 值 | select @eN 值 | upload @eN 绝对路径 | scroll down|up 像素 | key 键名 | navigate URL | done | fail: 原因
- @eN 必须来自快照实际存在的引用。
- 任务目标在当前页面已达成 → 输出 done。
- 快照信息不足以决策 → 输出 fail: <原因>。`;

const userPrompt = (c) =>
  `## 页面快照\n${c.snapshot}\n\n## 任务\n${c.task}\n\n## 已执行动作\n${c.history.join('；')}\n\n## 下一步命令`;

async function callOnce(caseId, sampleIdx) {
  const c = cases.find((x) => x.id === caseId);
  for (let attempt = 1; attempt <= 6; attempt++) {
    const t0 = Date.now();
    try {
      const resp = await fetch(CFG.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: CFG.model,
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt(c) }],
          max_tokens: 256, ...CFG.extra,
        }),
      });
      const latencyMs = Date.now() - t0;
      const data = await resp.json().catch(() => null);
      const err = data?.error ? JSON.stringify(data.error) : (resp.status >= 400 ? `http ${resp.status}` : null);
      if (resp.status === 429 && attempt < 6) { await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1))); continue; }
      return { caseId, sample: sampleIdx, http: resp.status, latencyMs,
        content: data?.choices?.[0]?.message?.content ?? null, usage: data?.usage ?? null, error: err };
    } catch (e) {
      if (attempt < 6) { await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1))); continue; }
      return { caseId, sample: sampleIdx, http: 0, latencyMs: Date.now() - t0, content: null, usage: null, error: String(e).slice(0, 200) };
    }
  }
}

const CASES_FILE = process.env.CASES || '../bench-m2w.jsonl';
const cases = readFileSync(new URL(CASES_FILE, import.meta.url), 'utf-8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const OUT = new URL(`./results/bench-${PROVIDER}${process.env.CASES ? '-ground' : ''}-raw.json`, import.meta.url);
let existing = [];
try { existing = JSON.parse(readFileSync(OUT, 'utf-8')); } catch {}
const done = new Set(existing.filter((r) => !r.error).map((r) => `${r.caseId}#${r.sample}`));

const jobs = [];
for (const c of cases) if (!done.has(`${c.id}#1`)) jobs.push(callOnce(c.id, 1));
const results = [...existing.filter((r) => !r.error)];
for (let i = 0; i < jobs.length; i += CFG.concurrency) {
  results.push(...(await Promise.all(jobs.slice(i, i + CFG.concurrency))));
  process.stderr.write(`progress ${Math.min(i + CFG.concurrency, jobs.length)}/${jobs.length}\n`);
  if (PROVIDER === 'flashx') await new Promise((r) => setTimeout(r, 400));
}
writeFileSync(OUT, JSON.stringify(results, null, 1));
const lat = results.filter((r) => !r.error).map((r) => r.latencyMs).sort((a, b) => a - b);
console.log(JSON.stringify({ provider: PROVIDER, total: results.length, errors: results.filter((r) => r.error).length,
  latencyMs: { p50: lat[Math.floor(lat.length / 2)], p90: lat[Math.floor(lat.length * 0.9)], max: lat.at(-1) } }));

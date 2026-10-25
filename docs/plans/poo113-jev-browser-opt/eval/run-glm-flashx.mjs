// POO-113 快层测评 B 路直连：glm-5.3-flashx（reasoning_effort=low）双路采样
// 用法：BIGMODEL_API_KEY=<zhipu key> node run-glm-flashx.mjs
// 输出：results/glm-flashx-raw.json（每案例两个样本：原始输出、延迟、token 用量）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const KEY = process.env.BIGMODEL_API_KEY;
if (!KEY) throw new Error('missing BIGMODEL_API_KEY');
const ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = 'glm-5.3-flashx';
const SAMPLES = 2;
const CONCURRENCY = 2;

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
  const RETRIES = 6;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const t0 = Date.now();
    try {
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: userPrompt(c) },
          ],
          reasoning_effort: 'low',
          temperature: 0.8,
          max_tokens: 256,
        }),
      });
      const latencyMs = Date.now() - t0;
      const http = resp.status;
      const data = await resp.json().catch(() => null);
      const err = data?.error ? JSON.stringify(data.error) : (http >= 400 ? `http ${http}` : null);
      if (http === 429 && attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      return {
        caseId, sample: sampleIdx, http, latencyMs,
        content: data?.choices?.[0]?.message?.content ?? null,
        reasoning: data?.choices?.[0]?.message?.reasoning_content ?? null,
        usage: data?.usage ?? null,
        error: err,
      };
    } catch (e) {
      if (attempt < RETRIES) { await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1))); continue; }
      return { caseId, sample: sampleIdx, http: 0, latencyMs: Date.now() - t0, content: null, usage: null, error: String(e).slice(0, 200) };
    }
  }
}

const cases = readFileSync(new URL('../testcases.jsonl', import.meta.url), 'utf-8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

// 断点续跑：已有成功样本直接沿用，只补失败/缺失的
let existing = [];
try { existing = JSON.parse(readFileSync(new URL('./results/glm-flashx-raw.json', import.meta.url), 'utf-8')); } catch {}
const done = new Set(existing.filter((r) => !r.error).map((r) => `${r.caseId}#${r.sample}`));

const jobs = [];
for (const c of cases) for (let s = 1; s <= SAMPLES; s++) if (!done.has(`${c.id}#${s}`)) jobs.push(callOnce(c.id, s));
const results = [...existing.filter((r) => !r.error)];
for (let i = 0; i < jobs.length; i += CONCURRENCY) {
  results.push(...(await Promise.all(jobs.slice(i, i + CONCURRENCY))));
  process.stderr.write(`progress ${Math.min(i + CONCURRENCY, jobs.length)}/${jobs.length}\n`);
  await new Promise((r) => setTimeout(r, 500));
}

mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/glm-flashx-raw.json', import.meta.url), JSON.stringify(results, null, 1));
const errN = results.filter((r) => r.error).length;
const lat = results.filter((r) => !r.error).map((r) => r.latencyMs).sort((a, b) => a - b);
const p = (q) => lat[Math.floor(lat.length * q)] ?? null;
console.log(JSON.stringify({ total: results.length, errors: errN, latencyMs: { p50: p(0.5), p90: p(0.9), max: lat.at(-1) } }, null, 1));

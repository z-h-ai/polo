#!/usr/bin/env python3
"""公开基准（Mind2Web）快层测评评分器。

判分口径（比内部集更宽容、贴合 M2W 标注习惯）：
- exact：动词正确 + 所选 @eN 映射到任一正候选（pos_candidates 的 backend_node_id）
  + fill/select 的 value 归一化相等（大小写/空白不敏感）
- partial：动词+元素对但 value 有差（0.5）；元素错但动词对（0.3）；拒绝/停手但应有动作（0）
用法：python3 bench-score.py results/bench-<provider>-raw.json > results/bench-<provider>-scored.json
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from score import parse, norm  # 复用主评分器的解析器

def value_norm(s):
    return re.sub(r'\s+', ' ', (s or '')).strip().lower()

def score_case(case, content):
    out = {'raw': content, 'norm': norm(content), 'format_ok': False, 'exact': False, 'partial': 0.0, 'detail': '', 'verb': None, 'ref': None}
    p = parse(content)
    if p is None:
        out['detail'] = 'unparseable'
        return out
    verb, ref, args = p
    out['verb'], out['ref'] = verb, ref
    refs_in_snapshot = set(case['meta']['ref_map'])
    out['format_ok'] = ref is None or ref in refs_in_snapshot
    pos_ids = set(case['meta']['pos_ids'])
    want_verb, want_value = case['meta']['verb'], case['meta']['value']
    if verb in ('fail', 'done'):
        out['detail'] = 'refused/stopped but action expected'
        return out
    if verb != want_verb:
        out['detail'] = f'verb mismatch: {verb} vs {want_verb}'
        return out
    if ref not in refs_in_snapshot:
        out['detail'] = 'ref not in snapshot'
        return out
    hit_pos = case['meta']['ref_map'].get(ref) in pos_ids
    if not hit_pos:
        out['partial'] = 0.3
        out['detail'] = 'verb ok, wrong element'
        return out
    if want_verb == 'click':
        out['exact'] = True; out['partial'] = 1.0
        return out
    got = ' '.join(str(a) for a in args)
    if value_norm(got) == value_norm(want_value):
        out['exact'] = True; out['partial'] = 1.0
    else:
        out['partial'] = 0.5
        out['detail'] = f'value diff: {got!r} vs {want_value!r}'
    return out

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    cases = {c['id']: c for c in (json.loads(l) for l in open(os.path.join(os.path.dirname(here), 'bench-m2w.jsonl'), encoding='utf-8') if l.strip())}
    scored = []
    for path in sys.argv[1:]:
        raws = json.load(open(path, encoding='utf-8'))
        provider = os.path.basename(path).replace('bench-', '').replace('-raw.json', '')
        for r in raws:
            c = cases[r['caseId']]
            s = score_case(c, r.get('content'))
            s.update(caseId=r['caseId'], provider=provider, sample=r.get('sample'), latencyMs=r.get('latencyMs'), usage=r.get('usage'))
            scored.append(s)
    json.dump(scored, sys.stdout, ensure_ascii=False, indent=1)
    print()

if __name__ == '__main__':
    main()

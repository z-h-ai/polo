#!/usr/bin/env python3
"""POO-113 测评评分器：对快层原始输出打分并汇总。

用法：python3 score.py results/deepseek-raw.json ... > results/scored.json
输入：一个或多个原始结果 JSON（数组，含 caseId/sample/content/latencyMs/usage）
输出：每样本打分明细 + 每案例聚合 + 总体统计（stdout JSON）
"""
import json, os, re, sys

VERBS = {'click', 'fill', 'select', 'scroll', 'key', 'navigate', 'done', 'upload', 'type', 'paste', 'wait'}

def norm(cmd):
    if not cmd: return None
    s = cmd.strip().strip('`').strip()
    s = re.sub(r'^```[a-z]*\s*|\s*```$', '', s, flags=re.M).strip()
    s = re.sub(r'\s+', ' ', s)
    return s or None

def parse(cmd):
    """返回 (verb, ref, args)；解析失败返回 None"""
    s = norm(cmd)
    if not s: return None
    if s == 'done': return ('done', None, [])
    if s.startswith('fail:') or s.startswith('fail ：') or s.startswith('fail:'):
        return ('fail', None, [s[5:].strip()])
    m = re.match(r'^(click|fill|select|upload|scroll|key|navigate|type)\s+(.*)$', s)
    if not m: return None
    verb, rest = m.group(1), m.group(2).strip()
    ref = None
    mref = re.match(r'^(@?e\d+)\s*(.*)$', rest, re.I)
    if mref and verb in {'click', 'fill', 'select', 'upload'}:
        ref = '@e' + re.sub(r'@?e', '', mref.group(1), flags=re.I).zfill(0)
        ref = mref.group(1).lower()
        if not ref.startswith('@'): ref = '@' + ref
        rest = mref.group(2).strip()
    if verb == 'scroll':
        m2 = re.match(r'^(down|up)\s+(\d+)$', rest, re.I)
        if not m2: return None
        return ('scroll', None, [m2.group(1).lower(), int(m2.group(2))])
    if verb == 'key':
        if not rest: return None
        return ('key', None, [rest])
    if verb == 'navigate':
        return ('navigate', None, [rest]) if rest else None
    return (verb, ref, [rest] if rest else [])

def score(case, content):
    """返回 dict: exact(bool), partial(float 0-0.99), format_ok(bool), parsed, detail"""
    out = {'raw': content, 'norm': norm(content), 'parsed': None, 'format_ok': False, 'exact': False, 'partial': 0.0, 'detail': ''}
    p = parse(content)
    out['parsed'] = list(p) if p else None
    if p is None:
        out['detail'] = 'unparseable'
        return out
    verb, ref, args = p
    # 格式合规：动词合法 + （如带 ref）ref 存在于快照 + 参数齐全
    refs_in_snapshot = set(re.findall(r'@\w+\d+', case['snapshot']))
    format_ok = verb in VERBS or verb == 'fail'
    if ref is not None:
        format_ok = format_ok and ref in refs_in_snapshot
    if verb in {'fill', 'select', 'navigate', 'upload', 'key'} and verb != 'fail':
        format_ok = format_ok and len(args) > 0 and args[0] != ''
    out['format_ok'] = format_ok

    exp = case['expected']
    ep = parse(exp)
    everb, eref, eargs = ep

    def verb_ref_ok():
        return verb == everb and (ref == eref or (ref is None and eref is None))

    if everb == 'fail':
        out['exact'] = verb == 'fail'
        out['partial'] = 1.0 if out['exact'] else 0.0
        out['detail'] = 'fail-refusal' if out['exact'] else f'expected refusal, got {verb}'
        return out
    if verb == 'fail':
        out['detail'] = 'refused but action expected'
        return out
    if everb == 'done':
        out['exact'] = verb == 'done'
        out['partial'] = 1.0 if out['exact'] else 0.0
        return out
    if verb == 'done':
        out['detail'] = 'stopped but action expected'
        return out
    if everb == 'scroll':
        if verb != 'scroll':
            out['detail'] = f'wrong verb {verb}'
            return out
        d, px = args[0], args[1] if len(args) > 1 else 0
        if d == eargs[0]:
            if isinstance(px, int) and 400 <= px <= 1500:
                out['exact'] = True; out['partial'] = 1.0
            else:
                out['partial'] = 0.6; out['detail'] = f'direction ok, px={px}'
        return out
    if not verb_ref_ok():
        # 动作对但元素错 → 小分；动词都不对 → 0；语义近动词组（fill/upload）给一半
        close = {('fill', 'upload'), ('upload', 'fill')}
        if verb == everb: out['partial'] = 0.3
        elif (verb, everb) in close: out['partial'] = 0.5
        else: out['partial'] = 0.0
        out['detail'] = f'verb/ref mismatch: got {verb} {ref}, want {everb} {eref}'
        return out
    # 动作+元素都对：无参数动词（click）即全对
    if everb == 'click':
        out['exact'] = True; out['partial'] = 1.0
        return out
    # 动作+元素都对，比较参数
    if everb == 'key':
        out['exact'] = (args[0].lower() == eargs[0].lower()); out['partial'] = 1.0 if out['exact'] else 0.5
    elif everb in {'fill', 'select', 'upload', 'navigate'}:
        got = ' '.join(str(a) for a in args)
        want = ' '.join(str(a) for a in eargs)
        if got == want:
            out['exact'] = True; out['partial'] = 1.0
        elif want.lower().startswith(got.lower()) or got.lower().startswith(want.lower()):
            out['partial'] = 0.7; out['detail'] = f'args close: {got!r} vs {want!r}'
        else:
            out['partial'] = 0.5; out['detail'] = f'args diff: {got!r} vs {want!r}'
        # H08: 不带断言给 0.7
        if everb == 'select' and case['id'] == 'H08' and not out['exact'] and got.strip() == 'CNAME':
            out['partial'] = 0.7; out['detail'] = 'select ok, missing --assert-text'
    return out

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    tc_path = os.path.join(os.path.dirname(here), 'testcases.jsonl')
    cases = {c['id']: c for c in (json.loads(l) for l in open(tc_path, encoding='utf-8') if l.strip())}
    raws = []
    for path in sys.argv[1:]:
        raws.extend(json.load(open(path, encoding='utf-8')))
    scored = []
    for r in raws:
        c = cases[r['caseId']]
        s = score(c, r.get('content'))
        s.update(caseId=r['caseId'], sample=r.get('sample'), latencyMs=r.get('latencyMs'), usage=r.get('usage'))
        scored.append(s)
    json.dump(scored, sys.stdout, ensure_ascii=False, indent=1)
    print()

if __name__ == '__main__':
    main()

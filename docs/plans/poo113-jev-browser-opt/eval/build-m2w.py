#!/usr/bin/env python3
"""从 Mind2Web (osunlp/Mind2Web) 构建快层测评案例集。

数据源：
  /tmp/m2w/row-*.json      HF datasets-server 拉取的行（每行=一个任务轨迹）
  /tmp/m2w/train_10.json   仓库分片（同样按任务记录），按 annotation_id 去重合并
每任务抽取最多 2 个相距较远的决策步（首/尾有效步），构建 polo snapshot 风格案例：
  cleaned_html 解析 backend_node_id -> (tag, 可读名称)；pos/neg 候选组成 @eN 菜单
  （cap 70 个，须含全部正候选；过滤结构标签）；ground truth = 该步 operation。
输出：bench-m2w.jsonl（meta.task_id 保留任务分组，供聚类感知统计）
"""
import json, os, random, re, glob
from bs4 import BeautifulSoup

ROW_DIR = '/tmp/m2w'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'bench-m2w.jsonl')
MAX_ELEMENTS = 70
STEPS_PER_TASK = 2
rng = random.Random(20261022)

ROLE = {'a': 'link', 'button': 'button', 'input': 'textbox', 'select': 'combobox',
        'textarea': 'textbox', 'img': 'image', 'svg': 'graphic', 'option': 'option',
        'h1': 'heading', 'h2': 'heading', 'h3': 'heading', 'h4': 'heading', 'h5': 'heading', 'h6': 'heading'}
SKIP_TAGS = {'html', 'body', 'head', 'script', 'style', 'noscript', 'template', 'iframe', 'path', 'g'}

def norm_text(s, n=64):
    s = re.sub(r'\s+', ' ', s or '').strip()
    return s[:n]

def parse_step_html(html):
    soup = BeautifulSoup(html or '', 'html.parser')
    out = {}
    for el in soup.find_all(True):
        bid = el.get('backend_node_id')
        if not bid:
            continue
        tag = (el.name or '').lower()
        name = norm_text(el.get('aria-label') or el.get('placeholder') or el.get('title')
                         or el.get('name') or el.get('alt') or '')
        if not name:
            name = norm_text(el.get_text(' ', strip=True))
        if not name and el.get('value'):
            name = norm_text(str(el.get('value')))
        if not name:
            name = norm_text(el.get('id') or '')
        out[str(bid)] = (tag, name)
    return out

def build_step_cases(row, task_tag):
    """一个任务 -> 最多 2 个案例（首/尾有效步）"""
    website = row['website']
    task = norm_text(row['confirmed_task'], 160)
    actions = row['actions']
    reprs = row.get('action_reprs') or []
    valid = [i for i, a in enumerate(actions)
             if a['operation']['op'] in ('CLICK', 'TYPE', 'SELECT')
             and a.get('pos_candidates')
             and (a['operation']['op'] == 'CLICK' or str(a['operation'].get('value') or '').strip())]
    if not valid:
        return []
    picks = [valid[0]] if len(valid) == 1 else [valid[0], valid[-1]]
    cases = []
    for pick in picks:
        act = actions[pick]
        op = act['operation']['op']
        value = str(act['operation'].get('value') or '').strip()
        pos_ids = [str(c['backend_node_id']) for c in act['pos_candidates']]
        elmap = parse_step_html(act['cleaned_html'])
        cands = act['pos_candidates'] + act['neg_candidates']
        entries = []
        for c in cands:
            bid = str(c['backend_node_id'])
            if bid not in elmap:
                continue
            tag, name = elmap[bid]
            if not name or tag in SKIP_TAGS:
                continue
            entries.append((int(bid), tag, name, bid))
        entries.sort(key=lambda e: e[0])
        entries = entries[:MAX_ELEMENTS]
        kept_ids = {e[3] for e in entries}
        if not all(p in kept_ids for p in pos_ids):
            continue
        ref_of = {e[3]: f'@e{i+1}' for i, e in enumerate(entries)}
        lines = [f'  {ref_of[e[3]]} [{ROLE.get(e[1], e[1] or "generic")}] "{e[2]}"' for e in entries]
        verb = {'CLICK': 'click', 'TYPE': 'fill', 'SELECT': 'select'}[op]
        gt_ref = ref_of[pos_ids[0]]
        expected = f'{verb} {gt_ref} {value}'.strip() if verb in ('fill', 'select') else f'{verb} {gt_ref}'
        history = reprs[:pick][-3:] or ['（空）']
        snapshot = (
            f'URL: (static trace: {website})\n'
            f'Title: {row.get("domain", website)} - Mind2Web 真实站点轨迹\n'
            f'Elements: {len(entries)}\nFocused ref: none, disabled: 0\n\n'
            f'Elements ({len(entries)}):\n' + '\n'.join(lines)
        )
        cases.append({
            'tier': 'bench', 'scene': f'{website}/{row.get("subdomain", "") or row.get("domain", "")}',
            'task': task, 'history': history, 'snapshot': snapshot, 'expected': expected,
            'meta': {'pos_ids': pos_ids, 'verb': verb, 'value': value, 'step': pick,
                     'n_steps': len(actions), 'task_id': str(row.get('annotation_id', task_tag)),
                     'this_repr': (reprs[pick] if pick < len(reprs) else ''),
                     'ref_map': {f'@e{i+1}': e[3] for i, e in enumerate(entries)}},
        })
    return cases

def load_rows():
    rows, seen = [], set()
    for path in sorted(glob.glob(os.path.join(ROW_DIR, 'row-*.json')), key=lambda p: int(re.search(r'row-(\d+)', p).group(1))):
        try:
            rows.append(('api', json.load(open(path, encoding='utf-8'))['rows'][0]['row']))
        except Exception:
            continue
    try:
        for rec in json.load(open(os.path.join(ROW_DIR, 'train_10.json'), encoding='utf-8')):
            rows.append(('shard', rec))
    except Exception:
        pass
    out = []
    for tag, r in rows:
        aid = str(r.get('annotation_id', ''))
        if aid and aid in seen:
            continue
        if aid:
            seen.add(aid)
        out.append((tag, r))
    return out

def main():
    cases = []
    for i, (tag, row) in enumerate(load_rows()):
        cases.extend(build_step_cases(row, f'{tag}-{i}'))
    for i, c in enumerate(cases):
        c['id'] = f'M{i+1:03d}'
    with open(OUT, 'w', encoding='utf-8') as f:
        for c in cases:
            f.write(json.dumps(c, ensure_ascii=False) + '\n')
    from collections import Counter
    tasks = {c['meta']['task_id'] for c in cases}
    print(f'built {len(cases)} cases from {len(tasks)} tasks')
    print('verbs:', dict(Counter(c["meta"]["verb"] for c in cases)))
    print('top websites:', dict(Counter(c["scene"].split("/")[0] for c in cases).most_common(8)))
    sizes = sorted(c['snapshot'].count('\n') for c in cases)
    print('snapshot lines: min %d / median %d / max %d' % (sizes[0], sizes[len(sizes)//2], sizes[-1]))

if __name__ == '__main__':
    main()

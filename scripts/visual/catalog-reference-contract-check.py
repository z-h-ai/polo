#!/usr/bin/env python3
"""POO-43 deterministic Catalog reference/contract conformance check (R44).

Validates the repository-owned two-source Catalog visual reference and its
binding contract against the six R43 review flags and the authoritative
human oracle, without touching frozen artifacts:

- reference: explicit scene app-catalog; TWO 商务写作 rows (桥见圈子 v1.6.0 /
  北极星共创社 v2.0.0 — authoritative source names, no invented creators);
  count 显示 2 / 7 个 Apps; no highlighted row; homologous .catalog-view
  container carrying subhead + search + section.
- contract: tablet 1024x768 REQUIRED; homologous region pair all-apps-view ↔
  .catalog-view; NO waived in-region differences; explicit ?scene=app-catalog
  navigation with fail-closed scene resolution; no invented creators.

Exit 0 when every check passes; exit 1 with the failing flags otherwise.
"""
import re
import sys

REF = '.agents/skills/polo-client-design/assets/design-context/references/app-catalog-two-source-light-zh-Hans-desktop.html'
CONTRACT = '.agents/skills/polo-client-design/assets/design-context/references/app-catalog-two-source.contract.md'


def main():
    ref = open(REF, encoding='utf-8').read()
    contract = open(CONTRACT, encoding='utf-8').read()
    failures = []

    # Reference markup (strip the inlined CSS block first so style-text never
    # satisfies markup checks).
    markup = re.sub(r'<style>.*?</style>', '', ref, flags=re.S)
    if 'data-scene="app-catalog"' not in ref:
        failures.append('reference: explicit app-catalog scene marker missing')
    if markup.count('商务写作') < 4:  # two rows × (h3 + pill context)
        failures.append('reference: expected two 商务写作 rows')
    if '来自 桥见圈子' not in markup or '来自 北极星共创社' not in markup:
        failures.append('reference: source pills must be 来自 桥见圈子 / 来自 北极星共创社')
    if '桥见圈子 · v1.6.0' not in markup or '北极星共创社 · v2.0.0' not in markup:
        failures.append('reference: source lines must use the authoritative circle names with versions')
    if '创作室' in markup:
        failures.append('reference: invented creator-studio names present')

    # Both available rows must carry the ordered unpinned action pair
    # (显示在首页 ghost, then primary 打开) and the 可用 status — parsed per
    # row article in DOM order.
    articles = re.findall(r'<article class="card catalog-card">.*?</article>', markup, flags=re.S)
    commercial_rows = [a for a in articles if '<h3>商务写作</h3>' in a]
    if len(commercial_rows) != 2:
        failures.append(f'reference: expected exactly two 商务写作 rows, got {len(commercial_rows)}')
    else:
        for index, article in enumerate(commercial_rows):
            actions = re.findall(r'<button class="button ([a-z]+)"[^>]*>([^<]+)</button>', article)
            ordered = [(cls, label.strip()) for cls, label in actions]
            expected = [('ghost', '显示在首页'), ('primary', '打开')]
            if ordered != expected:
                failures.append(
                    f'商务写作 row {index + 1}: ordered actions must be '
                    f'显示在首页(ghost) then 打开(primary), got {ordered}')
            if '<p class="status">可用</p>' not in article:
                failures.append(f'商务写作 row {index + 1}: 可用 status line missing')
    if re.search(r'catalog-card[^"]*highlighted|highlighted[^"]*catalog-card', markup):
        failures.append('reference: highlighted row must not exist in the searched state')
    if '显示 2 / 7 个 Apps' not in markup:
        failures.append('reference: visible count must be 显示 2 / 7 个 Apps')
    for cls in ('subhead', 'search', 'section'):
        if f'class="{cls}"' not in markup and f"class='{cls}'" not in markup:
            failures.append(f'reference: .{cls} missing from the homologous container')
    if 'class="catalog-view"' not in markup:
        failures.append('reference: .catalog-view homologous container missing')

    # Contract: REQUIRED tablet, homologous pairing, no waivers, explicit scene.
    if '1024x768 tablet — both REQUIRED' not in contract:
        failures.append('contract: tablet viewport must be REQUIRED')
    if '[data-testid=all-apps-view]' not in contract or '.catalog-view' not in contract:
        failures.append('contract: homologous all-apps-view ↔ .catalog-view pairing missing')
    if 'subhead + search + section' not in contract:
        failures.append('contract: homologous content description missing')
    if re.search(r'waive|waived|waiver', contract, flags=re.I):
        failures.append('contract: in-region differences must not be waived')
    if 'invented' in contract and 'no invented' not in contract:
        failures.append('contract: invented-fact language present')
    if '?scene=app-catalog' not in contract:
        failures.append('contract: explicit ?scene=app-catalog navigation missing')
    if 'FAIL CLOSED' not in contract.upper():
        failures.append('contract: fail-closed scene resolution missing')
    if '显示 2 / 7 个 Apps' not in contract:
        failures.append('contract: exact oracle count missing')
    if '0.02' not in contract:
        failures.append('contract: unchanged 0.02 threshold missing')

    if failures:
        print('FAILURES:')
        for f in failures:
            print(' -', f)
        sys.exit(1)
    print('catalog reference contract: all checks passed '
          '(tablet required, homologous .catalog-view pairing, no waivers, '
          'authoritative sources, no highlighted row, scene binding explicit)')


if __name__ == '__main__':
    main()

/** Journey #9 — the shared space-avatar glyph. One implementation for the
 * switcher menu and the select screen: personal spaces resolve to a localized
 * glyph key (never a hardcoded CJK character), named enterprise spaces show
 * the first letter uppercased, and the unnamed fallback is deterministic
 * (the localized enterprise glyph, never a guessed letter). */
import { describe, expect, it } from 'bun:test'
import { productSpaceAvatarGlyph } from '../space-initial'

describe('productSpaceAvatarGlyph(journey #9)', () => {
  it('个人空间:返回本地化字形 key,不再硬编码「我」', () => {
    expect(productSpaceAvatarGlyph('Anything', 'personal')).toEqual({
      kind: 'localized',
      key: 'productSpace.avatar.personal',
    })
  })

  it('企业有名空间:取名称首字母并大写', () => {
    expect(productSpaceAvatarGlyph('acme corp', 'enterprise')).toEqual({ kind: 'letter', letter: 'A' })
    expect(productSpaceAvatarGlyph('Zeta', 'enterprise')).toEqual({ kind: 'letter', letter: 'Z' })
  })

  it('企业无名空间(空串/纯空白):确定回退到本地化企业字形,不猜字母', () => {
    expect(productSpaceAvatarGlyph('', 'enterprise')).toEqual({
      kind: 'localized',
      key: 'productSpace.avatar.enterprise',
    })
    expect(productSpaceAvatarGlyph('   ', 'enterprise')).toEqual({
      kind: 'localized',
      key: 'productSpace.avatar.enterprise',
    })
  })

  it('名称只含空白+字母时先 trim 再取首字母', () => {
    expect(productSpaceAvatarGlyph('  beta  ', 'enterprise')).toEqual({ kind: 'letter', letter: 'B' })
  })
})

import { expect, test } from 'bun:test'
import { csvItems, exportCsv, exportJson, readSelectedFile, totalCents, validateQuote, validateSuggestedPrices } from './quotation'
const quote = { currency: 'CNY', items: [{ name: '设计', quantity: 3, unitPriceCents: 101, note: '<script>alert(1)</script>' }] }
test('strict schema and deterministic integer money reject malformed or unbounded suggestions', () => {
  expect(totalCents(validateQuote(quote))).toBe(303)
  for (const bad of [{ ...quote, total: 1 }, { ...quote, currency: 'USD' }, { ...quote, items: [] }, { ...quote, items: [{ ...quote.items[0], quantity: .3 }] }, { ...quote, items: [{ ...quote.items[0], unitPriceCents: Number.MAX_SAFE_INTEGER }] }]) expect(() => validateQuote(bad)).toThrow()
  expect(() => validateSuggestedPrices(validateQuote(quote), [], 100)).toThrow()
  validateSuggestedPrices(validateQuote(quote), [], 101)
  expect(() => validateSuggestedPrices(validateQuote(quote), [{ name: '外部', quantity: 1, unitPriceCents: 101, note: '' }], 101)).toThrow()
})
test('CSV quoting parses multiline names; malformed/header/duplicates/formulas in numbers are rejected', () => {
  expect(csvItems('name,quantity,unitPriceCents\r\n"A, B",2,12500')[0]?.name).toBe('A, B')
  for (const csv of ['bad,headers\nx,1', 'name,quantity,unitPriceCents\n"broken,1,2', 'name,quantity,unitPriceCents\nx,=2,100', 'name,quantity,unitPriceCents\nx,1,1\nx,1,1']) expect(() => csvItems(csv)).toThrow()
})
test('selected files reject size, extension, empty and invalid UTF8 before use', async () => {
  for (const file of [new File([new Uint8Array([0xc3, 0x28])], 'bad.txt'), new File(['hello'], 'bad.html'), new File(['x'.repeat(262145)], 'big.txt'), new File([''], 'empty.txt')]) await expect(readSelectedFile(file)).rejects.toThrow()
  expect((await readSelectedFile(new File(['需求'], 'selected.txt'))).text).toBe('需求')
})
test('CSV prevents spreadsheet formulas while JSON preserves text and recomputes totals', () => {
  for (const name of ['=HYPERLINK("bad")', ' +SUM(1,2)', '\t@evil', '-1']) {
    const q = validateQuote({ ...quote, items: [{ ...quote.items[0], name }] })
    expect(exportCsv(q)).toContain('"\''); expect(JSON.parse(exportJson(q)).items[0].name).toBe(name); expect(JSON.parse(exportJson(q)).totalCents).toBe(303)
  }
})

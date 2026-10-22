import { expect, it } from 'bun:test'
import { formatCanonicalSkillDiscovery, CANONICAL_DISCOVERY_BUDGET } from '../canonical-skill-discovery.ts'
import type { LoadedSkill } from '../../skills/types.ts'
const skill = (alias: string, description: string): LoadedSkill => ({slug:alias,path:'/owned/'+alias,metadata:{name:'Team helper',description,globs:['**/*.xlsx']},content:'Private instruction body.',source:'workspace'})
const entries = (text: string) => JSON.parse(text.split('\n').find(line=>line.startsWith('['))!)
it('context budget preserves complete trigger tails and prioritizes matching candidates',()=>{
 const rows=Array.from({length:80},(_,i)=>skill('canonical-'+String(i).padStart(3,'0'),'General conditions. '.repeat(200)))
 rows[79]!.metadata.description+=' Require QUOTE_APPROVAL_AFTER_STAGE42'
 const output=formatCanonicalSkillDiscovery(rows,'QUOTE_APPROVAL_AFTER_STAGE42 request',['quote.xlsx'])
 const selected=entries(output)
 expect(selected[0].alias).toBe(rows[79]!.slug)
 for(const row of selected)expect(row.description).toBe(rows.find(original=>original.slug===row.alias)!.metadata.description)
 expect(JSON.stringify(selected).length).toBeLessThanOrEqual(CANONICAL_DISCOVERY_BUDGET)
 expect(output).toContain('additional candidates were not included')
 expect(output).not.toContain('Private instruction body.')
})
it('explicit mentions win selection, while enterprise context never advertises personal Skill roots',()=>{
 const rows=[skill('canonical-a','Other task'),skill('canonical-b','Quote conditions')]
 const output=formatCanonicalSkillDiscovery(rows,'[skill:canonical-b] inspect')
 expect(entries(output)[0].alias).toBe('canonical-b')
 expect(output).toContain('legacy Skill roots are unavailable')
 expect(formatCanonicalSkillDiscovery([], 'ordinary request',[],true)).toBe('')
})

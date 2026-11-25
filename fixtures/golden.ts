// Retrieval golden set over fixtures/sample-session.ts (units built with session 'c0ffee12', k 1).
// Each question lists the unit refs that answer it (any one counts), read by hand from the fixture.
// `refs: []` marks a question the fixture cannot answer: search must abstain.

export type Golden = { question: string; leads?: string[]; refs: string[] }

const r = (...ns: string[]) => ns.map(n => `c0ffee12-1#${n}`)

export const golden: Golden[] = [
  { question: 'Why did the Acme March invoice show 1,204.99 instead of 1,205.00?', refs: r('6', '4.1') },
  { question: 'Which PDF libraries are installed in the environment?', refs: r('22.1', '24') },
  { question: 'Why did the first footer test fail to import?', leads: ['reportlab'], refs: r('20.1', '24') },
  { question: 'What is the UK standard VAT rate?', refs: r('30.1', '34') },
  { question: 'What must an invoice include?', refs: r('32.1', '34') },
  { question: 'What did the user say about pushing or sending invoices?', refs: r('35') },
  { question: 'Where was the local-only rule written after the guard blocked the memory file?', refs: r('38', '38.1') },
  { question: 'Which agent drafted the CSV exporter, and what is its agentId?', refs: r('48.1') },
  { question: 'Why did the month boundary export test fail?', refs: r('56.1', '58') },
  { question: 'Which columns does the monthly CSV export have?', refs: r('62', '54.1') },
  { question: 'What is still open before tagging v0.3?', refs: r('66') },
  { question: 'Where does the config file live?', leads: ['config.toml'], refs: r('11', '14.1') },
  { question: 'What Kubernetes helm chart values did we choose for the payments cluster?', refs: [] },
  { question: 'Which Figma colour palette was picked for the iOS onboarding screens?', refs: [] },
]

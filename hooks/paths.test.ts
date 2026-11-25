import { expect, test } from 'claude-code/testing'
import { dirname, expandPath } from './paths'

test('dirname: / and \\ both separate (0.2.9)', () => {
  expect(dirname('/home/u/.claude/projects/-home-u-p/abc.jsonl')).toBe('/home/u/.claude/projects/-home-u-p')
  expect(dirname('C:\\Users\\u\\.claude\\projects\\C--Users-u-p\\abc.jsonl')).toBe('C:\\Users\\u\\.claude\\projects\\C--Users-u-p')
  expect(dirname('C:/Users/u/x.jsonl')).toBe('C:/Users/u')
  expect(dirname('/a')).toBe('/')
  expect(dirname('a.jsonl')).toBe('.')
})

test('expandPath: ~ from HOME, else USERPROFILE; trailing separators dropped (0.2.9)', () => {
  expect(expandPath('~/notes/', { HOME: '/home/u' })).toBe('/home/u/notes')
  expect(expandPath('~\\notes\\', { USERPROFILE: 'C:\\Users\\u' })).toBe('C:\\Users\\u\\notes')
  expect(expandPath('~', { HOME: '/home/u', USERPROFILE: 'C:\\Users\\u' })).toBe('/home/u')
  expect(expandPath('~/x', {})).toBeUndefined()
  expect(expandPath('/abs/dir/', {})).toBe('/abs/dir')
  expect(expandPath('/', {})).toBe('/')
})

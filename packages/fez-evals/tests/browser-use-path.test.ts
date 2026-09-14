import { expect, it } from 'vitest';
import { browserUseSessionFile } from '../../fez-browser-use/src/index.js';

it('resolves only the selected valid persona beside the native socket', () => {
  expect(browserUseSessionFile({ persona: 'research_agent-2', home: '/Users/test' }))
    .toBe('/Users/test/.fez/native-surfaces/research_agent-2.json');
  expect(browserUseSessionFile({ persona: 'ResearchAgent', home: '/Users/test' }))
    .toBe('/Users/test/.fez/native-surfaces/ResearchAgent.json');
  expect(browserUseSessionFile({ persona: 'a'.repeat(65), home: '/Users/test' }))
    .toBe(`/Users/test/.fez/native-surfaces/${'a'.repeat(65)}.json`);
  expect(browserUseSessionFile({ persona: 'agent-a', home: '/Users/test' }))
    .not.toBe(browserUseSessionFile({ persona: 'agent-b', home: '/Users/test' }));
});

it.each([undefined, '', '../other', 'agent/name'])(
  'does not resolve a descriptor for missing or invalid persona %j', persona => {
    expect(browserUseSessionFile({ persona, home: '/Users/test' })).toBeUndefined();
  });

it('keeps an explicit nonblank lab descriptor ahead of persona resolution', () => {
  expect(browserUseSessionFile({ sessionFile: '/tmp/session.json', persona: '../invalid', home: '/Users/test' }))
    .toBe('/tmp/session.json');
  expect(browserUseSessionFile({ sessionFile: '  ', persona: 'agent', home: '/Users/test' }))
    .toBe('/Users/test/.fez/native-surfaces/agent.json');
});

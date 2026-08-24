export const libarchiveFixtures = Object.freeze([
  Object.freeze({
    name: 'hello.7z',
    format: '7z',
    base64: 'N3q8ryccAAM/XqGDHQAAAAAAAABqAAAAAAAAAJriatkANBlJ7o3pEuYUDr+5tDnK/fY3A8FxzP//xRwAAAEEBgABCR0ABwsBAAEjAwEBBV0AAIAADBIACAoBr9yKYgAABQERFQBoAGUAbABsAG8ALgB0AHgAdAAAABQKAQDmiBS9ejPdARIKAQDmiBS9ejPdARMKAQCFJBa9ejPdARUGAQAggKSBAAA=',
    entryName: 'hello.txt',
    text: 'hello from tar xz\n'
  }),
  Object.freeze({
    name: 'hello.tar.xz',
    format: 'TAR.XZ/LZMA',
    base64: '/Td6WFoAAATm1rRGBMCeAoBQIQEWAAAAAAAAAJRJuefgJ/8BFl0AKBhLBIZIGx7nZy2M9ukjPMv+eEvwR+RY/P/ykKjlQ5lUHKI9NgW9aoWWrPHTkPFw0dP9sMhc/xYMdwQw/egosGEnOjtVZ90m16Rb54Sg2YF8gOYwv2NRT7SHaqsuxNhV2qvBhL8jHCEYNjffxU3eP34frgWs2P23FnU04SRjuJIBgBpm+rN/CFKHjEu1QXflLjS8cfn9105Ir6ayM1XmMJd5xyOHttN0ovSnw6N4vhcdBOF27RsA+sFEtsWAp09eBcdDwEOdI0/0cKZlh5LVgKf1ZqB/aii321CJtS0pEkDMkzx2Bk2azpYuEDfC1Ws2bPU4ZYdwI/l9RL1Vm5TIHmWX+1wu3BUO9VY479YZLJkXCXiU2wAAAAAk4Y7tEdU1zgABugKAUAAAJS8hg7HEZ/sCAAAAAARZWg==',
    entryName: 'hello.txt',
    text: 'hello from tar xz\n'
  })
]);

export function fixtureBytes(fixture) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(fixture.base64, 'base64'));
  return Uint8Array.from(atob(fixture.base64), (character) => character.charCodeAt(0));
}

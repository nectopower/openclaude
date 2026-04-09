import { afterEach, expect, test } from 'bun:test'

import {
  clearHostSession,
  getCurrentHostSession,
  invalidateHostSession,
  registerHostSession,
  resolveHostSessionByToken,
} from './hostSessionRegistry.ts'

afterEach(() => {
  clearHostSession()
})

test('registerHostSession creates a tokenized host session', () => {
  const session = registerHostSession({
    cwd: '/workspace/demo',
    localUrl: 'http://localhost:3080',
    publicUrl: 'https://demo.trycloudflare.com',
  })

  expect(session.kind).toBe('host')
  expect(session.token.length).toBeGreaterThan(10)
  expect(getCurrentHostSession()).toEqual(session)
  expect(resolveHostSessionByToken(session.token)?.id).toBe(session.id)
})

test('invalidateHostSession removes token access immediately', () => {
  const session = registerHostSession({
    cwd: '/workspace/demo',
    localUrl: 'http://localhost:3080',
    publicUrl: 'https://demo.trycloudflare.com',
  })

  invalidateHostSession('host-exit')

  expect(getCurrentHostSession()).toBeNull()
  expect(resolveHostSessionByToken(session.token)).toBeNull()
})

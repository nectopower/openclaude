import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function readIndexHtml() {
  return fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.html'),
    'utf8',
  )
}

test('remote control mobile layout exposes drawer controls', () => {
  const html = readIndexHtml()

  expect(html).toContain('id="sidebar"')
  expect(html).toContain('id="mobileSidebarBackdrop"')
  expect(html).toContain('id="mobileMenuButton"')
  expect(html).toContain('id="emptyStateMenuButton"')
  expect(html).toContain('@media (max-width: 768px)')
  expect(html).toContain('.menu-btn')
  expect(html).toContain('.sidebar-backdrop')
  expect(html).toContain('function toggleMobileSidebar()')
  expect(html).toContain('function closeMobileSidebar()')
  expect(html).toContain("window.addEventListener('resize', syncMobileSidebar)")
  expect(html).toMatch(/async function init\(\) \{[\s\S]*syncMobileSidebar\(\)/)
})

test('remote control mobile interactions close the drawer around session actions', () => {
  const html = readIndexHtml()

  expect(html).toMatch(
    /function selectSession\(id\) \{[\s\S]*if \(isMobileViewport\(\)\) \{[\s\S]*closeMobileSidebar\(\)/,
  )
  expect(html).toMatch(
    /function openNewSessionModal\(\) \{[\s\S]*closeMobileSidebar\(\)/,
  )
  expect(html).toMatch(
    /function showEmptyState\(message\) \{[\s\S]*closeMobileSidebar\(\)/,
  )
})

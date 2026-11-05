import { expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { AuthForms } from '../../src/features/account/AuthForms'
import { processingNoticeText } from '../../src/lib/ai-processing'
import { AccountPanel } from '../../src/features/account/AccountPanel'
const account = vi.hoisted(() => ({
  user: { id: 'alice', name: 'Alice', verified: true } as any,
  pending: false,
}))
vi.mock('../../src/features/account/auth-client', () => ({
  useAccountStatus: () => account,
}))
vi.mock('../../src/features/account/PrivacyPanel', () => ({
  PrivacyPanel: () => null,
}))
vi.mock('../../src/features/account/UsageStatus', () => ({
  UsageStatus: () => null,
}))
vi.mock('../../src/features/account/library', () => ({
  useCloudLibrary: () => ({
    data: { pages: [{ threads: [] }] },
    isPending: false,
  }),
  useCloudThread: () => ({ data: undefined }),
}))
test('verified_account_owns_conversation_management', () => {
  expect(renderToStaticMarkup(createElement(AccountPanel))).toContain(
    'Conversation management',
  )
})

test('signup_submit_displays_processing_notice_without_extra_gate', () => {
  const html = renderToStaticMarkup(
    createElement(AuthForms, { initialMode: 'signup' }),
  )
  expect(html).toContain(processingNoticeText)
  expect(html.indexOf(processingNoticeText)).toBeLessThan(
    html.indexOf('Create account</button>'),
  )
  expect(html).not.toContain('type="checkbox"')
})

test('pending_session_refresh_retains_anonymous_form_but_hides_controls_and_owner_switch_removes_private_controls', () => {
  account.user = null
  account.pending = false
  expect(renderToStaticMarkup(createElement(AccountPanel))).toContain(
    'class="account-form"',
  )
  account.pending = true
  const pending = renderToStaticMarkup(createElement(AccountPanel))
  expect(pending).toContain('Checking your account')
  expect(pending).toContain('<div hidden="">')
  expect(pending).toContain('class="account-form"')
  expect(pending).not.toContain('Conversation management')
  account.user = { id: 'alice', name: 'Alice', verified: true }
  account.pending = false
  expect(renderToStaticMarkup(createElement(AccountPanel))).toContain(
    'Conversation management',
  )
  account.user = null
  account.pending = true
  const switched = renderToStaticMarkup(createElement(AccountPanel))
  expect(switched).not.toContain('Conversation management')
  expect(switched).not.toContain('Hi, Alice')
  account.user = { id: 'alice', name: 'Alice', verified: true }
  account.pending = false
})

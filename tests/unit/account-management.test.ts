import { expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { AuthForms } from '../../src/features/account/AuthForms'
import { processingNoticeText } from '../../src/lib/ai-processing'
import { AccountPanel } from '../../src/features/account/AccountPanel'
vi.mock('../../src/features/account/auth-client', () => ({
  useAccountStatus: () => ({
    user: { id: 'alice', name: 'Alice', verified: true },
    pending: false,
  }),
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

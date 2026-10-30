import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  processingNoticeText,
  processingNoticeVersion,
} from '../../lib/ai-processing'
import { authClient } from './auth-client'
import { validateAuthForm } from './auth-state'
import type { AuthFields, FormMode } from './auth-state'

const titles: Record<FormMode, string> = {
  login: 'Welcome back',
  signup: 'Make yourself at home',
  forgot: 'Reset your password',
  reset: 'Choose a new password',
  verify: 'Verify your email',
}
export function AuthForms({
  initialMode = 'login',
  token,
  initialNotice = '',
  initialEmail = '',
}: {
  initialMode?: FormMode
  token?: string
  initialNotice?: string
  initialEmail?: string
}) {
  const [mode, setMode] = useState<FormMode>(initialMode)
  const [fields, setFields] = useState<AuthFields>({ email: initialEmail })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(initialNotice)
  const [error, setError] = useState('')
  const [invalid, setInvalid] = useState<keyof AuthFields | null>(null)
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>('[data-autofocus]')?.focus()
  }, [mode])
  function changeMode(next: FormMode) {
    setMode(next)
    setFields(({ email }) => ({ email }))
    setError('')
    setInvalid(null)
    setNotice('')
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const validation = validateAuthForm(mode, fields)
    setError('')
    setInvalid(null)
    setNotice('')
    if (validation) {
      setError(validation.message)
      setInvalid(validation.field)
      form.current
        ?.querySelector<HTMLInputElement>(`[name="${validation.field}"]`)
        ?.focus()
      return
    }
    if (mode === 'reset' && !token) {
      setError('This reset link is missing or expired. Request a new one.')
      return
    }
    setBusy(true)
    try {
      const email = fields.email?.trim() ?? ''
      const callbackURL = new URL('/account?verified=1', location.origin).href
      const result =
        mode === 'signup'
          ? await authClient.signUp.email({
              aiProcessingNoticeVersion: processingNoticeVersion,
              name: fields.name!.trim(),
              email,
              password: fields.password!,
              callbackURL,
            })
          : mode === 'login'
            ? await authClient.signIn.email({
                email,
                password: fields.password!,
                callbackURL,
              })
            : mode === 'forgot'
              ? await authClient.requestPasswordReset({
                  email,
                  redirectTo: new URL('/account', location.origin).href,
                })
              : mode === 'reset'
                ? await authClient.resetPassword({
                    newPassword: fields.password!,
                    token: token!,
                  })
                : await authClient.sendVerificationEmail({ email, callbackURL })
      if (result.error) {
        if (result.error.code === 'EMAIL_NOT_VERIFIED') {
          setMode('verify')
          setFields({ email })
          setNotice(
            'Verify your email before signing in. Check your inbox or request a new link below.',
          )
        } else {
          setError(
            result.error.status === 429
              ? 'Too many attempts. Please wait a minute and try again.'
              : mode === 'login'
                ? 'Could not sign in. Check your email and password, then try again.'
                : mode === 'reset'
                  ? 'This reset link is invalid or expired. Request a new one.'
                  : mode === 'verify'
                    ? 'We could not send the link. Please try again.'
                    : 'Could not complete your request. Please try again.',
          )
        }
        return
      }
      setFields({ email })
      if (mode === 'signup') {
        setMode('verify')
        setNotice(
          'Check your inbox for a verification link. If it does not arrive, you can resend it below. Verification links last one hour.',
        )
      } else if (mode === 'forgot') {
        setNotice(
          'If an account matches that email, you will receive a reset link. Check your inbox and spam folder. Links last one hour.',
        )
      } else if (mode === 'reset') {
        setMode('login')
        setNotice(
          'Your password has been reset. Sign in with your new password.',
        )
      } else if (mode === 'verify') {
        setNotice(
          'If your email needs verification, a new link is on its way. Check your inbox and spam folder.',
        )
      }
    } catch {
      setError(
        'Could not connect. Your form is still here. Check your connection and try again.',
      )
    } finally {
      setBusy(false)
    }
  }
  const showPassword = ['login', 'signup', 'reset'].includes(mode)
  const confirm = ['signup', 'reset'].includes(mode)
  function field(
    name: keyof AuthFields,
    label: string,
    type = 'text',
    autoComplete?: string,
  ) {
    return (
      <label className="account-field" key={name}>
        <span>{label}</span>
        <input
          data-autofocus={
            name ===
              (mode === 'signup'
                ? 'name'
                : mode === 'reset'
                  ? 'password'
                  : 'email') || undefined
          }
          name={name}
          type={type}
          autoComplete={autoComplete}
          autoCapitalize={type === 'email' ? 'none' : undefined}
          spellCheck={false}
          maxLength={name === 'name' ? 100 : type === 'password' ? 128 : 254}
          minLength={type === 'password' ? 12 : undefined}
          required
          value={fields[name] ?? ''}
          onChange={(event) =>
            setFields({ ...fields, [name]: event.target.value })
          }
          aria-invalid={invalid === name || undefined}
          aria-describedby={
            invalid === name
              ? 'authError'
              : type === 'password' && mode !== 'login'
                ? 'passwordHint'
                : undefined
          }
        />
      </label>
    )
  }
  return (
    <div className="account-forms">
      <h3>{titles[mode]}</h3>
      {mode === 'verify' && (
        <p>
          Verify your email to use account features. After verification, come
          back here to sign in.
        </p>
      )}
      {notice && (
        <p className="account-notice" role="status">
          {notice}
        </p>
      )}
      <form
        ref={form}
        className="account-form"
        onSubmit={(event) => void submit(event)}
        noValidate
        aria-busy={busy}
      >
        <fieldset disabled={busy}>
          {mode === 'signup' && field('name', 'Your name', 'text', 'name')}
          {mode !== 'reset' && field('email', 'Email', 'email', 'username')}
          {showPassword &&
            field(
              'password',
              mode === 'reset' ? 'New password' : 'Password',
              'password',
              mode === 'login' ? 'current-password' : 'new-password',
            )}
          {confirm && (
            <p id="passwordHint" className="account-hint">
              Use 12–128 characters. Spaces and password managers are welcome.
            </p>
          )}
          {confirm &&
            field('confirm', 'Confirm password', 'password', 'new-password')}
          {error && (
            <p id="authError" className="account-error" role="alert">
              {error}
            </p>
          )}
          {mode === 'signup' && (
            <p className="account-hint">{processingNoticeText}</p>
          )}
          <button className="copy-primary" type="submit">
            {busy
              ? 'Please wait…'
              : {
                  login: 'Sign in',
                  signup: 'Create account',
                  forgot: 'Send reset link',
                  reset: 'Save new password',
                  verify: 'Resend verification link',
                }[mode]}
          </button>
        </fieldset>
      </form>
      <div className="account-links">
        {mode !== 'login' && (
          <button disabled={busy} onClick={() => changeMode('login')}>
            Back to sign in
          </button>
        )}
        {mode === 'login' && (
          <>
            <button disabled={busy} onClick={() => changeMode('signup')}>
              Create an account
            </button>
            <button disabled={busy} onClick={() => changeMode('forgot')}>
              Forgot password?
            </button>
          </>
        )}
        {mode === 'reset' && (
          <button disabled={busy} onClick={() => changeMode('forgot')}>
            Request a new reset link
          </button>
        )}
      </div>
    </div>
  )
}

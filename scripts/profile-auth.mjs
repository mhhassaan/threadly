// Windows-only local Worker CPU characterization; no secrets, providers or cloud resources.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { startPreview, stopPreview } from './preview.mjs'

assert.equal(process.platform, 'win32')
const base = 'http://127.0.0.1:4193',
  iterations = 40
const server = startPreview(4193, {
  stdio: ['ignore', 'pipe', 'pipe'],
  workerEntry: 'tests/worker/auth-profile-entry.ts',
})
let output = ''
server.stdout.on('data', (chunk) => (output += chunk))
server.stderr.on('data', (chunk) => (output += chunk))
const powershell = (script) =>
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
try {
  let ready = false
  for (let i = 0; i < 300; i++) {
    if (server.exitCode !== null) throw new Error(`Profile exited: ${output}`)
    try {
      if (
        (await fetch(base + '/health', { signal: AbortSignal.timeout(2000) }))
          .ok
      ) {
        ready = true
        break
      }
    } catch {}
    await delay(100)
  }
  assert(ready, `Profile starts: ${output}`)
  const ids = JSON.parse(
    powershell(
      `$all = @(Get-CimInstance Win32_Process); $owned = @(${server.pid}); do { $found = @($all | Where-Object { $_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned }); $owned += @($found.ProcessId) } while ($found.Count); ConvertTo-Json -Compress -InputObject @($all | Where-Object { $_.ProcessId -in $owned -and $_.Name -eq 'workerd.exe' } | ForEach-Object { $_.ProcessId })`,
    ),
  )
  assert(ids.length > 0)
  const cpuMs = () =>
    Number(
      powershell(
        `(@(Get-Process -Id ${ids.join(',')}) | ForEach-Object { $_.TotalProcessorTime.TotalMilliseconds } | Measure-Object -Sum).Sum.ToString([Globalization.CultureInfo]::InvariantCulture)`,
      ),
    )
  const measurements = []
  for (const path of ['/hash', '/verify']) {
    for (let i = 0; i < 3; i++)
      assert((await (await fetch(base + path)).json()).ok)
    const before = cpuMs(),
      start = performance.now()
    for (let i = 0; i < iterations; i++) {
      const response = await fetch(base + path)
      assert.equal(response.status, 200)
      assert((await response.json()).ok)
    }
    const wallMs = performance.now() - start
    const workerCpuMs = cpuMs() - before
    measurements.push({
      operation: path.slice(1),
      iterations,
      warmupRequests: 3,
      cpuMsPerRequest: workerCpuMs / iterations,
      wallMsPerRequest: wallMs / iterations,
    })
  }
  console.log(
    JSON.stringify(
      {
        runtime:
          'local workerd, Better Auth 1.7.14 default scrypt N=16384/r=16/p=1/dkLen=64',
        workerProcessCount: ids.length,
        measurements,
      },
      null,
      2,
    ),
  )
  console.log(
    'Owned workerd process CPU means include runtime/GC overhead; not production billed CPU or a free-tier qualification. Hash strength is unchanged; no plan or billing was enabled.',
  )
} finally {
  await stopPreview(server)
}

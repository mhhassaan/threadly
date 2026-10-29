// Windows local process-CPU characterization. Build first; no remote services.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { startPreview, stopPreview } from './preview.mjs'

assert.equal(
  process.platform,
  'win32',
  'This measurement uses Windows process CPU counters',
)
const base = 'http://127.0.0.1:4188',
  iterations = 100
const server = startPreview(4188, {
  stdio: ['ignore', 'pipe', 'pipe'],
  workerEntry: 'tests/worker/profile-entry.mjs',
})
let output = ''
server.stdout.on('data', (chunk) => (output += chunk))
server.stderr.on('data', (chunk) => (output += chunk))
function powershell(script) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
}
try {
  let started = false
  for (let i = 0; i < 300; i++) {
    if (server.exitCode !== null)
      throw new Error(`Profile Worker exited: ${output}`)
    try {
      if ((await fetch(base, { signal: AbortSignal.timeout(2000) })).ok) {
        started = true
        break
      }
    } catch {}
    await delay(100)
  }
  assert(started, `Profile Worker starts: ${output}`)
  // Restrict counters to workerd descendants of this script's own preview process.
  const ids = JSON.parse(
    powershell(
      `$all = @(Get-CimInstance Win32_Process); $owned = @(${server.pid}); do { $found = @($all | Where-Object { $_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned }); $owned += @($found.ProcessId) } while ($found.Count); ConvertTo-Json -Compress -InputObject @($all | Where-Object { $_.ProcessId -in $owned -and $_.Name -eq 'workerd.exe' } | ForEach-Object { $_.ProcessId })`,
    ),
  )
  assert(ids.length > 0, 'Owned workerd processes are measured')
  const cpuMs = () =>
    Number(
      powershell(
        `(@(Get-Process -Id ${ids.join(',')}) | ForEach-Object { $_.TotalProcessorTime.TotalMilliseconds } | Measure-Object -Sum).Sum.ToString([Globalization.CultureInfo]::InvariantCulture)`,
      ),
    )
  const measurements = []
  for (const [name, path] of [
    ['SSR dashboard', '/'],
    ['Large article extraction', '/__profile_extract'],
  ]) {
    for (let i = 0; i < 5; i++) await (await fetch(base + path)).arrayBuffer()
    const beforeCpu = cpuMs(),
      started = performance.now()
    for (let i = 0; i < iterations; i++) {
      const response = await fetch(base + path)
      assert.equal(response.status, 200)
      await response.arrayBuffer()
    }
    const wallMs = performance.now() - started,
      workerCpuMs = cpuMs() - beforeCpu
    measurements.push({
      workload: name,
      iterations,
      warmupRequests: 5,
      workerCpuMs,
      cpuMsPerRequest: workerCpuMs / iterations,
      wallMsPerRequest: wallMs / iterations,
    })
  }
  const fixture = await (await fetch(base + '/__profile_extract')).json()
  console.log(
    JSON.stringify(
      {
        runtime:
          'local workerd; production SSR bundle; synthetic extraction-only fixture',
        workerProcessCount: ids.length,
        fixture,
        measurements,
      },
      null,
      2,
    ),
  )
  console.log(
    'Warm batch means only. CPU is Windows workerd process CPU across all threads (including GC/runtime overhead), not wall time. This is not production billed CPU or a free-tier qualification.',
  )
} finally {
  await stopPreview(server)
}

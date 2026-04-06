#!/usr/bin/env bun
/**
 * Relay control CLI — start/stop/status for the relay daemon.
 */

import { existsSync, readFileSync, unlinkSync } from 'fs'
import { SOCKET_PATH, PID_FILE, STATE_DIR, encode, parseLines } from './protocol.js'

const cmd = process.argv[2]

function usage() {
  console.log(`Usage: relay-ctl <command>

Commands:
  start     Start the relay daemon
  stop      Stop the relay daemon
  status    Show relay status and connected bridges
  restart   Restart the relay daemon
`)
  process.exit(1)
}

function getPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
    // Check if process is alive
    try { process.kill(pid, 0); return pid } catch { return null }
  } catch { return null }
}

async function start() {
  const pid = getPid()
  if (pid) {
    console.log(`Relay already running (pid: ${pid})`)
    return
  }

  console.log('Starting relay daemon...')
  const daemonPath = new URL('./relay-daemon.ts', import.meta.url).pathname
  const child = Bun.spawn(['bun', 'run', daemonPath], {
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
    env: process.env,
  })
  child.unref()

  // Wait for socket
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000))
    if (existsSync(SOCKET_PATH)) {
      const newPid = getPid()
      console.log(`Relay started (pid: ${newPid})`)
      return
    }
  }
  console.error('Relay failed to start within 15 seconds')
  process.exit(1)
}

function stop() {
  const pid = getPid()
  if (!pid) {
    console.log('Relay is not running')
    // Clean up stale files
    try { unlinkSync(PID_FILE) } catch {}
    try { unlinkSync(SOCKET_PATH) } catch {}
    return
  }

  process.kill(pid, 'SIGTERM')
  console.log(`Sent SIGTERM to relay (pid: ${pid})`)
}

async function status() {
  const pid = getPid()
  if (!pid) {
    console.log('Relay is not running')
    return
  }

  console.log(`Relay running (pid: ${pid})`)
  console.log(`Socket: ${SOCKET_PATH}`)
  console.log(`State dir: ${STATE_DIR}`)

  // Connect and query status
  if (!existsSync(SOCKET_PATH)) {
    console.log('Socket file missing — relay may be unhealthy')
    return
  }

  try {
    const result = await new Promise<string>((resolve, reject) => {
      let buf = ''
      const socket = Bun.connect({
        unix: SOCKET_PATH,
        socket: {
          open(s) {
            const bridgeId = `ctl-${Date.now()}`
            s.write(encode({ type: 'register', bridgeId, channels: [], threads: [] }))
            // Small delay then query
            setTimeout(() => {
              const reqId = `status-${Date.now()}`
              s.write(encode({ type: 'action', bridgeId, requestId: reqId, action: { name: 'relay_status' } }))
            }, 200)
          },
          data(s, data) {
            buf += data.toString()
            const { messages } = parseLines(buf)
            for (const msg of messages) {
              const m = msg as any
              if (m.type === 'action_result' && m.success) {
                resolve(typeof m.data === 'string' ? m.data : JSON.stringify(m.data, null, 2))
                s.end()
              }
            }
          },
          close() {},
          error(s, err) { reject(err) },
        },
      })

      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    console.log('\nConnected bridges:')
    console.log(result)
  } catch (err) {
    console.log('Could not query relay status:', err)
  }
}

switch (cmd) {
  case 'start': await start(); break
  case 'stop': stop(); break
  case 'restart': stop(); await new Promise(r => setTimeout(r, 2000)); await start(); break
  case 'status': await status(); break
  default: usage()
}

/**
 * dsh-wash — Host half.
 *
 * Scans DSH session logs (`<DSH_HOME>/sessions/<workspace>/<session>/session.v*.jsonl.zstd`),
 * finds assistant messages whose text carries the input envelope the model copied
 * back (`<user_message ...>`, `<turn_meta>`, `<assistant_user>`), and rewrites the
 * log without those blocks after taking a timestamped backup.
 *
 * Everything is local: no network, no upload, one JSON route for the panel.
 *
 * @module dsh-wash
 */
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  statSync,
} from 'node:fs'
import { join, basename, dirname, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

const ROUTE_PREFIX = '/dsh-wash/api'
const MARKERS = ['<user_message', '<turn_meta', '<assistant_user']
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SHELL_APP_ORIGIN = 'dsh-app://app'
const MAX_BODY_BYTES = 256 * 1024

function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.length > 0) return env
  return join(homedir(), '.dsh')
}

/** `--C-Users-~4E91~6958-Documents-...` -> `C:/Users/云楘/Documents/...` */
function decodeWorkspace(dirName) {
  let text = dirName
  if (text.startsWith('--')) text = text.slice(2)
  if (text.endsWith('--')) text = text.slice(0, -2)
  text = text.replace(/~([0-9A-Fa-f]{4})~/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  text = text.replace(/-/g, '/')
  return text
}

function sessionFiles(root) {
  if (!existsSync(root)) return []
  const found = []
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(root, workspace.name)
    let entries = []
    try {
      entries = readdirSync(workspacePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(workspacePath, entry.name)
      let files = []
      try {
        files = readdirSync(dir).filter((name) => /^session\.v\d+\.jsonl\.zstd$/.test(name))
      } catch {
        continue
      }
      for (const name of files) {
        const file = join(dir, name)
        try {
          const info = statSync(file)
          found.push({
            id: entry.name,
            workspace: decodeWorkspace(workspace.name),
            workspaceDir: workspace.name,
            file,
            size: info.size,
            mtime: info.mtimeMs,
          })
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found
}

function frameStarts(buf) {
  const starts = []
  let index = 0
  while (true) {
    const at = buf.indexOf(ZSTD_MAGIC, index)
    if (at < 0) break
    starts.push(at)
    index = at + 4
  }
  return starts
}

function decodeEvents(file) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    const error = new Error('当前宿主运行时没有 zstd 支持（需要 Node 22.15+）')
    error.code = 'no-zstd'
    throw error
  }
  const buf = readFileSync(file)
  const starts = frameStarts(buf)
  if (starts.length === 0) {
    const error = new Error('不是可识别的会话记录（找不到 zstd 帧）')
    error.code = 'bad-format'
    throw error
  }
  const events = []
  let badFrames = 0
  for (let index = 0; index < starts.length; index++) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : buf.length
    let text
    try {
      text = zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
    } catch {
      badFrames++
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        /* skip a broken line, keep the rest */
      }
    }
  }
  return { events, badFrames, bytes: buf.length }
}

function firstFrameLineCount(file) {
  const buf = readFileSync(file)
  const starts = frameStarts(buf)
  if (starts.length === 0) return 0
  const to = starts.length > 1 ? starts[1] : buf.length
  try {
    const text = zlib.zstdDecompressSync(buf.subarray(starts[0], to)).toString('utf8')
    return text.split('\n').filter((line) => line.trim()).length
  } catch {
    return -1
  }
}

function textBlocks(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return []
  return content.filter((part) => part?.type === 'text' && typeof part?.text === 'string')
}

function measure(events) {
  let dirtyMessages = 0
  let dirtyChars = 0
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const parts = textBlocks(event)
    let touched = false
    for (const part of parts) {
      for (const marker of MARKERS) {
        const at = part.text.indexOf(marker)
        if (at >= 0) {
          dirtyChars += part.text.length - at
          touched = true
          break
        }
      }
    }
    if (touched) dirtyMessages++
  }
  return { dirtyMessages, dirtyChars }
}

function isBusy(file) {
  let handle
  try {
    handle = openSync(file, 'r+')
    return false
  } catch {
    return true
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

function backupName(id) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${id}__${stamp}.jsonl.zstd.bak`
}

function listBackups(backupDir, id) {
  if (!existsSync(backupDir)) return []
  return readdirSync(backupDir)
    .filter((name) => name.startsWith(`${id}__`))
    .map((name) => {
      const file = join(backupDir, name)
      const info = statSync(file)
      return { name, file, size: info.size, mtime: info.mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

class WashService {
  constructor(config) {
    this.config = config ?? {}
    this.cache = new Map()
  }

  root() {
    return resolve(this.config.sessionsRoot ?? join(dshHome(), 'sessions'))
  }

  backupRoot() {
    return resolve(this.config.backupDir ?? join(dshHome(), 'dsh-wash', 'backups'))
  }

  find(id) {
    const match = sessionFiles(this.root()).find((entry) => entry.id === id)
    if (match === undefined) {
      const error = new Error(`找不到会话：${id}`)
      error.code = 'not-found'
      throw error
    }
    const root = this.root()
    if (!match.file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      const error = new Error('会话路径越界，已拒绝')
      error.code = 'forbidden'
      throw error
    }
    return match
  }

  describe(entry) {
    const cached = this.cache.get(entry.id)
    const fresh = cached !== undefined && cached.mtime === entry.mtime && cached.size === entry.size
    const backups = listBackups(this.backupRoot(), entry.id)
    return {
      id: entry.id,
      workspace: entry.workspace,
      file: entry.file,
      size: entry.size,
      mtime: entry.mtime,
      busy: isBusy(entry.file),
      backups: backups.length,
      lastBackup: backups[0]?.mtime ?? null,
      scanned: fresh,
      events: fresh ? cached.events : null,
      dirtyMessages: fresh ? cached.dirtyMessages : null,
      dirtyChars: fresh ? cached.dirtyChars : null,
    }
  }

  list() {
    const sessions = sessionFiles(this.root()).map((entry) => this.describe(entry))
    return {
      sessionsRoot: this.root(),
      backupRoot: this.backupRoot(),
      sessions,
      totals: {
        sessions: sessions.length,
        dirty: sessions.filter((item) => (item.dirtyMessages ?? 0) > 0).length,
        busy: sessions.filter((item) => item.busy).length,
        bytes: sessions.reduce((sum, item) => sum + item.size, 0),
      },
    }
  }

  scan(id) {
    const targets = id === undefined || id === null ? sessionFiles(this.root()) : [this.find(id)]
    const results = []
    for (const entry of targets) {
      try {
        const { events, badFrames } = decodeEvents(entry.file)
        const stats = measure(events)
        this.cache.set(entry.id, {
          mtime: entry.mtime,
          size: entry.size,
          events: events.length,
          dirtyMessages: stats.dirtyMessages,
          dirtyChars: stats.dirtyChars,
          badFrames,
        })
        results.push({ id: entry.id, ok: true, events: events.length, ...stats, badFrames })
      } catch (error) {
        results.push({ id: entry.id, ok: false, error: messageOf(error) })
      }
    }
    return { results }
  }

  wash(id) {
    const entry = this.find(id)
    if (isBusy(entry.file)) {
      return { id, ok: false, busy: true, error: '会话正在被写入（DSH 正持有它），等它空闲再洗。' }
    }
    const before = statSync(entry.file)
    const { events } = decodeEvents(entry.file)

    let dirtyMessages = 0
    let dirtyChars = 0
    let changedBlocks = 0
    for (const event of events) {
      if (event?.type !== 'assistant/message') continue
      let touched = false
      for (const part of textBlocks(event)) {
        let cut = -1
        for (const marker of MARKERS) {
          const at = part.text.indexOf(marker)
          if (at >= 0 && (cut < 0 || at < cut)) cut = at
        }
        if (cut < 0) continue
        dirtyChars += part.text.length - cut
        part.text = part.text.slice(0, cut).replace(/\s+$/, '')
        changedBlocks++
        touched = true
      }
      if (touched) dirtyMessages++
    }

    if (changedBlocks === 0) {
      this.cache.set(entry.id, {
        mtime: entry.mtime,
        size: entry.size,
        events: events.length,
        dirtyMessages: 0,
        dirtyChars: 0,
        badFrames: 0,
      })
      return { id, ok: true, changed: false, dirtyMessages: 0, dirtyChars: 0, backup: null }
    }

    const lines = events.map((event) => Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'))
    // DSH 读取时要求第一帧恰好只含 header 一行，否则整份记录会被判为损坏、会话从列表消失
    const frames = [zlib.zstdCompressSync(lines[0])]
    const LINES_PER_FRAME = 200
    for (let index = 1; index < lines.length; index += LINES_PER_FRAME) {
      const chunk = Buffer.concat(lines.slice(index, index + LINES_PER_FRAME))
      frames.push(zlib.zstdCompressSync(chunk))
    }
    const reencoded = Buffer.concat(frames)

    const after = statSync(entry.file)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return { id, ok: false, busy: true, error: '洗的过程中文件被写过，原文件没动，重试一次。' }
    }

    mkdirSync(this.backupRoot(), { recursive: true })
    const backup = join(this.backupRoot(), backupName(entry.id))
    copyFileSync(entry.file, backup)

    writeFileSync(entry.file, reencoded)

    const check = decodeEvents(entry.file)
    const remaining = measure(check.events)
    const info = statSync(entry.file)
    this.cache.set(entry.id, {
      mtime: info.mtimeMs,
      size: info.size,
      events: check.events.length,
      dirtyMessages: remaining.dirtyMessages,
      dirtyChars: remaining.dirtyChars,
      badFrames: 0,
    })

    if (remaining.dirtyMessages > 0 || check.events.length !== events.length || firstFrameLineCount(entry.file) !== 1) {
      copyFileSync(backup, entry.file)
      return {
        id,
        ok: false,
        restored: true,
        error: `自检没过（剩余脏消息 ${remaining.dirtyMessages}，事件 ${check.events.length}/${events.length}，首帧行数 ${firstFrameLineCount(entry.file)}），已回滚。`,
      }
    }

    return {
      id,
      ok: true,
      changed: true,
      dirtyMessages,
      dirtyChars,
      backup,
      events: check.events.length,
      sizeBefore: before.size,
      sizeAfter: info.size,
    }
  }

  restore(id) {
    const entry = this.find(id)
    if (isBusy(entry.file)) {
      return { id, ok: false, busy: true, error: '会话正在被写入（DSH 正持有它），等它空闲再还原。' }
    }
    const backups = listBackups(this.backupRoot(), id)
    if (backups.length === 0) return { id, ok: false, error: '没有可用的备份。' }
    copyFileSync(backups[0].file, entry.file)
    this.cache.delete(id)
    const info = statSync(entry.file)
    return { id, ok: true, backup: backups[0].name, size: info.size, mtime: info.mtimeMs }
  }

  backups(id) {
    return { backups: listBackups(this.backupRoot(), id).map(({ name, size, mtime }) => ({ name, size, mtime })) }
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    request.on('error', rejectBody)
  })
}

function isTrusted(request, trustedHosts) {
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    if (origin !== SHELL_APP_ORIGIN) {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {
        return false
      }
      if (originHost !== request.headers.host) return false
    }
  }
  const host = request.headers.host
  if (typeof host === 'string') {
    const name = host.replace(/:\d+$/, '')
    if (name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1') return true
  }
  if (Array.isArray(trustedHosts)) {
    for (const trusted of trustedHosts) {
      if (typeof trusted === 'string' && host === trusted) return true
      if (trusted instanceof RegExp && typeof host === 'string' && trusted.test(host)) return true
    }
  }
  return request.headers['sec-fetch-site'] === 'same-origin'
}

export const inject = ['webServer']
export function apply(ctx, config) {
  const service = new WashService(config)
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('dsh-wash: 宿主没有 webServer，面板不可用')
    return
  }
  const webRuntime = ctx.get('webRuntime')
  const trustedHosts = Array.isArray(webRuntime?.trustedHosts) ? webRuntime.trustedHosts : []

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (request, response) => {
        if (!isTrusted(request, trustedHosts)) {
          writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: '请求来源未通过校验' } })
          return
        }
        if (request.method !== 'POST') {
          writeJson(response, 405, { ok: false, error: { code: 'invalid', message: '仅支持 POST' } })
          return
        }
        const method = (request.url ?? '').slice(ROUTE_PREFIX.length).replace(/^\//, '').split('?')[0]
        let body = {}
        try {
          const raw = await readBody(request)
          body = raw.length === 0 ? {} : JSON.parse(raw)
        } catch (error) {
          writeJson(response, 400, { ok: false, error: { code: 'invalid', message: messageOf(error) } })
          return
        }
        try {
          let data
          if (method === 'list') data = service.list()
          else if (method === 'scan') data = service.scan(body.id)
          else if (method === 'wash') {
            if (body.all === true) {
              const ids = service
                .scan()
                .results.filter((item) => item.ok === true && (item.dirtyMessages ?? 0) > 0)
                .map((item) => item.id)
              data = { results: ids.map((id) => service.wash(id)) }
            } else data = { results: [service.wash(String(body.id ?? ''))] }
          } else if (method === 'restore') data = { results: [service.restore(String(body.id ?? ''))] }
          else if (method === 'backups') data = service.backups(String(body.id ?? ''))
          else {
            writeJson(response, 404, { ok: false, error: { code: 'not-found', message: `未知接口：${method}` } })
            return
          }
          writeJson(response, 200, { ok: true, data })
        } catch (error) {
          writeJson(response, 200, {
            ok: false,
            error: { code: error?.code ?? 'internal', message: messageOf(error) },
          })
        }
      },
    }),
  )
}

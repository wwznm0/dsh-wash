/**
 * dsh-wash — Client half: sidebar panel + management page.
 *
 * Talks to the Host half over `/dsh-wash/api/<method>` (POST JSON envelope).
 *
 * @module dsh-wash/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-wash',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const PANEL_ID = 'dsh-wash'
    const ROUTE = '/dsh-wash/api'

    const TEXT = {
      title: '会话净化',
      subtitle: '扫出被抄进助手回复的输入信封，备份后清掉',
      refresh: '刷新',
      scanAll: '扫描全部',
      washDirty: '洗所有脏的',
      scanning: '扫描中…',
      washing: '清洗中…',
      session: '会话',
      workspace: '工作区',
      size: '大小',
      updated: '更新时间',
      dirty: '脏消息',
      backups: '备份',
      actions: '操作',
      scan: '扫描',
      wash: '洗',
      restore: '还原',
      clean: '干净',
      unknown: '未扫描',
      locked: '占用中',
      empty: '没有找到会话记录。',
      failed: '出错了',
      done: '完成',
      none: '—',
      confirmWash: '备份后重写这个会话记录？',
      confirmWashAll: '先扫描，再把所有脏会话备份后洗一遍？',
      confirmRestore: '用最近的备份覆盖这个会话记录？',
      resultOk: '洗好了',
      resultSkip: '不用洗',
      resultRestore: '已还原',
      total: '共',
    }

    function sizeText(bytes) {
      if (typeof bytes !== 'number') return TEXT.none
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
      return `${Math.max(1, Math.round(bytes / 1024))} KB`
    }

    function timeText(ms) {
      if (typeof ms !== 'number') return TEXT.none
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    async function call(method, payload) {
      let response
      try {
        response = await fetch(`${ROUTE}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload ?? {}),
        })
      } catch (error) {
        throw new Error(`${TEXT.failed}: ${String(error?.message ?? error)}`)
      }
      let envelope
      try {
        envelope = await response.json()
      } catch {
        throw new Error(`${TEXT.failed}: HTTP ${response.status}`)
      }
      if (envelope && envelope.ok === true) return envelope.data
      const message = envelope?.error?.message ?? `HTTP ${response.status}`
      throw new Error(message)
    }

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
        background: 'var(--dsw-alias-bg-base, #1e1e1e)',
        fontSize: 13,
        lineHeight: 1.5,
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #2e2e2e)',
        flex: '0 0 auto',
      },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      subtitle: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
      actions: { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' },
      button: {
        appearance: 'none',
        font: 'inherit',
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
        background: 'var(--dsw-alias-bg-layer-1, #252526)',
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
      },
      primary: {
        appearance: 'none',
        font: 'inherit',
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-accent, #2f6feb)',
        background: 'var(--dsw-alias-bg-accent, #1f4b8f)',
        color: '#fff',
      },
      body: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '10px 16px 28px' },
      row: {
        display: 'grid',
        gridTemplateColumns: 'minmax(180px, 1.6fr) minmax(140px, 1.2fr) 86px 118px 92px 60px auto',
        gap: 10,
        alignItems: 'center',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid transparent',
      },
      rowOdd: { background: 'var(--dsw-alias-bg-layer-1, #252526)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      dim: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', fontSize: 12 },
      badgeDirty: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 10,
        fontSize: 12,
        background: 'rgba(235, 87, 87, 0.18)',
        color: '#ff8a80',
        border: '1px solid rgba(235, 87, 87, 0.35)',
      },
      badgeClean: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 10,
        fontSize: 12,
        background: 'rgba(76, 175, 80, 0.16)',
        color: '#7bd88f',
        border: '1px solid rgba(76, 175, 80, 0.3)',
      },
      badgeLocked: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 10,
        fontSize: 12,
        background: 'rgba(255, 193, 7, 0.14)',
        color: '#ffd54f',
        border: '1px solid rgba(255, 193, 7, 0.3)',
      },
      toast: {
        position: 'sticky',
        bottom: 0,
        margin: '10px 16px 14px',
        padding: '8px 12px',
        borderRadius: 8,
        fontSize: 12,
        background: 'var(--dsw-alias-bg-layer-2, #2d2d30)',
        border: '1px solid var(--dsw-alias-border-l1, #2e2e2e)',
      },
    }

    function WashPanelIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 18
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          'aria-hidden': true,
          focusable: 'false',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: props?.active === true ? 1.7 : 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { display: 'block' },
        },
        h('path', { d: 'M3 13.2 6.4 9.8' }),
        h('path', { d: 'M5.2 7.6 8.4 10.8' }),
        h('path', { d: 'M7 5.6 10.4 2.2l3.4 3.4-3.4 3.4z' }),
        h('path', { d: 'M2.2 13.8 4.4 11.6' }),
      )
    }

    function WashPage() {
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState('')
      const [toast, setToast] = useState(null)
      const [error, setError] = useState(null)

      const notify = useCallback((message) => {
        setToast({ message, at: Date.now() })
      }, [])

      const refresh = useCallback(async () => {
        try {
          setError(null)
          const next = await call('list', {})
          setData(next)
        } catch (caught) {
          setError(String(caught?.message ?? caught))
        }
      }, [])

      useEffect(() => {
        void refresh()
      }, [refresh])

      useEffect(() => {
        if (toast === null) return undefined
        const timer = window.setTimeout(() => setToast(null), 4000)
        return () => window.clearTimeout(timer)
      }, [toast])

      const run = useCallback(
        async (label, action) => {
          setBusy(label)
          try {
            const result = await action()
            await refresh()
            notify(result)
          } catch (caught) {
            notify(`${TEXT.failed}: ${String(caught?.message ?? caught)}`)
          } finally {
            setBusy('')
          }
        },
        [notify, refresh],
      )

      const sessions = data?.sessions ?? []
      const headers = useMemo(
        () => [TEXT.session, TEXT.workspace, TEXT.size, TEXT.updated, TEXT.dirty, TEXT.backups, TEXT.actions],
        [],
      )

      const washAll = () => {
        if (!window.confirm(TEXT.confirmWashAll)) return
        void run(TEXT.washing, async () => {
          const result = await call('wash', { all: true })
          const rows = result?.results ?? []
          const ok = rows.filter((row) => row.ok === true && row.changed === true).length
          const busy = rows.filter((row) => row.busy === true).length
          return `洗了 ${ok} 个会话${busy > 0 ? `，${busy} 个占用中跳过` : ''}`
        })
      }

      const scanAll = () =>
        run(TEXT.scanning, async () => {
          const result = await call('scan', {})
          const dirty = (result?.results ?? []).filter((item) => (item.dirtyMessages ?? 0) > 0).length
          return `${TEXT.done}：扫描 ${result?.results?.length ?? 0} 个，${dirty} 个脏`
        })

      const washOne = (id) => {
        if (!window.confirm(TEXT.confirmWash)) return
        void run(TEXT.washing, async () => {
          const result = await call('wash', { id })
          const row = result?.results?.[0]
          if (row?.ok !== true) throw new Error(row?.error ?? '未知错误')
          return row.changed === true
            ? `${TEXT.resultOk}：${row.dirtyMessages} 条脏消息，省了 ${row.dirtyChars} 字`
            : TEXT.resultSkip
        })
      }

      const restoreOne = (id) => {
        if (!window.confirm(TEXT.confirmRestore)) return
        void run(TEXT.washing, async () => {
          const result = await call('restore', { id })
          const row = result?.results?.[0]
          if (row?.ok !== true) throw new Error(row?.error ?? '未知错误')
          return `${TEXT.resultRestore}：${row.backup}`
        })
      }

      const scanOne = (id) =>
        run(TEXT.scanning, async () => {
          const result = await call('scan', { id })
          const row = result?.results?.[0]
          if (row?.ok !== true) throw new Error(row?.error ?? '未知错误')
          return `扫描完成：${row.dirtyMessages} 条脏消息`
        })

      return h(
        'div',
        { style: styles.page },
        h(
          'div',
          { style: styles.head },
          h(
            'div',
            null,
            h('h1', { style: styles.title }, TEXT.title),
            h(
              'div',
              { style: styles.subtitle },
              data
                ? `${TEXT.total} ${data.totals.sessions} 个会话 · 脏 ${data.totals.dirty} · 占用中 ${data.totals.busy}`
                : TEXT.subtitle,
            ),
          ),
          h(
            'div',
            { style: styles.actions },
            h(
              'button',
              { style: styles.button, disabled: busy !== '', onClick: scanAll },
              busy === TEXT.scanning ? TEXT.scanning : TEXT.scanAll,
            ),
            h('button', { style: styles.button, disabled: busy !== '', onClick: () => void refresh() }, TEXT.refresh),
            h('button', { style: styles.primary, disabled: busy !== '', onClick: washAll }, TEXT.washDirty),
          ),
        ),
        h(
          'div',
          { style: styles.body },
          error !== null
            ? h('div', { style: { ...styles.toast, color: '#ff8a80' } }, `${TEXT.failed}: ${error}`)
            : null,
          sessions.length === 0
            ? h('div', { style: { ...styles.dim, padding: '18px 4px' } }, TEXT.empty)
            : h(
                'div',
                null,
                h(
                  'div',
                  { style: { ...styles.row, ...styles.dim, borderBottom: '1px solid var(--dsw-alias-border-l1, #2e2e2e)', borderRadius: 0 } },
                  ...headers.map((label, index) => h('div', { key: `${label}-${index}` }, label)),
                ),
                ...sessions.map((session, index) =>
                  h(
                    'div',
                    {
                      key: session.id,
                      style: { ...styles.row, ...(index % 2 === 1 ? styles.rowOdd : null) },
                    },
                    h(
                      'div',
                      { style: styles.mono, title: session.file },
                      session.id,
                      session.busy ? h('span', { style: { ...styles.badgeLocked, marginLeft: 8 } }, TEXT.locked) : null,
                    ),
                    h('div', { style: styles.dim, title: session.workspace }, session.workspace),
                    h('div', { style: styles.dim }, sizeText(session.size)),
                    h('div', { style: styles.dim }, timeText(session.mtime)),
                    h(
                      'div',
                      null,
                      session.dirtyMessages === null
                        ? h('span', { style: styles.dim }, TEXT.unknown)
                        : session.dirtyMessages > 0
                          ? h('span', { style: styles.badgeDirty }, `${session.dirtyMessages} 条`)
                          : h('span', { style: styles.badgeClean }, TEXT.clean),
                    ),
                    h('div', { style: styles.dim }, session.backups > 0 ? String(session.backups) : TEXT.none),
                    h(
                      'div',
                      { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
                      h(
                        'button',
                        { style: styles.button, disabled: busy !== '', onClick: () => scanOne(session.id) },
                        TEXT.scan,
                      ),
                      h(
                        'button',
                        {
                          style: session.busy ? styles.button : styles.primary,
                          disabled: busy !== '' || session.busy,
                          onClick: () => washOne(session.id),
                        },
                        TEXT.wash,
                      ),
                      h(
                        'button',
                        {
                          style: styles.button,
                          disabled: busy !== '' || session.busy || session.backups === 0,
                          onClick: () => restoreOne(session.id),
                        },
                        TEXT.restore,
                      ),
                    ),
                  ),
                ),
              ),
        ),
        toast !== null ? h('div', { style: styles.toast }, toast.message) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => TEXT.title },
            WashPanelIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: 'dsh-wash' }, WashPage),
        )
      },
    }
  },
})

// src/panel/panel-feedback-palette.js
// Side Panel Feedback / Issue Report Modal, Keyboard Shortcuts Modal, and Command Palette (Ctrl+K)

import {
  DATANOA_VERSION,
  ENGINE_BY_ID,
  sanitizeFeedbackError,
  buildPanelFeedbackMarkdown,
  buildGithubIssueUrl,
} from './panel-core.js'
import { $ } from './panel-utils.js'

export function createPanelFeedbackAndPaletteController(ctx) {
  const {
    state,
    getActiveConn,
    closeContextMenu,
    closeDataColsPopover,
    closePanelComboPopover,
    resetConnectionForm,
    setFormOpen,
    openFullStudio,
    switchTab,
    formatSqlInEditor,
    openCreateTableModal,
    refreshConnections,
    copyText,
    showBanner,
    onThemeToggled,
  } = ctx

  let feedbackKind = 'bug'
  let cmdPaletteActiveIdx = 0
  let filteredPaletteCommands = []

  function detectPanelOrcaApiVersion() {
    const api = window.orca?.api
    if (api && typeof api.major === 'number') {
      return typeof api.minor === 'number' ? `v${api.major}.${api.minor}` : `v${api.major}`
    }
    return 'v1'
  }

  function detectPanelPlatform() {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    const label = nav?.userAgentData?.platform || nav?.platform || ''
    return String(label).trim() || 'unknown'
  }

  function getPanelFeedbackPayload() {
    const conn = getActiveConn()
    return {
      kind: feedbackKind,
      title: $('feedbackTitleInput')?.value || '',
      description: $('feedbackDescInput')?.value || '',
      driver: conn?.driver || '',
      tab: state.tab || 'explorer',
      readOnly: Boolean(conn?.readOnly),
      orcaApi: detectPanelOrcaApiVersion(),
      platform: detectPanelPlatform(),
      lastError: state.lastError || '',
      version: DATANOA_VERSION,
    }
  }

  function renderFeedbackDiagnostics() {
    const grid = $('feedbackDiagGrid')
    if (!grid) return
    const payload = getPanelFeedbackPayload()
    const eng = payload.driver ? ENGINE_BY_ID[payload.driver] : null
    const engineText = eng ? `${eng.label} (${eng.id})` : 'None'
    const safeErr = sanitizeFeedbackError(payload.lastError)
    const items = [
      ['Plugin', `Datanoa v${DATANOA_VERSION}`],
      ['Orca API', payload.orcaApi],
      ['Surface', 'Side Panel'],
      ['Active Engine', engineText],
      ['Active Tab', payload.tab],
      ['Read-Only', payload.readOnly ? 'Yes' : 'No'],
      ['Platform', payload.platform],
    ]
    if (feedbackKind === 'bug' && safeErr) {
      items.push(['Last Error', safeErr.length > 44 ? `${safeErr.slice(0, 41)}...` : safeErr])
    }
    grid.textContent = ''
    for (const [k, v] of items) {
      const cell = document.createElement('div')
      cell.style.overflow = 'hidden'
      cell.style.textOverflow = 'ellipsis'
      cell.style.whiteSpace = 'nowrap'
      const strong = document.createElement('strong')
      strong.style.color = 'var(--t1)'
      strong.textContent = `${k}: `
      const span = document.createElement('span')
      span.textContent = v
      cell.append(strong, span)
      grid.appendChild(cell)
    }
  }

  function setFeedbackKind(nextKind) {
    feedbackKind = nextKind === 'feature' ? 'feature' : 'bug'
    $('feedbackKindBugBtn')?.classList.toggle('active', feedbackKind === 'bug')
    $('feedbackKindFeatureBtn')?.classList.toggle('active', feedbackKind === 'feature')
    if ($('feedbackDescLabel')) {
      $('feedbackDescLabel').textContent =
        feedbackKind === 'feature'
          ? 'Problem / Proposed Feature or UI Improvement'
          : 'Steps to Reproduce / Expected Behavior'
    }
    if ($('feedbackTitleInput')) {
      $('feedbackTitleInput').placeholder =
        feedbackKind === 'feature'
          ? 'e.g. Add export preset for PostgreSQL COPY...'
          : 'Short summary of the bug or issue...'
    }
    renderFeedbackDiagnostics()
  }

  function openFeedbackModal(initialKind = 'bug') {
    closeContextMenu()
    closeDataColsPopover()
    closePanelComboPopover()
    setFeedbackKind(initialKind)
    const modal = $('feedbackModal')
    if (!modal) return
    modal.hidden = false
    $('feedbackTitleInput')?.focus()
  }

  function closeFeedbackModal() {
    const modal = $('feedbackModal')
    if (modal) modal.hidden = true
  }

  function openShortcutsModal() {
    closeContextMenu()
    closeDataColsPopover()
    const modal = $('shortcutsModal')
    if (modal) modal.hidden = false
  }

  function closeShortcutsModal() {
    const modal = $('shortcutsModal')
    if (modal) modal.hidden = true
  }

  function getPanelPaletteCommands() {
    return [
      {
        label: 'Report Bug / Request Feature...',
        kbd: 'GitHub',
        keywords: 'feedback bug issue report feature request github support',
        run: () => openFeedbackModal('bug'),
      },
      {
        label: 'Request a Feature / UI Improvement...',
        kbd: 'GitHub',
        keywords: 'feature request enhancement suggestion feedback github',
        run: () => openFeedbackModal('feature'),
      },
      {
        label: 'New Database Connection...',
        kbd: '+ Connect',
        keywords:
          'connect new database server sqlite postgres mysql mariadb cockroach clickhouse redis libsql',
        run: () => {
          resetConnectionForm()
          setFormOpen(true)
        },
      },
      {
        label: 'Open Full-Screen Studio Tab',
        kbd: 'Studio',
        keywords: 'studio fullscreen editor tab open',
        run: () => void openFullStudio(),
      },
      {
        label: 'Switch to Explorer Tab',
        kbd: 'Tab 1',
        keywords: 'explorer tree schema tables connections',
        run: () => switchTab('explorer'),
      },
      {
        label: 'Switch to Data Grid Tab',
        kbd: 'Tab 2',
        keywords: 'data grid browse rows table',
        run: () => switchTab('data'),
      },
      {
        label: 'Switch to SQL Console Tab',
        kbd: 'Tab 3',
        keywords: 'sql query console editor execute',
        run: () => switchTab('sql'),
      },
      {
        label: 'Switch to Schema Designer Tab',
        kbd: 'Tab 4',
        keywords: 'schema structure columns indexes foreign keys ddl',
        run: () => switchTab('structure'),
      },
      {
        label: 'Format SQL Query',
        kbd: 'Shift+Alt+F',
        keywords: 'format prettify sql query indent',
        run: () => {
          switchTab('sql')
          formatSqlInEditor()
        },
      },
      {
        label: 'Create New Table...',
        kbd: '+ Table',
        keywords: 'create new table ddl schema',
        run: () => openCreateTableModal(),
      },
      {
        label: 'Refresh Connections & Schema',
        kbd: 'Refresh',
        keywords: 'refresh reload connections schema',
        run: () => void refreshConnections(),
      },
      {
        label: 'Keyboard Shortcuts (?)',
        kbd: 'Ctrl+/',
        keywords: 'keyboard shortcuts help cheatsheet',
        run: () => openShortcutsModal(),
      },
      {
        label: 'Toggle Light / Dark Theme',
        kbd: 'Theme',
        keywords: 'toggle theme light dark appearance mode color scheme',
        run: () => {
          const isLight = !document.documentElement.classList.contains('light')
          document.documentElement.classList.toggle('light', isLight)
          document.documentElement.classList.toggle('dark', !isLight)
          document.documentElement.dataset.themeOverride = isLight ? 'light' : 'dark'
          document.body?.classList.toggle('light', isLight)
          document.body?.classList.toggle('dark', !isLight)
          if (typeof onThemeToggled === 'function') {
            onThemeToggled(isLight)
          }
        },
      },
    ]
  }

  function renderCmdPaletteList() {
    const listEl = $('cmdPaletteList')
    if (!listEl) return
    const q = String($('cmdPaletteInput')?.value || '').trim().toLowerCase()
    const all = getPanelPaletteCommands()
    filteredPaletteCommands = q
      ? all.filter((c) => c.label.toLowerCase().includes(q) || c.keywords.includes(q))
      : all
    if (cmdPaletteActiveIdx >= filteredPaletteCommands.length) {
      cmdPaletteActiveIdx = Math.max(0, filteredPaletteCommands.length - 1)
    }
    listEl.textContent = ''
    if (filteredPaletteCommands.length === 0) {
      const empty = document.createElement('div')
      empty.style.padding = '10px 8px'
      empty.style.fontSize = '11.5px'
      empty.style.color = 'var(--t3)'
      empty.textContent = 'No matching commands'
      listEl.appendChild(empty)
      return
    }
    filteredPaletteCommands.forEach((cmd, idx) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `cmd-palette-item${idx === cmdPaletteActiveIdx ? ' active' : ''}`
      const lbl = document.createElement('span')
      lbl.textContent = cmd.label
      btn.appendChild(lbl)
      if (cmd.kbd) {
        const kbd = document.createElement('kbd')
        kbd.className = 'cmd-palette-kbd'
        kbd.textContent = cmd.kbd
        btn.appendChild(kbd)
      }
      btn.addEventListener('click', () => {
        closeCmdPaletteModal()
        cmd.run()
      })
      listEl.appendChild(btn)
    })
  }

  function openCmdPaletteModal() {
    closeContextMenu()
    closeDataColsPopover()
    closePanelComboPopover()
    const modal = $('cmdPaletteModal')
    if (!modal) return
    cmdPaletteActiveIdx = 0
    if ($('cmdPaletteInput')) $('cmdPaletteInput').value = ''
    renderCmdPaletteList()
    modal.hidden = false
    $('cmdPaletteInput')?.focus()
  }

  function closeCmdPaletteModal() {
    const modal = $('cmdPaletteModal')
    if (modal) modal.hidden = true
  }

  function bindEvents() {
    $('feedbackBtn')?.addEventListener('click', () => openFeedbackModal('bug'))
    $('feedbackKindBugBtn')?.addEventListener('click', () => setFeedbackKind('bug'))
    $('feedbackKindFeatureBtn')?.addEventListener('click', () => setFeedbackKind('feature'))
    $('feedbackCancelBtn')?.addEventListener('click', closeFeedbackModal)
    $('feedbackModal')?.addEventListener('click', (e) => {
      if (e.target === $('feedbackModal')) closeFeedbackModal()
    })
    $('feedbackCopyBtn')?.addEventListener('click', (e) => {
      const md = buildPanelFeedbackMarkdown(getPanelFeedbackPayload())
      void copyText(md, 'Diagnostic report copied to clipboard', e.currentTarget)
    })
    $('feedbackOpenGithubBtn')?.addEventListener('click', async (e) => {
      const payload = getPanelFeedbackPayload()
      const markdownBody = buildPanelFeedbackMarkdown(payload)
      const url = buildGithubIssueUrl({
        kind: payload.kind,
        title: payload.title,
        markdownBody,
      })
      const btn = e.currentTarget
      try {
        if (window.orca?.shell?.openExternal) {
          const res = await window.orca.shell.openExternal(url)
          if (res && res.opened) {
            closeFeedbackModal()
            showBanner('Opened GitHub Issue composer in browser', 'success')
            return
          }
          if (res && res.reason === 'cancelled') {
            return
          }
        }
        const win =
          typeof window.open === 'function'
            ? window.open(url, '_blank', 'noopener,noreferrer')
            : null
        if (win) {
          closeFeedbackModal()
          showBanner('Opened GitHub Issue composer in browser', 'success')
          return
        }
      } catch {}
      await copyText(
        markdownBody,
        'Report copied — paste at github.com/Thanhh2615/datanoa/issues',
        btn
      )
    })

    $('shortcutsBtn')?.addEventListener('click', openShortcutsModal)
    $('shortcutsCloseBtn')?.addEventListener('click', closeShortcutsModal)
    $('shortcutsModal')?.addEventListener('click', (e) => {
      if (e.target === $('shortcutsModal')) closeShortcutsModal()
    })

    $('cmdPaletteModal')?.addEventListener('click', (e) => {
      if (e.target === $('cmdPaletteModal')) closeCmdPaletteModal()
    })
    $('cmdPaletteInput')?.addEventListener('input', () => {
      cmdPaletteActiveIdx = 0
      renderCmdPaletteList()
    })
    $('cmdPaletteInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (filteredPaletteCommands.length > 0) {
          cmdPaletteActiveIdx = (cmdPaletteActiveIdx + 1) % filteredPaletteCommands.length
          renderCmdPaletteList()
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (filteredPaletteCommands.length > 0) {
          cmdPaletteActiveIdx =
            (cmdPaletteActiveIdx - 1 + filteredPaletteCommands.length) %
            filteredPaletteCommands.length
          renderCmdPaletteList()
        }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const target = filteredPaletteCommands[cmdPaletteActiveIdx]
        if (target) {
          closeCmdPaletteModal()
          target.run()
        }
      }
    })
  }

  return {
    openFeedbackModal,
    closeFeedbackModal,
    openShortcutsModal,
    closeShortcutsModal,
    openCmdPaletteModal,
    closeCmdPaletteModal,
    bindEvents,
  }
}

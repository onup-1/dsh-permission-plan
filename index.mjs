/**
 * dsh-permission-plan — one dialog for everything a task will need, then keywords instead of prompts.
 *
 * Two behaviours that belong together:
 *
 *   1. Plan first. Before starting work that will need escalations, the model calls
 *      `permission_plan` once with the operations it expects. The plugin groups them into
 *      clusters, shows the human ONE approval dialog, and — on approval — remembers the
 *      keywords of that batch.
 *
 *   2. Keywords instead of prompts. Every escalation request that this plugin does not
 *      auto-approve falls through to the human. When the human grants it, the reason text is
 *      scanned for domain keywords and those keywords are remembered. Later requests whose
 *      reason contains a remembered keyword are granted without asking again.
 *
 * Destructive wording never auto-approves, and `plugin_manager` never does either: a stale
 * keyword must not be able to delete something or install a bundle.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STORE = join(HERE, 'learned.json')
const STATS = join(HERE, 'stats.jsonl')

const VERSION = 1
const KEYWORD_CAP = 800
const DECISION_CAP = 100000

/** Tools whose approval requests may be auto-granted. `plugin_manager` is deliberately absent. */
const AUTO_TOOLS = new Set(['pwsh', 'bash', 'write', 'edit', 'read', 'glob', 'grep'])

/** Destructive wording: always ask, whatever keywords match. */
const DANGER_PATTERN =
  /(taskkill|pkill|killall|\brm\b|\brmdir\b|\brd\b|\bdel\b|\berase\b|\bformat\b|\bmkfs\b|\bshutdown\b|\breboot\b|Remove-Item|Stop-Process|Clear-Content|\bwipe\b|删除|删掉|移除|清空)/i

/** Words that carry no approval signal on their own. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'need', 'needs', 'required',
  'requires', 'request', 'requests', 'sandbox', 'escalation', 'danger', 'full', 'access',
  'danger-full-access', 'command', 'commands', 'run', 'runs', 'running', 'file', 'files',
  'folder', 'directory', 'dir', 'path', 'paths', 'write', 'writes', 'read', 'reads', 'test',
  'tests', 'escalate', 'escalates', 'allow', 'deny', 'operation', 'operations', 'permission',
  'permissions', 'workspace', 'approval', 'approve', 'requested',
  '需要', '文件', '目录', '路径', '命令', '运行', '测试', '权限', '工作区', '沙箱', '提权',
  '这个', '那个', '我们', '可以', '一个', '进行', '处理', '提升', '切换', '资源', '校验'
])

/** Genuinely ambiguous words: one hit asks, two hits do not. */
const WEAK_KEYWORDS = new Set([
  'mod', 'java', 'jar', 'jvm', 'client', 'server', 'build', 'cache', 'mirror', 'source',
  'sources', 'wrapper', 'daemon', 'download', 'install', 'update',
  '环境', '缓存', '下载', '依赖', '构建', '镜像', '预热', '安装', '更新',
  // Generic enough that a single hit must not auto-approve: Minecraft mod work also
  // says "配置/config", and that domain belongs to dsh-mod-build-auto-approve.
  'config', 'configs', 'configure', 'setup',
  '配置', '设置'
])

const MIN_WEAK_HITS = 2
const BUILTIN_HIT = '(plan)'

/** Cluster rules: label, matcher and the words worth remembering when the cluster is approved. */
const CLUSTERS = [
  { id: 'fs-write', label: '写入工作区之外的文件', re: /(\bwrite\b|\bsave\b|\bcopy\b|\bmove\b|\brename\b|\bmkdir\b|写入|写入到|保存|复制|移动|重命名|新建目录|覆盖)/i },
  { id: 'process', label: '启动/结束本地进程', re: /(\bstart\b|\bspawn\b|\bnpm\b|\bpnpm\b|\bpip\b|\bgradle\b|\bmvn\b|\bjava\b|\bnode\b|\bpython\b|\bcsc\b|启动|运行|执行|编译|构建)/i },
  { id: 'network', label: '访问网络/下载依赖', re: /(\bdownload\b|\bwget\b|\bcurl\b|\bhttp\b|\bhttps\b|\bgit\s+clone\b|下载|拉取|镜像|接口)/i },
  { id: 'install', label: '安装、升级软件包', re: /(\binstall\b|\bupgrade\b|\bunzip\b|\bextract\b|\bpackage\b|安装|升级|解压|依赖包)/i },
  { id: 'system', label: '修改系统级配置', re: /(\bhosts\b|\bregistry\b|\bservice\b|\bscheduled\s+task\b|\bschtasks\b|\bipconfig\b|注册表|服务|计划任务|系统配置|防火墙)/i },
  { id: 'elevate', label: '请求管理员权限', re: /(\badmin\b|\buac\b|\bsudo\b|\belevat|\brunas\b|管理员|提权|以管理员)/i },
  { id: 'destructive', label: '删除或终止（永不自动放行）', re: DANGER_PATTERN }
]

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function emptyStore() {
  return {
    version: VERSION,
    keywords: [],
    promoted: [],
    plans: [],
    stats: { startedAt: new Date().toISOString(), lastAt: 0, totals: { auto: 0, human: 0, rejected: 0, plan: 0 } },
    updatedAt: 0
  }
}

function loadStore() {
  const raw = readJson(STORE, undefined)
  const store = emptyStore()
  if (raw === null || typeof raw !== 'object') return store
  if (Array.isArray(raw.keywords)) {
    for (const entry of raw.keywords) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.word !== 'string' || entry.word.trim() === '') continue
      store.keywords.push({
        word: entry.word.trim(),
        at: Number.isFinite(entry.at) ? entry.at : 0,
        uses: Number.isFinite(entry.uses) ? entry.uses : 0,
        source: typeof entry.source === 'string' ? entry.source : 'manual'
      })
    }
  }
  if (Array.isArray(raw.promoted)) {
    for (const word of raw.promoted) {
      if (typeof word === 'string' && word.trim() !== '') store.promoted.push(word.trim())
    }
  }
  if (Array.isArray(raw.plans)) {
    for (const plan of raw.plans.slice(-40)) {
      if (plan !== null && typeof plan === 'object' && typeof plan.at === 'number') store.plans.push(plan)
    }
  }
  if (raw.stats !== null && typeof raw.stats === 'object') {
    store.stats.startedAt = typeof raw.stats.startedAt === 'string' ? raw.stats.startedAt : store.stats.startedAt
    store.stats.lastAt = Number.isFinite(raw.stats.lastAt) ? raw.stats.lastAt : 0
    if (raw.stats.totals !== null && typeof raw.stats.totals === 'object') {
      for (const key of Object.keys(store.stats.totals)) {
        if (Number.isFinite(raw.stats.totals[key])) store.stats.totals[key] = raw.stats.totals[key]
      }
    }
  }
  return store
}

function saveStore(store) {
  store.updatedAt = Date.now()
  try {
    mkdirSync(HERE, { recursive: true })
    writeFileSync(STORE, JSON.stringify(store, null, 2), 'utf8')
  } catch {
    // Storage is best-effort; a read-only profile still works for this session's decisions.
  }
}

function recordDecision(entry) {
  try {
    mkdirSync(HERE, { recursive: true })
    appendFileSync(STATS, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // Recording is best-effort.
  }
}

function readDecisions(maxLines = DECISION_CAP) {
  let text
  try {
    text = readFileSync(STATS, 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n').filter((line) => line.length > 0)
  if (lines.length > DECISION_CAP) {
    try {
      writeFileSync(STATS, lines.slice(-DECISION_CAP).join('\n') + '\n', 'utf8')
    } catch {
      // A failed trim is harmless.
    }
  }
  const out = []
  for (const line of lines.slice(-maxLines)) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // Skip a torn line.
    }
  }
  return out
}

function reasonText(req) {
  const parts = [req?.reason, req?.displayReason, req?.description, req?.detail]
  return parts.filter((part) => typeof part === 'string' && part.trim() !== '').join(' ')
}

/** Stopwords that are also valid CJK substrings: stripped before CJK segmentation. */
const CJK_STOPWORDS = [...STOPWORDS].filter((word) => /[\u4e00-\u9fff]/.test(word)).sort((a, b) => b.length - a.length)

/** Single-character particles: dropped so the tail slice lands on a real word ("里的配置" -> "读取配置"). */
const CJK_PARTICLES = ['的', '了', '里', '和', '与', '及', '在', '对', '把', '被', '就', '还', '也', '都', '而', '或', '从', '到', '向', '为', '是', '有', '这', '那', '个', '们', '会', '要', '并', '将', '已', '再', '又']

/**
 * CJK has no spaces, so a greedy 6-character regex produced fragments like "一次性权限批" / "量申请"
 * that never match anything useful. Strip the domain-neutral words and particles first, then keep
 * short pieces whole and cut longer runs down to their trailing 4 characters ("构建环境", "本地检查").
 */
function cjkKeywords(text) {
  let rest = text
  for (const word of CJK_STOPWORDS) rest = rest.split(word).join('|')
  for (const particle of CJK_PARTICLES) rest = rest.split(particle).join('|')
  const words = []
  for (const run of rest.split(/[^\u4e00-\u9fff]+/)) {
    if (run.length < 2) continue
    if (run.length <= 4) {
      words.push(run)
      continue
    }
    // Keep one representative head phrase per long run (the trailing 4 characters usually carry
    // the noun: "构建环境", "下载依赖", "本地检查"), instead of every overlapping 4-gram.
    words.push(run.slice(-4))
  }
  return words
}

/** Split a request/reason into candidate words: latin tokens and CJK pieces. */
function extractKeywords(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const words = []
  const latin = text.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) ?? []
  for (const word of latin) {
    const lower = word.toLowerCase().replace(/[.]+$/, '')
    if (lower.length < 3 || STOPWORDS.has(lower)) continue
    words.push(lower)
  }
  words.push(...cjkKeywords(text))
  return [...new Set(words)].slice(0, 24)
}

function matchedKeywords(text, store) {
  const haystack = String(text ?? '').toLowerCase()
  const hits = []
  for (const entry of store.keywords) {
    const word = entry.word.toLowerCase()
    const isCjk = /[\u4e00-\u9fff]/.test(word)
    const hit = isCjk ? haystack.includes(word) : new RegExp(`(^|[^a-z0-9_.])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_.]|$)`, 'i').test(haystack)
    if (hit) {
      hits.push(entry.word)
      entry.uses += 1
    }
  }
  return hits
}

/** Decide whether a live approval request can be granted without asking. */
function classify(req, store) {
  const text = reasonText(req)
  const blocked = DANGER_PATTERN.test(text)
  const hits = matchedKeywords(text, store)
  const strong = hits.filter((word) => !WEAK_KEYWORDS.has(word.toLowerCase()))
  const weak = hits.filter((word) => WEAK_KEYWORDS.has(word.toLowerCase()))
  const promoted = new Set(store.promoted.map((word) => word.toLowerCase()))
  const weakOk = weak.filter((word) => promoted.has(word.toLowerCase()) || !WEAK_KEYWORDS.has(word.toLowerCase()))
  const allowedTool = req?.toolName === undefined ? true : AUTO_TOOLS.has(String(req.toolName))
  const auto = !blocked && allowedTool && (strong.length > 0 || weakOk.length >= MIN_WEAK_HITS || weak.length >= MIN_WEAK_HITS)
  return { auto, blocked, hits, allowedTool, tool: req?.toolName }
}

function remember(store, words, source) {
  const now = Date.now()
  const known = new Set(store.keywords.map((entry) => entry.word.toLowerCase()))
  let added = 0
  for (const raw of words) {
    const word = String(raw ?? '').trim()
    if (word.length < 2 || STOPWORDS.has(word.toLowerCase())) continue
    if (known.has(word.toLowerCase())) continue
    store.keywords.push({ word, at: now, uses: 0, source })
    known.add(word.toLowerCase())
    added += 1
  }
  // Keep the table small: drop the least recently used entries beyond the cap.
  if (store.keywords.length > KEYWORD_CAP) {
    store.keywords.sort((a, b) => b.uses - a.uses || b.at - a.at)
    store.keywords = store.keywords.slice(0, KEYWORD_CAP)
  }
  if (added > 0) saveStore(store)
  return added
}

function forget(store, word) {
  const target = String(word ?? '').trim().toLowerCase()
  const before = store.keywords.length
  store.keywords = store.keywords.filter((entry) => entry.word.toLowerCase() !== target)
  store.promoted = store.promoted.filter((entry) => entry.toLowerCase() !== target)
  if (store.keywords.length !== before) saveStore(store)
  return before - store.keywords.length
}

function clustersOf(text) {
  const haystack = String(text ?? '')
  return CLUSTERS.filter((cluster) => cluster.re.test(haystack)).map((cluster) => cluster.id)
}

function clusterLabel(id) {
  return CLUSTERS.find((cluster) => cluster.id === id)?.label ?? id
}

function bump(store, mode) {
  store.stats.totals[mode] = (store.stats.totals[mode] ?? 0) + 1
  store.stats.lastAt = Date.now()
}

export function apply(ctx) {
  const current = () => loadStore()

  // ---------------------------------------------------------------- feature 2: keywords
  ctx.on(
    'approval/request',
    async (req, next) => {
      let store
      try {
        store = current()
        const verdict = classify(req, store)
        if (verdict.auto) {
          bump(store, 'auto')
          saveStore(store)
          recordDecision({ at: Date.now(), tool: req?.toolName, mode: 'auto', hits: verdict.hits, reason: String(req?.reason ?? '').slice(0, 160) })
          return 'allowed-once'
        }
      } catch {
        // A malformed request must never break the approval chain.
      }

      let outcome
      try {
        outcome = await next()
      } catch {
        return 'unavailable'
      }

      try {
        const live = current()
        // Never learn from a destructive request: one approved deletion must not generalise.
        if (outcome === 'allowed-once' && req?.toolName !== 'plugin_manager' && !DANGER_PATTERN.test(reasonText(req))) {
          const words = extractKeywords(reasonText(req))
          const added = remember(live, words, 'manual')
          bump(live, 'human')
          saveStore(live)
          recordDecision({ at: Date.now(), tool: req?.toolName, mode: 'human', hits: words, added, reason: String(req?.reason ?? '').slice(0, 160) })
          const weakNow = words.filter((word) => WEAK_KEYWORDS.has(word.toLowerCase()))
          if (weakNow.length > 0) {
            live.promoted = [...new Set([...live.promoted, ...weakNow])]
            saveStore(live)
          }
        } else if (outcome === 'rejected') {
          bump(live, 'rejected')
          saveStore(live)
          recordDecision({ at: Date.now(), tool: req?.toolName, mode: 'rejected', hits: [], reason: String(req?.reason ?? '').slice(0, 160) })
        }
      } catch {
        // Learning is best-effort.
      }

      return outcome
    },
    { prepend: true }
  )

  // ---------------------------------------------------------------- tools
  const tools = (() => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
    } catch {
      return undefined
    }
  })()
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return

  const disposers = []
  const keep = (disposer) => {
    if (typeof disposer === 'function') disposers.push(disposer)
  }

  // ---- permission_plan: one dialog for the whole task
  keep(
    tools.register({
      name: 'permission_plan',
      description:
        'Call this ONCE before starting work that will need sandbox escalations (writing outside the workspace, ' +
        'starting processes, downloading dependencies, editing system files). Pass every operation you expect to ' +
        'perform; the plugin groups them into permission clusters and asks the human a single combined question. ' +
        'Approval is remembered as keywords, so the following commands of the same kind stop prompting.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'One line per operation you will need, in the user language, e.g. "写 D:\\Gradle 缓存".'
          },
          task: {
            type: 'string',
            description: 'Optional task description; used to guess additional clusters and keywords.'
          },
          note: { type: 'string', description: 'Optional context shown above the list.' },
          scope: { type: 'string', description: 'Optional scope note, e.g. the project path this approval is for.' }
        },
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            approved: { type: 'boolean' },
            clusters: { type: 'array', items: { type: 'string' } },
            learned: { type: 'array', items: { type: 'string' } },
            blocked: { type: 'array', items: { type: 'string' } }
          },
          required: ['approved', 'clusters', 'learned', 'blocked'],
          additionalProperties: false
        },
        render(_args, value) {
          if (value?.approved === true) {
            const clusters = (value.clusters ?? []).join('、') || '（无）'
            return [{ type: 'text', text: `已一次性批准：${clusters}。记住关键词 ${(value.learned ?? []).length} 个，之后同类请求自动放行。` }]
          }
          return [{ type: 'text', text: '未获得批量授权：之后的提权请求仍会逐条询问。' }]
        }
      },
      async execute(args, exec) {
        const items = Array.isArray(args?.items)
          ? args.items.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
          : []
        const task = typeof args?.task === 'string' ? args.task : ''
        if (items.length === 0 && task.trim() === '') {
          return { approved: false, clusters: [], learned: [], blocked: ['没有提供任何操作项'] }
        }

        const blob = [task, ...items].join('\n')
        const clusters = clustersOf(blob)
        const destructive = clusters.includes('destructive')
        const agent = exec?.agent ?? exec?.session?.agent
        const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : undefined

        const detailLines = []
        if (args?.note !== undefined) detailLines.push(String(args.note))
        if (args?.scope !== undefined) detailLines.push(`范围：${String(args.scope)}`)
        if (items.length > 0) {
          detailLines.push('本次要做的操作：')
          items.forEach((item, index) => detailLines.push(`  ${index + 1}. ${item}`))
        }
        if (clusters.length > 0) {
          detailLines.push(`涉及权限类别：${clusters.map(clusterLabel).join('、')}`)
        }
        detailLines.push('批准后：这些类别里的同类请求不再弹窗；删除/终止类操作永远单独询问。')

        let approved = false
        try {
          const questions = typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined
          if (questions !== undefined && typeof questions.ask === 'function') {
            const answer = await questions.ask({
              ...(agent === undefined ? {} : { agent }),
              questions: [{
                id: 'permission-plan',
                header: '一次性权限申请',
                question: '以下操作在开工前一次性批准吗？',
                detail: detailLines.join('\n'),
                options: [
                  { label: '全部批准', description: '本次列出的权限类别一次通过，之后同类自动放行' },
                  { label: '拒绝', description: '不授权，仍逐条弹出审批' }
                ],
                intent: { kind: 'approval', approve: '全部批准', reject: '拒绝' }
              }]
            })
            const selected = answer?.answers?.[0]?.selected ?? []
            approved = Array.isArray(selected) && selected.includes('全部批准')
          }
        } catch {
          approved = false
        }

        const store = current()
        const learned = []
        if (approved) {
          const words = extractKeywords(blob)
          remember(store, words, 'plan')
          learned.push(...words)
          for (const entry of store.keywords) {
            const lower = entry.word.toLowerCase()
            if (WEAK_KEYWORDS.has(lower) && !store.promoted.some((word) => word.toLowerCase() === lower)) {
              store.promoted.push(entry.word)
            }
          }
          store.plans.push({
            at: Date.now(),
            sessionId,
            items: items.slice(0, 40),
            clusters,
            keywords: learned.slice(0, 40),
            destructive
          })
          if (store.plans.length > 40) store.plans = store.plans.slice(-40)
          bump(store, 'plan')
          saveStore(store)
          recordDecision({ at: Date.now(), tool: 'permission_plan', mode: 'plan', hits: learned, reason: blob.slice(0, 160) })
        } else {
          bump(store, 'rejected')
          saveStore(store)
          recordDecision({ at: Date.now(), tool: 'permission_plan', mode: 'rejected', hits: [], reason: blob.slice(0, 160) })
        }

        return { approved, clusters, learned, blocked: destructive ? ['包含删除/终止类操作，仍需单独批准'] : [] }
      }
    })
  )

  // ---- permission_check: dry run, no dialog
  keep(
    tools.register({
      name: 'permission_check',
      description:
        'Dry run for permission_plan: report which permission clusters a task would touch, which remembered ' +
        'keywords already match, and whether anything destructive is involved. Shows no dialog.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The operations, command lines, or task description to check.' }
        },
        required: ['text'],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            clusters: { type: 'array', items: { type: 'string' } },
            hits: { type: 'array', items: { type: 'string' } },
            needsApproval: { type: 'boolean' },
            destructive: { type: 'boolean' },
            text: { type: 'string' }
          },
          required: ['clusters', 'hits', 'needsApproval', 'destructive', 'text'],
          additionalProperties: false
        },
        render(_args, value) {
          return [{ type: 'text', text: String(value?.text ?? '') }]
        }
      },
      async execute(args) {
        const text = typeof args?.text === 'string' ? args.text : ''
        const store = current()
        const clusters = clustersOf(text)
        const hits = matchedKeywords(text, store)
        const destructive = clusters.includes('destructive')
        const strong = hits.filter((word) => !WEAK_KEYWORDS.has(word.toLowerCase()))
        const needsApproval = destructive || (strong.length === 0 && hits.length < MIN_WEAK_HITS)
        const lines = [
          `权限类别：${clusters.length === 0 ? '（未识别）' : clusters.map(clusterLabel).join('、')}`,
          `已记住的关键词命中：${hits.length === 0 ? '（无）' : hits.join('、')}`,
          needsApproval ? '结论：这条需要人工审批，建议先调用 permission_plan。' : '结论：已有记住的权限，可以自动放行。',
          destructive ? '注意：包含删除/终止类操作，永远不会自动放行。' : ''
        ].filter((line) => line !== '')
        return { clusters, hits, needsApproval, destructive, text: lines.join('\n') }
      }
    })
  )

  // ---- permission_keywords: inspect / forget
  keep(
    tools.register({
      name: 'permission_keywords',
      description:
        'List, forget, or reset the remembered permission keywords. Use "list" to show the user what is already ' +
        'auto-approved, "forget" for one word, "reset" to forget everything.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'forget', 'reset'], description: 'What to do.' },
          keyword: { type: 'string', description: 'Required for action=forget.' }
        },
        required: ['action'],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' }, count: { type: 'number' } },
          required: ['text', 'count'],
          additionalProperties: false
        },
        render(_args, value) {
          return [{ type: 'text', text: String(value?.text ?? '') }]
        }
      },
      async execute(args) {
        const store = current()
        const action = String(args?.action ?? 'list')
        if (action === 'forget') {
          const removed = forget(store, args?.keyword)
          return { count: store.keywords.length, text: removed > 0 ? `已忘记关键词：${String(args?.keyword)}` : `没有这个关键词：${String(args?.keyword ?? '')}` }
        }
        if (action === 'reset') {
          const count = store.keywords.length
          store.keywords = []
          store.promoted = []
          saveStore(store)
          return { count: 0, text: `已清空全部关键词（原有 ${count} 个），之后所有提权都会重新询问。` }
        }
        const ranked = [...store.keywords].sort((a, b) => b.uses - a.uses || b.at - a.at)
        const lines = [`当前记住 ${store.keywords.length} 个关键词（上限 ${KEYWORD_CAP}）：`]
        for (const entry of ranked.slice(0, 60)) {
          const when = entry.at > 0 ? new Date(entry.at).toISOString().slice(0, 10) : '—'
          const weak = WEAK_KEYWORDS.has(entry.word.toLowerCase()) ? '（弱词）' : ''
          lines.push(`  ${entry.word.padEnd(24)} 命中 ${String(entry.uses).padStart(4)} 次 · ${entry.source} · ${when}${weak}`)
        }
        if (ranked.length === 0) lines.push('  （空）')
        return { count: store.keywords.length, text: lines.join('\n') }
      }
    })
  )

  // ---- permission_stats: what the gate actually saved
  keep(
    tools.register({
      name: 'permission_stats',
      description:
        'Report how many approval requests were granted automatically, how many still asked the human, and which ' +
        'keywords did the work. Use it when the user asks whether the permission gate is actually helping.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Timeline length (default 20, max 100).' } },
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false
        },
        render(_args, value) {
          return [{ type: 'text', text: String(value?.text ?? '') }]
        }
      },
      async execute(args) {
        const store = current()
        const limit = Math.min(100, Math.max(1, Number(args?.limit ?? 20)))
        const events = readDecisions()
        const totals = store.stats.totals
        const auto = events.filter((event) => event.mode === 'auto').length
        const human = events.filter((event) => event.mode === 'human').length
        const rejected = events.filter((event) => event.mode === 'rejected').length
        const plans = events.filter((event) => event.mode === 'plan').length
        const freq = new Map()
        for (const event of events) {
          if (event.mode !== 'auto') continue
          for (const word of event.hits ?? []) freq.set(word, (freq.get(word) ?? 0) + 1)
        }
        const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1])
        const lines = [
          `权限网关统计（起始 ${new Date(store.stats.startedAt).toLocaleString('zh-CN')}）`,
          `合计 ${events.length} 次：自动放行 ${auto} · 人工批准 ${human} · 拒绝 ${rejected} · 批量授权 ${plans}`,
          `当前关键词 ${store.keywords.length} 个，其中弱词提升 ${store.promoted.length} 个`,
          `累计计数：${JSON.stringify(totals)}`,
          ''
        ]
        if (ranked.length > 0) {
          lines.push('关键词命中次数：')
          for (const [word, count] of ranked.slice(0, 15)) lines.push(`  ${String(word).padEnd(24)} ${count}`)
          lines.push('')
        }
        lines.push(`时间线（最近 ${Math.min(limit, events.length)} 条）：`)
        const recent = events.slice(-limit)
        for (const event of recent) {
          const when = new Date(event.at).toTimeString().slice(0, 8)
          const hits = (event.hits ?? []).join(',') || '—'
          lines.push(`  ${when} | ${String(event.mode).padEnd(8)} | ${String(event.tool ?? '').padEnd(8)} | ${hits}`)
        }
        return { text: lines.join('\n') }
      }
    })
  )

  ctx.on('dispose', () => {
    for (const disposer of disposers) {
      try {
        disposer()
      } catch {
        // Already disposed.
      }
    }
  })
}

export const name = 'dsh-permission-plan'

export { classify, extractKeywords, clustersOf, matchedKeywords, CLUSTERS, WEAK_KEYWORDS, DANGER_PATTERN }

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

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
  '配置', '设置',
  // File-shuffling verbs are how ordinary work phrases itself, and "copy the file" says nothing
  // about where it lands; two of them (or one plus another strong word) may pass, one may not.
  'copy', 'move', 'write', 'rename',
  '复制', '移动', '写入', '重命名'
])

const MIN_WEAK_HITS = 2
const BUILTIN_HIT = '(plan)'

/**
 * Vocabulary that belongs to the Minecraft mod domain (`dsh-mod-build-auto-approve`).
 * Kept out of this plugin's word list so the two stores never blur together.
 */
const MOD_DOMAIN_KEYWORD = /^(fabric|loom|forge|forgegradle|gradle|gradlew|maven|minecraft|mixin|yarn|mcp|mdk|jdk\d*|bmclapi|daynight|daynight-tuner|runserver|runclient|mods?|modloader|模组)$/i

/** Broader detector for live requests: mod-flavoured text is judged by the mod plugin. */
const MOD_DOMAIN_TEXT = /(fabric|loom|forge|gradle|minecraft|mixin|\bmcp\b|\byarn\b|\bmods?\b|daynight|bmclapi|runserver|runclient|模组)/i

const MOD_PLUGIN_PACKAGE = 'dsh-mod-build-auto-approve'
const MOD_PLUGIN_PATCH_ID = 'mod-build-auto-approve'

/**
 * Zones are the framework's compartments: a request is classified into exactly one of
 * them, and each zone keeps its own vocabulary. `other` is the catch-all and its words
 * also apply inside the other zones (a generic word like `pwsh` is not domain specific).
 */
const GITHUB_ZONE_TEXT = /(github|git-ssl|\bgit\b|gist|\bgh\b|\bcli\b|commit|push|pull request|clone|merge|\bbranch\b|repo|raw\.githubusercontent|api\.github)/i
const ZONES = [
  { id: 'mod', label: 'Minecraft 模组', order: 0, pattern: MOD_DOMAIN_TEXT, delegate: MOD_PLUGIN_PACKAGE },
  { id: 'github', label: 'GitHub / 版本库', order: 1, pattern: GITHUB_ZONE_TEXT, delegate: null },
  { id: 'other', label: '其他', order: 2, pattern: null, delegate: null }
]
const ZONE_IDS = new Set(ZONES.map((zone) => zone.id))

function zoneOf(text) {
  const haystack = String(text ?? '')
  for (const zone of ZONES) {
    if (zone.pattern !== null && zone.pattern.test(haystack)) return zone.id
  }
  return 'other'
}

function zoneOfWord(word) {
  return zoneOf(word)
}

function zoneMeta(id) {
  return ZONES.find((zone) => zone.id === id) ?? ZONES[ZONES.length - 1]
}

/** Which zones' vocabularies may speak for a request in `zone`. */
function zoneScope(zone) {
  return zone === 'other' ? new Set(['other']) : new Set([zone, 'other'])
}

/**
 * Is the Minecraft mod approver actually running? When it is not (uninstalled or
 * disabled through plugin_manager), mod-flavoured requests fall back to this plugin
 * so the user is not left with per-command prompts.
 */
let modOwnerState = { at: 0, active: true, source: 'unknown' }
function modOwnerActive() {
  if (process.env.DSH_PERMISSION_PLAN_MOD_FALLBACK === '0') {
    modOwnerState = { at: Date.now(), active: true, source: 'fallback-off' }
    return true
  }
  const now = Date.now()
  if (now - modOwnerState.at < 15000) return modOwnerState.active
  let active = true
  let source = 'assumed'
  for (const home of [process.env.DSH_HOME, join(process.env.USERPROFILE || process.cwd(), '.dsh'), join(process.env.APPDATA || process.cwd(), 'dsh')]) {
    if (!home) continue
    try {
      const dir = join(home, 'profiles', process.env.DSH_PROFILE || 'desktop')
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const bundles = manifest?.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) continue
      source = dir
      active = bundles.includes(MOD_PLUGIN_PACKAGE)
      if (active) {
        try {
          const lines = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8').split(/\r?\n/)
          for (let index = 0; index < lines.length; index += 1) {
            if (!new RegExp(`^-\\s*id:\\s*${MOD_PLUGIN_PATCH_ID}\\s*$`).test(lines[index])) continue
            for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
              if (/^-\s/.test(lines[cursor])) break
              if (/^\s*disabled:\s*true\s*$/.test(lines[cursor])) active = false
            }
            break
          }
        } catch (error) {
          source = `${dir} (patch unreadable: ${String(error?.code ?? error)})`
        }
      } else {
        source = `${dir} (not in bundles)`
      }
      break
    } catch {
      continue
    }
  }
  modOwnerState = { at: now, active, source }
  return active
}

/**
 * Words the mod plugin learned are this framework's mod-zone vocabulary, so the two tables stay
 * in step without merging them: dsh-mod-build-auto-approve keeps serving people who only want
 * mod work to flow, and its newest words flow into the mod zone here.
 */
const MOD_LEGACY_WORDS = new Set([
  '复验构建', '构件', 'userdev', 'jar', 'gradle', 'gradlew', 'forge', 'fabric', 'loom', 'mixin',
  'mcp', 'yarn', 'minecraft', 'mod', 'mods', 'modloader', 'runserver', 'runclient', '模组', '构建产物'
])
/**
 * Words that stay weak forever, even after a plan was approved: "copy" on its own never says
 * where the file lands, so approving one plan must not turn it into a free pass.
 */
const NEVER_PROMOTE = new Set(['copy', 'move', 'write', 'rename', '复制', '移动', '写入', '重命名'])

const MOD_SYNC_MS = 15000
let modSyncState = { at: 0, file: '', mtimeMs: -1 }

function modStoreFile() {
  const override = process.env.DSH_PERMISSION_PLAN_MOD_STORE
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const profile = process.env.DSH_PROFILE || 'desktop'
  const homes = [process.env.DSH_HOME, join(process.env.USERPROFILE || process.cwd(), '.dsh'), join(process.env.APPDATA || process.cwd(), 'dsh')]
  for (const home of homes) {
    if (!home) continue
    const file = join(home, 'profiles', profile, 'node_modules', MOD_PLUGIN_PACKAGE, 'learned.json')
    try {
      if (statSync(file).isFile()) return file
    } catch {
      continue
    }
  }
  return undefined
}

function syncModZone(store) {
  const now = Date.now()
  if (now - modSyncState.at < MOD_SYNC_MS) return 0
  modSyncState.at = now
  const file = modStoreFile()
  if (file === undefined) return 0
  let mtimeMs = 0
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return 0
  }
  if (file === modSyncState.file && mtimeMs === modSyncState.mtimeMs) return 0
  modSyncState.file = file
  modSyncState.mtimeMs = mtimeMs
  const source = readJson(file, undefined)
  if (source === null || typeof source !== 'object') return 0
  const known = new Set(store.keywords.map((entry) => `${entry.zone ?? 'other'}:${entry.word.toLowerCase()}`))
  // A word already filed under `other` speaks for every zone, so copying it into `mod` would only
  // duplicate it; keep the single `other` copy instead.
  const inOther = new Set(store.keywords.filter((entry) => (entry.zone ?? 'other') === 'other').map((entry) => entry.word.toLowerCase()))
  let added = 0
  for (const entry of Array.isArray(source.keywords) ? source.keywords : []) {
    // The mod plugin stores bare strings; tolerate that and our own { word, ... } shape.
    const record = entry !== null && typeof entry === 'object' ? entry : undefined
    const word = typeof entry === 'string' ? entry.trim() : (typeof record?.word === 'string' ? record.word.trim() : '')
    if (word.length < 2) continue
    if (inOther.has(word.toLowerCase())) continue
    const key = `mod:${word.toLowerCase()}`
    if (known.has(key)) continue
    store.keywords.push({
      word,
      zone: 'mod',
      at: Number.isFinite(record?.at) ? record.at : Date.now(),
      uses: Number.isFinite(record?.uses) ? record.uses : 0,
      source: 'mod-plugin'
    })
    known.add(key)
    added += 1
  }
  if (Array.isArray(source.promoted)) {
    for (const word of source.promoted) {
      if (typeof word !== 'string' || word.trim() === '') continue
      if (store.promoted.some((item) => item.toLowerCase() === word.toLowerCase())) continue
      store.promoted.push(word.trim())
    }
  }
  const before = store.keywords.length
  store.keywords = store.keywords.filter((entry) => !((entry.zone ?? 'other') === 'mod' && inOther.has(entry.word.toLowerCase())))
  const pruned = before - store.keywords.length
  if (added > 0 || pruned > 0) saveStore(store)
  return added
}

/** One-time tidy-up: mod-flavoured words learned before the zones existed move into the mod zone. */
function migrateLegacyModWords(store) {
  let moved = 0
  for (const entry of store.keywords) {
    if ((entry.zone ?? 'other') === 'mod') continue
    if (!MOD_LEGACY_WORDS.has(String(entry.word).toLowerCase())) continue
    entry.zone = 'mod'
    moved += 1
  }
  // File-shuffling verbs may have been promoted by an older build; they stay weak from now on.
  const promoted = store.promoted.filter((word) => !NEVER_PROMOTE.has(String(word).toLowerCase()))
  const demoted = store.promoted.length - promoted.length
  if (demoted > 0) store.promoted = promoted
  if (moved > 0 || demoted > 0) saveStore(store)
  return moved
}

/** Cluster rules: label, matcher and the words worth remembering when the cluster is approved. */const CLUSTERS = [
  { id: 'fs-write', label: '写入工作区之外的文件', re: /(\bwrite\b|\bsave\b|\bcopy\b|\bmove\b|\brename\b|\bmkdir\b|写入|写入到|保存|复制|移动|重命名|新建目录|覆盖)/i },
  { id: 'process', label: '启动/结束本地进程', re: /(\bstart\b|\bspawn\b|\bnpm\b|\bpnpm\b|\bpip\b|\bgradle\b|\bmvn\b|\bjava\b|\bnode\b|\bpython\b|\bcsc\b|启动|运行|执行|编译|构建)/i },
  { id: 'network', label: '访问网络/下载依赖', re: /(\bdownload\b|\bwget\b|\bcurl\b|\bhttp\b|\bhttps\b|\bgit\s+(?:clone|push|pull|fetch|ls-remote|remote)\b|\bgit-ssl\b|\bgithub\b|\bgist\b|下载|拉取|推送|镜像|接口)/i },
  { id: 'install', label: '安装、升级软件包', re: /(\binstall\b|\bupgrade\b|\bunzip\b|\bextract\b|\bpackage\b|安装|升级|解压|依赖包)/i },
  { id: 'system', label: '修改系统级配置', re: /(\bhosts\b|\bregistry\b|\bservice\b|\bscheduled\s+task\b|\bschtasks\b|\bipconfig\b|注册表|服务|计划任务|系统配置|防火墙)/i },
  { id: 'elevate', label: '请求管理员权限', re: /(\badmin\b|\buac\b|\bsudo\b|\belevat|\brunas\b|管理员|提权|以管理员)/i },
  { id: 'destructive', label: '删除或终止（永不自动放行）', re: DANGER_PATTERN }
]

function readJson(path, fallback) {
  try {
    // A BOM sneaks in whenever a human edits these files with PowerShell 5.1's Set-Content,
    // and JSON.parse refuses it, so strip it before parsing instead of silently losing the table.
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
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
        zone: ZONE_IDS.has(entry.zone) ? entry.zone : zoneOfWord(entry.word.trim()),
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

function matchedKeywords(text, store, zone = zoneOf(text)) {
  const haystack = String(text ?? '').toLowerCase()
  const scope = zoneScope(zone)
  const hits = []
  for (const entry of store.keywords) {
    if (!scope.has(entry.zone ?? 'other')) continue
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
  const zone = zoneOf(text)
  const blocked = DANGER_PATTERN.test(text)
  const delegated = zone === 'mod' && modOwnerActive()
  const hits = matchedKeywords(text, store, zone)
  const strong = hits.filter((word) => !WEAK_KEYWORDS.has(word.toLowerCase()))
  const weak = hits.filter((word) => WEAK_KEYWORDS.has(word.toLowerCase()))
  const promoted = new Set(store.promoted.map((word) => word.toLowerCase()))
  const weakOk = weak.filter((word) => promoted.has(word.toLowerCase()) || !WEAK_KEYWORDS.has(word.toLowerCase()))
  const allowedTool = req?.toolName === undefined ? true : AUTO_TOOLS.has(String(req.toolName))
  // The mod zone is delegated to dsh-mod-build-auto-approve while it runs; once it is gone
  // this plugin takes that zone over instead of leaving the user to approve every command.
  const auto = !blocked && !delegated && allowedTool && (strong.length > 0 || weakOk.length >= MIN_WEAK_HITS || weak.length >= MIN_WEAK_HITS)
  return { auto, blocked, zone, delegated, modish: zone === 'mod', modOwned: delegated, hits, allowedTool, tool: req?.toolName }
}

function remember(store, words, source, zone = 'other') {
  const now = Date.now()
  const known = new Set(store.keywords.map((entry) => entry.word.toLowerCase()))
  let added = 0
  for (const raw of words) {
    const word = String(raw ?? '').trim()
    if (word.length < 2 || STOPWORDS.has(word.toLowerCase())) continue
    // Words naming the Minecraft mod domain are learned only while that zone is ours:
    // otherwise one mod word would let this plugin approve mod builds behind the mod
    // plugin's back.
    if (zone !== 'mod' && MOD_DOMAIN_KEYWORD.test(word.toLowerCase())) continue
    if (known.has(word.toLowerCase())) continue
    store.keywords.push({ word, zone: ZONE_IDS.has(zone) ? zone : zoneOfWord(word), at: now, uses: 0, source })
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
  const current = () => {
    const store = loadStore()
    migrateLegacyModWords(store)
    syncModZone(store)
    return store
  }

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
          const added = remember(live, words, 'manual', zoneOf(reasonText(req)))
          bump(live, 'human')
          saveStore(live)
          recordDecision({ at: Date.now(), tool: req?.toolName, mode: 'human', hits: words, added, reason: String(req?.reason ?? '').slice(0, 160) })
          const weakNow = words.filter((word) => WEAK_KEYWORDS.has(word.toLowerCase()) && !NEVER_PROMOTE.has(word.toLowerCase()))
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
          // A plan can span zones (a mod build that also pushes to GitHub), so each item is
          // filed under its own zone instead of dumping the whole plan into one vocabulary.
          const perZone = new Map()
          const collect = (text) => {
            const value = String(text ?? '')
            if (value.trim() === '') return
            const zone = zoneOf(value)
            perZone.set(zone, [...(perZone.get(zone) ?? []), ...extractKeywords(value)])
          }
          if (typeof args?.task === 'string') collect(args.task)
          for (const item of items) collect(item)
          const words = []
          for (const [zone, bucket] of perZone) {
            remember(store, bucket, 'plan', zone)
            words.push(...bucket)
          }
          learned.push(...words)
          for (const entry of store.keywords) {
            const lower = entry.word.toLowerCase()
            if (NEVER_PROMOTE.has(lower)) continue
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
        const zone = zoneOf(text)
        const clusters = clustersOf(text)
        const hits = matchedKeywords(text, store, zone)
        const destructive = clusters.includes('destructive')
        const delegated = zone === 'mod' && modOwnerActive()
        const strong = hits.filter((word) => !WEAK_KEYWORDS.has(word.toLowerCase()))
        const needsApproval = delegated || destructive || (strong.length === 0 && hits.length < MIN_WEAK_HITS)
        const lines = [
          `分区：${zoneMeta(zone).label}（${zone}）`,
          `权限类别：${clusters.length === 0 ? '（未识别）' : clusters.map(clusterLabel).join('、')}`,
          `已记住的关键词命中：${hits.length === 0 ? '（无）' : hits.join('、')}`,
          delegated ? '分区归属：mod 区已委托给 dsh-mod-build-auto-approve，本插件不接管。' : '',
          zone === 'mod' && !delegated ? '分区归属：mod 区（mod 插件未启用 → 本插件接管该区）。' : '',
          zone === 'mod' ? `mod 插件检测：${modOwnerActive() ? '启用' : '未启用'} · ${modOwnerState.source}` : '',
          delegated
            ? '结论：mod 区请求，交给 mod 插件判断。'
            : needsApproval
              ? '结论：这条需要人工审批，建议先调用 permission_plan。'
              : '结论：本分区已有记住的权限，可以自动放行。',
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
        const perZone = ZONES.map((zone) => `${zone.label} ${store.keywords.filter((entry) => (entry.zone ?? 'other') === zone.id).length}`).join(' · ')
        const lines = [`当前记住 ${store.keywords.length} 个关键词（上限 ${KEYWORD_CAP}）：${perZone}`]
        for (const entry of ranked.slice(0, 60)) {
          const when = entry.at > 0 ? new Date(entry.at).toISOString().slice(0, 10) : '—'
          const weak = WEAK_KEYWORDS.has(entry.word.toLowerCase()) ? '（弱词）' : ''
          const zone = `[${entry.zone ?? 'other'}]`
          lines.push(`  ${entry.word.padEnd(24)} ${zone.padEnd(9)} 命中 ${String(entry.uses).padStart(4)} 次 · ${entry.source} · ${when}${weak}`)
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

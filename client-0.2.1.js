// dsh-permission-plan — browser half.
//
// DSH answers a pending approval by moving the approval card INTO the composer seat, which makes
// the input box collapse to zero height. Instead of fighting that layout, this bundle polls the
// plugin host for approvals the plugin could not auto-approve and renders its own floating card
// just above the composer. The composer is never taken over, so the input box stays where it is.
//
// Protocol (host side, index.mjs):
//   GET  /permission-plan/pending  -> { ok, pending: [{ id, tool, reason, createdAt }] }  (also a heartbeat)
//   POST /permission-plan/answer   -> { id, allow: true|false }
(() => {
  const POLL_MS = 1000
  const BOX_ID = "permission-plan-card"
  const TEXT = {
    waiting: "等待审批",
    escalation: "工具 {tool} 请求越权执行",
    reject: "拒绝",
    allowOnce: "允许一次"
  }

  let lastPayload = ""
  let answering = false
  let lastChimedId = ""
  let audioContext
  let chimeAudio
  let chimeFallbackUsed = false
  let cardSound = ""
  let soundInfo = { kind: "synth", name: "synth", label: "", file: "", card: "" }

  // The host decides the card chime: "synth" means the two-note tone below, any other value is a wav
  // name served at /permission-plan/sound.wav. Asked once per page load.
  async function loadCardSound() {
    try {
      const response = await fetch("/permission-plan/sounds", { cache: "no-store" })
      if (!response.ok) return
      const data = await response.json()
      cardSound = String(data?.card ?? "")
      soundInfo = {
        kind: String(data?.kind ?? (cardSound === "synth" ? "synth" : "wav")),
        name: String(data?.name ?? cardSound),
        label: String(data?.label ?? ""),
        file: String(data?.file ?? ""),
        card: cardSound
      }
    } catch {
      // Keep the wav path: it falls back to the tone on its own.
    }
  }

  // The approval chime this machine already knows: dsh-whale-widget's assets/approve-default.wav,
  // served by the host at /permission-plan/sound.wav. When that file is absent the host answers 404
  // and we synthesise a short two-note chime instead, so the card is never silent.
  function playChime() {
    if (soundInfo.kind === "synth" || cardSound === "synth") {
      playSynthesisedChime()
      return
    }
    if (!chimeFallbackUsed) {
      try {
        chimeAudio = chimeAudio ?? new Audio("/permission-plan/sound.wav")
        chimeAudio.currentTime = 0
        const played = chimeAudio.play()
        if (played !== undefined && typeof played.catch === "function") {
          played.catch(() => {
            chimeFallbackUsed = true
            playSynthesisedChime()
          })
        }
        return
      } catch {
        chimeFallbackUsed = true
      }
    }
    playSynthesisedChime()
  }

  function playSynthesisedChime() {
    try {
      const Ctor = window.AudioContext ?? window.webkitAudioContext
      if (Ctor === undefined) return
      audioContext = audioContext ?? new Ctor()
      if (audioContext.state === "suspended") void audioContext.resume()
      const now = audioContext.currentTime
      for (const [frequency, offset] of [[880, 0], [1174.66, 0.13]]) {
        const oscillator = audioContext.createOscillator()
        const gain = audioContext.createGain()
        oscillator.type = "sine"
        oscillator.frequency.value = frequency
        gain.gain.setValueAtTime(0.0001, now + offset)
        gain.gain.exponentialRampToValueAtTime(0.16, now + offset + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.3)
        oscillator.connect(gain).connect(audioContext.destination)
        oscillator.start(now + offset)
        oscillator.stop(now + offset + 0.32)
      }
    } catch {
      // Sound is best-effort.
    }
  }

  // The card chime is a single fixed sound, decided by the host (see /permission-plan/sounds).
  // No sound tour: back-to-back samples are hard to tell apart.

  // ---- sound preview button ------------------------------------------------
  // Sits next to the round send/stop button. Hovering shows exactly which sound is in use (selectable
  // text plus a copy button) and clicking plays it once — which also unlocks audio for later cards.
  const SOUND_BTN_ID = "permission-plan-sound-btn"
  const SOUND_TIP_ID = "permission-plan-sound-tip"
  let hideTipTimer

  function soundFacts() {
    const facts = {
      name: soundInfo.kind === "synth" ? "synth" : soundInfo.name || soundInfo.card || "(unknown)",
      label: soundInfo.label || soundInfo.name || "",
      file: soundInfo.kind === "synth" ? "（无文件，浏览器内合成）" : soundInfo.file || "（未找到该文件）"
    }
    return facts
  }

  function tipText() {
    const facts = soundFacts()
    return `当前提示音：${facts.name}\n名称：${facts.label}\n文件：${facts.file}`
  }

  function playCardSound() {
    if (soundInfo.kind === "synth") {
      playSynthesisedChime()
      return
    }
    try {
      chimeAudio = new Audio(`/permission-plan/sound.wav?name=${encodeURIComponent(soundInfo.name || soundInfo.card)}`)
      const played = chimeAudio.play()
      if (played !== undefined && typeof played.catch === "function") played.catch(() => playSynthesisedChime())
    } catch {
      playSynthesisedChime()
    }
  }

  function hideTip() {
    document.getElementById(SOUND_TIP_ID)?.remove()
  }

  function showTip() {
    hideTip()
    const button = document.getElementById(SOUND_BTN_ID)
    if (button === null) return
    const rect = button.getBoundingClientRect()
    const tip = document.createElement("div")
    tip.id = SOUND_TIP_ID
    Object.assign(tip.style, {
      position: "fixed",
      zIndex: "2147483002",
      maxWidth: "min(560px, calc(100vw - 32px))",
      padding: "10px 12px",
      border: "1px solid rgba(240, 162, 58, 0.5)",
      borderRadius: "10px",
      background: "rgba(28, 22, 14, 0.98)",
      color: "#f3ede2",
      font: "12px/1.6 ui-monospace, 'Cascadia Mono', Consolas, monospace",
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
      boxShadow: "0 10px 26px rgba(0, 0, 0, 0.5)",
      userSelect: "text",
      webkitUserSelect: "text"
    })
    const text = document.createElement("div")
    text.textContent = tipText()
    tip.appendChild(text)

    const copy = document.createElement("button")
    copy.type = "button"
    copy.textContent = "复制"
    Object.assign(copy.style, {
      marginTop: "8px",
      padding: "3px 10px",
      borderRadius: "6px",
      border: "1px solid rgba(240, 162, 58, 0.45)",
      background: "transparent",
      color: "#f0a23a",
      font: "12px/1.4 system-ui, sans-serif",
      cursor: "pointer"
    })
    copy.addEventListener("click", () => {
      const payload = tipText()
      const done = () => {
        copy.textContent = "已复制"
        setTimeout(() => {
          copy.textContent = "复制"
        }, 1200)
      }
      try {
        void navigator.clipboard?.writeText(payload).then(done, () => {
          const range = document.createRange()
          range.selectNodeContents(text)
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
        })
      } catch {
        // Selection fallback is enough.
      }
    })
    tip.appendChild(copy)

    tip.addEventListener("mouseenter", () => clearTimeout(hideTipTimer))
    tip.addEventListener("mouseleave", () => {
      hideTipTimer = setTimeout(hideTip, 400)
    })

    document.body.appendChild(tip)
    const tipRect = tip.getBoundingClientRect()
    const left = Math.min(
      Math.max(12, rect.left + rect.width / 2 - tipRect.width / 2),
      window.innerWidth - tipRect.width - 12
    )
    const top = Math.max(12, rect.top - tipRect.height - 8)
    tip.style.left = `${left}px`
    tip.style.top = `${top}px`
  }

  function ensureSoundButton() {
    let button = document.getElementById(SOUND_BTN_ID)
    if (button !== null) return button
    button = document.createElement("button")
    button.id = SOUND_BTN_ID
    button.type = "button"
    button.textContent = "试听"
    Object.assign(button.style, {
      position: "fixed",
      zIndex: "2147483002",
      width: "auto",
      height: "30px",
      padding: "0 10px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      border: "1px solid rgba(240, 162, 58, 0.55)",
      borderRadius: "15px",
      background: "rgba(38, 30, 20, 0.94)",
      color: "#f0a23a",
      font: "12px/1 system-ui, -apple-system, 'Segoe UI', sans-serif",
      cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,0.35)"
    })
    button.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      playCardSound()
    })
    button.addEventListener("mouseenter", () => {
      clearTimeout(hideTipTimer)
      showTip()
    })
    button.addEventListener("mouseleave", () => {
      hideTipTimer = setTimeout(hideTip, 400)
    })
    document.body.appendChild(button)
    return button
  }

  // The model selector sits in the same row as the round send button, so its rectangle is the natural
  // anchor for a control that should ride on the same line, just left of the model name.
  function modelAnchorRect() {
    const anchor = findRoundButton()
    if (anchor === null) return undefined
    const row = anchor.parentElement
    if (row === null) return undefined
    const siblings = Array.from(row.children)
    const index = siblings.indexOf(anchor)
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = siblings[cursor]
      const rect = candidate.getBoundingClientRect()
      if (rect.width > 40 && rect.height > 10) return rect
    }
    return undefined
  }

  function placeSoundButton() {
    const button = document.getElementById(SOUND_BTN_ID)
    if (button === null) return
    // Default target: same row as the model name, immediately to its left, vertically centred on it.
    // Falling back keeps the pill on screen even when the composer layout changes.
    const model = modelAnchorRect()
    const anchor = findRoundButton()
    const anchorRect = anchor?.getBoundingClientRect()
    const composer = composerRect()
    const width = button.offsetWidth > 0 ? button.offsetWidth : 56
    let left
    let top
    if (model !== undefined) {
      left = model.left - width - 8
      top = model.top + (model.height - 30) / 2
      if (composer !== undefined && left < composer.left + 8) left = composer.left + 8
    } else if (anchorRect !== undefined) {
      left = anchorRect.right + 8
      top = anchorRect.top + (anchorRect.height - 30) / 2
    } else if (composer !== undefined) {
      left = composer.left + composer.width + 8
      top = composer.top + composer.height - 40
    } else {
      left = window.innerWidth - width - 16
      top = window.innerHeight - 80
    }
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8
    if (left < 8) left = 8
    if (top + 30 > window.innerHeight - 8) top = window.innerHeight - 38
    if (top < 8) top = 8
    button.style.left = `${Math.round(left)}px`
    button.style.right = "auto"
    button.style.top = `${Math.round(top)}px`
  }

  const css = `
  #${BOX_ID} {
    position: fixed;
    left: 50%;
    bottom: 120px;
    transform: translateX(-50%);
    width: min(760px, calc(100vw - 48px));
    z-index: 2147483000;
    box-sizing: border-box;
    padding: 14px 16px 12px;
    border: 1px solid rgba(240, 162, 58, 0.55);
    border-radius: 14px;
    background: rgba(38, 30, 20, 0.97);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    color: #f3ede2;
    font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  #${BOX_ID} .pp-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    color: #f0a23a;
    font-weight: 600;
  }
  #${BOX_ID} .pp-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #f0a23a;
  }
  #${BOX_ID} .pp-body {
    max-height: 30vh;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: #e8e1d6;
  }
  #${BOX_ID} .pp-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  #${BOX_ID} button {
    font: inherit;
    padding: 6px 14px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: transparent;
    color: #ece6dc;
    cursor: pointer;
  }
  #${BOX_ID} button.pp-allow {
    border-color: transparent;
    background: #f0f0f0;
    color: #1b1b1b;
    font-weight: 600;
  }
  #${BOX_ID} button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  `

  function ensureStyle() {
    if (document.getElementById(`${BOX_ID}-style`) !== null) return
    const style = document.createElement("style")
    style.id = `${BOX_ID}-style`
    style.textContent = css
    document.head.appendChild(style)
  }

  function findRoundButton() {
    const labels = ["停止生成", "Stop generating", "停止", "Stop", "发送消息", "Send message", "Send"]
    for (const label of labels) {
      const button = document.querySelector(`button[aria-label="${label}"]`)
      if (button !== null) return button
    }
    return null
  }

  // Anchor on the typing area itself (not the outer seat, which spans the whole column), so the
  // card is never wider than the composer box and sits right on top of its upper edge.
  function composerRect() {
    const editable = document.querySelector('[contenteditable="true"]')
    const inner = editable?.getBoundingClientRect()
    if (inner !== undefined && inner.width > 200) {
      return { left: inner.left, width: inner.width, top: inner.top }
    }
    const seat = document.querySelector('[class*="composerSeat"]')
    const rect = seat?.getBoundingClientRect()
    if (rect !== undefined && rect.width > 200) return { left: rect.left, width: rect.width, top: rect.top }
    return undefined
  }

  function place(box) {
    const rect = composerRect()
    const viewportWidth = window.innerWidth
    if (rect === undefined) {
      box.style.width = `${Math.min(720, viewportWidth - 48)}px`
      box.style.left = `${viewportWidth / 2}px`
      box.style.transform = "translateX(-50%)"
      box.style.bottom = "120px"
      return
    }
    // The typing area is already narrower than the composer box, so matching it keeps the card
    // inside the dialog width while still reading as one block.
    const width = Math.max(280, Math.min(rect.width, viewportWidth - 48))
    box.style.width = `${width}px`
    box.style.left = `${rect.left + rect.width / 2}px`
    box.style.transform = "translateX(-50%)"
    box.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 20)}px`
  }

  // While our card is up the round button sits right under the pointer, so make it inert.
  function shieldRoundButton(active) {
    const button = findRoundButton()
    if (button === null) return
    button.style.pointerEvents = active ? "none" : ""
    button.style.opacity = active ? "0.35" : ""
  }

  function removeCard() {
    document.getElementById(BOX_ID)?.remove()
    shieldRoundButton(false)
  }

  function render(pending) {
    ensureStyle()
    if (pending.id !== lastChimedId) {
      lastChimedId = pending.id
      playChime()
    }
    let box = document.getElementById(BOX_ID)
    if (box === null) {
      box = document.createElement("div")
      box.id = BOX_ID
      document.body.appendChild(box)
    }
    shieldRoundButton(true)
    place(box)
    box.textContent = ""

    const head = document.createElement("div")
    head.className = "pp-head"
    const dot = document.createElement("span")
    dot.className = "pp-dot"
    head.appendChild(dot)
    head.appendChild(document.createTextNode(TEXT.waiting))
    box.appendChild(head)

    const body = document.createElement("div")
    body.className = "pp-body"
    body.textContent = TEXT.escalation.replace("{tool}", pending.tool || "pwsh")
    if (pending.reason) body.appendChild(document.createTextNode(`\n${pending.reason}`))
    box.appendChild(body)

    const actions = document.createElement("div")
    actions.className = "pp-actions"

    const reject = document.createElement("button")
    reject.type = "button"
    reject.textContent = TEXT.reject
    reject.addEventListener("click", () => void answer(pending.id, false))

    const allow = document.createElement("button")
    allow.type = "button"
    allow.className = "pp-allow"
    allow.textContent = TEXT.allowOnce
    allow.addEventListener("click", () => void answer(pending.id, true))

    actions.appendChild(reject)
    actions.appendChild(allow)
    box.appendChild(actions)
  }

  async function answer(id, allow) {
    if (answering) return
    answering = true
    const box = document.getElementById(BOX_ID)
    if (box !== null) {
      for (const button of box.querySelectorAll("button")) button.disabled = true
    }
    try {
      await fetch("/permission-plan/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, allow })
      })
    } catch {
      // The next poll reconciles the card state.
    } finally {
      answering = false
      lastPayload = ""
      void poll()
    }
  }

  // A one-line self report so the host can answer "is the bell actually on screen?" without a
  // devtools console. It travels on the heartbeat the poll already sends.
  function selfReport() {
    try {
      const button = document.getElementById(SOUND_BTN_ID)
      const rect = button?.getBoundingClientRect()
      return JSON.stringify({
        hasBody: document.body !== null,
        button: button === null ? null : {
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          display: getComputedStyle(button).display,
          visibility: getComputedStyle(button).visibility,
          opacity: getComputedStyle(button).opacity
        },
        viewport: { width: window.innerWidth, height: window.innerHeight }
      })
    } catch (error) {
      return JSON.stringify({ error: String(error) })
    }
  }

  async function poll() {
    let pending = []
    try {
      const target = `/permission-plan/pending?diag=${encodeURIComponent(selfReport())}`
      const response = await fetch(target, { cache: "no-store" })
      if (response.ok) {
        const payload = await response.json()
        pending = Array.isArray(payload?.pending) ? payload.pending : []
      }
    } catch {
      // Host not reachable right now; keep whatever is on screen.
      return
    }
    const first = pending[0]
    if (first === undefined) {
      lastPayload = ""
      removeCard()
      return
    }
    const signature = `${first.id}:${first.tool}:${first.reason}`
    if (signature === lastPayload) {
      const existing = document.getElementById(BOX_ID)
      if (existing !== null) place(existing)
      return
    }
    lastPayload = signature
    render(first)
  }

  // A bundle can be imported before <body> exists, so every DOM write waits for it. The beacon also
  // lets the host tell "bundle never ran" apart from "bundle ran but drew nothing".
  void fetch("/permission-plan/pending", { cache: "no-store" }).catch(() => {})

  function report(stage) {
    try {
      const button = document.getElementById(SOUND_BTN_ID)
      const rect = button?.getBoundingClientRect()
      const card = document.getElementById(BOX_ID)
      void fetch("/permission-plan/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stage,
          href: location.href,
          at: Date.now(),
          hasBody: document.body !== null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          button: button === null || button === undefined ? null : {
            top: Math.round(rect.top),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            display: getComputedStyle(button).display,
            visibility: getComputedStyle(button).visibility,
            opacity: getComputedStyle(button).opacity,
            text: button.textContent
          },
          card: card === null ? null : { top: Math.round(card.getBoundingClientRect().top) },
          roundButton: (() => {
            const anchor = findRoundButton()
            if (anchor === null) return null
            const box = anchor.getBoundingClientRect()
            return { label: anchor.getAttribute("aria-label"), top: Math.round(box.top), left: Math.round(box.left) }
          })(),
          modelRow: (() => {
            const model = modelAnchorRect()
            if (model === undefined) return null
            return { top: Math.round(model.top), left: Math.round(model.left), width: Math.round(model.width) }
          })()
        })
      }).catch(() => {})
    } catch (error) {
      void fetch("/permission-plan/probe", { method: "POST", body: JSON.stringify({ stage, error: String(error) }) }).catch(() => {})
    }
  }

  function boot() {
    report("boot-start")
    try {
      ensureStyle()
      ensureSoundButton()
      placeSoundButton()
      void loadCardSound()
      report("booted")
    } catch (error) {
      report(`boot-error: ${String(error)}`)
    }
    void poll()
    setInterval(() => {
      placeSoundButton()
    }, POLL_MS)
    setInterval(() => void poll(), POLL_MS)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void poll()
    })
    window.addEventListener("resize", () => {
      const box = document.getElementById(BOX_ID)
      if (box !== null) place(box)
    })
  }

  if (document.body === null) {
    document.addEventListener("DOMContentLoaded", boot, { once: true })
  } else {
    boot()
  }
})()

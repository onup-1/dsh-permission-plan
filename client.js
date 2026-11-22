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
    const labels = ["停止生成", "Stop generating", "停止", "Stop"]
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

  async function poll() {
    let pending = []
    try {
      const response = await fetch("/permission-plan/pending", { cache: "no-store" })
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

  ensureStyle()
  void poll()
  setInterval(() => void poll(), POLL_MS)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void poll()
  })
  window.addEventListener("resize", () => {
    const box = document.getElementById(BOX_ID)
    if (box !== null) place(box)
  })
})()

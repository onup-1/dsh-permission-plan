// Browser half of dsh-permission-plan: layout guard for the approval card.
//
// The host renders the approval card (dsh-client-ui-approval) right above the composer,
// and the composer's round button turns into "stop generating" while the turn is open.
// Reaching for 允许一次 therefore puts the pointer a few pixels above the stop button,
// so a missed click stops the run instead of answering. Two small corrections:
//   1. keep a gap between the card and the composer;
//   2. while a card is waiting (any element carrying data-approval-key), the stop button
//      stops accepting pointer events, so a miss lands on nothing instead of stopping.

window.__ModuleLoader__.load({
  id: 'dsh-permission-plan',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const STYLE_ID = '@deepseek-ai/dsh-permission-plan/approval-layout'

    const CSS = `
[data-approval-key] {
  margin-bottom: 16px !important;
}
body:has([data-approval-key]) button[aria-label="\u505c\u6b62\u751f\u6210"],
body:has([data-approval-key]) button[aria-label="Stop generating"],
body:has([data-approval-key]) button[aria-label="\u505c\u6b62\u751f\u6210\u4e2d"],
body:has([data-approval-key]) button[title="\u505c\u6b62\u751f\u6210"] {
  opacity: 0.3 !important;
  pointer-events: none !important;
  cursor: default !important;
}
`

    function apply(ctx) {
      if (typeof document === 'undefined') return
      const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']')
      if (existing !== null) return
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', STYLE_ID)
      tag.textContent = CSS
      document.head.appendChild(tag)
      ctx?.effect?.(() => () => tag.remove(), 'permission-plan: approval layout')
    }

    exports.apply = apply
    exports.inject = []
    return exports
  }
})

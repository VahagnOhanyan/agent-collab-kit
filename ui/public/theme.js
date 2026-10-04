// The panel's theme: as the system says (the default), or light, or dark — chosen with the button in the side menu.
//
// Loaded from <head>, so the class is on <html> before the first paint and the page does not flash the wrong theme.
// The choice is kept in a COOKIE, not in localStorage: the panel listens on a different port every time it starts, and
// localStorage belongs to one origin (host AND port), so a choice kept there would be forgotten at every restart. A
// cookie does not include the port. It holds one of three words and nothing else, and the page never reads it as code.
(function () {
  const NAME = 'collab-theme'
  const MODES = ['auto', 'light', 'dark']
  const LABEL = { auto: 'Тема: как в системе', light: 'Тема: светлая', dark: 'Тема: тёмная' }

  function read() {
    try {
      const match = new RegExp('(?:^|;\\s*)' + NAME + '=([a-z]+)').exec(document.cookie || '')
      return match && MODES.includes(match[1]) ? match[1] : 'auto'
    } catch {
      return 'auto'
    }
  }
  function write(mode) {
    try {
      document.cookie = NAME + '=' + mode + '; Path=/; Max-Age=31536000; SameSite=Strict'
    } catch {
      // A browser that refuses cookies keeps the choice for this page only.
    }
  }
  function apply(mode) {
    const root = document.documentElement
    root.classList.remove('theme-light', 'theme-dark')
    if (mode !== 'auto') root.classList.add('theme-' + mode)
  }

  let mode = read()
  apply(mode)

  document.addEventListener('DOMContentLoaded', function () {
    const button = document.getElementById('theme-toggle')
    const label = document.getElementById('theme-label')
    if (!button || !label) return
    function paint() {
      label.textContent = LABEL[mode]
      button.setAttribute('aria-label', LABEL[mode] + '. Нажмите, чтобы сменить')
    }
    paint()
    button.addEventListener('click', function () {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length]
      write(mode)
      apply(mode)
      paint()
    })
  })
})()

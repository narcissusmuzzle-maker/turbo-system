/**
 * Таймеры занятий (3×3) + красный таймер на 15 минут. Подробности логики — в shared/core.js.
 *  - Нажатие на квадрат: запуск, повторное — пауза. На кнопке идущего таймера — минуты (60…1).
 *  - Час закончился: вибрация, событие уходит на телефон через службу в приложении Zepp (app-side/index.js),
 *    пока телефон не подтвердит, событие хранится и отправляется снова.
 *  - Во всём приложении идёт только один таймер (запуск другого переключает).
 *  - Красный: 15:00 с секундами, один раз; в конце длинная вибрация. Долгое нажатие на красный — тестовый режим
 *    (час = 1 минута, часы не засчитываются; на телефон уходит только проверка связи).
 */
import { BasePage } from '@zeppos/zml/base-page'
import { createWidget, widget, prop } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { Vibrator, VIBRATOR_SCENE_DURATION_LONG, VIBRATOR_SCENE_STRONG_REMINDER } from '@zos/sensor'
import { setPageBrightTime, pauseDropWristScreenOff, setWakeUpRelaunch } from '@zos/display'
import { LocalStorage } from '@zos/storage'
import { set as alarmSet, cancel as alarmCancel } from '@zos/alarm'
import * as core from '../shared/core'

const SEND_GAP = 15000        // как часто повторять отправку неподтверждённого события
const USE_ALARM = true        // будить приложение будильником, когда час/15 минут заканчиваются при погасшем экране
const KEEP_AWAKE = true       // пока что-то идёт, не гасить экран
const WHITE = 0xffffff
const AMBER = 0xffc107
const RED = 0xc62828
const RED_PRESS = 0xe53935

// эмодзи занятий в порядке кнопок; приложение-трекер на телефоне по эмодзи понимает, какому занятию +1 час
const EMOJI = ['\u{1F93F}', '\u{1F3A8}', '\u{1FA78}', '\u{1F4D6}', '\u{1F9EC}', '\u{1F480}', '\u{1F3E0}', '\u{1F340}', '\u{1F50D}']

const store = new LocalStorage()

let ST = null          // обычное состояние (хранится)
let STT = null         // тестовое состояние (не хранится)
let testMode = false
let vib = null
let inflight = false
let inflightAt = 0
let timer = null
let ticks = 0
let shown = []         // для каждого квадрата: показана ли кнопка идущего таймера
let lastLabel = []
let lastColor = []
let lastQuick = ''
let lastQuickColor = -1
let idle = []
let runb = []
let quick = null
let G = null           // геометрия

function cur() { return testMode ? STT : ST }

function save() {
  try { store.setItem('st', JSON.stringify(ST)) } catch (e) { /* без сохранения продолжаем работать */ }
}

function vibrate(mode) {
  try {
    if (!vib) vib = new Vibrator()
    vib.start({ mode: mode })
  } catch (e) {
    try { vib.setMode({ mode: mode }); vib.start() } catch (e2) { /* нет вибромотора */ }
  }
}

function signalHour() { vibrate(VIBRATOR_SCENE_DURATION_LONG) }

function signalQuick() {
  vibrate(VIBRATOR_SCENE_STRONG_REMINDER)
  setTimeout(function () { vibrate(VIBRATOR_SCENE_STRONG_REMINDER) }, 1600)
  setTimeout(function () { vibrate(VIBRATOR_SCENE_STRONG_REMINDER) }, 3200)
}

function geometry() {
  let w = 432
  let h = 514
  try {
    const d = getDeviceInfo()
    if (d && d.width > 0 && d.height > 0) { w = d.width; h = d.height }
  } catch (e) { /* значения по умолчанию */ }
  const pad = Math.round(w * 0.03)
  const gap = Math.round(w * 0.025)
  const cell = Math.floor((w - 2 * pad - 2 * gap) / 3)
  const qy = pad + 3 * cell + 3 * gap
  return { w: w, h: h, pad: pad, gap: gap, cell: cell, qy: qy, qh: h - pad - qy, qw: w - 2 * pad, font: Math.round(cell * 0.42) }
}

function cellXY(i) {
  const c = i % 3
  const r = Math.floor(i / 3)
  return { x: G.pad + c * (G.cell + G.gap), y: G.pad + r * (G.cell + G.gap) }
}

function setBtn(b, x, y, w, h, text, color) {
  try { b.setProperty(prop.MORE, { x: x, y: y, w: w, h: h, text: text, color: color }) } catch (e) { /* не критично */ }
}

function setVisible(b, v) {
  try { b.setProperty(prop.VISIBLE, v) } catch (e) { /* не критично */ }
}

/** Перерисовать кнопки по текущему состоянию (меняем только то, что поменялось). */
function render(now) {
  const st = cur()
  for (let i = 0; i < core.COUNT; i++) {
    const isRun = core.running(st, i)
    const show = isRun || core.paused(st, i)
    if (shown[i] !== show) {
      setVisible(idle[i], !show)
      setVisible(runb[i], show)
      shown[i] = show
      lastLabel[i] = ''
    }
    if (show) {
      const text = core.label(st, core.remaining(st, i, now))
      const color = isRun ? WHITE : AMBER
      if (text !== lastLabel[i] || color !== lastColor[i]) {
        const p = cellXY(i)
        setBtn(runb[i], p.x, p.y, G.cell, G.cell, text, color)
        lastLabel[i] = text
        lastColor[i] = color
      }
    }
  }
  const left = core.quickLeft(st, now)
  let qt = core.clock(left)
  if (testMode) qt = 'TEST ' + qt
  const qc = st.q.s === 2 ? AMBER : WHITE
  if (qt !== lastQuick || qc !== lastQuickColor) {
    setBtn(quick, G.pad, G.qy, G.qw, G.qh, qt, qc)
    lastQuick = qt
    lastQuickColor = qc
  }
}

function resetView() {
  shown = []
  lastLabel = []
  lastColor = []
  lastQuick = ''
  lastQuickColor = -1
}

/** Будильники на моменты окончания: разбудят приложение, если экран погас. */
function scheduleAlarms(now) {
  if (!USE_ALARM) return
  try {
    const old = JSON.parse(store.getItem('alarms', '[]'))
    for (let k = 0; k < old.length; k++) { try { alarmCancel(old[k]) } catch (e) { /* уже сработал */ } }
  } catch (e) { /* нет старых */ }
  const ids = []
  const due = core.nextDue(ST)
  for (let k = 0; k < due.length; k++) {
    const delay = Math.max(1, Math.ceil((due[k].t - now) / 1000) + 1)
    try {
      const id = alarmSet({ url: 'page/index', param: 'alarm', delay: delay })
      if (id) ids.push(id)
    } catch (e) { /* без будильника работаем только при включённом экране */ }
  }
  try { store.setItem('alarms', JSON.stringify(ids)) } catch (e) { /* не критично */ }
}

function keepAwake() {
  if (!KEEP_AWAKE || !core.anyRunning(cur())) return
  try { setPageBrightTime({ brightTime: 120000 }) } catch (e) { /* не критично */ }
  try { pauseDropWristScreenOff({ duration: 600000 }) } catch (e) { /* не критично */ }
}

Page(
  BasePage({
    build() {
      G = geometry()
      // при включении экрана открывается это приложение, а не стартовый экран часов
      try { setWakeUpRelaunch({ relaunch: true }) } catch (e) { /* не критично */ }
      testMode = false
      STT = null
      ST = core.restore(store.getItem('st', ''))
      resetView()
      idle = []
      runb = []

      for (let i = 0; i < core.COUNT; i++) {
        const p = cellXY(i)
        const k = i
        idle.push(createWidget(widget.BUTTON, {
          x: p.x, y: p.y, w: G.cell, h: G.cell, text: '', normal_src: 'i' + i + '.png', press_src: 'i' + i + '.png',
          click_func: () => { this.cellTap(k) }
        }))
        const rb = createWidget(widget.BUTTON, {
          x: p.x, y: p.y, w: G.cell, h: G.cell, text: '60', text_size: G.font, color: WHITE,
          normal_src: 'r' + i + '.png', press_src: 'r' + i + '.png',
          click_func: () => { this.cellTap(k) }
        })
        setVisible(rb, false)
        runb.push(rb)
      }
      quick = createWidget(widget.BUTTON, {
        x: G.pad, y: G.qy, w: G.qw, h: G.qh, text: '15:00', text_size: Math.round(G.qh * 0.5), color: WHITE,
        normal_color: RED, press_color: RED_PRESS, radius: Math.round(G.qh * 0.25),
        click_func: () => { this.quickTap() },
        longpress_func: () => { this.toggleTest() }
      })

      const now = Date.now()
      this.settle(core.process(ST, now), now)   // то, что закончилось, пока приложение было закрыто или спало
      timer = setInterval(() => { this.tick() }, 1000)
    },

    onDestroy() {
      if (timer) { clearInterval(timer); timer = null }
      save()
    },

    /** Всё, что нужно сделать после любого изменения состояния. */
    settle(res, now) {
      if (res.fresh) signalHour()
      if (res.quickDone && res.quickFresh) signalQuick()
      if (!testMode || res.events.length || res.quickDone) save()
      if (!testMode) scheduleAlarms(now)
      keepAwake()
      render(now)
      this.sendDue(now)
    },

    tick() {
      const now = Date.now()
      ticks++
      const res = core.process(cur(), now)
      if (res.events.length || res.quickDone) {
        this.settle(res, now)
      } else {
        render(now)
        this.sendDue(now)
        if (ticks % 60 === 0) keepAwake()
      }
    },

    cellTap(i) {
      const now = Date.now()
      const res = core.toggle(cur(), i, now)
      this.settle(res, now)
      if (!testMode) save()
    },

    quickTap() {
      const now = Date.now()
      const res = core.quickTap(cur(), now)
      this.settle(res, now)
      if (!testMode) save()
    },

    /** Долгое нажатие на красный: войти в тестовый режим или выйти из него. */
    toggleTest() {
      testMode = !testMode
      if (testMode) STT = core.newState(true)
      resetView()
      const now = Date.now()
      keepAwake()
      render(now)
      signalHour()
    },

    /** Отправить телефону одно неподтверждённое событие (по одному за раз). */
    sendDue(now) {
      if (inflight && now - inflightAt < 30000) return
      const states = testMode ? [ST, STT] : [ST]
      let target = null
      let owner = null
      for (let s = 0; s < states.length && !target; s++) {
        const d = core.due(states[s], now, SEND_GAP)
        if (d.length) { target = d[0]; owner = states[s] }
      }
      if (!target) return
      target.tried = now
      inflight = true
      inflightAt = now
      const id = target.id
      // настоящий час -> «done» с эмодзи; в тестовом режиме вместо него «ping» (проверка связи, час не засчитывается)
      const test = !!target.x
      const payload = test
        ? { t: 'ping', ts: target.ts }
        : { t: 'done', id: id, e: EMOJI[target.i], ts: target.ts }
      this.request({ method: 'u613.send', params: payload })
        .then((res) => {
          inflight = false
          const r = res && res.ok ? res.reply : null
          const ok = r && (test ? r.t === 'pong' : (r.t === 'ack' && r.id === id))
          if (ok) {
            core.ack(owner, id)
            if (owner === ST) save()
            this.sendDue(Date.now())
          }
        })
        .catch(() => { inflight = false })
    }
  })
)

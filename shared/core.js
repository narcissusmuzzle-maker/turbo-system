/**
 * Логика таймеров для часов Amazfit (Zepp OS). Чистый JS без обращений к API часов — поэтому проверяется
 * тестами в Node (tests/core.test.js). Правила те же, что у таймеров в приложении-трекере (Timers.kt):
 *  - у каждого из 9 занятий таймер отсчитывает 60 минут, после нуля час засчитывается и отсчёт идёт заново;
 *  - одновременно идёт только один таймер занятия: запуск второго ставит первый на паузу;
 *  - всё считается по меткам времени, поэтому если приложение на часах закрывалось, часы, закончившиеся
 *    за это время, всё равно засчитаются (с настоящим временем окончания).
 * Красный таймер на 15 минут — обычный: идёт с секундами, один раз, сам не перезапускается.
 * Во всём приложении идёт только один таймер: запуск красного ставит на паузу идущий таймер занятия,
 * запуск таймера занятия сбрасывает красный (на 15:00).
 * Тестовый режим: «час» длится 1 минуту, события помечены x:1 и телефон их не засчитывает.
 */
export const FULL = 60 * 60 * 1000
export const TEST_FULL = 60 * 1000
export const QUICK = 15 * 60 * 1000
export const FRESH = 20 * 1000      // событие «свежее», если случилось не раньше 20 секунд назад (тогда подаём сигнал)
export const COUNT = 9              // порядок как на экране: слева направо, сверху вниз
export const MAX_OUT = 500          // сколько неподтверждённых событий храним

export function newState(test) {
  const rem = []
  const run = []
  const full = test ? TEST_FULL : FULL
  for (let i = 0; i < COUNT; i++) { rem.push(full); run.push(0) }
  // q.s: 0 — стоит, 1 — идёт, 2 — закончился
  return { v: 2, test: !!test, full: full, rem: rem, run: run, q: { s: 0, run: 0 }, out: [] }
}

/** Привести сохранённое состояние к рабочему виду (на случай пустых/старых данных). */
export function restore(text) {
  const st = newState(false)
  if (!text) return st
  try {
    const o = JSON.parse(text)
    if (o && o.rem && o.run && o.rem.length === COUNT && o.run.length === COUNT) {
      st.rem = o.rem
      st.run = o.run
      if (o.q && typeof o.q.s === 'number') st.q = { s: o.q.s, run: o.q.run || 0 }
      if (o.out && o.out.length !== undefined) st.out = o.out
    }
  } catch (e) { /* битые данные — начинаем с чистого состояния */ }
  return st
}

function clamp(x, a, b) { return x < a ? a : (x > b ? b : x) }

export function running(st, i) { return st.run[i] > 0 }

/** Таймер поставлен на паузу посреди часа (остаток меньше полного). */
export function paused(st, i) { return st.run[i] <= 0 && st.rem[i] < st.full }

/** Остаток таймера занятия, мс (может быть ≤ 0, если срабатывание ещё не обработано). */
export function remaining(st, i, now) {
  return st.run[i] > 0 ? st.rem[i] - (now - st.run[i]) : st.rem[i]
}

export function anyRunning(st) {
  for (let i = 0; i < COUNT; i++) if (st.run[i] > 0) return true
  return st.q.s === 1
}

/**
 * Обработать сработавшее. Возвращает { events, fresh, quickDone, quickFresh }.
 * События «час» добавляются и в st.out (очередь на отправку телефону, пока не придёт подтверждение).
 */
export function process(st, now) {
  const events = []
  let fresh = false
  for (let i = 0; i < COUNT; i++) {
    const s = st.run[i]
    if (s <= 0) continue
    const first = st.rem[i]
    if (first - (now - s) > 0) continue
    let t = s + first
    let count = 0
    while (t <= now && count < 24) {
      const ev = { id: (st.test ? 'x' : '') + i + '-' + t, i: i, ts: t, x: st.test ? 1 : 0, tried: 0 }
      events.push(ev)
      st.out.push(ev)
      if (now - t <= FRESH) fresh = true
      t += st.full
      count++
    }
    st.rem[i] = st.full
    st.run[i] = count >= 24 ? now : t - st.full   // новый круг начался в момент последнего срабатывания
  }
  if (st.out.length > MAX_OUT) st.out = st.out.slice(st.out.length - MAX_OUT)

  let quickDone = false
  let quickFresh = false
  if (st.q.s === 1 && now - st.q.run >= QUICK) {
    const at = st.q.run + QUICK
    st.q.s = 2
    quickDone = true
    quickFresh = now - at <= FRESH
  }
  return { events: events, fresh: fresh, quickDone: quickDone, quickFresh: quickFresh }
}

/** Нажатие на кнопку занятия: запуск / пауза. Запуск ставит на паузу любой другой идущий таймер. */
export function toggle(st, i, now) {
  const res = process(st, now)
  if (st.run[i] > 0) {
    st.rem[i] = clamp(remaining(st, i, now), 1, st.full)
    st.run[i] = 0
  } else {
    if (st.q.s === 1) st.q = { s: 0, run: 0 }   // красный сбрасывается: идёт только один таймер
    for (let k = 0; k < COUNT; k++) {
      if (k !== i && st.run[k] > 0) {
        st.rem[k] = clamp(remaining(st, k, now), 1, st.full)
        st.run[k] = 0
      }
    }
    st.run[i] = now
  }
  return res
}

/** Нажатие на красную кнопку: стоит -> пошёл 15:00 (идущий таймер занятия встаёт на паузу); идёт или закончился -> сброс. */
export function quickTap(st, now) {
  const res = process(st, now)
  if (st.q.s === 0) {
    for (let k = 0; k < COUNT; k++) {
      if (st.run[k] > 0) {
        st.rem[k] = clamp(remaining(st, k, now), 1, st.full)
        st.run[k] = 0
      }
    }
    st.q = { s: 1, run: now }
  } else {
    st.q = { s: 0, run: 0 }
  }
  return res
}

/** Сколько осталось на красном таймере, мс. */
export function quickLeft(st, now) {
  if (st.q.s === 0) return QUICK
  if (st.q.s === 2) return 0
  return clamp(QUICK - (now - st.q.run), 0, QUICK)
}

/** Подтверждение от телефона: событие больше не нужно отправлять. */
export function ack(st, id) {
  const n = []
  let removed = false
  for (let k = 0; k < st.out.length; k++) {
    if (st.out[k].id === id) removed = true
    else n.push(st.out[k])
  }
  st.out = n
  return removed
}

/** События, которые пора (пере)отправить: прошло не меньше [gap] мс с прошлой попытки. */
export function due(st, now, gap) {
  const r = []
  for (let k = 0; k < st.out.length; k++) {
    if (now - (st.out[k].tried || 0) >= gap) r.push(st.out[k])
  }
  return r
}

/** Метка на кнопке занятия: минуты вверх (60…1), в тестовом режиме — секунды. */
export function label(st, ms) {
  if (st.test) return '' + clamp(Math.ceil(ms / 1000), 1, 60)
  return '' + clamp(Math.ceil(ms / 60000), 1, 60)
}

function two(n) { return n < 10 ? '0' + n : '' + n }

/** «мм:сс» (секунды вверх, как у обычного таймера: 15:00 -> 14:59 -> ... -> 00:01 -> 00:00). */
export function clock(ms) {
  const s = Math.ceil(clamp(ms, 0, QUICK) / 1000)
  return two(Math.floor(s / 60)) + ':' + two(s % 60)
}

/** Моменты, когда что-то закончится (для будильников): [{ t, kind }]. */
export function nextDue(st) {
  const r = []
  for (let i = 0; i < COUNT; i++) if (st.run[i] > 0) r.push({ t: st.run[i] + st.rem[i], kind: 'hour' })
  if (st.q.s === 1) r.push({ t: st.q.run + QUICK, kind: 'quick' })
  return r
}

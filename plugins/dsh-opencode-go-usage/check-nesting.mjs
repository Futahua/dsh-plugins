// Do the three Go windows nest inside each other, and with what durations?
// The nested-timeline idea only works if the month contains the week, which
// contains the 5-hour window.
import { AUTHORITY } from '../../config.mjs'
const { readFileSync } = await import('node:fs')

const yaml = readFileSync('D:/Letters/MatTroiSeConMoc/.dsh/.credentials.yaml', 'utf8')
const KEY = /OPENCODE_GO_API_KEY:\s*(\S+)/u.exec(yaml)?.[1]

const res = await fetch('https://opencode.ai/zen/go/v1/usage', {
  headers: { authorization: `Bearer ${KEY}`, accept: 'application/json', 'user-agent': 'dsh-usage-probe/1.0' },
})
const data = await res.json()
const now = Date.now()

// Documented Go window lengths.
const LENGTHS = { rolling: 5 * 3600e3, weekly: 7 * 864e5, monthly: 30 * 864e5 }
const HOUR = 3600e3
const DAY = 864e5

console.log('now:', new Date(now).toISOString(), '\n')
const rows = []
for (const key of ['rolling', 'weekly', 'monthly']) {
  const w = data.usage[key]
  const endsAt = Date.parse(w.resetsAt)
  const startsAt = endsAt - LENGTHS[key]
  const elapsed = now - startsAt
  rows.push({
    key,
    percent: w.percent,
    lengthHours: +(LENGTHS[key] / HOUR).toFixed(1),
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    endsInHours: +((endsAt - now) / HOUR).toFixed(2),
    elapsedFraction: +(elapsed / LENGTHS[key]).toFixed(4),
    usedFraction: +(w.percent / 100).toFixed(4),
  })
}
console.table(rows)

// Nesting check: is each shorter window fully inside the next longer one?
const r = data.usage.rolling, w = data.usage.weekly, m = data.usage.monthly
const rEnd = Date.parse(r.resetsAt), wEnd = Date.parse(w.resetsAt), mEnd = Date.parse(m.resetsAt)
const rStart = rEnd - LENGTHS.rolling, wStart = wEnd - LENGTHS.weekly, mStart = mEnd - LENGTHS.monthly

console.log('\n--- nesting ---')
console.log(`month  : ${new Date(mStart).toISOString()}  ->  ${new Date(mEnd).toISOString()}`)
console.log(`week   : ${new Date(wStart).toISOString()}  ->  ${new Date(wEnd).toISOString()}`)
console.log(`5-hour : ${new Date(rStart).toISOString()}  ->  ${new Date(rEnd).toISOString()}`)
console.log('')
console.log(`week inside month : ${wStart >= mStart && wEnd <= mEnd}`)
console.log(`5h   inside week  : ${rStart >= wStart && rEnd <= wEnd}`)
console.log(`5h   inside month : ${rStart >= mStart && rEnd <= mEnd}`)

// Where does "now" sit, as a fraction of the month?
console.log('')
console.log(`now as fraction of month : ${(((now - mStart) / LENGTHS.monthly) * 100).toFixed(1)}%`)
console.log(`week duration / month    : ${((LENGTHS.weekly / LENGTHS.monthly) * 100).toFixed(1)}%`)
console.log(`5h duration / month      : ${((LENGTHS.rolling / LENGTHS.monthly) * 100).toFixed(2)}%`)
console.log(`5h duration / week       : ${((LENGTHS.rolling / LENGTHS.weekly) * 100).toFixed(2)}%`)

// The documented dollar limits for a $60 model.
console.log('\n--- documented limits for a $60 monthly model ---')
console.log('  5-hour : $12   (20% of monthly)')
console.log('  weekly : $30   (50% of monthly)')
console.log('  monthly: $60   (100%)')

/**
 * Russian inverse text normalization: number words become digits ("двадцать пять" → "25",
 * "в две тысячи двадцать пятом году" → "в 2025 году").
 *
 * Deliberately conservative — a wrong digit in a chat message is worse than a written-out number:
 * single words below two are left alone, so idioms like "ни один" and "один в один" survive.
 *
 * ponytail: no decimals ("две целых пять десятых"), no fractions and no unit-aware rewrites ("полтора");
 * add a small grammar over the same token runs if dictating measurements matters.
 */
const CARDINAL = new Map(
  Object.entries({
    ноль: [0, 'unit'],
    один: [1, 'unit'], одна: [1, 'unit'], одно: [1, 'unit'],
    два: [2, 'unit'], две: [2, 'unit'], три: [3, 'unit'], четыре: [4, 'unit'],
    пять: [5, 'unit'], шесть: [6, 'unit'], семь: [7, 'unit'], восемь: [8, 'unit'], девять: [9, 'unit'],
    десять: [10, 'unit'], одиннадцать: [11, 'unit'], двенадцать: [12, 'unit'], тринадцать: [13, 'unit'],
    четырнадцать: [14, 'unit'], пятнадцать: [15, 'unit'], шестнадцать: [16, 'unit'], семнадцать: [17, 'unit'],
    восемнадцать: [18, 'unit'], девятнадцать: [19, 'unit'],
    двадцать: [20, 'ten'], тридцать: [30, 'ten'], сорок: [40, 'ten'], пятьдесят: [50, 'ten'],
    шестьдесят: [60, 'ten'], семьдесят: [70, 'ten'], восемьдесят: [80, 'ten'], девяносто: [90, 'ten'],
    сто: [100, 'hundred'], двести: [200, 'hundred'], триста: [300, 'hundred'], четыреста: [400, 'hundred'],
    пятьсот: [500, 'hundred'], шестьсот: [600, 'hundred'], семьсот: [700, 'hundred'], восемьсот: [800, 'hundred'],
    девятьсот: [900, 'hundred'],
    тысяча: [1000, 'scale'], тысячи: [1000, 'scale'], тысяч: [1000, 'scale'], тысячу: [1000, 'scale'],
    миллион: [1e6, 'scale'], миллиона: [1e6, 'scale'], миллионов: [1e6, 'scale'],
    миллиард: [1e9, 'scale'], миллиарда: [1e9, 'scale'], миллиардов: [1e9, 'scale'],
  }),
)

/** Ordinal stems; the inflection is stripped before the lookup, so "пятом", "пятый", "пятая" all match. */
const ORDINAL_STEMS = [
  ['перв', 1], ['втор', 2], ['трет', 3], ['четверт', 4], ['пят', 5], ['шест', 6], ['седьм', 7],
  ['восьм', 8], ['девят', 9], ['десят', 10], ['одиннадцат', 11], ['двенадцат', 12], ['тринадцат', 13],
  ['четырнадцат', 14], ['пятнадцат', 15], ['шестнадцат', 16], ['семнадцат', 17], ['восемнадцат', 18],
  ['девятнадцат', 19], ['двадцат', 20], ['тридцат', 30], ['сороков', 40], ['пятидесят', 50],
  ['шестидесят', 60], ['семидесят', 70], ['восьмидесят', 80], ['девяност', 90], ['сот', 100],
  ['двухсот', 200], ['трёхсот', 300], ['трехсот', 300], ['четырёхсот', 400], ['четырехсот', 400],
  ['пятисот', 500], ['шестисот', 600], ['семисот', 700], ['восьмисот', 800], ['девятисот', 900],
  ['тысячн', 1000], ['миллионн', 1e6],
]
const ORDINAL_TAIL = /(?:ый|ий|ой|ая|яя|ое|ее|ые|ие|ого|его|ому|ему|ом|ем|ым|им|ыми|ими|ых|их|ую|юю|ья|ье|ьи|ьего|ьему|ьем|ьих|ьими|ьим)$/

function ordinalValue(word) {
  if (!ORDINAL_TAIL.test(word)) return null
  for (const [stem, value] of ORDINAL_STEMS) {
    if (word.startsWith(stem) && word.length > stem.length) {
      const tail = word.slice(stem.length)
      if (ORDINAL_TAIL.test(tail)) return value
    }
  }
  return null
}

/** `{lead, word, trail}` for "«двадцать," → {lead: '«', word: 'двадцать', trail: ','}. */
function splitToken(raw) {
  const match = /^([^\p{L}]*)([\p{L}-]+)([^\p{L}]*)$/u.exec(raw)
  return match ? { lead: match[1], word: match[2].toLowerCase(), trail: match[3] } : null
}

const MAGNITUDE = { unit: 1, ten: 10, hundred: 100 }

/** Longest valid prefix of cardinal words, or null. */
function cardinalValue(entries) {
  let total = 0
  let current = 0
  let lastMagnitude = Number.POSITIVE_INFINITY
  for (const entry of entries) {
    const [value, kind] = entry
    if (kind === 'scale') {
      total += (current || 1) * value
      current = 0
      lastMagnitude = Number.POSITIVE_INFINITY
      continue
    }
    const magnitude = MAGNITUDE[kind]
    if (magnitude >= lastMagnitude) return null
    current += value
    lastMagnitude = magnitude
  }
  return total + current
}

export function normalizeNumbers(text) {
  const parts = text.split(/(\s+)/)
  const output = []
  let index = 0
  while (index < parts.length) {
    const token = splitToken(parts[index] ?? '')
    const cardinal = token ? CARDINAL.get(token.word) : undefined
    const ordinal = token && !cardinal ? ordinalValue(token.word) : null
    if (!cardinal && ordinal === null) {
      output.push(parts[index])
      index += 1
      continue
    }
    const words = []
    let lastIndex = index
    let lastToken = token
    let cursor = index
    for (;;) {
      const current = splitToken(parts[cursor] ?? '')
      if (!current) break
      const entry = CARDINAL.get(current.word)
      if (entry) {
        words.push({ value: entry[0], kind: entry[1] })
      } else {
        const value = ordinalValue(current.word)
        if (value === null) break
        words.push({ value, kind: 'ordinal' })
        lastIndex = cursor
        lastToken = current
        break
      }
      lastIndex = cursor
      lastToken = current
      const separator = parts[cursor + 1]
      if (separator === undefined || !/^\s+$/.test(separator)) break
      cursor += 2
    }
    const cardinals = words.filter((word) => word.kind !== 'ordinal').map((word) => [word.value, word.kind])
    const ordinals = words.filter((word) => word.kind === 'ordinal')
    const base = cardinals.length > 0 ? cardinalValue(cardinals) : 0
    const total = base === null ? null : base + ordinals.reduce((sum, word) => sum + word.value, 0)
    if (total === null || (ordinals.length === 0 && words.length < 2 && total < 2)) {
      output.push(parts[index])
      index += 1
      continue
    }
    output.push(`${lastToken.lead}${String(total)}${lastToken.trail}`)
    index = lastIndex + 1
  }
  return output.join('')
}

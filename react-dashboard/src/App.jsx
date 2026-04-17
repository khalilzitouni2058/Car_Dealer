import { useEffect, useMemo, useRef, useState } from 'react'
import html2canvas from 'html2canvas'
import Papa from 'papaparse'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const COLORS = ['#0f766e', '#0ea5e9', '#84cc16', '#f59e0b', '#ef4444']

const toNumber = (value) => {
  const text = String(value ?? '').replace(/[^\d.]/g, '')
  const number = Number.parseFloat(text)
  return Number.isFinite(number) ? number : null
}

const median = (arr) => {
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}

const formatPrice = (value) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '-'
  return `${new Intl.NumberFormat('fr-TN', {
    maximumFractionDigits: 0,
  }).format(value)} DT`
}

const r2Score = (actual, predicted) => {
  if (!actual.length || actual.length !== predicted.length) return null
  const mean = actual.reduce((s, v) => s + v, 0) / actual.length
  const ssTot = actual.reduce((s, v) => s + (v - mean) ** 2, 0)
  if (ssTot === 0) return null
  const ssRes = actual.reduce((s, v, i) => s + (v - predicted[i]) ** 2, 0)
  return 1 - ssRes / ssTot
}

const meanAbsoluteError = (actual, predicted) => {
  if (!actual.length || actual.length !== predicted.length) return null
  return actual.reduce((s, v, i) => s + Math.abs(v - predicted[i]), 0) / actual.length
}

const sampleRows = (arr, maxSize) => {
  if (arr.length <= maxSize) return arr
  const step = arr.length / maxSize
  const out = []
  for (let i = 0; i < maxSize; i += 1) {
    out.push(arr[Math.floor(i * step)])
  }
  return out
}

const seededShuffle = (arr, seed = 42) => {
  const out = [...arr]
  let state = seed
  const rand = () => {
    state = (1664525 * state + 1013904223) % 4294967296
    return state / 4294967296
  }
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const buildKnnPredictor = (trainRows, fuelWeight = 0.15) => {
  const kmVals = trainRows.map((r) => r.km)
  const yrVals = trainRows.map((r) => r.annee)
  const pVals = trainRows.map((r) => r.puissance)
  const kmMin = Math.min(...kmVals)
  const kmMax = Math.max(...kmVals)
  const yrMin = Math.min(...yrVals)
  const yrMax = Math.max(...yrVals)
  const pMin = Math.min(...pVals)
  const pMax = Math.max(...pVals)
  const norm = (v, min, max) => (max > min ? (v - min) / (max - min) : 0)

  return (query, k = 12) => {
    const qKm = norm(query.km, kmMin, kmMax)
    const qYr = norm(query.annee, yrMin, yrMax)
    const qPw = norm(query.puissance, pMin, pMax)

    const scored = trainRows.map((row) => {
      const dKm = norm(row.km, kmMin, kmMax) - qKm
      const dYr = norm(row.annee, yrMin, yrMax) - qYr
      const dPw = norm(row.puissance, pMin, pMax) - qPw
      const fuelPenalty = query.carburant !== 'unknown' && row.carburant !== query.carburant ? fuelWeight : 0
      return {
        distance: Math.sqrt(dKm ** 2 + dYr ** 2 + dPw ** 2) + fuelPenalty,
        price: row.price,
      }
    })

    const nearest = scored.sort((a, b) => a.distance - b.distance).slice(0, Math.min(k, scored.length))
    const weighted = nearest.reduce((sum, n) => sum + n.price / (n.distance + 1e-6), 0)
    const totalW = nearest.reduce((sum, n) => sum + 1 / (n.distance + 1e-6), 0)
    return weighted / totalW
  }
}

function App() {
  const [rows, setRows] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [input, setInput] = useState({
    km: '90000',
    annee: '2018',
    puissance: '120',
    carburant: 'unknown',
  })
  const [selectedBrand, setSelectedBrand] = useState('all')
  const [selectedFuel, setSelectedFuel] = useState('all')
  const [yearStart, setYearStart] = useState('')
  const [yearEnd, setYearEnd] = useState('')

  const priceRef = useRef(null)
  const fuelRef = useRef(null)
  const brandRef = useRef(null)
  const scatterRef = useRef(null)
  const sidebarScrollRef = useRef(null)

  useEffect(() => {
    const fetchTextWithTimeout = async (url, timeoutMs = 10000) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} while loading ${url}`)
        }
        return await res.text()
      } finally {
        clearTimeout(timer)
      }
    }

    const loadData = async () => {
      try {
        const candidates = [
          `${import.meta.env.BASE_URL}tayara_cars_clean_small.csv`,
          `${import.meta.env.BASE_URL}tayara_cars_clean.csv`,
          '/tayara_cars_clean_small.csv',
          '/tayara_cars_clean.csv',
        ]

        let csvText = ''
        let lastError = null

        for (const url of candidates) {
          try {
            csvText = await fetchTextWithTimeout(url)
            if (csvText && csvText.trim().length > 0) break
          } catch (err) {
            lastError = err
          }
        }

        if (!csvText || !csvText.trim()) {
          throw lastError ?? new Error('Could not load CSV dataset from public folder')
        }

        const parsed = Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
        })

        if (parsed.errors?.length) {
          throw new Error(`CSV parsing failed: ${parsed.errors[0].message}`)
        }

        const cleaned = parsed.data
          .map((row) => {
            const price = toNumber(row.price)
            const km = toNumber(row.km)
            const annee = toNumber(row.annee)
            const puissance = toNumber(row.puissance)
            const carburant = String(row.carburant ?? 'unknown').trim() || 'unknown'
            const marque = String(row.marque ?? 'unknown').trim() || 'unknown'
            if (price === null) return null
            return { price, km, annee, puissance, carburant, marque }
          })
          .filter(Boolean)

        if (!cleaned.length) {
          throw new Error('Dataset loaded but parsed rows are empty.')
        }

        setRows(cleaned)
      } catch (loadError) {
        setError(loadError.message)
      } finally {
        setIsLoading(false)
      }
    }

    loadData()
  }, [])

  const yearBounds = useMemo(() => {
    const years = rows.map((r) => r.annee).filter((v) => v !== null)
    if (!years.length) return { min: null, max: null }
    return { min: Math.min(...years), max: Math.max(...years) }
  }, [rows])

  useEffect(() => {
    if (yearBounds.min !== null && yearBounds.max !== null && !yearStart && !yearEnd) {
      setYearStart(String(yearBounds.min))
      setYearEnd(String(yearBounds.max))
    }
  }, [yearBounds, yearStart, yearEnd])

  const brandOptions = useMemo(() => {
    const values = Array.from(new Set(rows.map((r) => r.marque || 'unknown'))).sort()
    return ['all', ...values]
  }, [rows])

  const fuelOptions = useMemo(() => {
    const values = new Set(rows.map((row) => row.carburant || 'unknown'))
    return ['unknown', ...Array.from(values).filter((v) => v !== 'unknown')]
  }, [rows])

  const filterFuelOptions = useMemo(() => ['all', ...fuelOptions], [fuelOptions])

  const filteredRows = useMemo(() => {
    const ys = Number.parseFloat(yearStart)
    const ye = Number.parseFloat(yearEnd)

    return rows.filter((row) => {
      const brandOk = selectedBrand === 'all' || row.marque === selectedBrand
      const fuelOk = selectedFuel === 'all' || row.carburant === selectedFuel
      const yearOk = row.annee === null ||
        ((!Number.isFinite(ys) || row.annee >= ys) && (!Number.isFinite(ye) || row.annee <= ye))
      return brandOk && fuelOk && yearOk
    })
  }, [rows, selectedBrand, selectedFuel, yearStart, yearEnd])

  const kpis = useMemo(() => {
    const prices = filteredRows.map((row) => row.price)
    const kms = filteredRows.map((row) => row.km).filter((v) => v !== null)
    const years = filteredRows.map((row) => row.annee).filter((v) => v !== null)

    return {
      listings: filteredRows.length,
      avgPrice: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
      medianPrice: median(prices),
      avgKm: kms.length ? kms.reduce((a, b) => a + b, 0) / kms.length : null,
      yearMin: years.length ? Math.min(...years) : null,
      yearMax: years.length ? Math.max(...years) : null,
    }
  }, [filteredRows])

  const brandData = useMemo(() => {
    const groups = new Map()
    filteredRows.forEach((row) => {
      const key = row.marque
      const current = groups.get(key) ?? { total: 0, count: 0 }
      groups.set(key, { total: current.total + row.price, count: current.count + 1 })
    })

    return Array.from(groups.entries())
      .map(([brand, stats]) => ({
        brand,
        avgPrice: stats.total / stats.count,
        count: stats.count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  }, [filteredRows])

  const fuelData = useMemo(() => {
    const groups = new Map()
    filteredRows.forEach((row) => {
      groups.set(row.carburant, (groups.get(row.carburant) ?? 0) + 1)
    })

    return Array.from(groups.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6)
  }, [filteredRows])

  const priceHistogram = useMemo(() => {
    if (!filteredRows.length) return []

    const minPrice = Math.min(...filteredRows.map((row) => row.price))
    const maxPrice = Math.max(...filteredRows.map((row) => row.price))
    const bins = 12
    const width = (maxPrice - minPrice) / bins || 1

    const output = Array.from({ length: bins }, (_, i) => ({
      bucket: `${Math.round((minPrice + (i * width)) / 1000)}k-${Math.round((minPrice + ((i + 1) * width)) / 1000)}k`,
      count: 0,
    }))

    filteredRows.forEach((row) => {
      const idx = Math.min(bins - 1, Math.floor((row.price - minPrice) / width))
      output[idx].count += 1
    })

    return output
  }, [filteredRows])

  const scatterData = useMemo(
    () => sampleRows(filteredRows.filter((row) => row.km !== null && row.km < 500000), 1200),
    [filteredRows],
  )

  const yearTrendData = useMemo(() => {
    const byYear = new Map()
    filteredRows.forEach((row) => {
      if (row.annee === null) return
      const current = byYear.get(row.annee) ?? { year: row.annee, total: 0, count: 0 }
      byYear.set(row.annee, {
        year: row.annee,
        total: current.total + row.price,
        count: current.count + 1,
      })
    })

    return Array.from(byYear.values())
      .map((entry) => ({
        year: entry.year,
        avgPrice: entry.total / entry.count,
        count: entry.count,
      }))
      .sort((a, b) => a.year - b.year)
  }, [filteredRows])

  const topBrand = brandData[0] ?? null
  const topFuel = fuelData[0] ?? null
  const priceFloor = kpis.avgPrice ? kpis.avgPrice * 0.85 : null
  const priceCeil = kpis.avgPrice ? kpis.avgPrice * 1.15 : null
  const navItems = [
    { label: 'Overview', href: '#overview', accent: 'from-cyan-500 to-sky-600' },
    { label: 'Controls', href: '#controls', accent: 'from-teal-500 to-emerald-600' },
    { label: 'Estimator', href: '#estimator', accent: 'from-amber-500 to-orange-600' },
    { label: 'Charts', href: '#charts', accent: 'from-fuchsia-500 to-pink-600' },
  ]
  const sidebarMetrics = [
    { label: 'Records', value: kpis.listings.toLocaleString(), tone: 'from-cyan-500 to-sky-600' },
    { label: 'Top Brand', value: topBrand?.brand ?? '-', tone: 'from-teal-500 to-emerald-600' },
    { label: 'Top Fuel', value: topFuel?.name ?? '-', tone: 'from-amber-500 to-orange-600' },
    { label: 'Avg Price', value: formatPrice(kpis.avgPrice), tone: 'from-fuchsia-500 to-pink-600' },
  ]

  const modelRows = useMemo(
    () => sampleRows(filteredRows.filter((r) => r.km !== null && r.annee !== null && r.puissance !== null), 4000),
    [filteredRows],
  )

  const modelStats = useMemo(() => {
    if (modelRows.length < 60) return { holdoutR2: null, holdoutMae: null, cvR2: null }

    const shuffled = seededShuffle(modelRows, 42)
    const testSize = Math.max(20, Math.floor(shuffled.length * 0.2))
    const testRows = shuffled.slice(0, testSize)
    const trainRows = shuffled.slice(testSize)
    const predict = buildKnnPredictor(trainRows)

    const pred = testRows.map((r) => predict(r, 12))
    const actual = testRows.map((r) => r.price)

    const holdoutMae = meanAbsoluteError(actual, pred)
    const holdoutR2 = r2Score(actual, pred)

    const folds = 5
    const foldSize = Math.floor(shuffled.length / folds)
    const cvScores = []
    for (let f = 0; f < folds; f += 1) {
      const start = f * foldSize
      const end = f === folds - 1 ? shuffled.length : start + foldSize
      const testFold = shuffled.slice(start, end)
      const trainFold = [...shuffled.slice(0, start), ...shuffled.slice(end)]
      if (trainFold.length < 20 || testFold.length < 8) continue
      const foldPredict = buildKnnPredictor(trainFold)
      const foldPred = testFold.map((r) => foldPredict(r, 12))
      const foldActual = testFold.map((r) => r.price)
      const foldR2 = r2Score(foldActual, foldPred)
      if (foldR2 !== null) cvScores.push(foldR2)
    }

    const cvR2 = cvScores.length ? cvScores.reduce((a, b) => a + b, 0) / cvScores.length : null
    return { holdoutR2, holdoutMae, cvR2 }
  }, [modelRows])

  const modelPrediction = useMemo(() => {
    if (!modelRows.length) return null

    const km = Number.parseFloat(input.km)
    const annee = Number.parseFloat(input.annee)
    const puissance = Number.parseFloat(input.puissance)
    const carburant = input.carburant
    if (![km, annee, puissance].every(Number.isFinite)) return null

    const predict = buildKnnPredictor(modelRows)
    return predict({ km, annee, puissance, carburant }, 12)
  }, [input, modelRows])

  useEffect(() => {
    if (sidebarOpen && sidebarScrollRef.current) {
      sidebarScrollRef.current.scrollTop = 0
    }
  }, [sidebarOpen])

  const marketNotes = [
    `Median price: ${formatPrice(kpis.medianPrice)}`,
    `Mileage center: ${kpis.avgKm ? `${Math.round(kpis.avgKm).toLocaleString()} km` : '-'}`,
    `Model fit: ${modelStats.holdoutR2 === null ? '-' : modelStats.holdoutR2.toFixed(3)} R2`,
  ]

  const exportCsv = () => {
    const csv = Papa.unparse(filteredRows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'tayara_filtered_dashboard.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const exportChart = async (ref, filename) => {
    if (!ref.current) return
    const canvas = await html2canvas(ref.current, { backgroundColor: '#ffffff', scale: 2 })
    const link = document.createElement('a')
    link.download = filename
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  if (isLoading) {
    return (
      <main className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4 py-10">
        <p className="rounded-2xl border border-slate-200 bg-white/90 px-6 py-4 text-slate-600 shadow-sm">Loading cleaned dataset...</p>
      </main>
    )
  }

  if (error) {
    return (
      <main className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4 py-10">
        <p className="rounded-2xl border border-rose-200 bg-rose-50 px-6 py-4 text-rose-700 shadow-sm">{error}</p>
      </main>
    )
  }

  return (
    <main className="min-h-screen px-4 py-4 md:px-5 lg:px-6 lg:py-5">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1600px] flex-col gap-5 lg:flex-row">
        {sidebarOpen ? (
          <div
            className="fixed inset-0 z-40 bg-slate-950/55 backdrop-blur-sm lg:hidden"
            role="button"
            tabIndex={0}
            aria-label="Close sidebar overlay"
            onClick={() => setSidebarOpen(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
                setSidebarOpen(false)
              }
            }}
          />
        ) : null}

        <aside className={`fixed inset-y-0 left-0 z-50 h-dvh w-[300px] max-w-[85vw] transform transition-transform duration-300 lg:sticky lg:top-5 lg:z-auto lg:h-auto lg:w-[320px] lg:flex-none lg:self-start lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
          <div ref={sidebarScrollRef} className="flex h-full min-h-full flex-col overflow-hidden rounded-none border-r border-slate-200/80 bg-slate-950 text-white shadow-[0_24px_80px_rgba(15,23,42,0.24)] lg:h-auto lg:min-h-0 lg:rounded-[2rem] lg:border lg:shadow-[0_24px_80px_rgba(15,23,42,0.24)]">
            <div className="relative overflow-hidden px-5 py-6">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(45,212,191,0.28),transparent_30%),radial-gradient(circle_at_top_right,rgba(56,189,248,0.24),transparent_32%),linear-gradient(165deg,#0f172a_0%,#111827_55%,#082f49_100%)]" />
              <div className="absolute right-0 top-8 h-24 w-24 rounded-full bg-cyan-400/20 blur-3xl" />
              <div className="relative">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/10 text-lg font-bold text-cyan-100 ring-1 ring-white/10">T</div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200/80">Tayara Board</p>
                      <h1 className="font-serif text-2xl text-white">Market cockpit</h1>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white transition hover:bg-white/15 lg:hidden"
                    onClick={() => setSidebarOpen(false)}
                  >
                    Close
                  </button>
                </div>
                <p className="max-w-xs text-sm leading-6 text-slate-200">
                  A cleaner dashboard shell for browsing the car market, reading signals, and exporting views.
                </p>
                <div className="mt-5 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-100/90">
                  <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1">Live filters</span>
                  <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1">Cool visuals</span>
                </div>
              </div>
            </div>

            <nav className="px-5 pb-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-100/70">Navigation</p>
              <div className="mt-3 grid gap-2">
                {navItems.map((item, index) => (
                  <a
                    key={item.label}
                    href={item.href}
                    className="group flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 transition hover:-translate-y-0.5 hover:bg-white/10"
                    onClick={() => setSidebarOpen(false)}
                  >
                    <span className={`flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br ${item.accent} text-sm font-bold text-white shadow-lg shadow-black/10`}>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="text-sm font-medium text-white">{item.label}</span>
                  </a>
                ))}
              </div>
            </nav>

            <div className="grid gap-3 px-5 pb-5">
              {sidebarMetrics.map((item) => (
                <div key={item.label} className="rounded-2xl border border-white/10 bg-white/8 p-4 backdrop-blur-md">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.22em] text-slate-300/80">{item.label}</p>
                      <p className="mt-1 text-lg font-semibold text-white">{item.value}</p>
                    </div>
                    <div className={`h-10 w-10 rounded-2xl bg-gradient-to-br ${item.tone}`} />
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t border-white/10 px-5 py-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-100/70">Market notes</p>
              <div className="mt-3 space-y-3">
                {marketNotes.map((note) => (
                  <div key={note} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200">
                    {note}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-auto border-t border-white/10 px-5 py-5">
              <div className="rounded-[1.5rem] bg-white/8 p-4 ring-1 ring-white/10">
                <p className="text-xs uppercase tracking-[0.22em] text-cyan-100/70">Active filters</p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <span className="rounded-xl bg-white/10 px-3 py-2 text-center">{selectedBrand === 'all' ? 'All brands' : selectedBrand}</span>
                  <span className="rounded-xl bg-white/10 px-3 py-2 text-center">{selectedFuel === 'all' ? 'All fuels' : selectedFuel}</span>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <section className="min-w-0 flex-1 space-y-5">
          <header className="rounded-[2rem] border border-slate-200/80 bg-white/85 px-5 py-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur-sm md:px-6">
            <div className="mb-4 flex items-center justify-between lg:hidden">
              <button
                type="button"
                className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-lg shadow-slate-950/10"
                onClick={() => setSidebarOpen(true)}
              >
                Menu
              </button>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Dashboard</span>
            </div>

            <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between" id="overview">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">Overview</p>
                <h2 className="mt-2 font-serif text-3xl text-slate-900 md:text-4xl">Used Car Intelligence Board</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                  Explore the Tunisian used car market through a stronger layout, denser card hierarchy, and sharper visual cues.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:min-w-[560px]">
                <div className="rounded-2xl bg-slate-950 px-4 py-3 text-white shadow-lg shadow-slate-950/10">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-slate-300">Rows</p>
                  <p className="mt-1 text-xl font-bold">{kpis.listings.toLocaleString()}</p>
                </div>
                <div className="rounded-2xl bg-gradient-to-br from-teal-600 to-emerald-600 px-4 py-3 text-white shadow-lg shadow-teal-600/20">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-teal-50/80">Median</p>
                  <p className="mt-1 text-lg font-bold">{formatPrice(kpis.medianPrice)}</p>
                </div>
                <div className="rounded-2xl bg-gradient-to-br from-sky-500 to-cyan-500 px-4 py-3 text-white shadow-lg shadow-sky-500/20">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-50/80">Top brand</p>
                  <p className="mt-1 text-lg font-bold">{topBrand ? topBrand.brand : '-'}</p>
                </div>
                <div className="rounded-2xl bg-gradient-to-br from-amber-500 to-orange-500 px-4 py-3 text-white shadow-lg shadow-amber-500/20">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-orange-50/80">Top fuel</p>
                  <p className="mt-1 text-lg font-bold">{topFuel ? topFuel.name : '-'}</p>
                </div>
              </div>
            </div>
          </header>

          <section className="rounded-[1.75rem] border border-slate-200/80 bg-white/90 p-4 shadow-[0_18px_50px_rgba(15,23,42,0.08)]" id="controls">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-serif text-xl text-slate-900 md:text-2xl">Market Controls</h2>
                <p className="text-sm text-slate-600">Shape the dashboard by brand, fuel, and year.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                <span className="rounded-full bg-slate-100 px-3 py-1">{selectedBrand === 'all' ? 'All brands' : selectedBrand}</span>
                <span className="rounded-full bg-slate-100 px-3 py-1">{selectedFuel === 'all' ? 'All fuels' : selectedFuel}</span>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <label className="text-sm font-medium text-slate-700">
                Brand
                <select className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring"
                  value={selectedBrand}
                  onChange={(e) => setSelectedBrand(e.target.value)}
                >
                  {brandOptions.map((brand) => (
                    <option key={brand} value={brand}>{brand}</option>
                  ))}
                </select>
              </label>

              <label className="text-sm font-medium text-slate-700">
                Fuel
                <select className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring"
                  value={selectedFuel}
                  onChange={(e) => setSelectedFuel(e.target.value)}
                >
                  {filterFuelOptions.map((fuel) => (
                    <option key={fuel} value={fuel}>{fuel}</option>
                  ))}
                </select>
              </label>

              <label className="text-sm font-medium text-slate-700">
                Year From
                <input
                  className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring"
                  value={yearStart}
                  onChange={(e) => setYearStart(e.target.value)}
                />
              </label>

              <label className="text-sm font-medium text-slate-700">
                Year To
                <input
                  className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring"
                  value={yearEnd}
                  onChange={(e) => setYearEnd(e.target.value)}
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button className="rounded-full bg-slate-950 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-lg shadow-slate-950/10 transition hover:-translate-y-0.5 hover:bg-slate-800" onClick={exportCsv}>Export CSV</button>
              <button className="rounded-full bg-gradient-to-r from-teal-700 to-emerald-600 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-lg shadow-teal-700/20 transition hover:-translate-y-0.5" onClick={() => exportChart(priceRef, 'price_distribution.png')}>Price Chart</button>
              <button className="rounded-full bg-gradient-to-r from-sky-600 to-cyan-500 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-lg shadow-sky-600/20 transition hover:-translate-y-0.5" onClick={() => exportChart(fuelRef, 'fuel_mix.png')}>Fuel Chart</button>
              <button className="rounded-full bg-gradient-to-r from-lime-600 to-emerald-500 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-lg shadow-lime-600/20 transition hover:-translate-y-0.5" onClick={() => exportChart(brandRef, 'brand_price_chart.png')}>Brand Chart</button>
              <button className="rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-lg shadow-amber-500/20 transition hover:-translate-y-0.5" onClick={() => exportChart(scatterRef, 'mileage_price_scatter.png')}>Scatter</button>
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <article className="group overflow-hidden rounded-[1.5rem] border border-slate-200/80 bg-white shadow-[0_18px_40px_rgba(15,23,42,0.07)] transition hover:-translate-y-1 hover:shadow-[0_22px_60px_rgba(15,23,42,0.12)]">
              <div className="bg-gradient-to-r from-sky-500 to-teal-500 px-4 py-3 text-white">
                <p className="text-[11px] uppercase tracking-[0.22em] text-white/80">Median Price</p>
                <p className="mt-2 text-2xl font-bold">{formatPrice(kpis.medianPrice)}</p>
              </div>
              <div className="p-4">
                <p className="text-sm text-slate-500">Middle value of the filtered market.</p>
              </div>
            </article>

            <article className="group overflow-hidden rounded-[1.5rem] border border-slate-200/80 bg-white shadow-[0_18px_40px_rgba(15,23,42,0.07)] transition hover:-translate-y-1 hover:shadow-[0_22px_60px_rgba(15,23,42,0.12)]">
              <div className="bg-gradient-to-r from-emerald-500 to-lime-500 px-4 py-3 text-white">
                <p className="text-[11px] uppercase tracking-[0.22em] text-white/80">Average Price</p>
                <p className="mt-2 text-2xl font-bold">{formatPrice(kpis.avgPrice)}</p>
              </div>
              <div className="p-4">
                <p className="text-sm text-slate-500">Useful for spotting the general market level.</p>
              </div>
            </article>

            <article className="group overflow-hidden rounded-[1.5rem] border border-slate-200/80 bg-white shadow-[0_18px_40px_rgba(15,23,42,0.07)] transition hover:-translate-y-1 hover:shadow-[0_22px_60px_rgba(15,23,42,0.12)]">
              <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-3 text-white">
                <p className="text-[11px] uppercase tracking-[0.22em] text-white/80">Average Mileage</p>
                <p className="mt-2 text-2xl font-bold">{kpis.avgKm ? `${Math.round(kpis.avgKm).toLocaleString()} km` : '-'}</p>
              </div>
              <div className="p-4">
                <p className="text-sm text-slate-500">Where the current sample sits on the road.</p>
              </div>
            </article>

            <article className="group overflow-hidden rounded-[1.5rem] border border-slate-200/80 bg-white shadow-[0_18px_40px_rgba(15,23,42,0.07)] transition hover:-translate-y-1 hover:shadow-[0_22px_60px_rgba(15,23,42,0.12)]">
              <div className="bg-gradient-to-r from-fuchsia-500 to-cyan-500 px-4 py-3 text-white">
                <p className="text-[11px] uppercase tracking-[0.22em] text-white/80">Year Range</p>
                <p className="mt-2 text-2xl font-bold">{kpis.yearMin && kpis.yearMax ? `${kpis.yearMin} - ${kpis.yearMax}` : '-'}</p>
              </div>
              <div className="p-4">
                <p className="text-sm text-slate-500">Model years in the filtered set.</p>
              </div>
            </article>
          </section>

          <section className="rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_50px_rgba(15,23,42,0.08)]" id="estimator">
            <div className="mb-3">
              <h2 className="font-serif text-2xl text-slate-900">Price Estimator (KNN)</h2>
              <p className="text-sm text-slate-600">Estimate a price from nearest neighbors in the filtered sample.</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="text-sm font-medium text-slate-700">
                Mileage (km)
                <input className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring" value={input.km} onChange={(e) => setInput((s) => ({ ...s, km: e.target.value }))} />
              </label>
              <label className="text-sm font-medium text-slate-700">
                Year
                <input className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring" value={input.annee} onChange={(e) => setInput((s) => ({ ...s, annee: e.target.value }))} />
              </label>
              <label className="text-sm font-medium text-slate-700">
                Power (hp)
                <input className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring" value={input.puissance} onChange={(e) => setInput((s) => ({ ...s, puissance: e.target.value }))} />
              </label>
              <label className="text-sm font-medium text-slate-700">
                Fuel Type
                <select className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring" value={input.carburant} onChange={(e) => setInput((s) => ({ ...s, carburant: e.target.value }))}>
                  {fuelOptions.map((fuel) => (
                    <option key={fuel} value={fuel}>{fuel}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-4 overflow-hidden rounded-[1.5rem] border border-slate-200 bg-gradient-to-r from-teal-50 via-sky-50 to-cyan-50 p-4 shadow-inner">
              <p className="text-xs font-medium uppercase tracking-[0.28em] text-slate-500">Predicted Price</p>
              <p className="mt-1 text-3xl font-bold text-slate-900">{formatPrice(modelPrediction)}</p>
            </div>

            <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-700">
              <span>KNN Holdout R2: <b>{modelStats.holdoutR2 === null ? '-' : modelStats.holdoutR2.toFixed(3)}</b></span>
              <span>KNN Holdout MAE: <b>{modelStats.holdoutMae === null ? '-' : formatPrice(modelStats.holdoutMae)}</b></span>
              <span>KNN 5-Fold Mean R2: <b>{modelStats.cvR2 === null ? '-' : modelStats.cvR2.toFixed(3)}</b></span>
              <span className="text-slate-500">metrics on sampled rows for speed</span>
            </div>
          </section>

          <section className="grid gap-4 xl:grid-cols-12" id="charts">
            <article className="rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_50px_rgba(15,23,42,0.08)] xl:col-span-4" ref={priceRef}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="font-serif text-xl text-slate-900">Price Distribution</h2>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Histogram</span>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={priceHistogram}>
                  <defs>
                    <linearGradient id="priceBars" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#38bdf8" />
                      <stop offset="100%" stopColor="#0f766e" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis dataKey="bucket" hide />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="count" fill="url(#priceBars)" radius={[12, 12, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </article>

            <article className="rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_50px_rgba(15,23,42,0.08)] xl:col-span-4" ref={fuelRef}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="font-serif text-xl text-slate-900">Fuel Mix</h2>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Share</span>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie data={fuelData} dataKey="value" nameKey="name" innerRadius={58} outerRadius={98} paddingAngle={4} labelLine={false} label>
                    {fuelData.map((entry, index) => (
                      <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </article>

            <article className="rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_50px_rgba(15,23,42,0.08)] xl:col-span-4" ref={scatterRef}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="font-serif text-xl text-slate-900">Mileage vs Price</h2>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Scatter</span>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <ScatterChart>
                  <defs>
                    <linearGradient id="scatterGlow" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#f59e0b" />
                      <stop offset="100%" stopColor="#ef4444" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis type="number" dataKey="km" name="Mileage" unit=" km" />
                  <YAxis type="number" dataKey="price" name="Price" />
                  <Tooltip cursor={{ strokeDasharray: '3 3' }} formatter={(v, n) => (n === 'price' ? formatPrice(v) : Math.round(v))} />
                  <Scatter data={scatterData} fill="url(#scatterGlow)" />
                </ScatterChart>
              </ResponsiveContainer>
            </article>

            <article className="rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_50px_rgba(15,23,42,0.08)] xl:col-span-7" ref={brandRef}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-serif text-xl text-slate-900">Top Brands by Average Price</h2>
                  <p className="text-sm text-slate-600">A horizontal ranking view with stronger spacing.</p>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Rank</span>
              </div>
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={brandData} layout="vertical" margin={{ left: 20, right: 12 }} barCategoryGap={18}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis type="number" tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                  <YAxis type="category" dataKey="brand" width={100} />
                  <Tooltip formatter={(v) => formatPrice(v)} />
                  <Bar dataKey="avgPrice" radius={[0, 16, 16, 0]}>
                    {brandData.map((entry, index) => (
                      <Cell key={entry.brand} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </article>

            <article className="rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_50px_rgba(15,23,42,0.08)] xl:col-span-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-serif text-xl text-slate-900">Average Price by Year</h2>
                  <p className="text-sm text-slate-600">A cleaner way to see the trend line across the filtered market.</p>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Trend</span>
              </div>
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={yearTrendData}>
                  <defs>
                    <linearGradient id="trendLine" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#0f766e" />
                      <stop offset="100%" stopColor="#0ea5e9" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="year" />
                  <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                  <Tooltip formatter={(v) => formatPrice(v)} />
                  <Line type="monotone" dataKey="avgPrice" stroke="url(#trendLine)" strokeWidth={4} dot={{ r: 4 }} activeDot={{ r: 7 }} />
                </LineChart>
              </ResponsiveContainer>
            </article>
          </section>
        </section>
      </div>
    </main>
  )
}

export default App

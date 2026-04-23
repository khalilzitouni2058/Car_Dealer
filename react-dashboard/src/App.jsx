import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import html2canvas from 'html2canvas'
import Papa from 'papaparse'
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis,
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
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const formatPrice = (value) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '-'
  return `${new Intl.NumberFormat('fr-TN', { maximumFractionDigits: 0 }).format(value)} DT`
}

const sampleRows = (arr, maxSize) => {
  if (arr.length <= maxSize) return arr
  const step = arr.length / maxSize
  const out = []
  for (let i = 0; i < maxSize; i += 1) out.push(arr[Math.floor(i * step)])
  return out
}

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'
const EMPTY_METRICS = {
  catboost: { r2: null, mae: null },
  neural: { r2: null, mae: null },
  ensemble: { r2: null, mae: null },
}
const EMPTY_PREDICTIONS = {
  catboost: null,
  neural: null,
  ensemble: null,
  status: 'idle',
  error: '',
}

const HOW_TO_STEPS = [
  {
    eyebrow: 'Step 01',
    title: 'Start with the overview',
    text: 'This section shows the dashboard summary and the main market numbers: total rows, median price, top brand, and top fuel.',
    accent: 'from-cyan-400 to-sky-500',
    target: 'overview',
  },
  {
    eyebrow: 'Step 02',
    title: 'Upload your CSV',
    text: 'Use this section to load your cleaned CSV. After upload, the dashboard can build the KPIs, filters, charts, and estimator.',
    accent: 'from-teal-400 to-emerald-500',
    target: 'upload',
  },
  {
    eyebrow: 'Step 03',
    title: 'Filter the market',
    text: 'Use brand, fuel, and year filters here to reshape the whole dashboard and focus on the cars you want to analyze.',
    accent: 'from-amber-400 to-orange-500',
    target: 'controls',
  },
  {
    eyebrow: 'Step 04',
    title: 'Estimate a price',
    text: 'Enter mileage, year, power, and fuel type here to compare the CatBoost, Neural Network, and ensemble predictions.',
    accent: 'from-fuchsia-400 to-rose-500',
    target: 'estimator',
  },
  {
    eyebrow: 'Step 05',
    title: 'Read the charts',
    text: 'Use these charts to understand price distribution, fuel mix, mileage relationships, brand ranking, and year trends.',
    accent: 'from-cyan-400 to-sky-500',
    target: 'charts',
  },
]

const buildPredictionPayload = (input) => {
  const km = Number.parseFloat(input.km)
  const annee = Number.parseFloat(input.annee)
  const puissance = Number.parseFloat(input.puissance)
  if (![km, annee, puissance].every(Number.isFinite)) return null
  return { km, annee, puissance, carburant: input.carburant }
}

const parseCSV = (text) => {
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true })
  if (parsed.errors?.length) throw new Error(`CSV parse error: ${parsed.errors[0].message}`)
  return parsed.data
    .map((row) => {
      const price     = toNumber(row.price)
      const km        = toNumber(row.km)
      const annee     = toNumber(row.annee)
      const puissance = toNumber(row.puissance)
      const carburant = String(row.carburant ?? 'unknown').trim() || 'unknown'
      const marque    = String(row.marque ?? 'unknown').trim() || 'unknown'
      if (price === null) return null
      return { price, km, annee, puissance, carburant, marque }
    })
    .filter(Boolean)
}

export default function App() {
  const [rows, setRows]               = useState([])
  const [isLoading, setIsLoading]     = useState(true)
  const [isDragging, setIsDragging]   = useState(false)
  const [uploadInfo, setUploadInfo]   = useState('')
  const [error, setError]             = useState('')
  const [modelServiceError, setModelServiceError] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [howToOpen, setHowToOpen] = useState(false)
  const [howToStep, setHowToStep] = useState(0)
  const [input, setInput]             = useState({ km: '90000', annee: '2018', puissance: '8', carburant: 'unknown' })
  const [selectedBrand, setSelectedBrand] = useState('all')
  const [selectedFuel, setSelectedFuel]   = useState('all')
  const [yearStart, setYearStart] = useState('')
  const [yearEnd, setYearEnd]     = useState('')
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('tayara-theme') === 'dark')
  const [modelInfo, setModelInfo] = useState({
    available: false,
    metrics: EMPTY_METRICS,
    models: { primary: 'CatBoost', secondary: 'Neural Network' },
  })
  const [predictionState, setPredictions] = useState(EMPTY_PREDICTIONS)

  const priceRef    = useRef(null)
  const fuelRef     = useRef(null)
  const brandRef    = useRef(null)
  const scatterRef  = useRef(null)
  const sidebarScrollRef = useRef(null)
  const fileInputRef     = useRef(null)

  const loadFromText = useCallback((text, filename = '') => {
    try {
      const cleaned = parseCSV(text)
      if (!cleaned.length) throw new Error('No valid rows found in the CSV.')
      setRows(cleaned)
      setError('')
      setUploadInfo(filename ? `✓ Loaded "${filename}" — ${cleaned.length.toLocaleString()} rows` : `✓ ${cleaned.length.toLocaleString()} rows loaded`)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  // Wait for the user to upload a CSV instead of auto-loading a bundled file.
  useEffect(() => {
    setError('Please upload your CSV file to load the dashboard.')
    setIsLoading(false)
  }, [])

  // File handlers
  const handleFile = useCallback((file) => {
    if (!file || !file.name.endsWith('.csv')) { setError('Please upload a .csv file.'); return }
    const reader = new FileReader()
    reader.onload = (e) => loadFromText(e.target.result, file.name)
    reader.readAsText(file)
  }, [loadFromText])

  const handleDrop = useCallback((e) => {
    e.preventDefault(); setIsDragging(false)
    handleFile(e.dataTransfer.files[0])
  }, [handleFile])

  const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true) }
  const handleDragLeave = () => setIsDragging(false)
  const currentHowToStep = HOW_TO_STEPS[howToStep]
  const activeGuide = howToOpen ? currentHowToStep.target : ''
  const openHowTo = () => {
    setHowToStep(0)
    setHowToOpen(true)
    setSidebarOpen(false)
  }
  const closeHowTo = () => setHowToOpen(false)
  const nextHowToStep = () => {
    if (howToStep < HOW_TO_STEPS.length - 1) {
      setHowToStep((step) => step + 1)
    } else {
      closeHowTo()
    }
  }

  useEffect(() => {
    if (!howToOpen) return
    const target = document.getElementById(currentHowToStep.target)
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentHowToStep.target, howToOpen])

  useEffect(() => {
    localStorage.setItem('tayara-theme', isDarkMode ? 'dark' : 'light')
  }, [isDarkMode])

  // Year bounds
  const yearBounds = useMemo(() => {
    const years = rows.map((r) => r.annee).filter((v) => v !== null)
    if (!years.length) return { min: null, max: null }
    return { min: Math.min(...years), max: Math.max(...years) }
  }, [rows])

  useEffect(() => {
    if (yearBounds.min !== null && !yearStart && !yearEnd) {
      setYearStart(String(yearBounds.min))
      setYearEnd(String(yearBounds.max))
    }
  }, [yearBounds, yearStart, yearEnd])

  useEffect(() => {
    let ignore = false
    const controller = new AbortController()

    const loadModelInfo = async () => {
      try {
        const res = await fetch(`${API_BASE}/model-info`, { signal: controller.signal })
        if (!res.ok) throw new Error('Model service is not available.')
        const data = await res.json()
        if (ignore) return
        setModelInfo({
          available: Boolean(data.available),
          metrics: data.metrics ?? EMPTY_METRICS,
          models: data.models ?? { primary: 'CatBoost', secondary: 'Neural Network' },
        })
        setModelServiceError(data.available ? '' : (data.error ?? 'Exported model files were not found.'))
      } catch (err) {
        if (ignore || err.name === 'AbortError') return
        setModelInfo({
          available: false,
          metrics: EMPTY_METRICS,
          models: { primary: 'CatBoost', secondary: 'Neural Network' },
        })
        setModelServiceError(err.message || 'Model service is not available.')
      }
    }

    loadModelInfo()
    return () => {
      ignore = true
      controller.abort()
    }
  }, [])

  const brandOptions = useMemo(() => ['all', ...Array.from(new Set(rows.map((r) => r.marque || 'unknown'))).sort()], [rows])
  const fuelOptions  = useMemo(() => {
    const values = new Set(rows.map((r) => r.carburant || 'unknown'))
    return ['unknown', ...Array.from(values).filter((v) => v !== 'unknown')]
  }, [rows])
  const filterFuelOptions = useMemo(() => ['all', ...fuelOptions], [fuelOptions])

  const filteredRows = useMemo(() => {
    const ys = Number.parseFloat(yearStart)
    const ye = Number.parseFloat(yearEnd)
    return rows.filter((row) => {
      const brandOk = selectedBrand === 'all' || row.marque === selectedBrand
      const fuelOk  = selectedFuel === 'all' || row.carburant === selectedFuel
      const yearOk  = row.annee === null || ((!Number.isFinite(ys) || row.annee >= ys) && (!Number.isFinite(ye) || row.annee <= ye))
      return brandOk && fuelOk && yearOk
    })
  }, [rows, selectedBrand, selectedFuel, yearStart, yearEnd])

  const kpis = useMemo(() => {
    const prices = filteredRows.map((r) => r.price)
    const kms    = filteredRows.map((r) => r.km).filter((v) => v !== null)
    const years  = filteredRows.map((r) => r.annee).filter((v) => v !== null)
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
      const cur = groups.get(row.marque) ?? { total: 0, count: 0 }
      groups.set(row.marque, { total: cur.total + row.price, count: cur.count + 1 })
    })
    return Array.from(groups.entries())
      .map(([brand, s]) => ({ brand, avgPrice: s.total / s.count, count: s.count }))
      .sort((a, b) => b.count - a.count).slice(0, 10)
  }, [filteredRows])

  const fuelData = useMemo(() => {
    const groups = new Map()
    filteredRows.forEach((row) => groups.set(row.carburant, (groups.get(row.carburant) ?? 0) + 1))
    return Array.from(groups.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 6)
  }, [filteredRows])

  const priceHistogram = useMemo(() => {
    if (!filteredRows.length) return []
    const minP = Math.min(...filteredRows.map((r) => r.price))
    const maxP = Math.max(...filteredRows.map((r) => r.price))
    const bins = 12, width = (maxP - minP) / bins || 1
    const output = Array.from({ length: bins }, (_, i) => ({
      bucket: `${Math.round((minP + i * width) / 1000)}k–${Math.round((minP + (i + 1) * width) / 1000)}k`,
      count: 0,
    }))
    filteredRows.forEach((row) => { const idx = Math.min(bins - 1, Math.floor((row.price - minP) / width)); output[idx].count += 1 })
    return output
  }, [filteredRows])

  const scatterData  = useMemo(() => sampleRows(filteredRows.filter((r) => r.km !== null && r.km < 500000), 1200), [filteredRows])
  const yearTrendData = useMemo(() => {
    const byYear = new Map()
    filteredRows.forEach((row) => {
      if (row.annee === null) return
      const cur = byYear.get(row.annee) ?? { year: row.annee, total: 0, count: 0 }
      byYear.set(row.annee, { year: row.annee, total: cur.total + row.price, count: cur.count + 1 })
    })
    return Array.from(byYear.values()).map((e) => ({ year: e.year, avgPrice: e.total / e.count })).sort((a, b) => a.year - b.year)
  }, [filteredRows])

  const topBrand = brandData[0] ?? null
  const topFuel  = fuelData[0] ?? null

  const predictionPayload = useMemo(() => buildPredictionPayload(input), [input])

  useEffect(() => {
    let ignore = false
    const controller = new AbortController()

    if (!predictionPayload) {
      setPredictions(EMPTY_PREDICTIONS)
      return () => controller.abort()
    }
    if (!modelInfo.available) {
      setPredictions((current) => ({ ...current, status: 'idle' }))
      return () => controller.abort()
    }

    const timer = setTimeout(async () => {
      setPredictions((current) => ({ ...current, status: 'loading', error: '' }))
      try {
        const res = await fetch(`${API_BASE}/predict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(predictionPayload),
          signal: controller.signal,
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error ?? 'Prediction request failed.')
        }
        const data = await res.json()
        if (ignore) return
        setPredictions({
          catboost: data.predictions?.catboost ?? null,
          neural: data.predictions?.neural ?? null,
          ensemble: data.predictions?.ensemble ?? null,
          status: 'ready',
          error: '',
        })
      } catch (err) {
        if (ignore || err.name === 'AbortError') return
        setPredictions({
          ...EMPTY_PREDICTIONS,
          status: 'error',
          error: err.message || 'Prediction service is not available.',
        })
      }
    }, 250)

    return () => {
      ignore = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [modelInfo.available, predictionPayload])

  const modelStats = { knnR2: null, knnMae: null, lrR2: null, lrMae: null, ensR2: null, ensMae: null }
  const unusedLegacyMarketNotes = [


  // ── Dual model stats (holdout) ────────────────────────────────────────────

  // ── Dual model prediction ─────────────────────────────────────────────────

    `KNN R²: ${modelStats.knnR2 === null ? '-' : modelStats.knnR2.toFixed(3)}`,
    `LR  R²: ${modelStats.lrR2 === null ? '-' : modelStats.lrR2.toFixed(3)}`,
  ]

  void unusedLegacyMarketNotes

  const marketNotes = [
    `Median price: ${formatPrice(kpis.medianPrice)}`,
    `Mileage center: ${kpis.avgKm ? `${Math.round(kpis.avgKm).toLocaleString()} km` : '-'}`,
    `CatBoost R²: ${modelInfo.metrics.catboost?.r2 === null ? '-' : modelInfo.metrics.catboost?.r2?.toFixed(3) ?? '-'}`,
    `Neural R²: ${modelInfo.metrics.neural?.r2 === null ? '-' : modelInfo.metrics.neural?.r2?.toFixed(3) ?? '-'}`,
  ]

  const predictions = useMemo(() => ({
    ...predictionState,
    knn: predictionState.catboost,
    lr: predictionState.neural,
  }), [predictionState])

  Object.assign(modelStats, {
    knnR2: modelInfo.metrics.catboost?.r2 ?? null,
    knnMae: modelInfo.metrics.catboost?.mae ?? null,
    lrR2: modelInfo.metrics.neural?.r2 ?? null,
    lrMae: modelInfo.metrics.neural?.mae ?? null,
    ensR2: modelInfo.metrics.ensemble?.r2 ?? null,
    ensMae: modelInfo.metrics.ensemble?.mae ?? null,
  })

  const navItems = [
    { label: 'Overview',  href: '#overview',  accent: 'from-cyan-500 to-sky-600' },
    { label: 'Upload',    href: '#upload',     accent: 'from-violet-500 to-purple-600' },
    { label: 'Controls',  href: '#controls',   accent: 'from-teal-500 to-emerald-600' },
    { label: 'Estimator', href: '#estimator',  accent: 'from-amber-500 to-orange-600' },
    { label: 'Charts',    href: '#charts',     accent: 'from-fuchsia-500 to-pink-600' },
  ]

  const sidebarMetrics = [
    { label: 'Records',   value: kpis.listings.toLocaleString(), tone: 'from-cyan-500 to-sky-600' },
    { label: 'Top Brand', value: topBrand?.brand ?? '-',          tone: 'from-teal-500 to-emerald-600' },
    { label: 'Top Fuel',  value: topFuel?.name ?? '-',            tone: 'from-amber-500 to-orange-600' },
    { label: 'Avg Price', value: formatPrice(kpis.avgPrice),      tone: 'from-fuchsia-500 to-pink-600' },
  ]

  const exportCsv = () => {
    const csv  = Papa.unparse(filteredRows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = 'tayara_filtered.csv'; link.click()
    URL.revokeObjectURL(url)
  }

  const exportChart = async (ref, filename) => {
    if (!ref.current) return
    const canvas = await html2canvas(ref.current, { backgroundColor: '#ffffff', scale: 2 })
    const link = document.createElement('a')
    link.download = filename; link.href = canvas.toDataURL('image/png'); link.click()
  }

  if (isLoading) return (
    <main className={`flex min-h-screen items-center justify-center ${isDarkMode ? 'app-dark' : ''}`}>
      <p className="rounded-2xl border border-slate-200 bg-white/90 px-6 py-4 text-slate-600 shadow-sm">Loading dataset...</p>
    </main>
  )

  return (
    <main className={`min-h-screen px-4 py-4 transition-colors duration-300 md:px-5 lg:px-6 lg:py-5 ${isDarkMode ? 'app-dark' : ''}`}>
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1600px] flex-col gap-5 lg:flex-row">

        {/* Overlay */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-40 bg-slate-950/55 backdrop-blur-sm lg:hidden"
            role="button" tabIndex={0} aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
            onKeyDown={(e) => { if (['Escape','Enter',' '].includes(e.key)) setSidebarOpen(false) }}
          />
        )}

        {howToOpen && (
          <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[80] px-4">
            <div className="pointer-events-auto mx-auto max-w-3xl overflow-hidden rounded-[1.75rem] border border-slate-200/80 bg-white/95 text-slate-900 shadow-[0_24px_80px_rgba(15,23,42,0.28)] backdrop-blur-xl">
              <div className={`h-1.5 bg-gradient-to-r ${currentHowToStep.accent}`} />
              <div className="grid gap-4 p-4 md:grid-cols-[1fr_auto] md:items-center">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                    {currentHowToStep.eyebrow} of {HOW_TO_STEPS.length.toString().padStart(2, '0')}
                  </p>
                  <h3 className="mt-1 font-serif text-xl text-slate-950">{currentHowToStep.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{currentHowToStep.text}</p>
                </div>

                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  <button
                    type="button"
                    className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 transition hover:bg-slate-100"
                    onClick={closeHowTo}
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={howToStep === 0}
                    onClick={() => setHowToStep((step) => Math.max(0, step - 1))}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className={`rounded-full bg-gradient-to-r ${currentHowToStep.accent} px-5 py-2.5 text-xs font-bold uppercase tracking-[0.18em] text-white shadow-lg transition hover:-translate-y-0.5`}
                    onClick={nextHowToStep}
                  >
                    {howToStep === HOW_TO_STEPS.length - 1 ? 'Finish' : 'Next'}
                  </button>
                </div>
              </div>

              <div className="flex gap-2 px-4 pb-4">
                {HOW_TO_STEPS.map((step, index) => (
                  <button
                    key={step.title}
                    type="button"
                    className={`h-2 rounded-full transition-all ${index === howToStep ? 'w-10 bg-slate-950' : 'w-2 bg-slate-300 hover:bg-slate-400'}`}
                    aria-label={`Go to ${step.eyebrow}`}
                    onClick={() => setHowToStep(index)}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Sidebar */}
        <aside className={`fixed inset-y-0 left-0 z-50 h-dvh w-[300px] max-w-[85vw] transform transition-transform duration-300 lg:sticky lg:top-5 lg:z-auto lg:h-auto lg:w-[320px] lg:flex-none lg:self-start lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
          <div ref={sidebarScrollRef} className="flex h-full flex-col overflow-hidden rounded-none border-r border-slate-200/80 bg-slate-950 text-white shadow-[0_24px_80px_rgba(15,23,42,0.24)] lg:h-auto lg:rounded-[2rem] lg:border">
            {/* Header */}
            <div className="relative overflow-hidden px-5 py-6">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(45,212,191,0.28),transparent_30%),radial-gradient(circle_at_top_right,rgba(56,189,248,0.24),transparent_32%),linear-gradient(165deg,#0f172a_0%,#111827_55%,#082f49_100%)]" />
              <div className="relative">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/10 text-lg font-bold text-cyan-100 ring-1 ring-white/10">T</div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200/80">Tayara Board</p>
                      <h1 className="font-serif text-2xl text-white">Market cockpit</h1>
                    </div>
                  </div>
                  <button type="button" className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white transition hover:bg-white/15 lg:hidden" onClick={() => setSidebarOpen(false)}>Close</button>
                </div>
                <div className="mt-5 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-100/90">
                  <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1">Live filters</span>
                  <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1">Dual model</span>
                </div>
              </div>
            </div>

            <nav className="px-5 pb-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-100/70">Navigation</p>
              <div className="mt-3 grid gap-2">
                {navItems.map((item, index) => (
                  <a key={item.label} href={item.href} className="group flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 transition hover:-translate-y-0.5 hover:bg-white/10" onClick={() => setSidebarOpen(false)}>
                    <span className={`flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br ${item.accent} text-sm font-bold text-white shadow-lg shadow-black/10`}>{String(index + 1).padStart(2, '0')}</span>
                    <span className="text-sm font-medium text-white">{item.label}</span>
                  </a>
                ))}
                <button
                  type="button"
                  className="group mt-2 overflow-hidden rounded-2xl border border-cyan-300/30 bg-gradient-to-br from-cyan-400/20 via-sky-400/10 to-teal-400/20 px-4 py-4 text-left shadow-[0_16px_40px_rgba(8,145,178,0.18)] ring-1 ring-white/10 transition hover:-translate-y-0.5 hover:border-cyan-200/60 hover:bg-white/10"
                  onClick={openHowTo}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span>
                      <span className="block text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-100/75">Need a guide?</span>
                      <span className="mt-1 block font-serif text-xl text-white">How to use</span>
                    </span>
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-sm font-bold text-slate-950 transition group-hover:scale-105">?</span>
                  </span>
                </button>
              </div>
            </nav>

            <div className="grid gap-3 px-5 pb-5">
              {sidebarMetrics.map((item) => (
                <div key={item.label} className="rounded-2xl border border-white/10 bg-white/8 p-4">
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

            <div className="mt-auto border-t border-white/10 px-5 py-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-100/70">Market notes</p>
              <div className="mt-3 space-y-2">
                {marketNotes.map((note) => (
                  <div key={note} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200">{note}</div>
                ))}
              </div>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <section className="min-w-0 flex-1 space-y-5">

          {/* Header */}
          <header className={`relative scroll-mt-28 rounded-[2rem] border border-slate-200/80 bg-white/85 px-5 py-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur-sm transition-all duration-500 md:px-6 ${activeGuide === 'overview' ? 'section-tour-active' : ''}`} id="overview">
            <button
              type="button"
              className={`absolute right-5 top-5 flex items-center gap-2 rounded-full border px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] shadow-lg transition ${
                isDarkMode
                  ? 'border-white bg-black text-white'
                  : 'border-slate-200 bg-white text-slate-600'
              }`}
              aria-pressed={isDarkMode}
              aria-label="Toggle dark mode"
              onClick={() => setIsDarkMode((value) => !value)}
            >
              <span>{isDarkMode ? 'Dark' : 'Light'}</span>
              <span className={`relative h-6 w-11 rounded-full border transition ${isDarkMode ? 'border-white bg-white' : 'border-slate-300 bg-white'}`}>
                <span className={`absolute left-1 top-1 h-4 w-4 rounded-full shadow transition-transform ${isDarkMode ? 'translate-x-0 bg-black' : 'translate-x-5 bg-black'}`} />
              </span>
            </button>

            <div className="mb-4 flex items-center justify-between pr-32 lg:hidden">
              <button type="button" className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-lg" onClick={() => setSidebarOpen(true)}>Menu</button>
            </div>
            <div className="flex flex-col gap-4 pt-10 xl:flex-row xl:items-end xl:justify-between xl:pt-0">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">Overview</p>
                <h2 className="mt-2 font-serif text-3xl text-slate-900 md:text-4xl">Used Car Intelligence Board</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Explore the Tunisian used car market with backend-powered price estimation from CatBoost and a Neural Network.</p>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:min-w-[560px]">
                <div className="rounded-2xl bg-slate-950 px-4 py-3 text-white shadow-lg">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-slate-300">Rows</p>
                  <p className="mt-1 text-xl font-bold">{kpis.listings.toLocaleString()}</p>
                </div>
                <div className="rounded-2xl bg-gradient-to-br from-teal-600 to-emerald-600 px-4 py-3 text-white shadow-lg">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-teal-50/80">Median</p>
                  <p className="mt-1 text-lg font-bold">{formatPrice(kpis.medianPrice)}</p>
                </div>
                <div className="rounded-2xl bg-gradient-to-br from-sky-500 to-cyan-500 px-4 py-3 text-white shadow-lg">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-50/80">Top brand</p>
                  <p className="mt-1 text-lg font-bold">{topBrand ? topBrand.brand : '-'}</p>
                </div>
                <div className="rounded-2xl bg-gradient-to-br from-amber-500 to-orange-500 px-4 py-3 text-white shadow-lg">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-orange-50/80">Top fuel</p>
                  <p className="mt-1 text-lg font-bold">{topFuel ? topFuel.name : '-'}</p>
                </div>
              </div>
            </div>
          </header>

          {/* ── CSV Upload ──────────────────────────────────────────────────── */}
          <section className={`scroll-mt-28 rounded-[1.75rem] border border-slate-200/80 bg-white/90 p-4 shadow-[0_18px_50px_rgba(15,23,42,0.08)] transition-all duration-500 ${activeGuide === 'upload' ? 'section-tour-active' : ''}`} id="upload">
            <div className="mb-3">
              <h2 className="font-serif text-2xl text-slate-900">Upload Dataset</h2>
              <p className="text-sm text-slate-600">Upload your cleaned CSV — or drag and drop it below.</p>
            </div>

            {/* Drop zone */}
            <div
              onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave}
              className={`relative flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-all ${isDragging ? 'border-teal-400 bg-teal-50' : 'border-slate-300 bg-slate-50 hover:border-teal-300 hover:bg-teal-50/40'}`}
            >
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-500 text-white text-2xl shadow-lg shadow-teal-500/30">
                ↑
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-700">Drag &amp; drop your CSV here</p>
                <p className="mt-1 text-xs text-slate-500">or click to browse files</p>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-full bg-slate-950 px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-lg transition hover:-translate-y-0.5 hover:bg-slate-800"
              >
                Browse CSV
              </button>
              <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={(e) => handleFile(e.target.files[0])} />
            </div>

            {/* Status messages */}
            {uploadInfo && !error && (
              <div className="mt-3 flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                <span className="text-lg">✓</span>
                <p className="text-sm font-medium text-emerald-700">{uploadInfo}</p>
              </div>
            )}
            {error && (
              <div className="mt-3 flex items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3">
                <span className="text-lg">⚠</span>
                <p className="text-sm text-rose-700">{error}</p>
              </div>
            )}

            {/* Expected columns hint */}
            <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Expected columns</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {['price','km','annee','puissance','carburant','marque'].map((col) => (
                  <span key={col} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-mono text-slate-700">{col}</span>
                ))}
              </div>
            </div>
          </section>

          {/* ── Controls ─────────────────────────────────────────────────────── */}
          <section className={`scroll-mt-28 rounded-[1.75rem] border border-slate-200/80 bg-white/90 p-4 shadow-[0_18px_50px_rgba(15,23,42,0.08)] transition-all duration-500 ${activeGuide === 'controls' ? 'section-tour-active' : ''}`} id="controls">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-serif text-xl text-slate-900 md:text-2xl">Market Controls</h2>
                <p className="text-sm text-slate-600">Filter by brand, fuel, and year.</p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                <span className="rounded-full bg-slate-100 px-3 py-1">{selectedBrand === 'all' ? 'All brands' : selectedBrand}</span>
                <span className="rounded-full bg-slate-100 px-3 py-1">{selectedFuel === 'all' ? 'All fuels' : selectedFuel}</span>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <label className="text-sm font-medium text-slate-700">Brand
                <select className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring" value={selectedBrand} onChange={(e) => setSelectedBrand(e.target.value)}>
                  {brandOptions.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
              <label className="text-sm font-medium text-slate-700">Fuel
                <select className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring" value={selectedFuel} onChange={(e) => setSelectedFuel(e.target.value)}>
                  {filterFuelOptions.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
              <label className="text-sm font-medium text-slate-700">Year From
                <input className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring" value={yearStart} onChange={(e) => setYearStart(e.target.value)} />
              </label>
              <label className="text-sm font-medium text-slate-700">Year To
                <input className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring" value={yearEnd} onChange={(e) => setYearEnd(e.target.value)} />
              </label>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="rounded-full bg-slate-950 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-lg transition hover:-translate-y-0.5" onClick={exportCsv}>Export CSV</button>
              <button className="rounded-full bg-gradient-to-r from-teal-700 to-emerald-600 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-lg transition hover:-translate-y-0.5" onClick={() => exportChart(priceRef, 'price_dist.png')}>Price Chart</button>
              <button className="rounded-full bg-gradient-to-r from-sky-600 to-cyan-500 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-lg transition hover:-translate-y-0.5" onClick={() => exportChart(fuelRef, 'fuel_mix.png')}>Fuel Chart</button>
              <button className="rounded-full bg-gradient-to-r from-lime-600 to-emerald-500 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-lg transition hover:-translate-y-0.5" onClick={() => exportChart(brandRef, 'brand_chart.png')}>Brand Chart</button>
              <button className="rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-lg transition hover:-translate-y-0.5" onClick={() => exportChart(scatterRef, 'scatter.png')}>Scatter</button>
            </div>
          </section>

          {/* ── KPIs ─────────────────────────────────────────────────────────── */}
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: 'Median Price', value: formatPrice(kpis.medianPrice), desc: 'Middle value of filtered market.', gradient: 'from-sky-500 to-teal-500' },
              { label: 'Average Price', value: formatPrice(kpis.avgPrice), desc: 'General market level.', gradient: 'from-emerald-500 to-lime-500' },
              { label: 'Average Mileage', value: kpis.avgKm ? `${Math.round(kpis.avgKm).toLocaleString()} km` : '-', desc: 'Where the sample sits.', gradient: 'from-amber-500 to-orange-500' },
              { label: 'Year Range', value: kpis.yearMin && kpis.yearMax ? `${kpis.yearMin} – ${kpis.yearMax}` : '-', desc: 'Model years in filtered set.', gradient: 'from-fuchsia-500 to-cyan-500' },
            ].map((kpi) => (
              <article key={kpi.label} className="group overflow-hidden rounded-[1.5rem] border border-slate-200/80 bg-white shadow-[0_18px_40px_rgba(15,23,42,0.07)] transition hover:-translate-y-1">
                <div className={`bg-gradient-to-r ${kpi.gradient} px-4 py-3 text-white`}>
                  <p className="text-[11px] uppercase tracking-[0.22em] text-white/80">{kpi.label}</p>
                  <p className="mt-2 text-2xl font-bold">{kpi.value}</p>
                </div>
                <div className="p-4"><p className="text-sm text-slate-500">{kpi.desc}</p></div>
              </article>
            ))}
          </section>

          {/* ── Dual Model Estimator ──────────────────────────────────────────── */}
          <section className={`scroll-mt-28 rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_50px_rgba(15,23,42,0.08)] transition-all duration-500 ${activeGuide === 'estimator' ? 'section-tour-active' : ''}`} id="estimator">
            <div className="mb-3">
              <h2 className="font-serif text-2xl text-slate-900">CatBoost + Neural Estimator</h2>
              <p className="text-sm text-slate-600">Predictions come from your exported CatBoost model and Neural Network, with an ensemble average.</p>
            </div>
            <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              <p className="font-medium text-slate-800">
                {modelInfo.available ? 'Model service connected.' : 'Model service offline.'}
              </p>
              <p className="mt-1">
                {modelServiceError || 'Start the Python API and export the model files to enable live predictions.'}
              </p>
              {predictions.status === 'loading' && (
                <p className="mt-2 text-xs font-semibold uppercase tracking-[0.18em] text-teal-700">Refreshing prediction...</p>
              )}
              {predictions.status === 'error' && (
                <p className="mt-2 text-xs font-semibold uppercase tracking-[0.18em] text-rose-700">{predictions.error}</p>
              )}
            </div>

            {/* Inputs */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="text-sm font-medium text-slate-700">Mileage (km)
                <input className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring" value={input.km} onChange={(e) => setInput((s) => ({ ...s, km: e.target.value }))} />
              </label>
              <label className="text-sm font-medium text-slate-700">Year
                <input className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring" value={input.annee} onChange={(e) => setInput((s) => ({ ...s, annee: e.target.value }))} />
              </label>
              <label className="text-sm font-medium text-slate-700">Fiscal Power (CV)
                <input className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring" value={input.puissance} onChange={(e) => setInput((s) => ({ ...s, puissance: e.target.value }))} />
              </label>
              <label className="text-sm font-medium text-slate-700">Fuel Type
                <select className="mt-1 w-full rounded-2xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none ring-teal-300 transition focus:ring" value={input.carburant} onChange={(e) => setInput((s) => ({ ...s, carburant: e.target.value }))}>
                  {fuelOptions.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
            </div>

            {/* Three prediction cards */}
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {/* CatBoost */}
              <div className="overflow-hidden rounded-[1.5rem] border border-sky-200 bg-gradient-to-br from-sky-50 to-cyan-50 p-4 shadow-inner">
                <div className="flex items-center gap-2 mb-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-sky-500 text-xs font-bold text-white">C</span>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-700">CatBoost</p>
                </div>
                <p className="text-3xl font-bold text-slate-900">{formatPrice(predictions.catboost)}</p>
                <p className="mt-2 text-xs text-slate-500">
                  R² {modelStats.knnR2 !== null ? modelStats.knnR2.toFixed(3) : '-'} · MAE {modelStats.knnMae !== null ? formatPrice(modelStats.knnMae) : '-'}
                </p>
              </div>

              {/* Neural Network */}
              <div className="overflow-hidden rounded-[1.5rem] border border-violet-200 bg-gradient-to-br from-violet-50 to-purple-50 p-4 shadow-inner">
                <div className="flex items-center gap-2 mb-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-violet-500 text-xs font-bold text-white">N</span>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-violet-700">Neural Network</p>
                </div>
                <p className="text-3xl font-bold text-slate-900">{formatPrice(predictions.lr)}</p>
                <p className="mt-2 text-xs text-slate-500">
                  R² {modelStats.lrR2 !== null ? modelStats.lrR2.toFixed(3) : '-'} · MAE {modelStats.lrMae !== null ? formatPrice(modelStats.lrMae) : '-'}
                </p>
              </div>

              {/* Ensemble */}
              <div className="overflow-hidden rounded-[1.5rem] border border-teal-300 bg-gradient-to-br from-teal-50 via-emerald-50 to-cyan-50 p-4 shadow-inner ring-2 ring-teal-300/40">
                <div className="flex items-center gap-2 mb-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br from-teal-500 to-emerald-500 text-xs font-bold text-white">∑</span>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-teal-700">Ensemble Average</p>
                </div>
                <p className="text-3xl font-bold text-teal-900">{formatPrice(predictions.ensemble)}</p>
                <p className="mt-2 text-xs text-slate-500">
                  R² {modelStats.ensR2 !== null ? modelStats.ensR2.toFixed(3) : '-'} · MAE {modelStats.ensMae !== null ? formatPrice(modelStats.ensMae) : '-'}
                </p>
              </div>
            </div>

            {/* Model comparison bar */}
            {predictions.knn && predictions.lr && (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Model agreement</p>
                <div className="space-y-2">
                  {[
                    { label: 'CatBoost', value: predictions.knn, color: 'bg-sky-500' },
                    { label: 'Neural', value: predictions.lr, color: 'bg-violet-500' },
                    { label: 'Ensemble', value: predictions.ensemble, color: 'bg-teal-500' },
                  ].map((m) => {
                    const max = Math.max(predictions.knn, predictions.lr) * 1.05
                    const pct = Math.round((m.value / max) * 100)
                    return (
                      <div key={m.label} className="flex items-center gap-3">
                        <span className="w-16 text-xs font-medium text-slate-600">{m.label}</span>
                        <div className="flex-1 overflow-hidden rounded-full bg-slate-200 h-3">
                          <div className={`h-3 rounded-full transition-all duration-500 ${m.color}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="w-24 text-right text-xs font-semibold text-slate-700">{formatPrice(m.value)}</span>
                      </div>
                    )
                  })}
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  Gap between models: <b>{formatPrice(Math.abs(predictions.knn - predictions.lr))}</b>
                  {Math.abs(predictions.knn - predictions.lr) / predictions.ensemble < 0.1
                    ? ' — High agreement'
                    : Math.abs(predictions.knn - predictions.lr) / predictions.ensemble < 0.25
                    ? ' — Moderate agreement'
                    : ' — Low agreement, treat the ensemble with caution'}
                </p>
              </div>
            )}
          </section>

          {/* ── Charts ───────────────────────────────────────────────────────── */}
          <section className={`scroll-mt-28 grid gap-4 rounded-[1.75rem] transition-all duration-500 xl:grid-cols-12 ${activeGuide === 'charts' ? 'section-tour-active p-3' : ''}`} id="charts">
            <article className="rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_50px_rgba(15,23,42,0.08)] xl:col-span-4" ref={priceRef}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="font-serif text-xl text-slate-900">Price Distribution</h2>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Histogram</span>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={priceHistogram}>
                  <defs><linearGradient id="priceBars" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#38bdf8" /><stop offset="100%" stopColor="#0f766e" /></linearGradient></defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis dataKey="bucket" hide /><YAxis />
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
                    {fuelData.map((entry, index) => <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />)}
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
                  <defs><linearGradient id="scatterGlow" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#f59e0b" /><stop offset="100%" stopColor="#ef4444" /></linearGradient></defs>
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
                  <p className="text-sm text-slate-600">Horizontal ranking of top 10 brands.</p>
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
                    {brandData.map((entry, index) => <Cell key={entry.brand} fill={COLORS[index % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </article>

            <article className="rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_50px_rgba(15,23,42,0.08)] xl:col-span-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-serif text-xl text-slate-900">Average Price by Year</h2>
                  <p className="text-sm text-slate-600">Trend line across the filtered market.</p>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Trend</span>
              </div>
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={yearTrendData}>
                  <defs><linearGradient id="trendLine" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#0f766e" /><stop offset="100%" stopColor="#0ea5e9" /></linearGradient></defs>
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

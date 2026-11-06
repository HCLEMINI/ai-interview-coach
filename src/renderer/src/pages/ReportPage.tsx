import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import type { LlmScore, MetricsResult, SessionMeta, TrendEntry } from '../../../shared/types'
import { useUIStore } from '../store/sessionStore'

interface Extra {
  transcript?: string
  metrics?: MetricsResult
  llmScore?: LlmScore
}

const TYPE_LABEL: Record<string, string> = {
  practice: '练习题',
  intro: '自我介绍',
  motivation: '求职动机',
  behavioral: '行为经历题',
  situational: '情境判断题',
  reading: '文段朗读题',
  english: '英语题',
  experience: '行为经历类'
}

const STAGE_LABEL: Record<string, string> = {
  asr: '转写',
  metrics: '指标',
  llm: '评分',
  done: '完成'
}

function MetricChip({ label, value, pass }: { label: string; value: string; pass?: boolean | null }): JSX.Element {
  const color = pass === null || pass === undefined ? 'text-gray-600 bg-gray-100' : pass ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'
  return (
    <span className={`px-2.5 py-1 rounded-md text-xs ${color}`}>
      {label} {value}
    </span>
  )
}

export default function ReportPage(): JSX.Element {
  const reportSessionId = useUIStore((s) => s.reportSessionId)
  const setPage = useUIStore((s) => s.setPage)
  const [meta, setMeta] = useState<SessionMeta | null>(null)
  const [extras, setExtras] = useState<Record<string, Extra>>({})
  const [coachSummary, setCoachSummary] = useState<{ overall: string; actions: string[] } | null>(null)
  const [trends, setTrends] = useState<TrendEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const radarRef = useRef<HTMLDivElement>(null)
  const trendRef = useRef<HTMLDivElement>(null)
  const loadRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    const load = async (): Promise<void> => {
      setLoading(true)
      let target = reportSessionId
      if (!target) {
        const list = await window.api.sessionList()
        target = list[0]?.session_id ?? null
      }
      if (!target) {
        setMeta(null)
        setLoading(false)
        return
      }
      const r = await window.api.sessionDetail(target)
      if (r.ok && r.meta) {
        setMeta(r.meta)
        setExtras((r.extras as Record<string, Extra>) ?? {})
        setCoachSummary(r.coachSummary ?? null)
        const t = await window.api.trendsGet()
        setTrends(t.sessions.slice(-12))
      } else {
        setMeta(null)
      }
      setLoading(false)
    }
    loadRef.current = load
    void load()
  }, [reportSessionId])

  // AI 教练总评生成完成 → 刷新（总评在报告就绪后数十秒异步生成）
  useEffect(() => {
    const off = window.api.onReportSummaryReady(() => {
      void loadRef.current?.()
    })
    return off
  }, [])

  // 雷达图：表达六方面（防御式初始化：显式尺寸、异常落日志）
  useEffect(() => {
    if (!meta || !radarRef.current) return
    const formalDirs = meta.questions.filter((q) => /^q\d+$/.test(q.dir) && extras[q.dir]?.metrics)
    if (formalDirs.length === 0) return
    const m = formalDirs.map((q) => extras[q.dir]!.metrics!)
    const avg = (f: (x: MetricsResult) => number): number => {
      const vals = m.map(f).filter((v) => Number.isFinite(v))
      return vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : 0
    }
    try {
      const el = radarRef.current
      const rect = el.getBoundingClientRect()
      if (rect.width < 10 || rect.height < 10) {
        console.warn('[Report] 雷达图容器尺寸异常', rect.width, rect.height)
        return
      }
      const chart = echarts.init(el)
      const rateVal = avg((x) => x.speech_rate_cpm)
      const values = [
        Math.min(100, Math.round((avg((x) => x.duration_ratio) / 0.9) * 100)),
        rateVal > 0 ? Math.max(0, 100 - Math.abs(rateVal - 220) / 2) : 0,
        Math.max(0, 100 - avg((x) => x.pauses_gt_1_5s) * 12),
        Math.min(100, avg((x) => x.connectives?.count ?? 0) * 33),
        Math.max(0, 100 - avg((x) => x.filler_words?.total ?? 0) * 4),
        Math.min(100, Math.round((avg((x) => x.ending_rms_ratio ?? 1) / 0.9) * 100))
      ]
      chart.setOption({
        radar: {
          indicator: [
            { name: '时长达成', max: 100 },
            { name: '语速', max: 100 },
            { name: '停顿控制', max: 100 },
            { name: '逻辑词', max: 100 },
            { name: '口头禅', max: 100 },
            { name: '结尾音量', max: 100 }
          ],
          radius: '62%',
          splitNumber: 4
        },
        series: [
          {
            type: 'radar',
            data: [
              {
                value: values.map((v) => Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0))),
                name: '表达层',
                areaStyle: { opacity: 0.25 },
                lineStyle: { width: 2 },
                symbolSize: 5
              }
            ]
          }
        ]
      })
      chart.resize()
      return () => chart.dispose()
    } catch (e) {
      console.error('[Report] 雷达图初始化失败', e)
    }
    return undefined
  }, [meta, extras])

  // 趋势折线
  useEffect(() => {
    if (!trendRef.current || trends.length === 0) return
    const scored = trends.filter((t) => t.total_score !== null)
    if (scored.length === 0) return
    const chart = echarts.init(trendRef.current)
    chart.setOption({
      grid: { left: 40, right: 20, top: 30, bottom: 30 },
      xAxis: { type: 'category', data: scored.map((t) => t.session_id.slice(5)) },
      yAxis: { type: 'value', min: 0, max: 100 },
      tooltip: { trigger: 'axis' },
      series: [
        {
          type: 'line',
          data: scored.map((t) => t.total_score),
          symbolSize: 8,
          label: { show: true }
        }
      ]
    })
    return () => chart.dispose()
  }, [trends])

  if (loading) return <div className="py-16 text-center text-gray-400">加载中…</div>

  if (!meta) {
    return (
      <div className="py-16 text-center text-gray-400">
        没有可查看的场次
        <div className="mt-4">
          <button className="btn-secondary" onClick={() => setPage('home')}>
            返回首页
          </button>
        </div>
      </div>
    )
  }

  const answered = meta.questions.filter((q) => q.state === 'answered')
  const redlines = answered
    .map((q) => ({ dir: q.dir, rl: extras[q.dir]?.llmScore?.redline }))
    .filter((x) => x.rl?.triggered)

  return (
    <div className="max-w-4xl mx-auto py-8 px-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">场次报告</h1>
        <button className="btn-secondary" onClick={() => setPage('home')}>
          返回首页
        </button>
      </div>

      <div className="card p-5 mb-4 flex items-center justify-between flex-wrap gap-3">
        <div className="text-sm text-gray-600">
          <span className="font-mono">{meta.session_id}</span> ·{' '}
          {meta.vendor === 'beisen' ? '北森' : meta.vendor === 'zhilian' ? '智联' : '前程无忧'} ·{' '}
          {meta.company} · {meta.position}
        </div>
        <div className="flex items-center gap-4">
          {meta.total_score !== null && (
            <div className="text-center">
              <div className="text-3xl font-bold text-blue-700 tabular-nums">{meta.total_score}</div>
              <div className="text-xs text-gray-400">总分（内容60%+表达40%）</div>
            </div>
          )}
        </div>
      </div>

      {(coachSummary || meta.status === 'completed') && (
        <div className={`card p-5 mb-4 ${coachSummary ? 'border-l-4 border-blue-500' : ''}`}>
          <h2 className="font-semibold mb-2">🤖 AI 教练总评</h2>
          {coachSummary ? (
            <>
              <p className="text-sm text-gray-700 leading-7 mb-3">{coachSummary.overall}</p>
              <ul className="space-y-1.5">
                {coachSummary.actions.map((a, i) => (
                  <li key={i} className="text-sm text-gray-600">
                    ▸ {a}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-gray-400">总评生成中，约一分钟内自动刷新……</p>
          )}
        </div>
      )}

      {redlines.length > 0 && (
        <div className="card p-4 mb-4 border-l-4 border-red-600">
          <h2 className="font-semibold text-red-600 mb-2">⚠ 越界警告（真实面试中这些话会严重扣分）</h2>
          {redlines.map(({ dir, rl }) =>
            rl!.items.map((it, i) => (
              <div key={`${dir}-${i}`} className="text-sm mb-2">
                <div className="text-gray-800">
                  [{dir}]（{it.type}）说了：「{it.quote}」
                </div>
                <div className="text-green-700">替换话术：{it.replacement}</div>
              </div>
            ))
          )}
        </div>
      )}

      {(answered.some((q) => extras[q.dir]?.metrics) || trends.some((t) => t.total_score !== null)) && (
        <div className="grid grid-cols-2 gap-4 mb-4">
          {answered.some((q) => extras[q.dir]?.metrics) && (
            <div className="card p-3">
              <div ref={radarRef} className="w-full h-56" />
            </div>
          )}
          {trends.some((t) => t.total_score !== null) && (
            <div className="card p-3">
              <div ref={trendRef} className="w-full h-56" />
            </div>
          )}
        </div>
      )}

      <div className="card p-5 mb-4">
        <h2 className="font-semibold mb-3">逐题结果</h2>
        <div className="space-y-2">
          {meta.questions.map((q) => {
            const ex = extras[q.dir]
            const m = ex?.metrics
            const sc = ex?.llmScore
            const key = q.dir
            const open = openKey === key
            return (
              <div key={key} className="border border-gray-100 rounded-lg overflow-hidden">
                <button
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 text-left"
                  onClick={() => setOpenKey(open ? null : key)}
                >
                  <span className="font-mono text-xs text-gray-400 w-14">{q.dir}</span>
                  <span className="text-sm">{TYPE_LABEL[q.type] ?? q.type}</span>
                  {q.state === 'zeroed' ? (
                    <span className="text-xs text-red-500">计零分</span>
                  ) : q.state === 'answered' ? (
                    <span className="text-xs text-green-600">已作答 {q.recordedSec.toFixed(0)}s</span>
                  ) : (
                    <span className="text-xs text-gray-400">未作答</span>
                  )}
                  <span className="flex-1" />
                  {m?.expression_score !== null && m?.expression_score !== undefined && (
                    <span className="text-xs text-gray-500">表达 {m.expression_score}</span>
                  )}
                  {sc?.content_score !== null && sc?.content_score !== undefined && (
                    <span className="text-xs text-gray-500">内容 {sc.content_score}</span>
                  )}
                  {sc?.overall !== null && sc?.overall !== undefined && (
                    <span className="text-sm font-semibold text-blue-700">{sc.overall}</span>
                  )}
                </button>
                {open && (
                  <div className="px-4 pb-4 border-t border-gray-100 pt-3 text-sm space-y-3">
                    {m && !m.error && (
                      <div className="flex flex-wrap gap-2">
                        <MetricChip label="语速" value={`${m.speech_rate_cpm}/分`} pass={m.rate_pass} />
                        <MetricChip label="停顿>1.5s" value={`${m.pauses_gt_1_5s}次`} pass={m.pause_pass} />
                        <MetricChip
                          label="口头禅"
                          value={m.filler_words.top3.map((f) => `${f.word}×${f.count}`).join(' ') || '无'}
                        />
                        <MetricChip label="逻辑词" value={`${m.connectives.count}个`} pass={m.connectives.count >= 3} />
                        <MetricChip
                          label="时长达成"
                          value={`${Math.round(m.duration_ratio * 100)}%`}
                          pass={m.duration_pass}
                        />
                        {m.ending_rms_ratio !== null && (
                          <MetricChip label="结尾音量" value={`${m.ending_rms_ratio}`} pass={m.ending_pass} />
                        )}
                        {m.reading_char_accuracy !== null && (
                          <MetricChip
                            label="朗读字准"
                            value={`${m.reading_char_accuracy}%`}
                            pass={m.reading_char_accuracy >= 90}
                          />
                        )}
                      </div>
                    )}
                    {m?.error && <p className="text-amber-600 text-xs">指标计算失败：{m.error}</p>}
                    {sc && !sc.error && (
                      <div className="space-y-1.5">
                        {sc.star && (
                          <div className="text-xs text-gray-600">
                            STAR：情境{sc.star.situation} 任务{sc.star.task} 行动{sc.star.action} 结果{sc.star.result}（各0-2）
                          </div>
                        )}
                        {sc.keyword_hits && (
                          <div className="text-xs text-gray-600">
                            关键词命中：
                            <span className="text-green-700">{sc.keyword_hits.hit.join('、') || '无'}</span>
                            {sc.keyword_hits.miss.length > 0 && (
                              <span className="text-gray-400">（未中：{sc.keyword_hits.miss.join('、')}）</span>
                            )}
                          </div>
                        )}
                        {sc.sentence_comments?.map((c, i) => (
                          <div
                            key={i}
                            className={`text-xs px-2 py-1 rounded ${
                              c.severity === 'danger'
                                ? 'bg-red-50 text-red-700'
                                : c.severity === 'warn'
                                  ? 'bg-amber-50 text-amber-700'
                                  : 'bg-gray-50 text-gray-600'
                            }`}
                          >
                            「{c.quote}」{c.comment}
                          </div>
                        ))}
                      </div>
                    )}
                    {sc?.error && <p className="text-amber-600 text-xs">内容评分失败：{sc.error}</p>}
                    {ex?.transcript && (
                      <div>
                        <div className="text-xs text-gray-400 mb-1">作答转写</div>
                        <div className="p-3 bg-gray-50 rounded-lg text-xs leading-6 whitespace-pre-wrap max-h-52 overflow-y-auto">
                          {ex.transcript}
                        </div>
                      </div>
                    )}
                    {!ex?.transcript && q.state === 'answered' && (
                      <p className="text-xs text-gray-300">转写尚未生成（处理中或失败）</p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="card p-5 text-sm text-gray-600">
        <div className="font-semibold text-gray-800 mb-2">历次趋势</div>
        {trends.filter((t) => t.total_score !== null).length === 0 ? (
          <span className="text-gray-400">完成带网关评分的场次后出现趋势折线</span>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="py-1">场次</th>
                <th>总分</th>
                <th>表达</th>
                <th>内容</th>
                <th>语速</th>
                <th>停顿</th>
              </tr>
            </thead>
            <tbody>
              {[...trends].reverse().map((t) => (
                <tr key={t.session_id} className="border-t border-gray-100">
                  <td className="py-1.5 font-mono">{t.session_id}</td>
                  <td className="tabular-nums font-semibold">{t.total_score ?? '—'}</td>
                  <td className="tabular-nums">{t.expression_avg ?? '—'}</td>
                  <td className="tabular-nums">{t.content_avg ?? '—'}</td>
                  <td className="tabular-nums">{t.metrics_avg?.speech_rate_cpm ?? '—'}</td>
                  <td className="tabular-nums">{t.metrics_avg?.pauses_gt_1_5s ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-gray-400 mt-4 text-center">
        模拟评分按三家公开资料复刻，用于练纪律与看趋势，不代表真实考试分数。
      </p>
    </div>
  )
}

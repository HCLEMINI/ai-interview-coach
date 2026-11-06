// 题库与素材管理：深挖题生成 / 题目启停 / 分公司事实卡 / STAR 故事
import { useCallback, useEffect, useState } from 'react'
import type { CompanyCard, Question } from '../../../shared/types'
import { useUIStore } from '../store/sessionStore'

interface StarStory {
  id: string
  title: string
  hint?: string
}

const EMPTY_CARD: CompanyCard = {
  company: '',
  short: '',
  parent: '中国石油',
  business_focus: [],
  key_facts: [],
  common_positions: [],
  interview_tips: [],
  updated_at: ''
}

export default function LibraryPage(): JSX.Element {
  const setPage = useUIStore((s) => s.setPage)
  const showToast = useUIStore((s) => s.showToast)
  const [tab, setTab] = useState<'bank' | 'cards' | 'star'>('bank')
  const [baseQs, setBaseQs] = useState<Question[]>([])
  const [genQs, setGenQs] = useState<Question[]>([])
  const [cards, setCards] = useState<CompanyCard[]>([])
  const [stories, setStories] = useState<StarStory[]>([])
  const [genBusy, setGenBusy] = useState(false)
  const [editingCard, setEditingCard] = useState<CompanyCard | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const b = await window.api.questionBankGet('base')
    const g = await window.api.questionBankGet('generated')
    setBaseQs(b.questions)
    setGenQs(g.questions)
    setCards(await window.api.companyCardsList())
    const s = await window.api.starStoriesGet()
    setStories((s.stories as StarStory[]) ?? [])
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggleQ = async (file: 'base' | 'generated', id: string): Promise<void> => {
    const list = file === 'base' ? baseQs : genQs
    const next = list.map((q) => (q.id === id ? { ...q, enabled: !q.enabled } : q))
    if (file === 'base') setBaseQs(next)
    else setGenQs(next)
    await window.api.questionBankUpsert(file, next)
  }

  const removeQ = async (id: string): Promise<void> => {
    const next = genQs.filter((q) => q.id !== id)
    setGenQs(next)
    await window.api.questionBankUpsert('generated', next)
  }

  const generate = async (): Promise<void> => {
    setGenBusy(true)
    try {
      const r = await window.api.questionsGenerate()
      if (r.ok) {
        showToast(`已生成 ${r.count} 道简历深挖题`)
        await refresh()
      } else {
        showToast(`生成失败：${r.reason}`)
      }
    } finally {
      setGenBusy(false)
    }
  }

  const saveCard = async (): Promise<void> => {
    if (!editingCard || !editingCard.company.trim()) {
      showToast('单位名不能为空')
      return
    }
    await window.api.companyCardsUpsert({ ...editingCard, updated_at: new Date().toISOString() })
    setEditingCard(null)
    await refresh()
    showToast('事实卡已保存')
  }

  const saveStories = async (next: StarStory[]): Promise<void> => {
    setStories(next)
    await window.api.starStoriesUpsert(next)
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">题库与素材</h1>
        <button className="btn-secondary" onClick={() => setPage('home')}>
          返回首页
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        {(
          [
            ['bank', `题库（${baseQs.length + genQs.length}）`],
            ['cards', `事实卡（${cards.length}）`],
            ['star', `STAR 故事（${stories.length}）`]
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            className={`px-4 py-1.5 rounded-lg text-sm ${tab === k ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-600'}`}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'bank' && (
        <div className="space-y-3">
          <div className="card p-4 flex items-center gap-3">
            <button className="btn-primary" disabled={genBusy} onClick={() => void generate()}>
              {genBusy ? '生成中…（约 30-60 秒）' : '基于个人档案生成简历深挖题'}
            </button>
            <span className="text-xs text-gray-400">
              需先在设置页构建并审阅脱敏摘要；生成 10 道左右，追加进下方"生成题"区
            </span>
          </div>

          {genQs.length > 0 && (
            <div className="card p-4">
              <h2 className="font-semibold mb-2 text-sm text-gray-500">生成题（深挖）</h2>
              {genQs.map((q) => (
                <div key={q.id} className="flex items-start gap-2 py-2 border-b border-gray-50 last:border-0">
                  <input type="checkbox" checked={q.enabled} onChange={() => void toggleQ('generated', q.id)} className="mt-1" />
                  <div className="flex-1 text-sm">
                    <div>{q.text}</div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {q.digestAnchor ? `锚点：${q.digestAnchor} · ` : ''}
                      关键词：{q.targetKeywords.join('、') || '—'}
                    </div>
                  </div>
                  <button className="text-xs text-red-400 hover:text-red-600" onClick={() => void removeQ(q.id)}>
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="card p-4">
            <h2 className="font-semibold mb-2 text-sm text-gray-500">基础真题库</h2>
            {baseQs.map((q) => (
              <div key={q.id} className="flex items-start gap-2 py-1.5 border-b border-gray-50 last:border-0">
                <input type="checkbox" checked={q.enabled} onChange={() => void toggleQ('base', q.id)} className="mt-1" />
                <div className="flex-1 text-sm text-gray-700">
                  <span className="text-xs text-gray-400 mr-2 font-mono">{q.id}</span>
                  {q.text.slice(0, 80)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'cards' && (
        <div className="space-y-3">
          {editingCard ? (
            <div className="card p-4 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <input
                  className="input-box"
                  placeholder="单位全称*"
                  value={editingCard.company}
                  onChange={(e) => setEditingCard({ ...editingCard, company: e.target.value })}
                />
                <input
                  className="input-box"
                  placeholder="简称"
                  value={editingCard.short}
                  onChange={(e) => setEditingCard({ ...editingCard, short: e.target.value })}
                />
                <input
                  className="input-box"
                  placeholder="母公司"
                  value={editingCard.parent}
                  onChange={(e) => setEditingCard({ ...editingCard, parent: e.target.value })}
                />
              </div>
              <textarea
                className="input-box h-20"
                placeholder="业务方向，逗号分隔（如：页岩气压裂,致密气,数字化转型）"
                value={editingCard.business_focus.join(',')}
                onChange={(e) =>
                  setEditingCard({
                    ...editingCard,
                    business_focus: e.target.value.split(/[,，]/).filter(Boolean)
                  })
                }
              />
              <textarea
                className="input-box h-24"
                placeholder={'关键事实，每行一条（在营区块/项目/驻地/规模——面试被问"了解我们吗"时能答上的）'}
                value={editingCard.key_facts.map((f) => f.fact).join('\n')}
                onChange={(e) =>
                  setEditingCard({
                    ...editingCard,
                    key_facts: e.target.value.split('\n').filter(Boolean).map((fact) => ({ fact }))
                  })
                }
              />
              <textarea
                className="input-box h-16"
                placeholder="面试提示，每行一条"
                value={editingCard.interview_tips.join('\n')}
                onChange={(e) =>
                  setEditingCard({ ...editingCard, interview_tips: e.target.value.split('\n').filter(Boolean) })
                }
              />
              <div className="flex gap-3">
                <button className="btn-primary" onClick={() => void saveCard()}>
                  保存
                </button>
                <button className="btn-secondary" onClick={() => setEditingCard(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <button className="btn-primary" onClick={() => setEditingCard({ ...EMPTY_CARD })}>
                新建事实卡
              </button>
              {cards.map((c) => (
                <div key={c.company} className="card p-4">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold">
                      {c.company} <span className="text-xs text-gray-400">{c.parent}</span>
                    </div>
                    <button className="text-sm text-blue-600" onClick={() => setEditingCard(c)}>
                      编辑
                    </button>
                  </div>
                  {c.business_focus.length > 0 && (
                    <div className="text-xs text-gray-500 mt-1">业务：{c.business_focus.join(' · ')}</div>
                  )}
                  {c.key_facts.map((f, i) => (
                    <div key={i} className="text-sm text-gray-700 mt-1">
                      · {f.fact}
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {tab === 'star' && (
        <div className="space-y-3">
          <div className="card p-4 text-sm text-gray-500">
            九个 STAR 故事登记处：标题写一句话概括，要点提示写该故事必须讲到的细节（数据/动作/结果）。
            保存后在首页「STAR 特训」可点名单练。
          </div>
          {stories.map((s, i) => (
            <div key={s.id} className="card p-3 flex items-center gap-3">
              <input
                className="input-box flex-1"
                value={s.title}
                placeholder="故事标题，如：XX平台压裂施工指挥"
                onChange={(e) => {
                  const next = stories.map((x, j) => (j === i ? { ...x, title: e.target.value } : x))
                  void saveStories(next)
                }}
              />
              <input
                className="input-box flex-1"
                value={s.hint ?? ''}
                placeholder="要点提示（可选）：泵注程序设计/施工参数/结果"
                onChange={(e) => {
                  const next = stories.map((x, j) => (j === i ? { ...x, hint: e.target.value } : x))
                  void saveStories(next)
                }}
              />
              <button
                className="text-xs text-red-400 hover:text-red-600"
                onClick={() => void saveStories(stories.filter((_, j) => j !== i))}
              >
                删除
              </button>
            </div>
          ))}
          <button
            className="btn-secondary"
            onClick={() => void saveStories([...stories, { id: `S-${Date.now() % 100000}`, title: '', hint: '' }])}
          >
            + 添加故事
          </button>
        </div>
      )}
    </div>
  )
}

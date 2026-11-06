// 会话与题库的文件读写；首次启动写入默认真题库
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { Question, QuestionBankFile, SessionMeta, TrendEntry } from '../shared/types'
import { questionBankDir, sessionsDir, trendsPath } from './paths'

// ---------- 默认真题库（2026-10 三家中石油 AI 面试调研真题打底） ----------
const DEFAULT_BASE_BANK: Question[] = [
  {
    id: 'QB-000',
    type: 'practice',
    text: '请用一分钟简单介绍你的姓名、学校和专业，作为设备与状态测试。本题不计分。',
    readingPassage: null,
    targetKeywords: [],
    vendorTags: ['all'],
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-001',
    type: 'intro',
    text: '请做一个自我介绍，说说你的姓名、年龄、学校、专业、项目或实习经验、自我评价，以及你投递的企业和岗位。',
    answerSec: 180,
    readingPassage: null,
    targetKeywords: ['教育背景', '科研方向', '项目', '压裂'],
    vendorTags: ['all'],
    starHint: null,
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-002',
    type: 'motivation',
    text: '你为什么选择报考我们分公司？请结合分公司的业务和你的专业方向谈一谈。',
    readingPassage: null,
    targetKeywords: ['分公司', '业务', '区块', '专业方向'],
    vendorTags: ['all'],
    starHint: null,
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-003',
    type: 'behavioral',
    text: '请讲一次你在团队中与他人发生分歧或冲突的经历。当时的情形是什么，你是怎么处理的，结果如何？',
    readingPassage: null,
    targetKeywords: ['分歧', '沟通', '分工', '结果'],
    vendorTags: ['all'],
    starHint: 'S=项目组内方案分歧',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-004',
    type: 'behavioral',
    text: '请举一个你快速学习新知识或新技能并应用到实际问题中的例子。',
    readingPassage: null,
    targetKeywords: ['学习', '方法', '应用', '成果'],
    vendorTags: ['all'],
    starHint: 'S=可压性计算独立完成',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-005',
    type: 'behavioral',
    text: '请讲一次你遭遇挫折或失败的经历。你从中学到了什么？',
    readingPassage: null,
    targetKeywords: ['挫折', '原因', '改进', '收获'],
    vendorTags: ['all'],
    starHint: null,
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-006',
    type: 'motivation',
    text: '请谈谈你对能源行业转型和双碳目标的看法，以及它对你选择石油行业有什么影响。',
    readingPassage: null,
    targetKeywords: ['双碳', '转型', '天然气', '非常规'],
    vendorTags: ['all'],
    starHint: null,
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-007',
    type: 'motivation',
    text: '你还投递了哪些单位？如果都录用了，你会如何选择？',
    readingPassage: null,
    targetKeywords: ['匹配', '方向', '选择', '理由'],
    vendorTags: ['all'],
    starHint: '预案：如实一句带过+落点岗位匹配，不评价其他单位，不提放弃经历',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-008',
    type: 'situational',
    text: '假如你在压裂施工现场发现泵压突然异常升高，作为现场技术人员，你会怎么做？',
    readingPassage: null,
    targetKeywords: ['安全', '停泵', '汇报', '预案'],
    vendorTags: ['all'],
    starHint: '提示：用一段真实的现场实习或项目经历，按情境-任务-行动-结果展开',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-009',
    type: 'behavioral',
    text: '如果你带的团队里有成员不配合工作，你会怎么凝聚团队、高效推进任务？',
    readingPassage: null,
    targetKeywords: ['沟通', '分工', '激励', '目标'],
    vendorTags: ['all'],
    starHint: '西北油田真题',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-010',
    type: 'situational',
    text: '工作中如果你的方案与直属领导的意见不一致，你会怎么处理？',
    readingPassage: null,
    targetKeywords: ['听取', '论证', '执行', '汇报'],
    vendorTags: ['all'],
    starHint: null,
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-011',
    type: 'experience',
    text: '请讲一段你在现场或实习中最有收获的经历，你具体承担了什么工作。',
    readingPassage: null,
    targetKeywords: ['现场', '承担', '收获'],
    vendorTags: ['all'],
    starHint: '提示：用一次坚持完成的高强度任务，突出时间跨度与成果数字',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-012',
    type: 'reading',
    text: '请朗读下面这段文字。朗读前有准备时间，注意语速与普通话标准程度。',
    readingPassage:
      '水力压裂是油气田增产的核心技术手段。施工时，地面高压泵车将压裂液以高于地层破裂压力的排量注入井筒，压开地层形成裂缝，随后混入支撑剂的携砂液进入裂缝，将裂缝支撑起来，形成高导流能力的油气渗流通道。压裂效果的好坏，直接决定了非常规油气藏能否实现经济开发。近年来，随着页岩气、深层煤层气等非常规资源的规模开发，压裂技术正朝着数字化、智能化方向快速发展。',
    readingLang: 'zh',
    targetKeywords: [],
    answerSec: 90,
    vendorTags: ['zhilian'],
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-014',
    type: 'reading',
    text: '请朗读下面这段英文。朗读前有准备时间，注意发音、连读与语速。',
    readingPassage:
      'Hydraulic fracturing is one of the most important technologies for developing unconventional oil and gas reservoirs. In this process, fracturing fluid is injected into the wellbore at a pressure higher than the formation breakdown pressure, creating fractures in the rock. Proppant carried by the slurry then enters these fractures and keeps them open, forming high-conductivity channels for oil and gas. In recent years, with the large-scale development of shale gas and deep coalbed methane, fracturing design has shifted from empirical charts to data-driven optimization, and machine learning models are increasingly used to predict fracture geometry and long-term conductivity.',
    readingLang: 'en',
    targetKeywords: [],
    answerSec: 90,
    vendorTags: ['all'],
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-013',
    type: 'english',
    text: 'Please introduce your research direction in one minute, including why it matters to the industry.',
    readingPassage: null,
    targetKeywords: ['research', 'fracturing', 'prediction'],
    answerSec: 90,
    vendorTags: ['all'],
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-015',
    type: 'behavioral',
    text: '请描述一次你在很大压力下同时完成多项任务的经历：压力来自哪里？你是如何安排和应对的？最后结果如何？',
    readingPassage: null,
    targetKeywords: ['优先级', '拆分', '分工', '结果'],
    vendorTags: ['all'],
    starHint: '提示：先说压力来源，再讲按优先级拆分，收在带数字的完成结果',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-016',
    type: 'behavioral',
    text: '请举一个例子：你曾给自己确立了一个很高的目标，并最终完成了它。目标是什么？你具体做了什么？结果如何？',
    readingPassage: null,
    targetKeywords: ['目标', '计划', '执行', '结果'],
    vendorTags: ['all'],
    starHint: '提示：目标要具体可量化，讲分阶段计划，收在排名或分数结果',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-017',
    type: 'behavioral',
    text: '请描述一次你用事实和数据说服他人的经历。当时的分歧是什么？你是怎么说服对方的？最终结果如何？',
    readingPassage: null,
    targetKeywords: ['数据', '对比', '事实', '沟通'],
    vendorTags: ['all'],
    starHint: '提示：分歧对事不对人，讲用什么数据或标准说服了对方',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-020',
    type: 'motivation',
    text: '请谈谈你如何理解"能源的饭碗必须端在自己手里"。',
    readingPassage: null,
    targetKeywords: ['能源安全', '对外依存度', '增储上产', '压裂'],
    vendorTags: ['all'],
    starHint: '长庆真题；落点：对外依存度→国内增储上产→本单位产量数字→我的专业在其中做什么',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-021',
    type: 'behavioral',
    text: '面对陌生的项目任务，你会通过哪些渠道搜集有效信息？如何筛选出核心重点？',
    readingPassage: null,
    targetKeywords: ['渠道', '筛选', '交叉', '核实'],
    vendorTags: ['all'],
    starHint: '长庆真题；三步法：定框架→多渠道交叉（文献/现场数据/请教）→按可信度筛选',
    source: 'base',
    enabled: true
  },
  {
    // 以下 6 题按 2026-11-04 长庆 24h 实测题单补齐
    id: 'QB-046',
    type: 'motivation',
    text: '请谈谈你对我们公司以及你应聘的这个岗位的了解。',
    readingPassage: null,
    targetKeywords: ['业务', '岗位', '职责', '匹配'],
    answerSec: 120,
    vendorTags: ['all'],
    starHint: '长庆实测题：六数字+三低+岗位职责（方案设计/现场施工/效果评价）',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-047',
    type: 'motivation',
    text: '你应聘的是油气田工程技术岗位，请谈谈你对这个岗位工作内容的理解。',
    readingPassage: null,
    targetKeywords: ['压裂', '方案', '现场', '增产措施'],
    answerSec: 120,
    vendorTags: ['all'],
    starHint: '岗位理解：压裂方案设计/现场实施/效果评价/新技术试验',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-048',
    type: 'motivation',
    text: '请谈谈你对中国石油企业文化的了解。',
    readingPassage: null,
    targetKeywords: ['爱国', '创业', '求实', '奉献'],
    answerSec: 120,
    vendorTags: ['all'],
    starHint: '企业精神：爱国创业求实奉献；大庆精神铁人精神；绿色转型使命担当',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-049',
    type: 'behavioral',
    text: '请讲一件你最有成就感的事情。当时的情境是什么？你做了什么？为什么有成就感？',
    readingPassage: null,
    targetKeywords: ['成就感', '行动', '结果', '成长'],
    answerSec: 120,
    vendorTags: ['all'],
    starHint: '提示：选一件从不敢到做成的事，结果带数字，结尾讲成就感来源',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-050',
    type: 'reading',
    text: '请朗读下面两句话（普通话朗读）。',
    readingPassage:
      '中国石油是国内最大的油气生产和供应企业之一，肩负着保障国家能源安全的重要使命。长庆油田油气当量已连续六年突破六千万吨，是我国油气开发的重要基石。',
    readingLang: 'zh',
    targetKeywords: [],
    answerSec: 45,
    vendorTags: ['all'],
    starHint: '短朗读实测题型：两句约30秒',
    source: 'base',
    enabled: true
  },
  {
    id: 'QB-051',
    type: 'reading',
    text: 'Please read the following two sentences aloud.',
    readingPassage:
      'Hydraulic fracturing is a key technology for developing unconventional oil and gas reservoirs. I believe my expertise in petroleum engineering and artificial intelligence can bring real value to the oilfield.',
    readingLang: 'en',
    targetKeywords: [],
    answerSec: 45,
    vendorTags: ['all'],
    starHint: '英文两句朗读实测题型：约45秒',
    source: 'base',
    enabled: true
  }
]

// ---------- 题库 ----------
export function loadQuestionBank(file: 'base' | 'generated'): QuestionBankFile {
  const dir = questionBankDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const p = join(dir, `${file}.json`)
  if (file === 'base' && !existsSync(p)) {
    writeFileSync(p, JSON.stringify({ questions: DEFAULT_BASE_BANK }, null, 2), 'utf-8')
    return { questions: DEFAULT_BASE_BANK }
  }
  if (!existsSync(p)) return { questions: [] }
  try {
    const bank = JSON.parse(readFileSync(p, 'utf-8')) as QuestionBankFile
    // 存量库迁移：默认题库新增条目（如英文朗读题）按 id 补入，不动用户已有启停编辑
    if (file === 'base' && Array.isArray(bank.questions)) {
      const ids = new Set(bank.questions.map((q) => q.id))
      let added = false
      for (const q of DEFAULT_BASE_BANK) {
        if (!ids.has(q.id)) {
          bank.questions.push(q)
          added = true
        }
      }
      if (added) writeFileSync(p, JSON.stringify(bank, null, 2), 'utf-8')
    }
    return bank
  } catch (e) {
    console.error(`[SessionStore] 题库解析失败 ${p}`, e)
    return { questions: [] }
  }
}

export function saveQuestionBank(file: 'base' | 'generated', bank: QuestionBankFile): void {
  const dir = questionBankDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${file}.json`), JSON.stringify(bank, null, 2), 'utf-8')
}

// ---------- 会话 ----------
export function sessionTimestamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`
}

export function createSession(meta: SessionMeta, qDirs: string[]): void {
  const root = join(sessionsDir(), meta.session_id)
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  for (const d of qDirs) {
    const p = join(root, d)
    if (!existsSync(p)) mkdirSync(p, { recursive: true })
  }
  saveSessionMeta(meta)
}

export function saveSessionMeta(meta: SessionMeta): void {
  const root = join(sessionsDir(), meta.session_id)
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'session.json'), JSON.stringify(meta, null, 2), 'utf-8')
}

export function loadSessionMeta(sessionId: string): SessionMeta | null {
  const p = join(sessionsDir(), sessionId, 'session.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SessionMeta
  } catch {
    return null
  }
}

export function listSessions(): SessionMeta[] {
  const root = sessionsDir()
  if (!existsSync(root)) return []
  const metas: SessionMeta[] = []
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    const meta = loadSessionMeta(name.name)
    if (meta) metas.push(meta)
  }
  metas.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  return metas
}

// ---------- 趋势 ----------
export function loadTrends(): { sessions: TrendEntry[] } {
  const p = trendsPath()
  if (!existsSync(p)) return { sessions: [] }
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as { sessions: TrendEntry[] }
  } catch {
    return { sessions: [] }
  }
}

export function appendTrend(entry: TrendEntry): void {
  const data = loadTrends()
  data.sessions = data.sessions.filter((s) => s.session_id !== entry.session_id)
  data.sessions.push(entry)
  writeFileSync(trendsPath(), JSON.stringify(data, null, 2), 'utf-8')
}

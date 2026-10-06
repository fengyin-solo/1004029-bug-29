import { commitRow, listRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

const PUMP_KEY = 'pump_station'

export type PumpTransition = {
  at: string
  action: string
  from: string
  to: string
  operator: string
  note?: string
}

// 泵站模块的专用服务：在通用动作之上加状态机守卫、乐观锁和流转留痕。
// 所有写操作都从存储里现取当前行，避免列表/详情各自缓存导致「看到的状态」与「真实状态」错位。

export function getPump(id: number): EntryRow | undefined {
  return listRows(PUMP_KEY).find((row) => Number(row.id) === id)
}

export function legalPumpActions(status: string): string[] {
  switch (status) {
    case '待启机':
      return ['启动泵站']
    case '运行中':
      return ['正常停机', '上报故障']
    case '故障中':
      return ['故障核验']
    case '已停机':
      return ['启动泵站']
    default:
      return []
  }
}

export function transitionHistory(id: number): PumpTransition[] {
  const key = `${PUMP_KEY}:${id}:history`
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    const raw = window.localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as PumpTransition[]) : []
  } catch {
    return []
  }
}

function appendHistory(id: number, entry: PumpTransition): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const history = transitionHistory(id)
  history.push(entry)
  window.localStorage.setItem(`${PUMP_KEY}:${id}:history`, JSON.stringify(history))
}

type PumpCommand = {
  id: number
  action: string
  // 调用方（列表行/详情弹层）发起时看到的版本号；提交时做 CAS，
  // 两处界面并发启停/上报，只有持最新版本的那一次落盘，另一次原样失败。
  expectedRevision?: number
  operator?: string
  note?: string
  // 故障核验结论：true 通过（故障中 → 已停机，并生成溢流复核事项）；false 不通过，维持故障中。
  verified?: boolean
}

export function runPumpCommand(command: PumpCommand): ActionResult {
  const target = getPump(command.id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${command.id} 的泵站` }
  }
  const current = String(target.status)
  const expectedRevision = command.expectedRevision ?? Number(target.revision ?? 1)
  const allowed = legalPumpActions(current)
  if (!allowed.includes(command.action)) {
    return {
      ok: false,
      message: `泵站当前为「${current}」，不能执行「${command.action}」，合法操作：${allowed.join('、') || '无'}；状态保持「${current}」`,
    }
  }
  if (expectedRevision !== Number(target.revision ?? 1)) {
    // 版本闸：另一处界面上的并发操作已经先行生效，本次直接拒绝，状态完全不动。
    return {
      ok: false,
      message: '该泵站刚被其他操作处理过（并发冲突），本次操作未生效，请刷新后重试',
    }
  }

  // 重复上报故障：故障核验不通过等同于一次未生效操作，不产生任何写入。
  if (command.action === '故障核验' && command.verified === false) {
    appendHistory(command.id, {
      at: new Date().toISOString(),
      action: '故障核验（不通过）',
      from: current,
      to: current,
      operator: command.operator ?? '值班管理员',
      note: command.note,
    })
    return {
      ok: false,
      message: '故障核验未通过，泵站维持「故障中」，需检修后重新核验；未生成溢流复核事项',
    }
  }

  const targetStatus = command.action === '故障核验' ? '已停机' : applyTarget(command.action)
  const flags = flagsFor(targetStatus)
  const committed = commitRow(PUMP_KEY, command.id, expectedRevision, {
    status: targetStatus,
    pending: flags.pending,
    abnormal: flags.abnormal,
  })
  if (!committed.ok) {
    // 乐观锁失败：并发的另一次启停/上报已经生效，本次结果不落盘，状态不变。
    return { ok: false, message: committed.message }
  }

  appendHistory(command.id, {
    at: new Date().toISOString(),
    action: command.action,
    from: current,
    to: targetStatus,
    operator: command.operator ?? '值班管理员',
    note: command.note,
  })

  // 只有故障核验通过这一条路径会通知排水管网页生成溢流复核事项；
  // 上报故障、核验不通过、并发失败都不会提前生成。
  if (command.action === '故障核验' && command.verified === true) {
    createOverflowReview({
      sourcePumpId: command.id,
      sourcePumpName: String(target['泵站名称'] ?? target['泵站编号'] ?? command.id),
      operator: command.operator ?? '值班管理员',
      note: command.note,
    })
  }

  return { ok: true, message: `泵站已${command.action}，当前状态「${targetStatus}」` }
}

function applyTarget(action: string): string {
  switch (action) {
    case '启动泵站':
      return '运行中'
    case '正常停机':
      return '已停机'
    case '上报故障':
      return '故障中'
    default:
      return ''
  }
}

function flagsFor(status: string): { pending: boolean; abnormal: boolean } {
  if (status === '故障中') {
    return { pending: true, abnormal: true }
  }
  if (status === '待启机') {
    return { pending: true, abnormal: false }
  }
  return { pending: false, abnormal: false }
}

// ---- 溢流复核事项（排水管网页） ----

export type OverflowReview = {
  id: number
  sourcePumpId: number
  sourcePumpName: string
  status: '待复核' | '已闭环'
  createdAt: string
  createdBy: string
  closedAt?: string
  note?: string
}

const OVERFLOW_KEY = 'drain_network:overflow-reviews'

function readReviews(): OverflowReview[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    const raw = window.localStorage.getItem(OVERFLOW_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as OverflowReview[]) : []
  } catch {
    return []
  }
}

function writeReviews(reviews: OverflowReview[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(OVERFLOW_KEY, JSON.stringify(reviews))
  }
}

export function listOverflowReviews(): OverflowReview[] {
  return readReviews().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function createOverflowReview(input: {
  sourcePumpId: number
  sourcePumpName: string
  operator: string
  note?: string
}): void {
  const reviews = readReviews()
  // 同一泵站存在未闭环事项时不重复生成（一次故障核验最多一条待复核事项）。
  const exists = reviews.some(
    (item) => item.sourcePumpId === input.sourcePumpId && item.status === '待复核',
  )
  if (exists) {
    return
  }
  const nextId = reviews.reduce((max, item) => Math.max(max, item.id), 0) + 1
  reviews.push({
    id: nextId,
    sourcePumpId: input.sourcePumpId,
    sourcePumpName: input.sourcePumpName,
    status: '待复核',
    createdAt: new Date().toISOString(),
    createdBy: input.operator,
    note: input.note,
  })
  writeReviews(reviews)
}

export function closeOverflowReview(id: number): ActionResult {
  const reviews = readReviews()
  const index = reviews.findIndex((item) => item.id === id)
  if (index < 0) {
    return { ok: false, message: '没有找到这条溢流复核事项' }
  }
  if (reviews[index].status === '已闭环') {
    return { ok: false, message: '该溢流复核事项已闭环，不用重复操作' }
  }
  reviews[index] = { ...reviews[index], status: '已闭环', closedAt: new Date().toISOString() }
  writeReviews(reviews)
  return { ok: true, message: '溢流复核事项已闭环' }
}

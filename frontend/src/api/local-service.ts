import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionPayload,
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  StatusFlags,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 同一记录的操作锁：并发启停、重复点击只放行第一个，其余直接拒绝。
const inFlight = new Set<string>()

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  payload: ActionPayload = {},
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const lockKey = `${key}:${id}`
  if (inFlight.has(lockKey)) {
    return { ok: false, message: `这条${meta.entity}有正在处理的操作，「${action}」已被忽略` }
  }
  inFlight.add(lockKey)
  try {
    return applyTransition(meta, id, action, target, payload)
  } finally {
    inFlight.delete(lockKey)
  }
}

function applyTransition(
  meta: ModuleMeta,
  id: number,
  action: string,
  target: string,
  payload: ActionPayload,
): ActionResult {
  const rows = listRows(meta.key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 状态机校验：只允许按登记的合法路径推进，非法操作拒绝且保留当前状态。
  const allowedFrom = meta.actionFrom?.[action]
  if (allowedFrom && !allowedFrom.includes(current)) {
    return {
      ok: false,
      message: `${meta.entity}当前为「${current}」，不允许执行「${action}」，状态保持不变`,
    }
  }
  // 核验类动作：没有核验信息一律失败，状态不变。
  const needsVerify = meta.verifyActions?.includes(action) ?? false
  const verifier = String(payload.verifier ?? '').trim()
  if (needsVerify && !verifier) {
    return {
      ok: false,
      message: `「${action}」需要先完成核验（提供核验人），状态保持「${current}」不变`,
    }
  }
  const flags = statusFlagsFor(meta, target, action)
  const updated: EntryRow = { ...rows[index], status: target, ...flags }
  if (meta.statusField) {
    updated[meta.statusField] = target
  }
  if (needsVerify) {
    updated['最近核验人'] = verifier
  }
  const next = [...rows]
  next[index] = updated
  saveRows(meta.key, next)
  runSideEffects(meta, action, updated)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function statusFlagsFor(meta: ModuleMeta, target: string, action: string): StatusFlags {
  const declared = meta.statusFlags?.[target]
  if (declared) {
    return declared
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  return {
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
}

// 流转成功后的联动：泵站故障确认才会在排水管网生成溢流复核事项，
// 同一泵站的未复核事项只保留一条，重复上报不会重复生成；动作失败时这里不会执行。
function runSideEffects(meta: ModuleMeta, action: string, row: EntryRow): void {
  if (meta.key !== 'pump_station' || action !== '上报故障') {
    return
  }
  const drainKey = 'drain_network'
  const source = String(row['泵站编号'] ?? row.id)
  const drainRows = listRows(drainKey)
  const existing = drainRows.some(
    (item) => item['复核来源'] === source && item.status === '溢流风险',
  )
  if (existing) {
    return
  }
  const nextId = drainRows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const review: EntryRow = {
    id: nextId,
    status: '溢流风险',
    pending: true,
    abnormal: true,
    管段编号: `REVIEW-${source}`,
    上游节点: `泵站${source}`,
    下游节点: '待复核',
    管段长度: '—',
    断面尺寸: '—',
    设计坡度: '—',
    排水能力: '—',
    运行状况: `泵站${source}故障，待溢流复核`,
    复核来源: source,
  }
  saveRows(drainKey, [...drainRows, review])
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

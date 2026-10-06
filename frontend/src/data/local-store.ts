import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'underground-pipeline-inspection:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 以状态字符串为唯一权威，重算看板标记和行版本。
// 旧版本写进 localStorage 的数据 pending/abnormal 是用「是否末态」推导的，
// 故障中会被错标成已处理，重进工作台后列表与看板口径不一致，这里统一纠正。
function normalizeRow(key: string, row: EntryRow): EntryRow {
  const meta = MODULE_BY_KEY.get(key)
  const flags = meta?.stateFlags?.[String(row.status)]
  return {
    ...row,
    pending: flags ? flags.pending : row.pending,
    abnormal: flags ? flags.abnormal : row.abnormal,
    revision: typeof row.revision === 'number' ? row.revision : 1,
  }
}

function normalizeAll(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const result: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(data)) {
    result[key] = Array.isArray(rows) ? rows.map((row) => normalizeRow(key, row)) : []
  }
  return result
}

function seedData(): Record<string, EntryRow[]> {
  return normalizeAll(clone(SEED_ROWS))
}

function persist(data: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    // 写盘失败（隐私模式/配额）不能让内存态与存储态分叉：抛出后由调用方放弃本次改动。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = seedData()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('invalid storage payload')
    }
    // 新模块/新示例数据以种子为准，老模块沿用浏览器里的改动。
    return normalizeAll({ ...clone(SEED_ROWS), ...(parsed as Record<string, EntryRow[]>) })
  } catch {
    persist(fallback)
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export type CommitError = { ok: false; message: string }

// 提交单行改动。expectedRevision 是乐观锁：
// 并发启停/重复上报时，只有持当前版本的那次提交能落盘，其余原样拒绝，状态保持不变。
export function commitRow(
  key: string,
  id: number,
  expectedRevision: number,
  patch: Partial<EntryRow>,
): { ok: true; row: EntryRow } | CommitError {
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: '记录不存在或已被删除' }
  }
  const current = rows[index]
  if (Number(current.revision) !== expectedRevision) {
    return {
      ok: false,
      message: `该${MODULE_BY_KEY.get(key)?.entity ?? '记录'}刚被其他操作处理过，请刷新后重试，本次操作未生效`,
    }
  }
  const updated: EntryRow = { ...current, ...patch, revision: expectedRevision + 1 }
  const nextRows = [...rows]
  nextRows[index] = updated
  const nextAll = { ...allRows(), [key]: nextRows }
  persist(nextAll) // 先写盘，成功后才更新内存缓存，避免两态分叉
  cache = nextAll
  return { ok: true, row: updated }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = normalizeAll({ ...allRows(), [key]: rows })
  persist(next)
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = seedData()[key] ?? []
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

import { MODULES } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'underground-pipeline-inspection:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 旧数据可能存了状态与镜像字段、标记不一致的行（比如故障中被误改成运行中之前的残留），
// 加载时按模块登记的状态语义修复一遍，保证列表、详情、看板看到的都是同一个状态。
function sanitize(rows: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  for (const meta of MODULES) {
    const list = rows[meta.key]
    if (!list) {
      continue
    }
    for (const row of list) {
      const status = String(row.status)
      if (meta.statusField && row[meta.statusField] !== status) {
        row[meta.statusField] = status
      }
      const flags = meta.statusFlags?.[status]
      if (flags) {
        row.pending = flags.pending
        row.abnormal = flags.abnormal
      }
    }
  }
  return rows
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return sanitize({ ...fallback, ...parsed })
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
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

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

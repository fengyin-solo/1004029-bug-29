/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  // 乐观锁版本号：每次成功流转 +1，并发提交凭它判定只有一次生效。
  revision?: number
  [field: string]: string | number | boolean | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  // 状态机：动作 -> 允许发起该动作的当前状态。未配置的模块沿用历史宽松行为。
  transitions?: Record<string, string[]>
  // 各状态对应的看板标记；未配置时沿用 pending = 非末态 的推导。
  stateFlags?: Record<string, { pending: boolean; abnormal: boolean }>
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

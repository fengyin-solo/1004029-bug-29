/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type StatusFlags = {
  pending: boolean
  abnormal: boolean
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
  /** 可选：每个动作允许的起始状态；登记了就按状态机校验，非法流转直接拒绝 */
  actionFrom?: Record<string, string[]>
  /** 可选：必须先核验才能执行的动作，缺核验信息时状态保持不变 */
  verifyActions?: string[]
  /** 可选：业务字段里镜像状态的列，流转成功时同步写入，避免列表与状态错位 */
  statusField?: string
  /** 可选：每个状态对应的待处理/异常标记；缺省沿用旧的推导规则 */
  statusFlags?: Record<string, StatusFlags>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionPayload = {
  /** 核验类动作要求提供核验人，空值视为未核验 */
  verifier?: string
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

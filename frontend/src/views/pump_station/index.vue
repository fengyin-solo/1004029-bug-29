<template>
  <section class="page" data-module="pump_station">
    <header class="page-head">
      <div>
        <h2>泵站运行管理</h2>
        <p class="page-desc">泵站状态按 待启机 → 运行中 → 已停机 推进；运行中可上报故障，故障须核验通过后回到已停机。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记泵站</button>
        <button class="btn" type="button" @click="exportRows">导出泵站运行清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <button v-if="column === '泵站编号'" class="link" type="button" @click="openDetail(row)">
              {{ row[column] ?? '—' }}
            </button>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            <span :class="['status-tag', statusClass(String(row.status))]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <template v-for="action in legalPumpActions(String(row.status))" :key="action">
              <button
                class="link"
                type="button"
                :disabled="busyKey === busyKeyOf(row, action)"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <button class="link" type="button" @click="openDetail(row)">详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无泵站运行数据，可先登记泵站</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条泵站运行记录</span>
      <span v-if="message" :class="lastOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 泵站详情：状态与时间线都在打开/操作后现取，避免重进工作台时显示陈旧状态 -->
    <div v-if="detailRow" class="modal-mask" @click.self="closeDetail">
      <div class="modal">
        <header class="modal-head">
          <h3>泵站详情 · {{ detailRow['泵站编号'] }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-grid">
          <template v-for="field in columns" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ detailRow[field] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd><span :class="['status-tag', statusClass(String(detailRow.status))]">{{ detailRow.status }}</span></dd>
        </dl>

        <div class="detail-actions">
          <button
            v-for="action in legalPumpActions(String(detailRow.status))"
            :key="action"
            class="btn"
            :class="{ primary: action !== '故障核验' }"
            type="button"
            :disabled="busyKey !== ''"
            @click="runAction(action, detailRow)"
          >
            {{ action }}
          </button>
        </div>

        <h4 class="timeline-title">状态流转记录</h4>
        <ul v-if="history.length" class="timeline">
          <li v-for="(item, index) in history" :key="index" class="timeline-item">
            <span class="timeline-time">{{ formatTime(item.at) }}</span>
            <span class="timeline-action">{{ item.action }}：{{ item.from }} → {{ item.to }}</span>
            <span v-if="item.note" class="timeline-note">核验意见：{{ item.note }}</span>
            <span class="timeline-operator">{{ item.operator }}</span>
          </li>
        </ul>
        <p v-else class="empty-state">暂无流转记录</p>
      </div>
    </div>

    <!-- 故障核验：通过才恢复并通知排水管网页生成溢流复核事项；不通过维持故障中 -->
    <div v-if="verifyRow" class="modal-mask" @click.self="verifyRow = null">
      <div class="modal modal-sm">
        <header class="modal-head">
          <h3>故障核验 · {{ verifyRow['泵站编号'] }}</h3>
          <button class="btn ghost" type="button" @click="verifyRow = null">取消</button>
        </header>
        <p class="verify-tip">泵站「{{ verifyRow['泵站名称'] }}」当前为故障中，请录入现场核验结论。</p>
        <label class="filter-item">
          <span>核验意见</span>
          <textarea v-model="verifyNote" rows="3" placeholder="记录检修与核验情况"></textarea>
        </label>
        <footer class="modal-foot">
          <button class="btn" type="button" :disabled="busyKey !== ''" @click="submitVerify(false)">
            核验不通过（维持故障中）
          </button>
          <button class="btn primary" type="button" :disabled="busyKey !== ''" @click="submitVerify(true)">
            核验通过（恢复为已停机）
          </button>
        </footer>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import {
  getPump,
  legalPumpActions,
  runPumpCommand,
  transitionHistory,
  type PumpTransition,
} from '@/api/pump-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pump_station')
const store = useSessionStore()
const columns = ["泵站编号", "泵站名称", "所在区域", "水泵型号", "额定流量", "运行电流", "运行时长", "运行状态"]
const statuses = ["待启机", "运行中", "已停机", "故障中"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const lastOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const busyKey = ref('')

const detailRow = ref<EntryRow | null>(null)
const history = ref<PumpTransition[]>([])
const verifyRow = ref<EntryRow | null>(null)
const verifyNote = ref('')

const stats = computed(() => [
  { label: '运行中泵站', value: countByStatus('运行中') },
  { label: '故障泵站', value: countByStatus('故障中') },
  { label: '待启机泵站', value: countByStatus('待启机') },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({ status, count: countByStatus(status) })),
)

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function statusClass(status: string): string {
  if (status === '运行中') return 'tag-running'
  if (status === '故障中') return 'tag-fault'
  if (status === '已停机') return 'tag-stopped'
  return 'tag-idle'
}

function busyKeyOf(row: EntryRow, action: string): string {
  return `${row.id}:${action}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  message.value = '泵站登记入口尚未接入审批流'
  lastOk.value = false
}

function flash(ok: boolean, text: string) {
  lastOk.value = ok
  message.value = text
}

function runAction(action: string, row: EntryRow) {
  if (action === '故障核验') {
    verifyRow.value = row
    verifyNote.value = ''
    return
  }
  const key = busyKeyOf(row, action)
  busyKey.value = key
  // 执行前现取存储里的最新行，列表/详情任一入口操作都基于真实状态与版本。
  const fresh = getPump(Number(row.id))
  if (!fresh) {
    busyKey.value = ''
    flash(false, '没有找到该泵站')
    return
  }
  const result = runPumpCommand({
    id: Number(fresh.id),
    action,
    expectedRevision: Number(row.revision ?? 1),
    operator: store.operator,
  })
  busyKey.value = ''
  flash(result.ok, result.message)
  reload()
  if (detailRow.value && Number(detailRow.value.id) === Number(fresh.id)) {
    openDetail(fresh.id)
  }
}

function submitVerify(pass: boolean) {
  if (!verifyRow.value) {
    return
  }
  const id = Number(verifyRow.value.id)
  busyKey.value = `${id}:故障核验`
  const result = runPumpCommand({
    id,
    action: '故障核验',
    expectedRevision: Number(verifyRow.value.revision ?? 1),
    verified: pass,
    operator: store.operator,
    note: verifyNote.value.trim() || undefined,
  })
  busyKey.value = ''
  flash(result.ok, result.message)
  verifyRow.value = null
  verifyNote.value = ''
  reload()
  if (detailRow.value && Number(detailRow.value.id) === id) {
    openDetail(id)
  }
}

function openDetail(rowOrId: EntryRow | number) {
  const id = typeof rowOrId === 'number' ? rowOrId : Number(rowOrId.id)
  const fresh = getPump(id)
  if (!fresh) {
    flash(false, '没有找到该泵站')
    return
  }
  detailRow.value = fresh
  history.value = transitionHistory(id)
}

function closeDetail() {
  detailRow.value = null
  history.value = []
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (detailRow.value) {
      detailRow.value = getPump(Number(detailRow.value.id)) ?? detailRow.value
    }
  } catch (error) {
    flash(false, error instanceof Error ? error.message : '泵站运行列表读取失败')
  }
}

onMounted(reload)
</script>

<style scoped>
.ok-text { color: #067647; }
.status-tag { border-radius: 999px; padding: 2px 10px; font-size: 12px; white-space: nowrap; }
.tag-idle { background: #eef2f7; color: #475569; }
.tag-running { background: #dcfae6; color: #067647; }
.tag-stopped { background: #f2f4f7; color: #667085; }
.tag-fault { background: #fee4e2; color: #b42318; }
.link:disabled { color: #98a2b3; cursor: not-allowed; }
.modal-mask {
  position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 20;
}
.modal {
  background: #fff; border-radius: 10px; width: 640px; max-width: 92vw;
  max-height: 86vh; overflow: auto; padding: 18px 20px;
}
.modal-sm { width: 460px; }
.modal-head { display: flex; justify-content: space-between; align-items: center; }
.modal-head h3 { margin: 0; font-size: 16px; }
.detail-grid { display: grid; grid-template-columns: 96px 1fr; gap: 6px 12px; margin: 14px 0; font-size: 13px; }
.detail-grid dt { color: var(--muted); }
.detail-grid dd { margin: 0; }
.detail-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.timeline-title { font-size: 14px; margin: 8px 0; }
.timeline { list-style: none; margin: 0; padding: 0; border-left: 2px solid var(--border); }
.timeline-item { padding: 6px 0 6px 14px; font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.timeline-time { color: var(--muted); }
.timeline-note { color: #b54708; }
.timeline-operator { color: var(--muted); }
.verify-tip { font-size: 13px; color: #475467; }
.verify-tip textarea, textarea { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font: inherit; resize: vertical; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
</style>

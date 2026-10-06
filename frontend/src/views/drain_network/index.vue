<template>
  <section class="page" data-module="drain_network">
    <header class="page-head">
      <div>
        <h2>排水管网管理</h2>
        <p class="page-desc">维护排水管段，围绕管段编号、上游节点、下游节点、管段长度做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记排水管段</button>
        <button class="btn" type="button" @click="exportRows">导出排水管网清单</button>
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

    <section class="review-panel">
      <header class="review-head">
        <h3>溢流复核事项</h3>
        <span class="review-hint">仅在泵站故障核验通过后由系统生成，核验不通过或重复上报不会提前产生事项</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>事项编号</th>
            <th>来源泵站</th>
            <th>生成时间</th>
            <th>核验人</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="review in reviews" :key="review.id">
            <td>OFR-{{ String(review.id).padStart(4, '0') }}</td>
            <td>{{ review.sourcePumpName }}（编号 {{ review.sourcePumpId }}）</td>
            <td>{{ formatTime(review.createdAt) }}</td>
            <td>{{ review.createdBy }}</td>
            <td>
              <span :class="['review-tag', review.status === '待复核' ? 'review-open' : 'review-done']">
                {{ review.status }}
              </span>
            </td>
            <td>
              <button
                v-if="review.status === '待复核'"
                class="link"
                type="button"
                @click="closeReview(review.id)"
              >
                复核闭环
              </button>
              <span v-else class="muted-text">{{ review.closedAt ? formatTime(review.closedAt) : '已闭环' }}</span>
            </td>
          </tr>
          <tr v-if="!reviews.length">
            <td colspan="6" class="empty-state">暂无溢流复核事项：泵站故障须核验通过后才会生成</td>
          </tr>
        </tbody>
      </table>
    </section>

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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in legalActions(String(row.status))"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无排水管网数据，可先登记排水管段</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条排水管网记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  closeOverflowReview,
  listOverflowReviews,
  type OverflowReview,
} from '@/api/pump-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('drain_network')
const columns = ["管段编号", "上游节点", "下游节点", "管段长度", "断面尺寸", "设计坡度", "排水能力", "运行状况"]
const statuses = ["正常", "淤积预警", "溢流风险", "已封堵"]
const stats = [{"label": "管段总数", "value": 0}, {"label": "淤积预警管段", "value": 0}, {"label": "溢流风险管段", "value": 0}]

const rows = ref<EntryRow[]>([])
const reviews = ref<OverflowReview[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('zh-CN', { hour12: false })
}

function closeReview(id: number) {
  errorMessage.value = ''
  const result = closeOverflowReview(id)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  loadReviews()
}

// 排水管段只允许逐级推进，列表上直接不给出跳级动作（服务端仍有二次守卫）。
function legalActions(status: string): string[] {
  switch (status) {
    case '正常':
      return ['标记淤积']
    case '淤积预警':
      return ['预警溢流']
    case '溢流风险':
      return ['确认封堵']
    default:
      return []
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '排水管段登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    loadReviews()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '排水管网列表读取失败'
  }
}

function loadReviews() {
  reviews.value = listOverflowReviews()
}

onMounted(reload)
</script>

<style scoped>
.review-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
}
.review-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.review-head h3 { margin: 0; font-size: 15px; }
.review-hint { color: var(--muted); font-size: 12px; }
.review-tag { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.review-open { background: #fef0c7; color: #b54708; }
.review-done { background: #dcfae6; color: #067647; }
.muted-text { color: var(--muted); font-size: 12px; }
</style>

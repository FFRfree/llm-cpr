// pages/shared.js —— 四个小页共享的框架组件：排序表头、分页条。
// 行为对齐原 app.js 的 bindSortHeaders / renderPager（纯 DOM 版），只是改成状态驱动。
import { html } from '../lib/html.js';

/* 可排序表头：点击 → (key) 回调，箭头状态由 sort 状态推导 */
export function SortTh({ k, label, sort, onSort, num: isNum }) {
  const active = sort.key === k;
  return html`<th class="sortable${isNum ? ' num' : ''}" onClick=${() => onSort(k)}>
    ${label} <span class="arrow">${active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
  </th>`;
}

/* 分页条：total/page/page_size + go(page) 回调；total=0 显示「0 条」 */
export function Pager({ data, go }) {
  if (!data) return null;
  const { page, page_size, total } = data;
  if (total === 0) return html`<div class="pager"><span>0 条</span></div>`;
  const last = Math.max(1, Math.ceil(total / page_size));
  return html`<div class="pager">
    <button disabled=${page <= 1} onClick=${() => go(page - 1)}>‹ 上一页</button>
    <span>第 <b class="num">${page}</b> / ${last} 页 · 共 <b class="num">${total}</b> 条</span>
    <button disabled=${page >= last} onClick=${() => go(page + 1)}>下一页 ›</button>
  </div>`;
}

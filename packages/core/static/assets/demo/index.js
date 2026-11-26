// preact + htm 基座自检页入口：装配组件、复用经典脚本 app.js 的全局工具（fetchJson/withTenant/
// fmtTok/esc/initChrome，app.js 以经典 <script> 先于本模块加载）。挂载点 #app。
import { render } from 'preact';
import { html } from '../lib/html.js';
import { Counter, LiveSummary, NameForm, primeRouteStatus } from './components.js';

function App() {
  return html`
    <h2>Preact + htm 基座自检</h2>
    <p class="muted">本页证明框架管线：组件拆分（assets/demo/）、import map 指 vendor 三文件、真后台 API、受控表单。
    挂载点之外的原生 DOM（顶栏等）不被框架接管。settings 正式页验收后另起，届时本页删除。</p>
    <${Counter} />
    <${NameForm} />
    <h2>实时摘要（真 API · /api/audit/summary）</h2>
    <${LiveSummary} />
  `;
}

initChrome('preact-demo.html');
primeRouteStatus();
render(html`<${App} />`, document.getElementById('app'));

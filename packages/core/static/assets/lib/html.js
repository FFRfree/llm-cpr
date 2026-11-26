// htm 单点绑定：全仓唯一一处 htm.bind(h)，所有要写 UI 的模块从这里 import { html }。
// 组件写法 = React 函数组件心智，模板走 htm 标签模板字符串（无 JSX、无构建）。
import { h } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);

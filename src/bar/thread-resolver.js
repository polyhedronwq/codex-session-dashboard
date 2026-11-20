// 「当前在哪个会话」的判定逻辑（纯函数，便于单测）。
//
// 这里曾经出过一次严重回归：新对话页面里 Codex 仍挂着旧会话的隐藏节点，
// 当时用"挂载节点数最多"兜底，于是底栏显示了别的会话的数据。
//
// 判定顺序（每一档都必须有测试钉住）：
//   1. 有可见的会话节点            → 就用它（最可靠的信号）
//   2. 页面可见 + 没有可见节点     → 这是新对话（真的空），不是布局问题
//   3. 页面不可见（窗口在后台）    → 布局没跑，保留上一次的结果
//
// 关键区分：2 和 3 在 DOM 上看起来一模一样（都是 0 个可见节点），
// 只能靠 document.visibilityState 分开。

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mostFrequent(ids) {
  const counts = new Map();
  for (const id of ids) {
    if (!UUID_RE.test(id)) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  let best = null;
  for (const [id, count] of counts) {
    if (!best || count > best.count) best = { id, count };
  }
  return best ? best.id : null;
}

function decideThread({ nodes, visibilityState, lastThread }) {
  const visibleIds = (nodes || []).filter((node) => node && node.visible).map((node) => node.id || '');
  const visible = mostFrequent(visibleIds);
  if (visible) return { id: visible, reason: 'visible' };

  // 页面可见却没有任何可见消息：用户确实在一个空会话里
  if (visibilityState === 'visible') return { id: null, reason: 'empty' };

  // 页面不可见：0×0 只是"没布局"，保持上一次的判断
  const kept = mostFrequent((nodes || []).map((node) => node.id || ''));
  return { id: kept || lastThread || null, reason: kept || lastThread ? 'background' : 'unknown' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { decideThread, mostFrequent, UUID_RE };
}

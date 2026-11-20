// 会话判定单测：把"新对话""后台""正常"三种状态钉死。
//
// 这条测试的存在意义：曾经因为用"挂载节点最多"兜底，新对话界面显示了
// 别的会话的数据。那个兜底永远能返回一个 id，所以永远不会判定为空。
//
//   node verify/test-resolver.js
const assert = require('assert');
const path = require('path');

const { decideThread } = require(path.join(__dirname, '..', 'src', 'bar', 'thread-resolver.js'));

const A = '01a1ec92-d66a-7323-8941-29f41f2a86d8';
const B = '01a1f1c6-a657-7941-94e5-5c95c819f918';
const C = '01a1f1ed-77ae-7433-ae4b-d47dba9fcc93';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (error) {
    failed += 1;
    console.log('  FAIL  ' + name + '  -> ' + error.message);
  }
}

// —— 正常情况 ——
test('有可见节点：用它', () => {
  const result = decideThread({
    nodes: [{ id: A, visible: false }, { id: C, visible: true }],
    visibilityState: 'visible',
    lastThread: A,
  });
  assert.deepStrictEqual(result, { id: C, reason: 'visible' });
});

test('多个可见节点时取出现次数最多的', () => {
  const result = decideThread({
    nodes: [{ id: B, visible: true }, { id: C, visible: true }, { id: C, visible: true }],
    visibilityState: 'visible',
    lastThread: null,
  });
  assert.strictEqual(result.id, C);
});

// —— 关键回归：新对话 ——
test('新对话：页面可见但无可见节点 → 判定为空，不能回退到旧会话', () => {
  const result = decideThread({
    nodes: [
      ...Array(9).fill({ id: A, visible: false }),
      ...Array(8).fill({ id: B, visible: false }),
      ...Array(7).fill({ id: C, visible: false }),
    ],
    visibilityState: 'visible',
    lastThread: A,
  });
  assert.strictEqual(result.id, null, '新对话不应该返回任何会话 id');
  assert.strictEqual(result.reason, 'empty');
});

test('新对话：完全没有节点时也是空', () => {
  const result = decideThread({ nodes: [], visibilityState: 'visible', lastThread: A });
  assert.deepStrictEqual(result, { id: null, reason: 'empty' });
});

// —— 关键回归：窗口在后台 ——
test('窗口在后台：0×0 只是没布局，要保留上次的会话', () => {
  const result = decideThread({
    nodes: [{ id: C, visible: false }],
    visibilityState: 'hidden',
    lastThread: C,
  });
  assert.strictEqual(result.id, C);
  assert.strictEqual(result.reason, 'background');
});

test('窗口在后台且没有任何节点：退回 lastThread', () => {
  const result = decideThread({ nodes: [], visibilityState: 'hidden', lastThread: B });
  assert.strictEqual(result.id, B);
});

// —— 健壮性 ——
test('忽略非法 id（占位符、空值）', () => {
  const result = decideThread({
    nodes: [
      { id: 'client-new-thread:abc', visible: true },
      { id: '', visible: true },
      { id: 'local:' + C, visible: true },
      { id: C, visible: true },
    ],
    visibilityState: 'visible',
    lastThread: null,
  });
  assert.strictEqual(result.id, C);
});

test('只有非法 id 且页面可见 → 空', () => {
  const result = decideThread({
    nodes: [{ id: 'client-new-thread:abc', visible: true }],
    visibilityState: 'visible',
    lastThread: A,
  });
  assert.strictEqual(result.id, null);
});

console.log(`\n  会话判定: ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);

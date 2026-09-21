import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DB } from '../db';
import { createProject, importVersion, saveFragmentDecision, type FragmentDecision } from '../service';
import { buildResolutionDraft, rebuildResolution, toResolutionMarkdown } from '../resolution';
import { splitParagraphs } from '../diff';

function makeComparison(oldContent: string, newContent: string) {
  const db = openDb(':memory:');
  const projectId = createProject(db, '决议稿测试办法');
  importVersion(db, projectId, 'v1', oldContent);
  const r = importVersion(db, projectId, 'v2', newContent);
  return { db, comparisonId: r.comparisonId! };
}

function fragmentIdsByOrd(db: DB, comparisonId: number): number[] {
  return (
    db
      .prepare('SELECT id FROM fragments WHERE comparison_id = ? ORDER BY ord')
      .all(comparisonId) as Array<{ id: number }>
  ).map((f) => f.id);
}

function decide(db: DB, comparisonId: number, decisions: FragmentDecision[]) {
  const ids = fragmentIdsByOrd(db, comparisonId);
  assert.equal(ids.length, decisions.length, '测试前置：片段数与结论数不一致');
  decisions.forEach((d, i) => {
    const r = saveFragmentDecision(
      db,
      ids[i],
      d,
      d === 'deferred' ? `暂缓理由 #${i + 1}` : null,
      '审阅人甲'
    );
    assert.equal(r.status, 'ok');
  });
}

test('全部接受：决议稿正文等于新版全文，变更段来源为 accepted', () => {
  const oldC = ['第一条 甲。', '第二条 旧。', '第三条 丙。'].join('\n\n');
  const newC = ['第一条 甲。', '第二条 新。', '第四条 丁。'].join('\n\n');
  const { db, comparisonId } = makeComparison(oldC, newC);
  const frags = fragmentIdsByOrd(db, comparisonId);
  // 片段顺序：修改（第二条）、删除（第三条）、新增（第四条）
  decide(db, comparisonId, ['accepted', 'accepted', 'accepted']);
  const r = buildResolutionDraft(db, comparisonId);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.deepEqual(r.draft.paragraphs.map((p) => p.text), splitParagraphs(newC));
  assert.deepEqual(
    r.draft.paragraphs.map((p) => p.source),
    ['unchanged', 'accepted', 'accepted']
  );
  // 删除片段被接受 → 进入「未进入正文」清单
  assert.equal(r.draft.stats.omitted, 1);
  assert.equal(r.draft.omittedFragments[0].fragmentType, 'removed');
  // 段号连续
  assert.deepEqual(r.draft.paragraphs.map((p) => p.seq), [1, 2, 3]);
});

test('全部拒绝：决议稿正文恢复为旧版全文', () => {
  const oldC = ['第一条 甲。', '第二条 旧。', '第三条 丙。'].join('\n\n');
  const newC = ['第一条 甲。', '第二条 新。', '第四条 丁。'].join('\n\n');
  const { db, comparisonId } = makeComparison(oldC, newC);
  decide(db, comparisonId, ['rejected', 'rejected', 'rejected']);
  const r = buildResolutionDraft(db, comparisonId);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.deepEqual(r.draft.paragraphs.map((p) => p.text), splitParagraphs(oldC));
  assert.deepEqual(
    r.draft.paragraphs.map((p) => p.source),
    ['unchanged', 'rejected', 'rejected']
  );
  // 拒绝的新增片段不进入正文
  assert.equal(r.draft.stats.omitted, 1);
  assert.equal(r.draft.omittedFragments[0].fragmentType, 'added');
});

test('混合结论：拒绝修改取旧段、拒绝删除恢复旧段、接受新增取新段，且按文档顺序排列', () => {
  const oldC = ['第一条 甲。', '第二条 旧。', '第三条 丙。'].join('\n\n');
  const newC = ['第一条 甲。', '第二条 新。', '第四条 丁。'].join('\n\n');
  const { db, comparisonId } = makeComparison(oldC, newC);
  // 修改→拒绝；删除（第三条）→拒绝（恢复）；新增（第四条）→接受
  decide(db, comparisonId, ['rejected', 'rejected', 'accepted']);
  const r = buildResolutionDraft(db, comparisonId);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.deepEqual(r.draft.paragraphs.map((p) => p.text), ['第一条 甲。', '第二条 旧。', '第三条 丙。', '第四条 丁。']);
  assert.deepEqual(
    r.draft.paragraphs.map((p) => p.source),
    ['unchanged', 'rejected', 'rejected', 'accepted']
  );
});

test('相邻删除与新增：拒绝删除 + 接受新增时，恢复段与新增段都处于正确位置', () => {
  // P2 在新版删除，P3 平移，P4 新增 —— 必须靠序列位置而非字符串替换才能正确重建
  const oldC = ['P1。', 'P2。', 'P3。'].join('\n\n');
  const newC = ['P1。', 'P3。', 'P4。'].join('\n\n');
  const { db, comparisonId } = makeComparison(oldC, newC);
  // 片段：删除 P2、新增 P4
  decide(db, comparisonId, ['rejected', 'accepted']);
  const r = buildResolutionDraft(db, comparisonId);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.deepEqual(r.draft.paragraphs.map((p) => p.text), ['P1。', 'P2。', 'P3。', 'P4。']);
  assert.deepEqual(r.draft.paragraphs.map((p) => p.fragmentOrd), [null, 1, null, 2]);
  assert.equal(r.draft.stats.omitted, 0);
});

test('相邻删除与新增：接受删除 + 拒绝新增时两者都不进入正文', () => {
  const oldC = ['P1。', 'P2。', 'P3。'].join('\n\n');
  const newC = ['P1。', 'P3。', 'P4。'].join('\n\n');
  const { db, comparisonId } = makeComparison(oldC, newC);
  decide(db, comparisonId, ['accepted', 'rejected']);
  const r = buildResolutionDraft(db, comparisonId);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.deepEqual(r.draft.paragraphs.map((p) => p.text), ['P1。', 'P3。']);
  assert.equal(r.draft.omittedFragments.length, 2);
});

test('重复段落：依据位置区分，拒绝删除可恢复全部重复段', () => {
  const oldC = ['D 同文。', 'D 同文。'].join('\n\n');
  const newC = 'D 同文。';
  const { db, comparisonId } = makeComparison(oldC, newC);
  // 片段：删除第二个重复段（old_start = 2）
  assert.equal(fragmentIdsByOrd(db, comparisonId).length, 1);
  decide(db, comparisonId, ['rejected']);
  const r = buildResolutionDraft(db, comparisonId);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.deepEqual(r.draft.paragraphs.map((p) => p.text), ['D 同文。', 'D 同文。']);
  const restored = r.draft.paragraphs.find((p) => p.source === 'rejected');
  assert.ok(restored);
  assert.equal(restored!.oldIndex, 2);
});

test('重复段落：拒绝新增时只剔除位置对应的新增重复段', () => {
  const oldC = 'D 同文。';
  const newC = ['D 同文。', 'D 同文。'].join('\n\n');
  const { db, comparisonId } = makeComparison(oldC, newC);
  decide(db, comparisonId, ['rejected']);
  const r = buildResolutionDraft(db, comparisonId);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.deepEqual(r.draft.paragraphs.map((p) => p.text), ['D 同文。']);
  const omitted = r.draft.omittedFragments[0];
  assert.equal(omitted.fragmentType, 'added');
  assert.equal(omitted.newIndex, 2);
});

test('暂缓：修改/新增保留新版正文并入待办；暂缓删除无新版内容、不进正文但仍在待办', () => {
  const oldC = ['K1。', 'M 旧。', 'G 删。'].join('\n\n');
  const newC = ['K1。', 'M 新。', 'N 增。'].join('\n\n');
  const { db, comparisonId } = makeComparison(oldC, newC);
  // 片段顺序：修改 M、删除 G、新增 N
  decide(db, comparisonId, ['deferred', 'deferred', 'deferred']);
  const r = buildResolutionDraft(db, comparisonId);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.deepEqual(r.draft.paragraphs.map((p) => p.text), ['K1。', 'M 新。', 'N 增。']);
  assert.deepEqual(
    r.draft.paragraphs.map((p) => p.source),
    ['unchanged', 'deferred', 'deferred']
  );
  assert.equal(r.draft.deferredTodos.length, 3);
  assert.deepEqual(
    r.draft.deferredTodos.map((t) => t.fragmentOrd),
    [1, 2, 3]
  );
  const removedTodo = r.draft.deferredTodos.find((t) => t.fragmentType === 'removed')!;
  assert.equal(removedTodo.text, null);
  assert.equal(removedTodo.reason, '暂缓理由 #2');
  assert.equal(r.draft.omittedFragments.length, 1);
  assert.equal(r.draft.omittedFragments[0].fragmentType, 'removed');

  const md = toResolutionMarkdown(r.draft);
  assert.ok(md.includes('暂缓待办清单（3 项）'));
  assert.ok(md.includes('暂缓理由 #1'));
  assert.ok(md.includes('M 新。'));
  assert.ok(md.includes('段落来源对照'));
});

test('存在未结论片段时返回 blocked 并给出片段编号', () => {
  const oldC = ['第一条 甲。', '第二条 旧。'].join('\n\n');
  const newC = ['第一条 甲。', '第二条 新。'].join('\n\n');
  const { db, comparisonId } = makeComparison(oldC, newC);
  const r = buildResolutionDraft(db, comparisonId);
  assert.equal(r.status, 'blocked');
  if (r.status !== 'blocked') return;
  assert.deepEqual(r.undecidedOrds, [1]);
});

test('无差异的比对也可生成决议稿，正文为全部未变更段落', () => {
  const content = ['第一条 甲。', '第二条 乙。'].join('\n\n');
  const { db, comparisonId } = makeComparison(content, content);
  const r = buildResolutionDraft(db, comparisonId);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.deepEqual(r.draft.paragraphs.map((p) => p.text), ['第一条 甲。', '第二条 乙。']);
  assert.ok(r.draft.paragraphs.every((p) => p.source === 'unchanged'));
  assert.equal(r.draft.deferredTodos.length, 0);
});

test('比对不存在返回 not_found', () => {
  const db = openDb(':memory:');
  assert.equal(buildResolutionDraft(db, 99999).status, 'not_found');
});

test('每段带来源与对应片段编号、新旧段落号', () => {
  const oldC = ['第一条 甲。', '第二条 旧。', '第三条 丙。'].join('\n\n');
  const newC = ['第一条 甲。', '第二条 新。', '第四条 丁。'].join('\n\n');
  const { db, comparisonId } = makeComparison(oldC, newC);
  decide(db, comparisonId, ['accepted', 'rejected', 'accepted']);
  const r = buildResolutionDraft(db, comparisonId);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  const [p1, p2, p3, p4] = r.draft.paragraphs;
  assert.equal(p1.fragmentOrd, null);
  assert.deepEqual([p2.fragmentOrd, p2.oldIndex, p2.newIndex], [1, 2, 2]);
  assert.deepEqual([p3.fragmentOrd, p3.oldIndex, p3.newIndex], [2, 3, null]);
  assert.deepEqual([p4.fragmentOrd, p4.oldIndex, p4.newIndex], [3, null, 3]);
});

test('rebuildResolution 为纯重建：重复文本相同但位置不同时结果稳定', () => {
  const oldParas = ['X 重复文本。', 'Y 唯一旧。', 'X 重复文本。'];
  const newParas = ['X 重复文本。', 'Y 唯一新。', 'X 重复文本。'];
  // 手工构造片段（中间为修改），验证重建不靠字符串替换
  const fragments = [
    {
      ord: 1,
      type: 'changed' as const,
      old_text: 'Y 唯一旧。',
      new_text: 'Y 唯一新。',
      old_start: 2,
      new_start: 2,
      decision: 'rejected' as FragmentDecision,
      decision_reason: null,
      decided_by: null,
      decided_at: null,
    },
  ];
  const draft = rebuildResolution(oldParas, newParas, fragments, '2026-09-21 10:00:00');
  assert.deepEqual(draft.paragraphs.map((p) => p.text), [
    'X 重复文本。',
    'Y 唯一旧。',
    'X 重复文本。',
  ]);
  assert.deepEqual(
    draft.paragraphs.map((p) => [p.oldIndex, p.newIndex]),
    [[1, 1], [2, 2], [3, 3]]
  );
});

import type { DB } from './db';
import { splitParagraphs, diffSequences } from './diff';
import type { FragmentDecision } from './service';

/**
 * 决议稿生成：
 * 依据段落序列（diffSequences 输出的 equal/del/ins 操作）与片段位置
 *（fragments.old_start / new_start，均为 1 起始段落号）重建完整正文，
 * 全程按位置索引拼装，不做任何全局字符串替换，可正确处理相邻新增 / 删除 /
 * 修改以及重复段落（相同文本依靠下标区分）。
 *
 * 结论语义：
 *  - accepted（接受）：采用新版内容；
 *      added  ：新段保留
 *      removed：旧段不保留
 *      changed：取新段
 *  - rejected（拒绝）：恢复旧版内容；
 *      added  ：新段不保留
 *      removed：旧段保留
 *      changed：取旧段
 *  - deferred（暂缓）：保留新版内容，并在独立待办清单中列出暂缓理由；
 *      added  ：新段保留
 *      removed：旧版本就不在新版正文中，无可保留的新版内容 → 不保留（列入待办）
 *      changed：取新段
 */

export type ResolutionSource =
  | 'unchanged'
  | 'accepted'
  | 'rejected'
  | 'deferred';

export interface ResolutionParagraph {
  /** 决议稿中的段落序号（从 1 开始） */
  seq: number;
  /** 段落正文 */
  text: string;
  /** 段落来源 */
  source: ResolutionSource;
  /** 来源类型描述（未变更 / 接受新增 / 拒绝删除 / 暂缓修改 等） */
  sourceLabel: string;
  /** 对应的差异片段编号（未变更段落为 null） */
  fragmentOrd: number | null;
  /** 片段类型（未变更段落为 null） */
  fragmentType: 'added' | 'removed' | 'changed' | null;
  /** 新版段落号（1 起始，仅来自新版的段落有值） */
  newIndex: number | null;
  /** 旧版段落号（1 起始，仅来自旧版的段落有值） */
  oldIndex: number | null;
}

export interface ResolutionTodo {
  fragmentOrd: number;
  fragmentType: 'added' | 'removed' | 'changed';
  reason: string;
  decidedBy: string | null;
  decidedAt: string | null;
  /** 暂缓处理时留在决议稿正文中的段落（无正文则为 null，如暂缓的删除片段） */
  text: string | null;
  oldIndex: number | null;
  newIndex: number | null;
}

export interface ResolutionDraft {
  comparison: {
    id: number;
    projectName: string;
    oldLabel: string;
    newLabel: string;
    sealedBy: string | null;
    sealedAt: string | null;
    generatedAt: string;
  };
  /** 重建后的完整正文段落（按最终文档顺序） */
  paragraphs: ResolutionParagraph[];
  /** 拼接后的完整正文（段落以空行分隔） */
  body: string;
  /** 暂缓待办清单（按片段编号排序，含理由） */
  deferredTodos: ResolutionTodo[];
  /** 结论未采纳、未进入正文的片段（纯删除 + 拒绝的新增），供溯源附录使用 */
  omittedFragments: Array<{
    fragmentOrd: number;
    fragmentType: 'added' | 'removed' | 'changed';
    decision: FragmentDecision;
    text: string | null;
    oldIndex: number | null;
    newIndex: number | null;
  }>;
  stats: {
    paragraphs: number;
    unchanged: number;
    accepted: number;
    rejected: number;
    deferred: number;
    omitted: number;
  };
}

export type BuildResolutionResult =
  | { status: 'ok'; draft: ResolutionDraft }
  | { status: 'not_found' }
  | { status: 'blocked'; undecidedOrds: number[] };

interface FragmentRowForResolution {
  ord: number;
  type: 'added' | 'removed' | 'changed';
  old_text: string | null;
  new_text: string | null;
  old_start: number | null;
  new_start: number | null;
  decision: FragmentDecision | null;
  decision_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

const SOURCE_LABEL: Record<ResolutionSource, string> = {
  unchanged: '未变更',
  accepted: '接受（采用新版）',
  rejected: '拒绝（恢复旧版）',
  deferred: '暂缓（暂用新版）',
};

function buildFragmentMaps(fragments: FragmentRowForResolution[]) {
  // 以片段位置建索引（旧段落号 / 新段落号，1 起始），避免依赖全局文本匹配
  const byOld = new Map<number, FragmentRowForResolution>();
  const byNew = new Map<number, FragmentRowForResolution>();
  for (const f of fragments) {
    if (f.old_start != null) byOld.set(f.old_start, f);
    if (f.new_start != null) byNew.set(f.new_start, f);
  }
  return { byOld, byNew };
}

/**
 * 依据段落序列与片段结论重建决议正文。纯函数（不访问数据库），
 * oldParas / newParas 必须与生成片段时所用的段落数组完全一致
 *（服务层用 splitParagraphs 重新切分版本原文获得）。
 */
export function rebuildResolution(
  oldParas: string[],
  newParas: string[],
  fragments: FragmentRowForResolution[],
  generatedAt: string
): ResolutionDraft {
  const ops = diffSequences(oldParas, newParas);
  const { byOld, byNew } = buildFragmentMaps(fragments);

  const paragraphs: ResolutionParagraph[] = [];
  const deferredTodos: ResolutionTodo[] = [];
  const omittedFragments: ResolutionDraft['omittedFragments'] = [];
  const emitted = new Set<number>(); // 已发射的片段 ord（修改片段在 del 处发射一次，ins 跳过）

  const pushParagraph = (
    text: string,
    source: ResolutionSource,
    f: FragmentRowForResolution | null,
    oldIndex: number | null,
    newIndex: number | null
  ) => {
    paragraphs.push({
      seq: paragraphs.length + 1,
      text,
      source,
      sourceLabel: SOURCE_LABEL[source],
      fragmentOrd: f?.ord ?? null,
      fragmentType: f?.type ?? null,
      newIndex,
      oldIndex,
    });
  };

  for (const op of ops) {
    if (op.type === 'equal') {
      pushParagraph(newParas[op.newIndex], 'unchanged', null, op.oldIndex + 1, op.newIndex + 1);
      continue;
    }
    if (op.type === 'del') {
      const oldNo = op.oldIndex + 1;
      const f = byOld.get(oldNo);
      if (!f) {
        // 理论上不会发生：所有非 equal 的旧段落都应能在片段中找到；防御性保留旧版
        pushParagraph(oldParas[op.oldIndex], 'unchanged', null, oldNo, null);
        continue;
      }
      if (f.type === 'changed') {
        emitted.add(f.ord);
        if (f.decision === 'rejected') {
          // 拒绝修改 → 恢复旧版内容
          pushParagraph(f.old_text ?? oldParas[op.oldIndex], 'rejected', f, oldNo, f.new_start);
        } else {
          // 接受 / 暂缓修改 → 采用新版内容（暂缓另登记待办）
          pushParagraph(
            f.new_text ?? newParas[(f.new_start ?? 1) - 1],
            f.decision === 'deferred' ? 'deferred' : 'accepted',
            f,
            oldNo,
            f.new_start
          );
        }
      } else {
        // removed：接受删除 → 不保留；拒绝删除 → 恢复旧版；暂缓删除 → 无可保留的新版，不保留
        if (f.decision === 'rejected') {
          pushParagraph(f.old_text ?? oldParas[op.oldIndex], 'rejected', f, oldNo, null);
        } else {
          omittedFragments.push({
            fragmentOrd: f.ord,
            fragmentType: f.type,
            decision: f.decision!,
            text: f.old_text,
            oldIndex: oldNo,
            newIndex: null,
          });
        }
      }
      continue;
    }
    // ins
    const newNo = op.newIndex + 1;
    const f = byNew.get(newNo);
    if (!f) {
      // 理论上不会发生：防御性保留新版
      pushParagraph(newParas[op.newIndex], 'unchanged', null, null, newNo);
      continue;
    }
    // 修改片段已在其删除操作处发射，这里跳过
    if (f.type === 'changed') continue;
    // added：接受 / 暂缓 → 保留新版；拒绝新增 → 不保留
    if (f.decision === 'accepted' || f.decision === 'deferred') {
      pushParagraph(
        f.new_text ?? newParas[op.newIndex],
        f.decision === 'deferred' ? 'deferred' : 'accepted',
        f,
        f.old_start,
        newNo
      );
    } else {
      omittedFragments.push({
        fragmentOrd: f.ord,
        fragmentType: f.type,
        decision: f.decision!,
        text: f.new_text,
        oldIndex: null,
        newIndex: newNo,
      });
    }
  }

  // 暂缓待办清单（按片段编号排序），理由与片段内容来自结论记录
  const deferredFragments = fragments
    .filter((f) => f.decision === 'deferred')
    .sort((a, b) => a.ord - b.ord);
  for (const f of deferredFragments) {
    deferredTodos.push({
      fragmentOrd: f.ord,
      fragmentType: f.type,
      reason: f.decision_reason ?? '',
      decidedBy: f.decided_by,
      decidedAt: f.decided_at,
      // 暂缓项正文保留新版；纯删除片段没有新版内容，正文为 null
      text: f.new_text ?? null,
      oldIndex: f.old_start,
      newIndex: f.new_start,
    });
  }

  const stats = {
    paragraphs: paragraphs.length,
    unchanged: 0,
    accepted: 0,
    rejected: 0,
    deferred: 0,
    omitted: omittedFragments.length,
  };
  for (const p of paragraphs) stats[p.source]++;

  return {
    comparison: {
      id: 0,
      projectName: '',
      oldLabel: '',
      newLabel: '',
      sealedBy: null,
      sealedAt: null,
      generatedAt,
    },
    paragraphs,
    body: paragraphs.map((p) => p.text).join('\n\n'),
    deferredTodos,
    omittedFragments: omittedFragments.sort((a, b) => a.fragmentOrd - b.fragmentOrd),
    stats,
  };
}

/** 从数据库读取比对数据并生成决议稿；存在未结论片段时返回 blocked */
export function buildResolutionDraft(db: DB, comparisonId: number): BuildResolutionResult {
  const cmp = db
    .prepare(
      `SELECT c.id, c.sealed_by, c.sealed_at,
              p.name AS project_name,
              ov.label AS old_label,
              nv.label AS new_label,
              ov.content AS old_content,
              nv.content AS new_content
         FROM comparisons c
         JOIN projects p ON p.id = c.project_id
         JOIN versions ov ON ov.id = c.old_version_id
         JOIN versions nv ON nv.id = c.new_version_id
        WHERE c.id = ?`
    )
    .get(comparisonId) as
    | {
        id: number;
        sealed_by: string | null;
        sealed_at: string | null;
        project_name: string;
        old_label: string;
        new_label: string;
        old_content: string;
        new_content: string;
      }
    | undefined;
  if (!cmp) return { status: 'not_found' };

  const fragments = db
    .prepare('SELECT * FROM fragments WHERE comparison_id = ? ORDER BY ord')
    .all(comparisonId) as FragmentRowForResolution[];

  const undecidedOrds = fragments.filter((f) => f.decision == null).map((f) => f.ord);
  if (undecidedOrds.length > 0) {
    return { status: 'blocked', undecidedOrds: undecidedOrds.sort((a, b) => a - b) };
  }

  const oldParas = splitParagraphs(cmp.old_content);
  const newParas = splitParagraphs(cmp.new_content);
  const generatedAt = new Date()
    .toLocaleString('sv-SE', { hour12: false })
    .replace('T', ' ')
    .slice(0, 19);

  const draft = rebuildResolution(oldParas, newParas, fragments, generatedAt);
  draft.comparison = {
    id: cmp.id,
    projectName: cmp.project_name,
    oldLabel: cmp.old_label,
    newLabel: cmp.new_label,
    sealedBy: cmp.sealed_by,
    sealedAt: cmp.sealed_at,
    generatedAt,
  };
  return { status: 'ok', draft };
}

/** 决议稿 JSON（蛇形命名，与其余接口风格一致），供页面预览 */
export function resolutionDraftToJson(draft: ResolutionDraft): Record<string, unknown> {
  return {
    comparison: {
      id: draft.comparison.id,
      project_name: draft.comparison.projectName,
      old_label: draft.comparison.oldLabel,
      new_label: draft.comparison.newLabel,
      sealed_by: draft.comparison.sealedBy,
      sealed_at: draft.comparison.sealedAt,
      generated_at: draft.comparison.generatedAt,
    },
    paragraphs: draft.paragraphs.map((p) => ({
      seq: p.seq,
      text: p.text,
      source: p.source,
      source_label: p.sourceLabel,
      fragment_ord: p.fragmentOrd,
      fragment_type: p.fragmentType,
      new_index: p.newIndex,
      old_index: p.oldIndex,
    })),
    body: draft.body,
    deferred_todos: draft.deferredTodos.map((t) => ({
      fragment_ord: t.fragmentOrd,
      fragment_type: t.fragmentType,
      reason: t.reason,
      decided_by: t.decidedBy,
      decided_at: t.decidedAt,
      text: t.text,
      old_index: t.oldIndex,
      new_index: t.newIndex,
    })),
    omitted_fragments: draft.omittedFragments.map((o) => ({
      fragment_ord: o.fragmentOrd,
      fragment_type: o.fragmentType,
      decision: o.decision,
      text: o.text,
      old_index: o.oldIndex,
      new_index: o.newIndex,
    })),
    stats: draft.stats,
  };
}

const TYPE_LABEL: Record<string, string> = { added: '新增', removed: '删除', changed: '修改' };

function paraPos(p: { oldIndex: number | null; newIndex: number | null }): string {
  return [p.oldIndex != null ? `旧¶${p.oldIndex}` : null, p.newIndex != null ? `新¶${p.newIndex}` : null]
    .filter(Boolean)
    .join(' → ');
}

/** 把决议稿渲染为 UTF-8 Markdown：正文段落带来源标记，末尾附暂缓待办清单与来源对照附录 */
export function toResolutionMarkdown(draft: ResolutionDraft): string {
  const c = draft.comparison;
  const lines: string[] = [];
  lines.push(`# 决议稿：${c.projectName}`);
  lines.push('');
  lines.push(`- 版本对比：\`${c.oldLabel}\` → \`${c.newLabel}\``);
  lines.push(`- 生成时间：${c.generatedAt}`);
  lines.push(
    `- 封存状态：${
      c.sealedAt != null ? `**已封存**（封存人：${c.sealedBy || '（未署名）'} · ${c.sealedAt}）` : '草稿（未封存）'
    }`
  );
  lines.push(
    `- 正文统计：共 ${draft.stats.paragraphs} 段（未变更 ${draft.stats.unchanged} · 接受 ${draft.stats.accepted} · 拒绝 ${draft.stats.rejected} · 暂缓 ${draft.stats.deferred}），另有 ${draft.stats.omitted} 个片段未进入正文`
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 决议正文');
  lines.push('');
  lines.push('> 段落前标记含义：🟢 接受（采用新版） · 🔴 拒绝（恢复旧版） · 🟠 暂缓（暂用新版）；无标记段落为未变更内容。');
  lines.push('');

  const marker = (p: ResolutionParagraph): string => {
    if (p.source === 'accepted') return `🟢 [接受 · 片段 #${p.fragmentOrd}（${TYPE_LABEL[p.fragmentType ?? '']}）] `;
    if (p.source === 'rejected') return `🔴 [拒绝 · 片段 #${p.fragmentOrd}（${TYPE_LABEL[p.fragmentType ?? '']}）] `;
    if (p.source === 'deferred') return `🟠 [暂缓 · 片段 #${p.fragmentOrd}（${TYPE_LABEL[p.fragmentType ?? '']}）] `;
    return '';
  };

  for (const p of draft.paragraphs) {
    lines.push(`${marker(p)}${p.text}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`## 暂缓待办清单（${draft.deferredTodos.length} 项）`);
  lines.push('');
  if (draft.deferredTodos.length === 0) {
    lines.push('_无暂缓事项。_');
  } else {
    draft.deferredTodos.forEach((t, i) => {
      lines.push(
        `${i + 1}. **片段 #${t.fragmentOrd}（${TYPE_LABEL[t.fragmentType]}）** — ${paraPos(t)}`
      );
      lines.push(`   - 暂缓理由：${t.reason}`);
      const who = t.decidedBy
        ? `提出人：${t.decidedBy}${t.decidedAt ? ` · ${t.decidedAt}` : ''}`
        : '提出人：（未署名）';
      lines.push(`   - ${who}`);
      if (t.text != null) {
        lines.push(`   - 当前正文（暂用新版）：`);
        lines.push(`     > ${t.text.replace(/\n/g, '\n     > ')}`);
      } else {
        lines.push(`   - 当前正文：未保留（该片段为删除项，无新版内容）`);
      }
    });
  }
  lines.push('');

  if (draft.omittedFragments.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push(`## 未进入正文的片段（${draft.omittedFragments.length} 个）`);
    lines.push('');
    lines.push('| 片段 | 类型 | 结论 | 位置 | 内容 |');
    lines.push('| --- | --- | --- | --- | --- |');
    const escCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    for (const o of draft.omittedFragments) {
      lines.push(
        `| #${o.fragmentOrd} | ${TYPE_LABEL[o.fragmentType]} | ${
          o.decision === 'accepted' ? '接受' : '暂缓'
        } | ${paraPos(o)} | ${escCell(o.text ?? '')} |`
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 段落来源对照');
  lines.push('');
  lines.push('| 段号 | 来源 | 片段 | 位置 |');
  lines.push('| --- | --- | --- | --- |');
  for (const p of draft.paragraphs) {
    lines.push(
      `| ${p.seq} | ${p.sourceLabel} | ${p.fragmentOrd != null ? `#${p.fragmentOrd}（${TYPE_LABEL[p.fragmentType ?? '']}）` : '—'} | ${paraPos(p) || '—'} |`
    );
  }
  lines.push('');

  return lines.join('\n');
}

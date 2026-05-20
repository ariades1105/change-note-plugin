// Figma 문서의 정보를 다루는 메인 코드
// 이 파일 안에서는 `figma` 전역 객체를 통해 현재 페이지, 선택된 노드 등에 접근할 수 있다.

figma.showUI(__html__, {
  width: 592,
  height: 755,
});

const LOG_PAGE_NAME = 'chAInge.note Logs';
const SNAPSHOT_STORAGE_KEY = 'change-note-snapshots';
const MAX_SNAPSHOTS = 10;

type TextEntry = {
  text: string;
  nodeId: string;
};

type Snapshot = {
  id: string;
  createdAt: string;
  frameName: string;
  memo: string;
  texts: string[];
  textEntries?: TextEntry[];
  containerNodeId?: string;
};

type LogSnapshotRef = {
  createdAt: string;
  frameName: string;
  memo: string;
};

type CompareResult = {
  summary: string;
  snapshotA: LogSnapshotRef;
  snapshotB: LogSnapshotRef;
  added: string[];
  changed: { before: string; after: string }[];
  deleted: string[];
};

// 선택한 "컨테이너"(프레임/그룹/섹션 등) 안의 텍스트들을 모은다.
function collectTextEntries(container: SceneNode): TextEntry[] {
  const entries: TextEntry[] = [];

  function walk(node: SceneNode) {
    if (node.type === 'TEXT') {
      entries.push({ text: (node as TextNode).characters, nodeId: node.id });
    } else if ('children' in node) {
      for (const child of node.children as readonly SceneNode[]) {
        walk(child);
      }
    }
  }

  walk(container);
  return entries;
}

function normalizeSnapshot(item: Snapshot): Snapshot {
  if (Array.isArray(item.textEntries) && item.textEntries.length > 0) {
    return item;
  }

  return {
    id: item.id,
    createdAt: item.createdAt,
    frameName: item.frameName,
    memo: item.memo,
    texts: item.texts || [],
    textEntries: (item.texts || []).map((text) => ({ text, nodeId: '' })),
    containerNodeId: item.containerNodeId,
  };
}

async function focusTextNode(nodeId: string): Promise<void> {
  if (!nodeId) {
    throw new Error('이 스냅샷에는 위치 정보가 없어요. 프레임을 다시 저장해주세요.');
  }

  await figma.loadAllPagesAsync();
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || node.removed || node.type !== 'TEXT') {
    throw new Error('텍스트 레이어를 찾지 못했어요. 삭제되었거나 문서에서 이동했을 수 있어요.');
  }

  let parent: BaseNode | null = node.parent;
  while (parent && parent.type !== 'PAGE') {
    parent = parent.parent;
  }
  if (parent && parent.type === 'PAGE') {
    await figma.setCurrentPageAsync(parent);
  }

  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

function formatDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}.${month}.${day} ${hours}:${minutes}:${seconds}`;
}

async function loadSnapshots(): Promise<Snapshot[]> {
  const saved = await figma.clientStorage.getAsync(SNAPSHOT_STORAGE_KEY);
  if (!Array.isArray(saved)) return [];

  return saved
    .filter((item): item is Snapshot => {
      return (
        item &&
        typeof item.id === 'string' &&
        typeof item.createdAt === 'string' &&
        typeof item.frameName === 'string' &&
        typeof item.memo === 'string' &&
        Array.isArray(item.texts)
      );
    })
    .map(normalizeSnapshot);
}

async function saveSnapshots(snapshots: Snapshot[]): Promise<void> {
  await figma.clientStorage.setAsync(SNAPSHOT_STORAGE_KEY, snapshots.slice(0, MAX_SNAPSHOTS));
}

async function saveCurrentSnapshot(memo: string): Promise<Snapshot> {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    throw new Error('아무 것도 선택되지 않았어요. 프레임을 하나 선택해주세요.');
  }

  const target = selection[0];
  if (!('children' in target) && target.type !== 'TEXT') {
    throw new Error('텍스트가 들어있는 프레임, 그룹, 섹션 또는 텍스트 레이어를 선택해야 해요.');
  }

  const textEntries =
    target.type === 'TEXT'
      ? [{ text: target.characters, nodeId: target.id }]
      : collectTextEntries(target);
  if (textEntries.length === 0) {
    throw new Error('선택한 프레임 안에서 텍스트를 찾지 못했어요.');
  }

  const snapshot: Snapshot = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    frameName: target.name || '이름 없는 프레임',
    memo: memo.trim(),
    texts: textEntries.map((entry) => entry.text),
    textEntries,
    containerNodeId: target.id,
  };

  const snapshots = await loadSnapshots();
  const nextSnapshots = snapshots.slice();
  nextSnapshots.unshift(snapshot);
  await saveSnapshots(nextSnapshots);
  return snapshot;
}

async function getOrCreateLogPage(): Promise<PageNode> {
  await figma.loadAllPagesAsync();
  const existing = figma.root.children.find((p) => p.type === 'PAGE' && p.name === LOG_PAGE_NAME);
  if (existing && existing.type === 'PAGE') return existing;

  const page = figma.createPage();
  page.name = LOG_PAGE_NAME;
  return page;
}

function getNextY(page: PageNode): number {
  if (page.children.length === 0) return 120;
  let maxBottom = 0;
  for (const node of page.children) {
    const bottom = node.y + node.height;
    if (bottom > maxBottom) maxBottom = bottom;
  }
  return maxBottom + 80;
}

function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}.${month}.${day}`;
}

type DiffSegment = {
  text: string;
  color?: RGB;
  strike?: boolean;
};

function buildInlineDiffSegments(beforeLine: string, afterLine: string): {
  beforeSegments: DiffSegment[];
  afterSegments: DiffSegment[];
} {
  if (beforeLine === afterLine) {
    return {
      beforeSegments: [{ text: beforeLine }],
      afterSegments: [{ text: afterLine }],
    };
  }

  let start = 0;
  const minLen = Math.min(beforeLine.length, afterLine.length);
  while (start < minLen && beforeLine[start] === afterLine[start]) start += 1;

  let endBefore = beforeLine.length - 1;
  let endAfter = afterLine.length - 1;
  while (endBefore >= start && endAfter >= start && beforeLine[endBefore] === afterLine[endAfter]) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const beforePrefix = beforeLine.slice(0, start);
  const beforeChanged = beforeLine.slice(start, endBefore + 1);
  const beforeSuffix = beforeLine.slice(endBefore + 1);

  const afterPrefix = afterLine.slice(0, start);
  const afterChanged = afterLine.slice(start, endAfter + 1);
  const afterSuffix = afterLine.slice(endAfter + 1);

  return {
    beforeSegments: [
      { text: beforePrefix },
      { text: beforeChanged, color: { r: 0.71, g: 0.14, b: 0.09 }, strike: true },
      { text: beforeSuffix },
    ].filter((segment) => segment.text.length > 0),
    afterSegments: [
      { text: afterPrefix },
      { text: afterChanged, color: { r: 0.12, g: 0.48, b: 0.12 } },
      { text: afterSuffix },
    ].filter((segment) => segment.text.length > 0),
  };
}

async function createLogCard(payload: CompareResult): Promise<void> {
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

  const page = await getOrCreateLogPage();
  const y = getNextY(page);

  const frame = figma.createFrame();
  const now = new Date();
  const nowDate = formatDateOnly(now);
  frame.name = `로그 ${nowDate}`;
  frame.resize(920, 100);
  frame.x = 120;
  frame.y = y;
  frame.layoutMode = 'VERTICAL';
  frame.counterAxisSizingMode = 'FIXED';
  frame.primaryAxisSizingMode = 'AUTO';
  frame.counterAxisAlignItems = 'MIN';
  frame.itemSpacing = 12;
  frame.paddingLeft = 16;
  frame.paddingRight = 16;
  frame.paddingTop = 12;
  frame.paddingBottom = 12;
  frame.cornerRadius = 8;
  frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  frame.strokes = [{ type: 'SOLID', color: { r: 0.87, g: 0.87, b: 0.87 } }]; // #dedede

  const LOG_COLORS = {
    boxBg: { r: 0.98, g: 0.98, b: 0.98 }, // #fafafa
    boxBorder: { r: 0.92, g: 0.92, b: 0.92 }, // #ebebeb
    text: { r: 0.11, g: 0.11, b: 0.11 }, // #1c1c1c
    del: { r: 0.71, g: 0.14, b: 0.09 }, // #b52417
    add: { r: 0.12, g: 0.48, b: 0.12 }, // #1f7a1f
  };

  function makeCell(text: string, width: number, bold = false, size = 12): TextNode {
    const t = figma.createText();
    t.fontName = { family: 'Inter', style: bold ? 'Bold' : 'Regular' };
    t.fontSize = size;
    t.characters = text;
    t.layoutSizingHorizontal = 'FIXED';
    t.resize(width, t.height);
    t.textAutoResize = 'HEIGHT';
    return t;
  }

  function makeStyledText(segments: DiffSegment[], width: number): TextNode {
    const t = figma.createText();
    t.fontName = { family: 'Inter', style: 'Regular' };
    t.fontSize = 12;
    t.layoutSizingHorizontal = 'FIXED';
    t.resize(width, 10);
    t.textAutoResize = 'HEIGHT';
    const safeSegments = segments.length > 0 ? segments : [{ text: '' }];
    const fullText = safeSegments.map((segment) => segment.text).join('');
    t.characters = fullText;

    if (fullText.length > 0) {
      t.setRangeFills(0, fullText.length, [{ type: 'SOLID', color: LOG_COLORS.text }]);
    }

    let cursor = 0;
    for (const segment of safeSegments) {
      if (!segment.text) continue;
      const end = cursor + segment.text.length;
      if (segment.color) {
        t.setRangeFills(cursor, end, [{ type: 'SOLID', color: segment.color }]);
      }
      if (segment.strike) {
        t.setRangeTextDecoration(cursor, end, 'STRIKETHROUGH');
      }
      cursor = end;
    }

    return t;
  }

  function makeInfoBox(title: string, body: string): FrameNode {
    const box = figma.createFrame();
    box.layoutMode = 'VERTICAL';
    box.primaryAxisSizingMode = 'AUTO';
    box.counterAxisSizingMode = 'FIXED';
    box.itemSpacing = 8;
    box.paddingLeft = 12;
    box.paddingRight = 12;
    box.paddingTop = 12;
    box.paddingBottom = 12;
    box.resize(424, 100);
    box.cornerRadius = 6;
    box.fills = [{ type: 'SOLID', color: LOG_COLORS.boxBg }];
    box.strokes = [{ type: 'SOLID', color: LOG_COLORS.boxBorder }];
    box.appendChild(makeCell(title, 400, true));
    box.appendChild(makeCell(body, 400));
    return box;
  }

  function formatSnapshotLine(snapshot: LogSnapshotRef): string {
    const date = formatDateTime(new Date(snapshot.createdAt));
    const memo = snapshot.memo.trim();
    if (memo && memo !== snapshot.frameName) {
      return `${memo} | ${snapshot.frameName} | ${date}`;
    }
    return `${snapshot.frameName} | ${date}`;
  }

  function makeDiffCard(beforeSegments: DiffSegment[], afterSegments: DiffSegment[]): FrameNode {
    const card = figma.createFrame();
    card.layoutMode = 'VERTICAL';
    card.primaryAxisSizingMode = 'AUTO';
    card.counterAxisSizingMode = 'FIXED';
    card.itemSpacing = 6;
    card.paddingLeft = 12;
    card.paddingRight = 12;
    card.paddingTop = 12;
    card.paddingBottom = 12;
    card.resize(860, 100);
    card.cornerRadius = 6;
    card.fills = [{ type: 'SOLID', color: LOG_COLORS.boxBg }];
    card.strokes = [{ type: 'SOLID', color: LOG_COLORS.boxBorder }];
    card.appendChild(makeCell('Before', 836, true, 11));
    card.appendChild(makeStyledText(beforeSegments, 836));
    card.appendChild(makeCell('After', 836, true, 11));
    card.appendChild(makeStyledText(afterSegments, 836));
    return card;
  }

  function makeSectionTitle(title: string): TextNode {
    return makeCell(title, 860, true, 13);
  }

  frame.appendChild(makeCell(`[${formatDateTime(now)}]`, 860, true, 14));
  frame.appendChild(makeCell(`비교 요약: ${payload.summary}`, 860, true));

  const compareInfoFrame = figma.createFrame();
  compareInfoFrame.layoutMode = 'HORIZONTAL';
  compareInfoFrame.primaryAxisSizingMode = 'FIXED';
  compareInfoFrame.counterAxisSizingMode = 'AUTO';
  compareInfoFrame.counterAxisAlignItems = 'MIN';
  compareInfoFrame.itemSpacing = 12;
  compareInfoFrame.fills = [];
  compareInfoFrame.strokes = [];
  compareInfoFrame.resize(860, 100);
  compareInfoFrame.appendChild(makeInfoBox('비교 대상 A', formatSnapshotLine(payload.snapshotA)));
  compareInfoFrame.appendChild(makeInfoBox('비교 대상 B', formatSnapshotLine(payload.snapshotB)));
  frame.appendChild(compareInfoFrame);

  if (payload.added.length > 0) {
    frame.appendChild(makeSectionTitle(`추가 ${payload.added.length}건`));
    for (const line of payload.added) {
      frame.appendChild(makeDiffCard([], [{ text: line, color: LOG_COLORS.add }]));
    }
  }
  if (payload.changed.length > 0) {
    frame.appendChild(makeSectionTitle(`변경 ${payload.changed.length}건`));
    for (const item of payload.changed) {
      const segments = buildInlineDiffSegments(item.before, item.after);
      frame.appendChild(makeDiffCard(segments.beforeSegments, segments.afterSegments));
    }
  }
  if (payload.deleted.length > 0) {
    frame.appendChild(makeSectionTitle(`삭제 ${payload.deleted.length}건`));
    for (const line of payload.deleted) {
      frame.appendChild(makeDiffCard([{ text: line, color: LOG_COLORS.del, strike: true }], []));
    }
  }

  page.appendChild(frame);
}

// UI(html)에서 보내는 메시지를 받는 부분
figma.ui.onmessage = async (
  msg: {
    type: string;
    memo?: string;
    nodeId?: string;
    width?: number;
    height?: number;
    payload?: CompareResult;
  }
) => {
  if (msg.type === 'resize-ui') {
    const width = typeof msg.width === 'number' ? msg.width : 400;
    const height = typeof msg.height === 'number' ? msg.height : 200;
    figma.ui.resize(width, Math.max(120, Math.min(Math.round(height), 1200)));
    return;
  }

  if (msg.type === 'save-snapshot') {
    try {
      const snapshot = await saveCurrentSnapshot(msg.memo || '');
      figma.ui.postMessage({
        type: 'save-snapshot-result',
        ok: true,
        snapshot,
        snapshots: await loadSnapshots(),
        message: `"${snapshot.frameName}" 스냅샷을 저장했어요.`,
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'save-snapshot-result',
        ok: false,
        message: error instanceof Error ? error.message : '스냅샷 저장 중 오류가 발생했어요.',
      });
    }
  }

  if (msg.type === 'get-snapshots') {
    try {
      figma.ui.postMessage({
        type: 'snapshots-loaded',
        snapshots: await loadSnapshots(),
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'snapshots-loaded',
        snapshots: [],
        message:
          error instanceof Error ? error.message : '스냅샷 목록을 불러오지 못했어요.',
      });
    }
  }

  if (msg.type === 'focus-text-node') {
    try {
      await focusTextNode(msg.nodeId || '');
      figma.ui.postMessage({
        type: 'focus-text-node-result',
        ok: true,
        message: '해당 텍스트 레이어로 이동했어요.',
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'focus-text-node-result',
        ok: false,
        message: error instanceof Error ? error.message : '레이어로 이동하지 못했어요.',
      });
    }
  }

  if (msg.type === 'save-log') {
    try {
      if (!msg.payload) {
        throw new Error('저장할 결과 정보가 없어요.');
      }
      await createLogCard(msg.payload);
      figma.ui.postMessage({
        type: 'save-log-result',
        ok: true,
        message: `"${LOG_PAGE_NAME}" 페이지에 로그를 기록했어요.`,
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'save-log-result',
        ok: false,
        message: error instanceof Error ? error.message : '로그 저장 중 오류가 발생했어요.',
      });
    }
  }
};

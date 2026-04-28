// Figma 문서의 정보를 다루는 메인 코드
// 이 파일 안에서는 `figma` 전역 객체를 통해 현재 페이지, 선택된 노드 등에 접근할 수 있다.

figma.showUI(__html__, {
  width: 420,
  height: 640,
});

const LOG_PAGE_NAME = 'chAInge.note Logs';
const SNAPSHOT_STORAGE_KEY = 'change-note-snapshots';
const MAX_SNAPSHOTS = 10;

type Snapshot = {
  id: string;
  createdAt: string;
  frameName: string;
  memo: string;
  texts: string[];
};

type CompareResult = {
  summary: string;
  snapshotA: Snapshot;
  snapshotB: Snapshot;
  added: string[];
  changed: { before: string; after: string }[];
  deleted: string[];
};

// 선택한 "컨테이너"(프레임/그룹/섹션 등) 안의 텍스트들을 모은다.
function collectTextInContainer(container: SceneNode): string[] {
  const texts: string[] = [];

  function walk(node: SceneNode) {
    if (node.type === 'TEXT') {
      texts.push((node as TextNode).characters);
    } else if ('children' in node) {
      for (const child of node.children as readonly SceneNode[]) {
        walk(child);
      }
    }
  }

  walk(container);
  return texts;
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

  return saved.filter((item): item is Snapshot => {
    return (
      item &&
      typeof item.id === 'string' &&
      typeof item.createdAt === 'string' &&
      typeof item.frameName === 'string' &&
      typeof item.memo === 'string' &&
      Array.isArray(item.texts)
    );
  });
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

  const texts = target.type === 'TEXT' ? [target.characters] : collectTextInContainer(target);
  if (texts.length === 0) {
    throw new Error('선택한 프레임 안에서 텍스트를 찾지 못했어요.');
  }

  const snapshot: Snapshot = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    frameName: target.name || '이름 없는 프레임',
    memo: memo.trim(),
    texts,
  };

  const snapshots = await loadSnapshots();
  await saveSnapshots([snapshot, ...snapshots]);
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

function joinTexts(texts: string[]): string {
  return texts.join('\n');
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
  frame.strokes = [{ type: 'SOLID', color: { r: 0.87, g: 0.87, b: 0.87 } }];

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
      t.setRangeFills(0, fullText.length, [{ type: 'SOLID', color: { r: 0.11, g: 0.11, b: 0.11 } }]);
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

  function makeInfoBox(title: string, body: string, detail?: string): FrameNode {
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
    box.fills = [{ type: 'SOLID', color: { r: 0.98, g: 0.98, b: 0.98 } }];
    box.strokes = [{ type: 'SOLID', color: { r: 0.92, g: 0.92, b: 0.92 } }];
    box.appendChild(makeCell(title, 400, true));
    box.appendChild(makeCell(body, 400));
    if (detail) {
      const detailText = makeCell(detail, 400, false, 11);
      detailText.fills = [{ type: 'SOLID', color: { r: 0.45, g: 0.45, b: 0.45 } }];
      box.appendChild(detailText);
    }
    return box;
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
    card.fills = [{ type: 'SOLID', color: { r: 0.98, g: 0.98, b: 0.98 } }];
    card.strokes = [{ type: 'SOLID', color: { r: 0.92, g: 0.92, b: 0.92 } }];
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
  compareInfoFrame.appendChild(
    makeInfoBox(
      '비교 대상 A',
      `${payload.snapshotA.memo || payload.snapshotA.frameName} | ${payload.snapshotA.frameName} | ${formatDateTime(
        new Date(payload.snapshotA.createdAt)
      )}`,
      joinTexts(payload.snapshotA.texts)
    )
  );
  compareInfoFrame.appendChild(
    makeInfoBox(
      '비교 대상 B',
      `${payload.snapshotB.memo || payload.snapshotB.frameName} | ${payload.snapshotB.frameName} | ${formatDateTime(
        new Date(payload.snapshotB.createdAt)
      )}`,
      joinTexts(payload.snapshotB.texts)
    )
  );
  frame.appendChild(compareInfoFrame);

  if (payload.added.length > 0) {
    frame.appendChild(makeSectionTitle(`추가 ${payload.added.length}건`));
    for (const line of payload.added) {
      frame.appendChild(makeDiffCard([], [{ text: line, color: { r: 0.12, g: 0.48, b: 0.12 } }]));
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
      frame.appendChild(makeDiffCard([{ text: line, color: { r: 0.71, g: 0.14, b: 0.09 }, strike: true }], []));
    }
  }

  page.appendChild(frame);
}

// UI(html)에서 보내는 메시지를 받는 부분
figma.ui.onmessage = async (
  msg: { type: string; memo?: string; payload?: CompareResult }
) => {
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
    figma.ui.postMessage({
      type: 'snapshots-loaded',
      snapshots: await loadSnapshots(),
    });
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

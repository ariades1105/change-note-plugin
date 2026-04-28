// Figma 문서의 정보를 다루는 메인 코드
// 이 파일 안에서는 `figma` 전역 객체를 통해 현재 페이지, 선택된 노드 등에 접근할 수 있다.

figma.showUI(__html__, {
  width: 400,
  height: 500,
});

const LOG_PAGE_NAME = '📋 chAInge.note';

type SaveLogPayload = {
  summary: string;
  intent: string;
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

function getOrCreateLogPage(): PageNode {
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

async function createLogCard(payload: SaveLogPayload): Promise<void> {
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

  const page = getOrCreateLogPage();
  const y = getNextY(page);

  const frame = figma.createFrame();
  const nowDate = formatDateOnly(new Date());
  frame.name = `로그 ${nowDate}`;
  frame.resize(960, 96);
  frame.x = 120;
  frame.y = y;
  frame.layoutMode = 'HORIZONTAL';
  frame.counterAxisSizingMode = 'AUTO';
  frame.primaryAxisSizingMode = 'FIXED';
  frame.counterAxisAlignItems = 'CENTER';
  frame.itemSpacing = 12;
  frame.paddingLeft = 16;
  frame.paddingRight = 16;
  frame.paddingTop = 12;
  frame.paddingBottom = 12;
  frame.cornerRadius = 8;
  frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  frame.strokes = [{ type: 'SOLID', color: { r: 0.87, g: 0.87, b: 0.87 } }];

  function makeCell(text: string, width: number, bold = false): TextNode {
    const t = figma.createText();
    t.fontName = { family: 'Inter', style: bold ? 'Bold' : 'Regular' };
    t.fontSize = 12;
    t.characters = text;
    t.layoutSizingHorizontal = 'FIXED';
    t.resize(width, t.height);
    t.textAutoResize = 'HEIGHT';
    return t;
  }

  frame.appendChild(makeCell(`[${nowDate}]`, 220, true));
  frame.appendChild(makeCell(`[${payload.summary}]`, 260, true));
  frame.appendChild(makeCell(`[${payload.intent}]`, 430, false));

  page.appendChild(frame);
}

// UI(html)에서 보내는 메시지를 받는 부분
figma.ui.onmessage = async (
  msg: { type: string; target?: 'before' | 'after'; payload?: SaveLogPayload }
) => {
  if (msg.type === 'get-selected-text') {
    const selection = figma.currentPage.selection;
    const targetKey = msg.target;

    if (selection.length === 0) {
      figma.ui.postMessage({
        type: 'selected-text',
        error: '아무 것도 선택되지 않았어요. 프레임을 하나 선택해주세요.',
        texts: [],
        target: targetKey,
      });
      return;
    }

    const target = selection[0];

    // 1) 텍스트 레이어를 선택했다면: 그 텍스트 1개만 UI로 보낸다.
    if (target.type === 'TEXT') {
      figma.ui.postMessage({
        type: 'selected-text',
        texts: [(target as TextNode).characters],
        target: targetKey,
      });
      return;
    }

    // 2) 프레임/그룹/섹션 등 "자식이 있는 컨테이너"를 선택했다면: 내부의 모든 텍스트를 모아서 보낸다.
    if (!('children' in target)) {
      figma.ui.postMessage({
        type: 'selected-text',
        error: '프레임/그룹/섹션 또는 텍스트 레이어를 선택해야 해요.',
        texts: [],
        target: targetKey,
      });
      return;
    }

    const texts = collectTextInContainer(target);

    figma.ui.postMessage({
      type: 'selected-text',
      texts,
      target: targetKey,
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

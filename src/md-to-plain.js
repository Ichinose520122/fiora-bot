// 把 agent 的 Markdown 回复转成适合 QQ 发送的纯文本。（移植自 qq-bridge src/md-to-plain.js）

export function mdToPlain(md) {
  let s = String(md ?? '');
  // 代码块：保留内容，去掉围栏
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, body) => body.replace(/\n+$/, ''));
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 图片/链接：保留文字，链接附在括号里（QQ 可点）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => (alt || url));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
  // 粗体/斜体/删除线标记
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  // 标题符
  s = s.replace(/^#{1,6}\s+/gm, '');
  // 引用符
  s = s.replace(/^>\s?/gm, '');
  // 列表符
  s = s.replace(/^\s*[-*+]\s+/gm, '• ');
  // 表格：按行保留文本
  s = s.split('\n').filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || line.includes('|') === false || /\S/.test(line.replace(/[\s:|-]/g, ''))).join('\n');
  s = s.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '');
  // 折叠的连续空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 按 UTF-16 码元数切分，保留换行与代理对。max=1 时完整代理对仍占 2 个码元。 */
export function splitForQQ(text, max = 4000) {
  const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 4000;
  const parts = [];
  let rest = String(text ?? '');
  while (rest.length > safeMax) {
    // 换行归前一段，因此搜索范围也必须给它预留一个码元。
    let cut = rest.lastIndexOf('\n', safeMax - 1);
    if (cut <= 0) {
      cut = safeMax;
    } else {
      cut += 1;
    }
    // 若切点正好落在代理对中间（emoji 等会被切成乱码），把切点前移一个码元
    const code = rest.charCodeAt(cut - 1);
    const next = rest.charCodeAt(cut);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut -= 1;
    if (cut <= 0) {
      const first = rest.charCodeAt(0);
      const second = rest.charCodeAt(1);
      cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/** Fiora 不接受纯空白消息；短空白尾段从前一段借一个完整字符，否则发送前报错。 */
export function splitForFiora(text, max = 2048) {
  const parts = splitForQQ(text, max);
  const last = parts.length - 1;
  if (last > 0 && !parts[last].trim()) {
    const previous = parts[last - 1];
    const trimmed = previous.trimEnd();
    const scalar = [...trimmed].at(-1) || '';
    const cut = trimmed.length - scalar.length;
    const tail = previous.slice(cut) + parts[last];
    if (previous.slice(0, cut).trim() && tail.length <= max) {
      parts[last - 1] = previous.slice(0, cut);
      parts[last] = tail;
    }
  }
  if (parts.some((part) => !part.trim())) {
    throw new Error('文本分段后包含纯空白消息，请缩短连续空白后重试');
  }
  return parts;
}

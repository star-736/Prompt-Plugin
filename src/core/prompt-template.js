// Plain-text substitution only. Values are never interpreted as template syntax.
export function promptTemplateEnabled(asset) {
  return ['generic', 'aigc'].includes(asset?.type) && asset.templateEnabled === true;
}

export function parsePromptTemplate(content) {
  const source = String(content ?? '');
  const segments = [];
  const names = [];
  let cursor = 0;
  const appendText = (text) => {
    if (text.includes('{{')) throw new Error('占位符格式不完整，请使用 {{名称}}。');
    if (text) segments.push({ text });
  };
  for (const match of source.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    appendText(source.slice(cursor, match.index));
    const name = match[1].trim();
    if (!name || /[{}\r\n]/.test(match[1])) throw new Error('占位符名称不能为空，不能包含花括号或换行。');
    if (!names.includes(name)) names.push(name);
    segments.push({ name, raw: match[0] });
    cursor = match.index + match[0].length;
  }
  appendText(source.slice(cursor));
  return { segments, names };
}

export function fillPromptTemplate(template, values = {}, { preview = false } = {}) {
  const missing = template.names.filter((name) => !Object.hasOwn(values, name) || typeof values[name] !== 'string' || !values[name].trim());
  if (!preview && missing.length) throw new Error(`请填写占位符：${missing.join('、')}。`);
  return template.segments.map((segment) => segment.name === undefined ? segment.text : missing.includes(segment.name) ? segment.raw : values[segment.name]).join('');
}

// Генерация коммерческих предложений (.docx) из ЗАГРУЖАЕМЫХ пользователем шаблонов.
// В отличие от soprovod.js (один фиксированный шаблон), здесь шаблоны — любые .docx,
// загруженные через портал, с плейсхолдерами {{ЗАКАЗЧИК}}, {{СУММА_РАБОТ}}, {{СУММА_ПОШЛИН}},
// {{ИТОГО}}, {{ДАТА}} где угодно в тексте.
//
// Проблема: Word часто разбивает видимую строку "{{ЗАКАЗЧИК}}" на несколько <w:r>
// (из-за проверки орфографии), и тогда простая замена текста её не найдёт. Поэтому
// при ЗАГРУЗКЕ шаблона мы один раз "склеиваем" соседние однотипные текстовые runs —
// после этого подстановка на каждую генерацию — простой поиск/замена по document.xml.
import { buildZip } from './zip.js';

// Склеивает соседние <w:r><w:rPr>…</w:rPr><w:t>…</w:t></w:r> с одинаковым rPr —
// упрощённый аналог merge_runs.py, без XML-парсера. Границы run'ов ищутся отдельным
// проходом (w:r никогда не вкладывается в w:r, так что нежадный поиск безопасен),
// а «простой текстовый run» проверяется полностью заякоренным regexp — run с чем-то
// ещё внутри (табуляция, разрыв строки, вложенный объект) НЕ трогаем, копируем как есть.
export function mergeRuns(xml) {
  const runOuterRe = /<w:r>([\s\S]*?)<\/w:r>/g;
  const simpleRe = /^(?:<w:rPr>([\s\S]*?)<\/w:rPr>)?<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>$/;
  let out = '';
  let lastEnd = 0;
  let pending = null; // {rPr, text, start, end}
  let m;
  while ((m = runOuterRe.exec(xml))) {
    const start = m.index;
    const end = start + m[0].length;
    const sm = simpleRe.exec(m[1]);
    if (sm) {
      const rPr = sm[1] || '';
      const text = sm[2];
      if (pending && pending.rPr === rPr && start === pending.end) {
        pending.text += text;
        pending.end = end;
      } else {
        if (pending) { out += xml.slice(lastEnd, pending.start) + buildRun(pending); lastEnd = pending.end; }
        pending = { rPr, text, start, end };
      }
    } else if (pending) {
      out += xml.slice(lastEnd, pending.start) + buildRun(pending);
      lastEnd = pending.end;
      pending = null;
    }
  }
  if (pending) { out += xml.slice(lastEnd, pending.start) + buildRun(pending); lastEnd = pending.end; }
  out += xml.slice(lastEnd);
  return out;
}
function buildRun(p) {
  const rPrPart = p.rPr ? `<w:rPr>${p.rPr}</w:rPr>` : '';
  return `<w:r>${rPrPart}<w:t xml:space="preserve">${p.text}</w:t></w:r>`;
}

function xmlEscape(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Обрабатывает СЫРОЙ .docx (Buffer) при загрузке: находит word/document.xml внутри
// zip-архива, склеивает runs, пересобирает архив. Дальше хранится уже эта версия.
export function preprocessTemplate(buf) {
  const entries = readZip(buf);
  for (const e of entries) {
    if (e.name === 'word/document.xml') {
      const xml = mergeRuns(e.data.toString('utf8'));
      e.data = Buffer.from(xml, 'utf8');
    }
  }
  return buildZip(entries);
}

// Подставляет значения и возвращает готовый .docx (Buffer).
export function fillTemplate(buf, values) {
  const entries = readZip(buf);
  for (const e of entries) {
    if (e.name === 'word/document.xml') {
      let xml = e.data.toString('utf8');
      for (const [key, val] of Object.entries(values)) {
        xml = xml.split(`{{${key}}}`).join(xmlEscape(val));
      }
      e.data = Buffer.from(xml, 'utf8');
    }
  }
  return buildZip(entries);
}

// ---------- минимальный ZIP-reader (только то, что нужно: список файлов + данные) ----------
// Поддерживает только STORE и DEFLATE (обычные .docx от Word используют DEFLATE).
import { inflateRawSync } from 'node:zlib';

function readZip(buf) {
  const eocdSig = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('not a valid zip/docx');
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);

  const entries = [];
  let p = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries.map(({ name, method, compSize, localOffset }) => {
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? Buffer.from(raw) : Buffer.from(inflateRawSync(raw));
    return { name, data };
  });
}

export function listPlaceholders(buf) {
  const entries = readZip(buf);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) return [];
  const xml = doc.data.toString('utf8');
  const text = xml.replace(/<[^>]+>/g, '');
  const found = new Set();
  for (const m of text.matchAll(/\{\{([А-ЯЁа-яёA-Za-z0-9_]+)\}\}/g)) found.add(m[1]);
  return [...found];
}

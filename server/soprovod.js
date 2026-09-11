// Генерация .docx «Сопроводительное письмо в ФИПС» из шаблона по объекту-патенту.
// Шаблон лежит в templates/soprovod/ как распакованный .docx (структура сохранена
// один в один), в word/document.xml — плейсхолдеры {{...}}. Мы читаем все файлы
// один раз, на каждый запрос подставляем значения и запаковываем заново (zip.js).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from './zip.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TPL_DIR = join(__dirname, 'templates', 'soprovod');

// Короткая (в шапке письма) и полная (в тексте, «патента на …») форма —
// для ПМ шаблон изначально использовал именно такую пару форм; для ИЗ и ПО
// подставляется одно и то же слово в обоих местах.
const TYPE_WORDS = {
  ПМ: { short: 'ПМ', long: 'полезную модель' },
  ИЗ: { short: 'изобретение', long: 'изобретение' },
  ПО: { short: 'промышленный образец', long: 'промышленный образец' },
};

let cachedFiles = null;
function loadTemplateFiles() {
  if (cachedFiles) return cachedFiles;
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push({ name: relative(TPL_DIR, full).split('\\').join('/'), path: full });
    }
  })(TPL_DIR);
  cachedFiles = files;
  return files;
}

function xmlEscape(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function soprovodAvailable(objectType) {
  return Object.prototype.hasOwnProperty.call(TYPE_WORDS, objectType);
}

// { objectType: 'ПМ'|'ИЗ'|'ПО', patentNo, outNo, outDate } -> Buffer (.docx)
export function buildSoprovod({ objectType, patentNo, outNo, outDate }) {
  const words = TYPE_WORDS[objectType];
  if (!words) throw new Error('unsupported object type: ' + objectType);

  const files = loadTemplateFiles();
  const entries = files.map(({ name, path }) => {
    let data = readFileSync(path);
    if (name === 'word/document.xml') {
      let xml = data.toString('utf8');
      xml = xml
        .replaceAll('{{OUT_NO}}', xmlEscape(outNo || 'б/н'))
        .replaceAll('{{OUT_DATE}}', xmlEscape(outDate))
        .replaceAll('{{TYPE_SHORT}}', xmlEscape(words.short))
        .replaceAll('{{TYPE_LONG}}', xmlEscape(words.long))
        .replaceAll('{{PATENT_NO}}', xmlEscape(patentNo || ''));
      data = Buffer.from(xml, 'utf8');
    }
    return { name, data };
  });

  return buildZip(entries);
}

export function soprovodFilename({ objectType, patentNo }) {
  const safe = String(patentNo || 'без_номера').replace(/[^\w\d-]+/g, '_');
  return `Сопроводительное ${objectType} ${safe}.docx`;
}

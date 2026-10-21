"""Read the supplied XLSX/DOCX without modifying them; output private import JSON.
Usage: python prepare-registry-update.py refused.xlsx price.docx output.json
"""
import sys, json, re, hashlib
from datetime import datetime, date
from collections import Counter
from openpyxl import load_workbook
from docx import Document

def text(v):
    if v is None: return ''
    if isinstance(v, (datetime,date)): return v.isoformat()[:10]
    return str(v).replace('\xa0',' ').strip()

workbook=load_workbook(sys.argv[1],data_only=True)
rows=[]
headers=None
for sheet in workbook:
    values=list(sheet.values)
    if not values: continue
    headers=[text(v) for v in values[0]]
    assert headers[:4]==['Стадия','Правообладатель','Вид объекта','Название объекта'], headers
    for i,r in enumerate(values[1:],2):
        if not any(v is not None for v in r): continue
        cells=[text(v) for v in r]
        if not any(cells[j] for j in [1,2,3,4,5,6,7,8]): continue
        typ='software' if cells[2]=='Программа для ЭВМ' else 'patent' if cells[2] in ['ИЗ','ПМ','ПО'] or cells[8] else 'trademark'
        rawreg=cells[8] or cells[6] if typ in ['patent','software'] else cells[7] or cells[6]
        reg=re.match(r'^\d+',rawreg)
        num=reg.group() if reg else ''
        name=cells[3] or cells[4] or ('Без названия · '+(cells[5] or num or f'строка {i}'))
        notes=[]
        # Keep the complete original row: no source annotations or extra columns lost.
        for j in [0,4,6,7,8,12,13,14,15,16,17,18]:
            if cells[j]: notes.append(headers[j]+': '+cells[j])
        if typ=='patent' and not cells[2]: notes.append('Вид патента не указан в исходном файле — требуется уточнение.')
        rows.append(dict(sourceKey=f'20261021-row-{i}', sourceRow=dict(zip(headers,cells)),
          type=typ,holder=cells[1],name=name,appNumber=cells[5],regNumber=num,
          objectType=cells[2] if cells[2] in ['ИЗ','ПМ','ПО'] else '',mktuClasses=cells[11],
          priorityDate=cells[9],expiryDate=cells[10],notes='\n'.join(notes),documentRef=cells[16] or cells[17],documentUrl=''))

categories=['Товарные знаки','Изобретения и полезные модели','Промышленные образцы','Программы для ЭВМ и базы данных','Споры и защита прав','Договоры']
doc=Document(sys.argv[2]); assert len(doc.tables)==len(categories)
prices=[]
for category,table in zip(categories,doc.tables):
    for r in table.rows[1:]:
        values=[]; seen=set()
        for cell in r.cells:
            # Word sometimes merges fee and duty; do not duplicate the fee as a duty.
            ident=cell._tc
            values.append('' if ident in seen else text(cell.text));seen.add(ident)
        assert len(values)==4
        name,fee,duty,total=values
        note=''
        if name.startswith('Изменение в заявку') and 'рубрик' in name: note='В исходном документе: гонорар 15 000, итог 10 000. Требуется уточнение.'
        if 'Таможенный реестр' in name: note='В исходном документе: гонорар 95 000, итог 90 000 + страховая премия. Требуется уточнение.'
        if name=='Поддержание патента на полезную модель': note='В исходном документе: 15 000 + 23 000, итог 37 000. Требуется уточнение.'
        if name=='Поддержание патента на изобретение' and '21-25' in duty: note='В исходном документе: 30 000 + 135 000, итог 150 000. Требуется уточнение.'
        if name.strip()=='Патентование промышленного образца': note='В исходном документе: гонорар 50 000, пошлины от 5 000 + 10 000, итог от 60 000. Требуется уточнение.'
        prices.append(dict(category=category,name=name,fee=fee,duty=duty,total=total,note=note))
payload=dict(format='erfis-registry-update-v1',id='2026-10-21-refused-price',confirmAll=True,refused=rows,price=prices)
with open(sys.argv[3],'w') as f:json.dump(payload,f,ensure_ascii=False,indent=2)
print(json.dumps({'objects':len(rows),'types':dict(Counter(r['type'] for r in rows)),'prices':len(prices),'warnings':sum(bool(p['note']) for p in prices)},ensure_ascii=False))

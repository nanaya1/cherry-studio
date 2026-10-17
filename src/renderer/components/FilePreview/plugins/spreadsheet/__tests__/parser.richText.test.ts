import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'

import { parseWorkbook } from '../worker/parseWorkbook'

async function stringWorkbook(content: string, storage: 'shared' | 'inline'): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Strings')
  sheet.getCell('A1').value = 'placeholder'
  sheet.getCell('B1').value = 42
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
  if (storage === 'shared') {
    zip.file(
      'xl/sharedStrings.xml',
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si>${content}</si></sst>`
    )
  } else {
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    zip.file(
      'xl/worksheets/sheet1.xml',
      xml.replace(/<c r="A1"[^>]*>[\s\S]*?<\/c>/, `<c r="A1" t="inlineStr"><is>${content}</is></c>`)
    )
  }
  return zip.generateAsync({ type: 'arraybuffer' })
}

const cases = [
  { name: '空 t 后接富文本', xml: '<t></t><r><rPr><b/></rPr><t>正文</t></r>', text: '正文' },
  { name: '自闭合空 t 后接富文本', xml: '<t/><r><t>正文</t></r>', text: '正文' },
  { name: '空 shared string 富文本', xml: '<t/><r><t/></r>', text: '' },
  {
    name: '非空 t 与 r 交错且保留空白和转义',
    xml: '<t xml:space="preserve"> 前&amp; </t><r><rPr><b/></rPr><t>中&lt;文</t></r><t xml:space="preserve"> 后 </t><r><t>尾</t></r>',
    text: ' 前& 中<文 后 尾'
  },
  { name: 'r 后接 t 不丢失文本', xml: '<r><t>前</t></r><t>后</t>', text: '前后' },
  { name: '纯空字符串', xml: '<t/>', text: '' },
  {
    name: '正常富文本保留文本与格式模型',
    xml: '<r><rPr><b/></rPr><t xml:space="preserve"> Hello </t></r><r><rPr><i/></rPr><t>世界&amp;!</t></r>',
    text: ' Hello 世界&!'
  }
]

for (const storage of ['shared', 'inline'] as const) {
  describe(`parseWorkbook 富文本兼容 — ${storage}`, () => {
    it.each(cases)('$name', async ({ xml, text }) => {
      const bytes = await stringWorkbook(xml, storage)
      const model = await parseWorkbook(bytes, 'rich-text.xlsx')
      if (storage === 'inline' && xml === '<t/>') {
        expect(model.sheets[0].cells['1:1']).toBeUndefined()
      } else {
        expect(model.sheets[0].cells['1:1']).toMatchObject({ raw: text, text })
      }
      expect(model.sheets[0].cells['1:2']).toMatchObject({ raw: 42, text: '42' })
      if (xml.includes('<r>')) expect(model.warnings).toContain('richtext-run-styles-dropped')
    })

    it('原始混排 XLSX 确实触发 ExcelJS richText 赋值异常', async () => {
      const xml = storage === 'shared' ? '<t/><r><t>正文</t></r>' : '<t>前</t><r><t>正文</t></r>'
      const bytes = await stringWorkbook(xml, storage)
      await expect(new ExcelJS.Workbook().xlsx.load(bytes)).rejects.toThrow(
        /Cannot create property 'richText' on string/
      )
    })

    it('预处理保留已有 run 的字体、顺序、空白和文本', async () => {
      const bytes = await stringWorkbook(
        '<t xml:space="preserve"> 前 </t><r><rPr><b/><color rgb="FFFF0000"/></rPr><t>正文&amp;</t></r><t>后</t>',
        storage
      )
      const load = new ExcelJS.Workbook().xlsx
      const spy = vi.spyOn(Object.getPrototypeOf(load), 'load')
      try {
        await parseWorkbook(bytes, 'runs.xlsx')
        const normalized = spy.mock.calls[0][0] as ArrayBuffer
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(normalized)
        expect(workbook.worksheets[0].getCell('A1').value).toEqual({
          richText: [
            { text: ' 前 ' },
            { font: { bold: true, color: { argb: 'FFFF0000' } }, text: '正文&' },
            { text: '后' }
          ]
        })
      } finally {
        spy.mockRestore()
      }
    })
  })
}

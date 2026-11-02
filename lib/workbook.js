const {parse} = require('csv-parse/sync');
const maxBytes=4*1024*1024;
const fail=message=>{throw Object.assign(new Error(message),{status:400});};
async function inspectZip(buffer) {
  // Validate actual decompressed sizes before passing XLSX to the XML reader.
  await new Promise((resolve,reject)=>{
    require('yauzl').fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true},(error,zip)=>{
      if(error)return reject(error);let total=0,count=0,finished=false,cells=0;
      const stop=error=>{if(finished)return;finished=true;zip.close();reject(error);};
      zip.on('error',stop);zip.on('end',()=>{if(!finished){finished=true;resolve();}});
      zip.on('entry',entry=>{
        if(++count>1000 || entry.uncompressedSize>20*1024*1024 || total+entry.uncompressedSize>20*1024*1024)return stop(new Error('Workbook is too large after decompression.'));
        if(entry.fileName.endsWith('/'))return zip.readEntry();
        zip.openReadStream(entry,(error,stream)=>{
          if(error)return stop(error);
          const xmlChunks=[];const xml=/\.xml$/i.test(entry.fileName);
          stream.on('error',stop);stream.on('data',chunk=>{total+=chunk.length;if(xml)xmlChunks.push(chunk);if(total>20*1024*1024){stream.destroy();stop(new Error('Workbook is too large after decompression.'));}});
          stream.on('end',()=>{
            if(finished)return;
            try{
              if(xml){
                const text=Buffer.concat(xmlChunks).toString('utf8');if(/<!DOCTYPE/i.test(text))throw new Error('Unsupported XML document type.');
                const {Parser}=require('saxen');const parser=new Parser();let rows=0;
                parser.on('error',error=>{throw error;});
                parser.on('openTag',(name,getAttributes,decode)=>{
                  const tag=name.split(':').at(-1);if(!['row','c'].includes(tag))return;const attrs=getAttributes();
                  if(tag==='row'){
                    if(++rows>5001)throw new Error('Worksheet is too large (maximum 5,000 data rows).');
                    if(attrs.r){const r=decode(attrs.r);if(!/^\d+$/.test(r) || Number(r)>5001)throw new Error('Worksheet is too large (maximum 5,000 data rows).');}
                  }else if(attrs.r){
                    if(++cells>100000)throw new Error('Workbook is too large (maximum 100,000 cells).');
                    const match=decode(attrs.r).match(/^([A-Z]+)(\d+)$/);if(!match)throw new Error('Invalid cell reference.');
                    const column=[...match[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
                    if(column>100 || Number(match[2])>5001)throw new Error('Worksheet is too large (maximum 100 columns and 5,000 data rows).');
                  }
                });parser.parse(text);
              }
              zip.readEntry();
            }catch(error){stop(error);}
          });
        });
      });zip.readEntry();
    });
  });
}
async function parseWorkbook(name,buffer) {
  if(buffer.length>maxBytes)fail('Files must be 4 MB or smaller. Split large files before importing.');
  let sheets;
  if(/\.csv$/i.test(name)) {
    try { sheets=[{name:'CSV',rows:parse(buffer,{bom:true,relax_column_count:true,skip_empty_lines:false,max_record_size:65536})}]; }
    catch {fail('This CSV could not be read. Use UTF-8 CSV with comma-separated columns and correctly quoted values.');}
  } else if(/\.xlsx$/i.test(name)) {
    try {
      await inspectZip(buffer);
      const {default:readExcelFile}=await import('read-excel-file/node');
      sheets=(await readExcelFile(buffer)).map(sheet=>({name:sheet.sheet,rows:sheet.data}));
    }catch(error){if(error.message.includes('too large'))fail(error.message);fail('This Excel workbook could not be read. Use an unencrypted .xlsx file, or save the worksheet as UTF-8 CSV.');}
  } else fail('Choose an .xlsx or .csv file. Legacy .xls files must be saved as .xlsx first.');
  if(!sheets.length || sheets.length>20)fail('A workbook must contain 1 to 20 worksheets.');
  let cells=0;
  for(const sheet of sheets){
    if(sheet.rows.length>5001)fail('A worksheet can contain at most 5,000 data rows plus a header. Split larger worksheets.');
    sheet.rows=sheet.rows.map(row=>{
      if(!Array.isArray(row) || row.length>100)fail('A worksheet can contain at most 100 columns.');
      cells+=row.length;if(cells>100000)fail('Select a smaller workbook (maximum 100,000 cells).');
      return row.map(value=>{
        if(value===null || value===undefined)return '';
        if(value instanceof Date)return value.toISOString().slice(0,10);
        if(typeof value==='boolean')return value?'TRUE':'FALSE';
        if(!['string','number'].includes(typeof value))fail('Cells must contain text, numbers or dates. Convert other cell values to plain values first.');
        if(typeof value==='string' && value.length>2000)fail('A cell exceeds the 2,000-character limit.');
        return value;
      });
    });
  }
  if(Buffer.byteLength(JSON.stringify(sheets))>2*1024*1024)fail('The worksheet data exceeds 2 MB. Split the workbook into smaller files.');
  return {name,sheets};
}
module.exports={parseWorkbook,maxBytes,inspectZip};

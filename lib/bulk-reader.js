const fs=require('node:fs');const {StringDecoder}=require('node:string_decoder');const sax=require('sax');
const fail=(message,code)=>{throw Object.assign(new Error(message),{status:400,...(code?{code}:{})});};
const maxRows=200000,maxColumns=100,maxExpanded=1024*1024*1024;
function clean(value){if(value.length>2000)fail('A source cell exceeds 2,000 characters. Shorten that cell before importing.');return value;}
async function readLargeWorkbook(filename,onSheet,onRows,onProgress=async()=>{},onSheetError){
  let expanded=0;
  if(/\.csv$/i.test(filename)){
    const {parse}=require('csv-parse');let pending=[],number=0;
    await onSheet({key:'0',name:'CSV'});
    for await(const values of fs.createReadStream(filename).pipe(parse({bom:true,relax_column_count:true,max_record_size:262144}))){
      number++;if(number>maxRows+1)fail('A worksheet can contain at most 200,000 data rows plus a header.');if(values.length>maxColumns)fail('A worksheet can contain at most 100 columns.');
      pending.push({n:number,v:values.map(clean)});if(pending.length===500){await onRows('0',pending);pending=[];}
    }
    if(pending.length)await onRows('0',pending);return;
  }
  const {zip,entries}=await new Promise((resolve,reject)=>require('yauzl').open(filename,{lazyEntries:true,autoClose:false,validateEntrySizes:true},(error,zip)=>{
    if(error)return reject(error);const entries=new Map();let count=0;zip.on('error',reject);zip.on('entry',entry=>{if(++count>4000){zip.close();reject(new Error('This workbook contains too many archive entries.'));return;}entries.set(entry.fileName,entry);zip.readEntry();});zip.on('end',()=>resolve({zip,entries}));zip.readEntry();
  }));
  async function xml(name,handlers={},afterChunk=async()=>{}){
    const entry=entries.get(name);if(!entry)fail(`The workbook is missing ${name}.`);if(entry.uncompressedSize>maxExpanded)fail('The workbook expands beyond the 1 GB processing limit.');
    const stream=await new Promise((resolve,reject)=>zip.openReadStream(entry,(error,stream)=>error?reject(error):resolve(stream)));
    const parser=sax.parser(true,{trim:false,normalize:false});const decoder=new StringDecoder('utf8');
    parser.onopentag=node=>handlers.open?.(node.name.split(':').at(-1),node.attributes);
    parser.onclosetag=name=>handlers.close?.(name.split(':').at(-1));parser.ontext=text=>handlers.text?.(text);parser.oncdata=text=>handlers.text?.(text);
    parser.ondoctype=()=>fail('XML document types are not supported.');parser.onerror=error=>{throw error;};
    try{for await(const chunk of stream){expanded+=chunk.length;if(expanded>maxExpanded)fail('The workbook expands beyond the 1 GB processing limit.');parser.write(decoder.write(chunk));await afterChunk();}parser.write(decoder.end()).close();await afterChunk();}
    finally{stream.destroy();}
  }
  try{
    const sheets=[];let date1904=false;
    await xml('xl/workbook.xml',{open:(name,a)=>{if(name==='workbookPr')date1904=['1','true'].includes(a.date1904);if(name==='sheet')sheets.push({name:a.name,relationship:a['r:id']});}});
    if(!sheets.length || sheets.length>20)fail('A workbook must contain 1 to 20 worksheets.');
    const relationships=new Map();await xml('xl/_rels/workbook.xml.rels',{open:(name,a)=>{if(name==='Relationship' && a.TargetMode!=='External')relationships.set(a.Id,a.Target);}});
    const formats=new Map(),styles=[];let cellStyles=false;
    if(entries.has('xl/styles.xml'))await xml('xl/styles.xml',{open:(name,a)=>{if(name==='numFmt')formats.set(Number(a.numFmtId),a.formatCode);if(name==='cellXfs')cellStyles=true;else if(name==='xf' && cellStyles)styles.push(Number(a.numFmtId));},close:name=>{if(name==='cellXfs')cellStyles=false;}});
    const strings=[];let stringBytes=0,inString=false,inText=false,phonetic=0,string='';
    if(entries.has('xl/sharedStrings.xml'))await xml('xl/sharedStrings.xml',{
      open:name=>{if(name==='si'){inString=true;string='';}if(name==='rPh')phonetic++;if(name==='t')inText=true;},
      text:text=>{if(inString && inText && !phonetic)string=clean(string+text);},
      close:name=>{if(name==='t')inText=false;if(name==='rPh')phonetic--;if(name==='si'){stringBytes+=Buffer.byteLength(string);if(stringBytes>48*1024*1024 || strings.length>=2000000)fail('The workbook has too much shared text. Export the required worksheet as CSV to reduce it.');strings.push(string);inString=false;}},
    });
    for(let sheetIndex=0;sheetIndex<sheets.length;sheetIndex++){
      const sheet=sheets[sheetIndex],key=String(sheetIndex),target=relationships.get(sheet.relationship);
      if(!target)fail('A worksheet relationship is missing.');
      const name=target.startsWith('/')?target.slice(1):require('node:path').posix.normalize('xl/'+target);
      await onSheet({key,name:sheet.name});await onProgress(`Reading ${sheet.name}`);
      let pending=[],row=[],rowNumber=0,lastRow=0,cell=null,insideValue=false,insideText=false,count=0;
      function value(c){
        if(c.formula && !c.hasValue)fail('A formula has no saved result. Recalculate and save the workbook in Excel before importing.','MISSING_FORMULA_RESULT');
        if(c.type==='inlineStr')return clean(c.text);
        if(c.type==='s'){const index=Number(c.value);if(!Number.isInteger(index)||index<0||index>=strings.length)fail('A shared-string reference is invalid.');return strings[index];}
        if(c.type==='str')return clean(c.value);
        if(c.type==='b')return c.value==='1'?'TRUE':'FALSE';
        if(c.type==='e')fail('A worksheet cell contains an Excel error. Correct it before importing.','EXCEL_CELL_ERROR');
        if(c.type==='d'){const date=new Date(c.value);if(!Number.isFinite(date.getTime()))fail('Invalid Excel date cell.');return date.toISOString().slice(0,10);}
        if(!c.hasValue || c.value==='')return '';
        const number=Number(c.value);if(!Number.isFinite(number))fail('Invalid numeric Excel cell.');
        const formatId=styles[c.style] || 0,format=formats.get(formatId) || '';
        if((formatId>=14&&formatId<=22)||(formatId>=27&&formatId<=36)||(formatId>=45&&formatId<=47)||(formatId>=50&&formatId<=58)||/[dy]/i.test(format.replace(/"[^"]*"|\\.|\[[^\]]*\]/g,''))){
          const baseline=date1904?Date.UTC(1904,0,1):Date.UTC(1899,11,number<60?31:30);return new Date(baseline+number*86400000).toISOString().slice(0,10);
        }
        if(/^0{2,20}$/.test(format) && Number.isInteger(number) && number>=0)return String(number).padStart(format.length,'0');
        return number;
      }
      try{await xml(name,{
        open:(tag,a)=>{
          if(tag==='row'){row=[];rowNumber=a.r?Number(a.r):lastRow+1;if(!Number.isInteger(rowNumber)||rowNumber<1||rowNumber>1048576)fail('Invalid Excel row number.');}
          if(tag==='c'){
            const match=String(a.r || '').match(/^([A-Z]+)(\d+)$/);if(!match)fail('Invalid Excel cell reference.');const column=[...match[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
            cell={column,type:a.t,style:Number(a.s || 0),value:'',text:'',formula:false,hasValue:false};
          }
          if(cell && tag==='f')cell.formula=true;
          if(cell && tag==='v'){insideValue=true;cell.hasValue=true;}
          if(cell && tag==='t')insideText=true;
        },
        text:text=>{if(!cell)return;if(insideValue)cell.value=clean(cell.value+text);if(insideText)cell.text=clean(cell.text+text);},
        close:tag=>{
          if(tag==='v')insideValue=false;if(tag==='t')insideText=false;
          if(tag==='c' && cell){const v=value(cell);if(v!==''){if(cell.column>maxColumns)fail('A worksheet can contain at most 100 populated columns.');while(row.length<cell.column)row.push('');row[cell.column-1]=v;}cell=null;}
          if(tag==='row'){
            if(row.some(v=>v!=='')){if(++count>maxRows+1)fail('A worksheet can contain at most 200,000 data rows plus a header.');pending.push({n:rowNumber,v:row});}
            lastRow=rowNumber;
          }
        },
      },async()=>{if(pending.length>=500){await onRows(key,pending);pending=[];}});}
      catch(error){if(onSheetError && ['EXCEL_CELL_ERROR','MISSING_FORMULA_RESULT'].includes(error.code)){await onSheetError(key,error.message);continue;}throw error;}
      if(pending.length)await onRows(key,pending);
    }
  }finally{zip.close();}
}
module.exports={readLargeWorkbook,maxRows,maxColumns};

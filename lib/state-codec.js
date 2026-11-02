const {gzipSync,gunzipSync}=require('node:zlib');
const maxStateBytes=64*1024*1024;
function encodeState(state){
  const text=JSON.stringify(state);
  if(Buffer.byteLength(text)>maxStateBytes)throw Object.assign(new Error('The workspace exceeds its 64 MB data capacity.'),{status:400});
  if(Buffer.byteLength(text)<256*1024)return text;
  const zipped=gzipSync(text);
  // Leave headroom for the serverless response envelope and backup audit data.
  if(zipped.length>3000*1024)throw Object.assign(new Error('The workspace has reached its current data capacity. Archive older records before adding more.'),{status:400});
  return 'gzip:'+zipped.toString('base64');
}
function decodeState(data){return JSON.parse(data.startsWith('gzip:')?gunzipSync(Buffer.from(data.slice(5),'base64'),{maxOutputLength:maxStateBytes}).toString('utf8'):data);}
module.exports={encodeState,decodeState,maxStateBytes};

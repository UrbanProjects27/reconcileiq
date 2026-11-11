function validateAttachment(input){
  const fail=message=>{throw Object.assign(new Error(message),{status:400});};
  if(!input || typeof input!=='object' || typeof input.claimId!=='string' || typeof input.name!=='string' || !input.name.trim() || input.name.length>200 || /[<>\x00-\x1f\\/]/.test(input.name))fail('Choose a valid attachment filename.');
  if(typeof input.data!=='string' || input.data.length>2800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data))fail('Attachment must be a PDF or JPG up to 2 MB.');
  const bytes=Buffer.from(input.data,'base64');if(bytes.length>2*1024*1024 || bytes.toString('base64')!==input.data)fail('Attachment must be up to 2 MB.');
  const pdf=/\.pdf$/i.test(input.name) && bytes.subarray(0,5).toString()==='%PDF-';
  const jpg=/\.jpe?g$/i.test(input.name) && bytes.length>3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  if(!pdf && !jpg)fail('Only genuine PDF and JPG files are supported.');
  return {...input,mediaType:pdf?'application/pdf':'image/jpeg'};
}
module.exports={validateAttachment};
